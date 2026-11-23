import { useCallback, useEffect, useRef, useState } from 'react';
import type { finalizeEvaluationSession, getEvaluationSettings, startEvaluationSession } from '../server/novelWritingEvaluationRunner';
import type { DurableEvaluationDetail } from '../server/novelWritingEvaluationSessions';
import { EVALUATION_SCENARIOS, REVIEW_DIMENSIONS, type EvaluationRating, type EvaluationScenarioId, type EvaluationSessionHeader, type EvaluationSettings, type EvaluationTreatment, type ReviewChoice } from '../types/novelWritingEvaluation';

type Settings = ReturnType<typeof getEvaluationSettings>;
type BlindRun = Awaited<ReturnType<typeof startEvaluationSession>> | DurableEvaluationDetail;
type Report = ReturnType<typeof finalizeEvaluationSession>;
type HistoryPage = { entries: EvaluationSessionHeader[]; next?: string };

const button = 'rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-200 hover:border-amber-400 disabled:opacity-50';
const input = 'rounded-lg border border-slate-700 bg-slate-950 px-2 py-1 text-sm text-slate-100';
const treatmentLabel: Record<EvaluationTreatment, string> = {
  STYLE_AND_VOICE: '문체 + 인물 화법', STYLE_ONLY: '문체만', VOICE_ONLY: '인물 화법만',
};
const choiceLabel: Record<ReviewChoice, string> = { A: 'A 선호', B: 'B 선호', TIE: '비슷함', DEFER: '판단 보류' };
const number = (value: number | null | undefined) => value == null ? '—' : value.toLocaleString('ko-KR', { maximumFractionDigits: 2 });

export function NovelWritingEvaluationPanel({ getIdToken }: { getIdToken: () => Promise<string | null> }) {
  const [settings, setSettings] = useState<Settings>();
  const [scenarios, setScenarios] = useState<EvaluationScenarioId[]>(['NW1']);
  const [treatment, setTreatment] = useState<EvaluationTreatment>('STYLE_AND_VOICE');
  const [mode, setMode] = useState<EvaluationSettings['mode']>('DRY_RUN_FIXTURE');
  const [repeats, setRepeats] = useState(1);
  const [budget, setBudget] = useState(4);
  const [optIn, setOptIn] = useState(false);
  const [run, setRun] = useState<BlindRun>();
  const [report, setReport] = useState<Report>();
  const [ratings, setRatings] = useState<Record<string, EvaluationRating>>({});
  const [active, setActive] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [stopping, setStopping] = useState(false);
  const [history, setHistory] = useState<HistoryPage>();
  const [message, setMessage] = useState('');
  const attempt = useRef<{ key: string; id: string } | undefined>(undefined);
  const reviewAttempt = useRef<{ key: string; id: string } | undefined>(undefined);
  const lock = useRef(false);
  const live = mode === 'LIVE_GEMINI';
  const expected = live ? scenarios.length * repeats * 4 : 0;
  const cloudRun = run && 'status' in run ? run : undefined;
  const waiting = cloudRun?.status === 'RUNNING' || cloudRun?.status === 'CREATED';

  const request = useCallback(async <T,>(action: string, data?: object) => {
    const token = await getIdToken();
    const response = await fetch(`/api/novel-writing-evaluation/${action}`, {
      method: data ? 'POST' : 'GET',
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(data ? { 'Content-Type': 'application/json' } : {}) },
      body: data ? JSON.stringify(data) : undefined,
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? 'EVALUATION_FAILED');
    return result as T;
  }, [getIdToken]);

  const applyCloud = useCallback((next: DurableEvaluationDetail, keepDraft = false) => {
    setRun(next); setReport(next.report);
    if (!keepDraft || next.report) {
      setRatings(Object.fromEntries((next.report?.ratings ?? next.reviewDraft).map((rating) => [rating.pairId, rating])));
    }
  }, []);

  const loadHistory = useCallback(async (after?: string) => {
    try {
      const page = await request<HistoryPage>(`sessions${after ? '?after=' + encodeURIComponent(after) : ''}`);
      setHistory((previous) => ({ ...page, entries: after ? [...(previous?.entries ?? []), ...page.entries] : page.entries }));
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'EVALUATION_FAILED'); }
  }, [request]);

  useEffect(() => {
    if (!waiting || !cloudRun) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await request<DurableEvaluationDetail>(`sessions/${cloudRun.operationId}`);
        if (!active) return;
        applyCloud(next);
        if (next.status !== 'RUNNING' && next.status !== 'CREATED') {
          setStopping(false);
          void loadHistory();
          return;
        }
      } catch (caught) {
        if (active) setError(caught instanceof Error ? caught.message : 'EVALUATION_FAILED');
      }
      if (active) timer = setTimeout(poll, 5000);
    };
    timer = setTimeout(poll, 3000);
    return () => { active = false; clearTimeout(timer); };
  }, [applyCloud, cloudRun?.operationId, loadHistory, request, waiting]);

  async function openSession(id: string, keepDraft = false) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true); setError(''); setMessage(''); setStopping(false);
    try {
      const next = await request<DurableEvaluationDetail>(`sessions/${id}`);
      applyCloud(next, keepDraft);
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'EVALUATION_FAILED'); }
    finally { lock.current = false; setBusy(false); }
  }

  async function start() {
    if (lock.current || !settings) return;
    lock.current = true;
    const payload = {
      scenarios, treatment, repeats, mode, optIn: live && optIn, ...(live ? { callBudget: budget } : {}),
    };
    const key = JSON.stringify(payload);
    if (attempt.current?.key !== key) attempt.current = { key, id: crypto.randomUUID() };
    const operationId = attempt.current.id;
    setBusy(true); setError(''); setMessage(''); setActive(operationId); setStopping(false);
    try {
      const next = await request<BlindRun>('run', { ...payload, operationId });
      if ('status' in next) { applyCloud(next); void loadHistory(); }
      else setRun(next);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'EVALUATION_FAILED');
      if (settings.durable) {
        const saved = await request<DurableEvaluationDetail>(`sessions/${operationId}`).catch(() => undefined);
        if (saved) applyCloud(saved);
        void loadHistory();
      }
    }
    finally { lock.current = false; setBusy(false); setActive(''); }
  }

  async function saveReview(finalize: boolean) {
    if (!run || lock.current) return;
    lock.current = true;
    setBusy(true); setError(''); setMessage('');
    try {
      const data = { operationId: run.operationId, ratings: Object.values(ratings), finalize, expectedVersion: cloudRun?.version };
      if (cloudRun) {
        const key = JSON.stringify(data);
        if (reviewAttempt.current?.key !== key) reviewAttempt.current = { key, id: crypto.randomUUID() };
        const next = await request<DurableEvaluationDetail>('review', { ...data, reviewOperationId: reviewAttempt.current.id });
        applyCloud(next);
        setMessage(finalize ? '리뷰를 확정했습니다.' : '검토 초안을 저장했습니다.');
        void loadHistory();
      } else setReport(await request<Report>('review', data));
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'EVALUATION_FAILED'); }
    finally { lock.current = false; setBusy(false); }
  }

  async function cancel() {
    if (stopping) return;
    setStopping(true);
    try {
      await request('cancel', { operationId: active || cloudRun?.operationId });
      if (cloudRun) void loadHistory();
    }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'EVALUATION_FAILED'); setStopping(false); }
  }

  function updateRating(pairId: string, changes: Partial<EvaluationRating>) {
    setRatings((current) => ({
      ...current, [pairId]: { ...(current[pairId] ?? { pairId, choice: 'DEFER' }), ...changes },
    }));
  }

  return <details className="rounded-xl border border-slate-700 bg-slate-950/90 p-4" onToggle={(event) => {
    if (event.currentTarget.open && !settings) void request<Settings>('settings')
      .then((loaded) => { setSettings(loaded); if (loaded.durable) void loadHistory(); })
      .catch((caught: Error) => setError(caught.message));
  }}>
    <summary className="cursor-pointer font-semibold text-slate-100">Novel Writing Evaluation</summary>
    <div className="mt-4 space-y-4 text-sm text-slate-200">
      {error && <p role="alert" className="text-rose-300">{error === 'VERSION_CONFLICT' ? '다른 기기가 먼저 리뷰를 저장했습니다. 최신 상태를 불러와 변경 내용을 확인하세요.' : error}</p>}
      {message && <p role="status">{message}</p>}
      {settings?.durable && <details className="rounded-lg border border-slate-800 p-3">
        <summary>평가 기록</summary>
        <button type="button" className={button + ' mt-2'} disabled={busy} onClick={() => void loadHistory()}>평가 기록 새로고침</button>
        {history?.entries.length === 0 && <p className="mt-2">저장된 평가가 없습니다.</p>}
        <ul className="mt-2 space-y-2">{history?.entries.map((entry) => <li key={entry.operationId} className="rounded-lg border border-slate-800 p-2">
          <button className={button} type="button" disabled={busy} onClick={() => void openSession(entry.operationId)}>
            {entry.status === 'FINALIZED' ? '완료 결과 보기' : '평가 복원'}
          </button>
          <p className="mt-1 text-xs text-slate-300">
            {new Date(entry.createdAt).toLocaleString('ko-KR')} · {entry.modelId} · {entry.datasetVersion} · {treatmentLabel[entry.treatment]} · {entry.status} · {entry.humanRatingStatus}
          </p>
          {entry.reason && <p className="text-xs text-amber-300">{entry.reason}</p>}
        </li>)}</ul>
        {history?.next && <button type="button" className={button} disabled={busy} onClick={() => void loadHistory(history.next)}>이전 평가 더 보기</button>}
      </details>}
      {!run && <>
        <fieldset disabled={busy} className="space-y-3">
          <legend className="sr-only">평가 설정</legend>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {EVALUATION_SCENARIOS.map(([id, title]) => <label key={id} className="flex gap-2">
              <input type="checkbox" checked={scenarios.includes(id)} onChange={(event) =>
                setScenarios(event.target.checked ? [...scenarios, id] : scenarios.filter((scenario) => scenario !== id))} />
              {title}
            </label>)}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2">비교 조건
              <select className={input} value={treatment} onChange={(event) => setTreatment(event.target.value as EvaluationTreatment)}>
                {Object.entries(treatmentLabel).map(([id, title]) => <option key={id} value={id}>공통 규칙 ↔ {title}</option>)}
              </select>
            </label>
            <label className="flex items-center gap-2">평가 반복
              <input className={input + ' w-16'} type="number" min={1} max={settings?.maxRepeats ?? 4} value={repeats} onChange={(event) => setRepeats(Number(event.target.value))} />
            </label>
            <label className="flex items-center gap-2">실행 모드
              <select className={input} value={mode} onChange={(event) => { setMode(event.target.value as EvaluationSettings['mode']); setOptIn(false); }}>
                <option value="DRY_RUN_FIXTURE">합성 원고로 검증</option>
                <option value="LIVE_GEMINI" disabled={!settings?.liveAvailable}>Live Gemini{!settings?.liveAvailable && ' · 비활성'}</option>
              </select>
            </label>
          </div>
          {live && <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2">호출 예산
              <input className={input + ' w-16'} type="number" min={1} max={settings?.maxCalls} value={budget} onChange={(event) => setBudget(Number(event.target.value))} />
            </label>
            <label><input type="checkbox" checked={optIn} onChange={(event) => setOptIn(event.target.checked)} /> 합성 데이터의 Gemini 전송 및 비용 발생에 동의</label>
          </div>}
        </fieldset>
        <dl className="grid gap-1 text-xs text-slate-300 sm:grid-cols-2">
          <div><dt className="inline font-semibold">입력 출처</dt><dd className="ml-2 inline">합성 벤치마크 {settings?.datasetVersion}</dd></div>
          <div><dt className="inline font-semibold">대상 모델</dt><dd className="ml-2 inline">{settings?.modelId ?? '불러오는 중'}{!live && ' · 고정 응답 사용'}</dd></div>
          <div><dt className="inline font-semibold">실제 원고 전송 · 자동 저장</dt><dd className="ml-2 inline">없음</dd></div>
          <div><dt className="inline font-semibold">예상 최대 API 호출</dt><dd className="ml-2 inline">{expected}건{live && ' · 생성 및 Q1~Q8 포함'}</dd></div>
        </dl>
        <p className="text-xs text-slate-400">{settings?.durable ? '평가와 리뷰를 Firebase 계정에 저장합니다.' : '로컬 평가와 리뷰는 서버의 임시 세션에 보관됩니다.'}</p>
        <div className="flex gap-2">
          <button type="button" className={button} disabled={busy || !settings || !scenarios.length || !Number.isInteger(repeats) ||
            repeats < 1 || repeats > settings.maxRepeats || (live && (!settings.liveAvailable || !optIn || !Number.isInteger(budget) || budget > settings.maxCalls || budget < expected))}
            onClick={() => void start()}>{active ? '평가 진행 중…' : 'A/B 평가 시작'}</button>
          {active && <button type="button" className={button} disabled={stopping} onClick={() => void cancel()}>{stopping ? '중단 중…' : '중단'}</button>}
        </div>
      </>}
      {run && <>
        <p role="status">{waiting ? `진행 중 · ${cloudRun?.completedCases ?? 0}/${run.total}건 처리`
          : `비교 가능 ${run.pairs.length}/${run.total}건 · 제외 ${run.excluded}건${run.interrupted ? ' · 실행 중단' : ''}`}</p>
        {cloudRun?.reason && <p className="text-amber-300">{cloudRun.reason === 'REMOTE_CALL_OUTCOME_UNKNOWN'
          ? 'REMOTE_CALL_OUTCOME_UNKNOWN · 마지막 Gemini 호출의 결과가 확인되지 않았습니다. 이 세션의 호출은 자동 재실행되지 않습니다.'
          : cloudRun.reason}</p>}
        {cloudRun && <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs">v{cloudRun.version} · {cloudRun.humanRatingStatus}</span>
          <button type="button" className={button} disabled={busy} onClick={() => void openSession(cloudRun.operationId, true)}>최신 상태 불러오기</button>
          {waiting && <button type="button" className={button} disabled={stopping} onClick={() => void cancel()}>{stopping ? '중단 중…' : '중단'}</button>}
        </div>}
        {run.pairs.map((pair) => {
          const rating = ratings[pair.pairId];
          const reveal = report?.reveal.find((entry) => entry.pairId === pair.pairId);
          return <article key={pair.pairId} className="space-y-2 rounded-lg border border-slate-800 p-3">
            <h3 className="font-semibold">{pair.title}</h3>
            <p className="text-slate-300">{pair.goal}</p>
            <div className="grid gap-3 md:grid-cols-2">
              {([['A', pair.optionA], ['B', pair.optionB]] as const).map(([side, text]) => <div key={side} className="rounded-lg bg-slate-900 p-3">
                <h4 className="font-semibold">원고 {side}{report && reveal && ` · ${reveal.baselineSide === side ? '공통 규칙' : treatmentLabel[report.treatment]}`}</h4>
                <p className="mt-2 whitespace-pre-wrap leading-relaxed">{text}</p>
              </div>)}
            </div>
            {!report && <fieldset disabled={busy} className="space-y-2">
              <legend className="font-semibold">블라인드 선호도</legend>
              <div className="flex flex-wrap gap-3">
                {Object.entries(choiceLabel).map(([value, label]) => <label key={value}>
                  <input type="radio" className="mr-1" name={pair.pairId} checked={rating?.choice === value}
                    onChange={() => updateRating(pair.pairId, { choice: value as ReviewChoice })} />{label}
                </label>)}
              </div>
              <details>
                <summary className="cursor-pointer">항목별 평가와 코멘트</summary>
                <div className="mt-2 flex flex-wrap gap-2">
                  {REVIEW_DIMENSIONS.map(([id, title]) => <label key={id} className="flex items-center gap-1">{title}
                    <select className={input} value={rating?.dimensions?.[id] ?? ''} onChange={(event) => {
                      const dimensions = { ...rating?.dimensions };
                      if (event.target.value) dimensions[id] = event.target.value as ReviewChoice;
                      else delete dimensions[id];
                      updateRating(pair.pairId, { dimensions });
                    }}>
                      <option value="">미평가</option>
                      {Object.entries(choiceLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                    </select>
                  </label>)}
                </div>
                <label className="mt-2 block">선호 이유
                  <textarea className={input + ' mt-1 block w-full'} rows={2} maxLength={1000} value={rating?.comment ?? ''}
                    onChange={(event) => updateRating(pair.pairId, { comment: event.target.value })} />
                </label>
              </details>
            </fieldset>}
            {report && rating && <p className="text-xs text-slate-300">{choiceLabel[rating.choice]}{rating.comment && ` · ${rating.comment}`}</p>}
          </article>;
        })}
        {!report && !waiting && <div className="flex flex-wrap gap-2">
          {cloudRun && run.pairs.length > 0 && <button type="button" className={button} disabled={busy} onClick={() => void saveReview(false)}>검토 초안 저장</button>}
          <button type="button" className={button} disabled={busy} onClick={() => void saveReview(true)}>리뷰 확정 및 결과 보기</button>
        </div>}
        {report && <>
          <EvaluationResults report={report} />
          <button type="button" className={button} onClick={() => {
            attempt.current = undefined; reviewAttempt.current = undefined;
            setRun(undefined); setReport(undefined); setRatings({}); setOptIn(false); setError(''); setMessage('');
          }}>새 평가</button>
        </>}
      </>}
    </div>
  </details>;
}

function EvaluationResults({ report }: { report: Report }) {
  const { summary, telemetry } = report;
  const decisive = summary.human.originalPreferredCount + summary.human.rewritePreferredCount;
  const signals = Object.entries(summary.integrity.baseline);
  return <section aria-label="평가 결과" className="space-y-3 border-t border-slate-700 pt-3">
    <h3 className="font-semibold">평가 결과</h3>
    <p className="text-slate-300">{report.mode === 'DRY_RUN_FIXTURE'
      ? 'FIXTURE · 고정 응답으로 평가 절차를 확인했습니다.'
      : 'Q1~Q8은 동일 모델의 보조 평가입니다. 표본 수와 점수만으로 품질 향상을 확정할 수 없습니다.'}</p>
    <p>인간 평가 {summary.human.status} · 공통 규칙 선호 {summary.human.originalPreferredCount} · 적용 조건 선호 {summary.human.rewritePreferredCount} · 동점 {summary.human.tieCount} · 미평가/보류 {summary.human.notRatedCount}</p>
    {summary.human.dimensionRatedCount > 0 && <p>항목별 선호를 기록한 쌍 {summary.human.dimensionRatedCount}건</p>}
    <p>적용 조건 승률 {summary.human.rewriteWinRateExcludingTiesPercent === null ? '미집계' : `${summary.human.rewriteWinRateExcludingTiesPercent}% (${decisive}건 기준)`}</p>
    <p>작가 문체 준수도 평균 차이 {number(summary.authorStyle.meanDelta)}점 · {summary.authorStyle.samples}쌍</p>
    <p>Character Voice 준수도 평균 차이 {number(summary.characterVoice.meanDelta)}점 · {summary.characterVoice.samples}쌍</p>
    <p>Gemini 호출 {telemetry.actualCalls}/{telemetry.plannedCalls}건 · 생성 {telemetry.generationCalls} · 평가 {telemetry.qualityCalls} · 측정 토큰 {number(telemetry.measuredTokens)} · 사용량 미확인 {telemetry.callsWithoutUsage}건</p>
    <p>소요 시간 {number(telemetry.latencyMs / 1000)}초 · 추정 비용 {telemetry.estimatedCostUsd === null ? '미집계' : `USD ${telemetry.estimatedCostUsd}`}</p>
    <p className="text-xs text-slate-400">실제 청구액은 집계 대상에 포함되지 않습니다. 무결성 표는 합성 시나리오의 규칙과 Writer 자체 점검으로 탐지한 신호입니다.</p>
    {telemetry.pricingReference && <a href={telemetry.pricingReference} target="_blank" rel="noreferrer" className="text-sky-300 underline">추정 단가 출처</a>}
    <div className="overflow-x-auto">
      <table className="w-full text-left text-xs">
        <thead><tr><th>품질 지표</th><th>점수 차이 평균</th><th>중앙값</th><th>표준편차</th><th>표본</th></tr></thead>
        <tbody>{summary.deltas.map((entry) => <tr className="border-t border-slate-800" key={entry.dimension}>
          <th className="py-1">{entry.dimension}</th><td>{number(entry.mean)}</td><td>{number(entry.median)}</td><td>{number(entry.standardDeviation)}</td><td>{entry.samples}</td>
        </tr>)}</tbody>
      </table>
    </div>
    <details><summary>무결성 검사별 탐지 건수</summary>
      <ul className="space-y-1 pt-2 text-xs">{signals.map(([code, count]) => <li key={code}>{code} · 공통 {count} / 적용 {summary.integrity.treatment[code]}</li>)}</ul>
    </details>
    {report.cases.map((entry) => <details key={entry.caseId} className="border-t border-slate-800 pt-2 text-xs">
      <summary>{entry.caseId} · {entry.comparable ? '비교 가능' : '비교 제외'} · 공통 {entry.baseline.chars}자 / 적용 {entry.treatment.chars}자</summary>
      {entry.lengthDifferencePercent !== null && entry.lengthDifferencePercent > 25 && <p>길이 차이 {number(entry.lengthDifferencePercent)}% · 긴 원고가 유리한 평가인지 검토할 필요가 있습니다.</p>}
      {entry.exclusionReasons.length > 0 && <p>제외 사유 {entry.exclusionReasons.join(' · ')}</p>}
      <p>모델 {entry.manifest.modelId} · 시점 {entry.manifest.perspective} · 목표 {entry.manifest.targetLength}자</p>
      {entry.baseline.observedModelVersion && <p>응답 모델 버전 · 공통 {entry.baseline.observedModelVersion} / 적용 {entry.treatment.observedModelVersion ?? '미확인'}</p>}
      <p>공통 / 적용 품질 점수 {summary.deltas.map(({ dimension }) => `${dimension} ${number(entry.baseline.scores[dimension])}/${number(entry.treatment.scores[dimension])}`).join(' · ')}</p>
      <p>채점 상태 {entry.baseline.qualityFailure ?? entry.baseline.qualityStatus} / {entry.treatment.qualityFailure ?? entry.treatment.qualityStatus}</p>
      {(['authorStyleAdherence', 'characterVoiceAdherence'] as const).map((key) => <p key={key}>
        {key === 'authorStyleAdherence' ? '작가 문체 준수' : '인물 화법 준수'} · {[entry.baseline[key], entry.treatment[key]].map((value) =>
          value ? `${number(value.score)} (${value.status}, ${value.confidence})` : '미측정').join(' / ')}
      </p>)}
      {!entry.comparable && [entry.baselineText, entry.treatmentText].some(Boolean) && <details>
        <summary>보존된 부분 원고 보기</summary>
        {[['공통 규칙', entry.baselineText], ['적용 조건', entry.treatmentText]].map(([label, prose]) => prose && <p key={label} className="whitespace-pre-wrap">{label} · {prose}</p>)}
      </details>}
      <ul>{[...entry.treatment.style, ...entry.treatment.voice].map((profile) => <li className="break-all" key={profile.profileId}>
        {profile.targetCharacterId ?? '작품 문체'} · {profile.profileId} · {profile.versionId} · {profile.contentHash}
      </li>)}</ul>
    </details>)}
  </section>;
}
