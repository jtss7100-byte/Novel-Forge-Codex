import { useEffect, useState } from 'react';
import type { Character, Episode, Scene, TimelineEvent } from '../types/novel';
import {
  KNOWLEDGE_METHODS, MEMORY_KNOWLEDGE_SCOPES, type KnowledgeMethod, type KnowledgeAcquisitionInput, type MemoryKnowledgeApprovalEntry,
  type MemoryKnowledgeCommand, type MemoryKnowledgePage, type MemoryKnowledgeReceipt, type MemoryKnowledgeRow,
  type MemoryKnowledgeScope, type MemoryKnowledgeTally, type MemoryKnowledgeWriteResult, type MemoryReviewStatus,
} from '../types/memoryKnowledge';
import type { MemoryTemporalStatus } from '../types/sceneMemory';

const scopes: Record<MemoryKnowledgeScope, string> = {
  PUBLIC: '공개 정보', CHARACTERS: '지정 인물만', AUTHOR_ONLY: '작가만 아는 정보', UNKNOWN: '미확정 · 집필 사용 제외',
};
const methods: Record<KnowledgeMethod, string> = {
  WITNESSED: '직접 목격', EXPERIENCED: '직접 경험', TOLD: '전달받음', DOCUMENT: '기록에서 확인', INFERRED: '추론', UNKNOWN: '경로 불명',
};
const statuses: Record<MemoryReviewStatus, string> = {
  ANNOTATED: '분류됨', UNANNOTATED: '미분류', PARTIALLY_ANNOTATED: '획득 근거 검토',
  SOURCE_UNVERIFIED: '출처 미검증', STALE_ANNOTATION: '이전 승인 재검토',
  CONFLICTING_ANNOTATION: '기존 지식 범위와 충돌', REVIEW_REQUIRED: '검토 보류',
};
const classifications: Record<MemoryTemporalStatus, string> = {
  PAST_EVENT: '과거 사건', CURRENT_VALID_STATE: '현재 유효한 상태', SUPERSEDED_HISTORICAL_STATE: '변경 전 상태',
};
const errors: Record<string, string> = {
  VERSION_CONFLICT: '다른 기기에서 수정했습니다. 최신 기록을 불러오세요.',
  OPERATION_CONFLICT: '다른 승인 요청에 이미 쓰인 ID입니다.',
  SOURCE_UNVERIFIED: '원본과 색인을 검증할 수 없습니다.',
  STALE_SOURCE: '원문 Revision 또는 범위가 바뀌었습니다. 최신 근거를 검토하세요.',
  KNOWLEDGE_SCOPE_CONFLICT: '기존 지식 범위와 충돌합니다.',
  INVALID_CHARACTER_SCOPE: '확정된 인물을 지정하세요.',
  TEMPORAL_EVIDENCE_MISSING: '획득 회차와 확정 장면 또는 연표 사건을 확인하세요.',
  TEMPORARY_FAILURE: '결과를 확인하지 못했습니다. 동일 요청으로 재시도할 수 있습니다.',
  FUTURE_INFORMATION: '이 장면보다 뒤의 정보입니다.',
  POV_KNOWLEDGE_RESTRICTED: '이 인물의 확인된 지식 범위 밖입니다.',
};
const tallyLabels: Record<keyof MemoryKnowledgeTally, string> = {
  reviewedDocuments: '집계한 문서', annotatedDocuments: '분류 포함', unannotatedDocuments: '미분류 포함',
  verifiedDocuments: '검증 근거 포함', staleDocuments: '이전 승인 포함', reviewDocuments: '검토 필요',
  eligibleDocuments: '집필 후보 포함',
};
const fieldClass = 'rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-slate-100';
const buttonClass = 'rounded border border-indigo-500/40 bg-indigo-500/15 px-3 py-1.5 text-indigo-200 disabled:opacity-40';
type Props = { projectId: string; token: string; characters: Character[]; episodes: Episode[]; scenes: Scene[]; events: TimelineEvent[] };
type EntryPage<T> = { entries: T[]; next?: string };

export function MemoryKnowledgePanel({ projectId, token, characters, episodes, scenes, events }: Props) {
  const [page, setPage] = useState<MemoryKnowledgePage>();
  const [totals, setTotals] = useState<{ all?: number; active?: number }>({});
  const [tally, setTally] = useState<MemoryKnowledgeTally>();
  const [summaryNext, setSummaryNext] = useState<string>();
  const [filters, setFilters] = useState({ status: '', characterId: '', minEpisode: '', maxEpisode: '',
    sourceEntityId: '', targetEpisodeId: '', targetSceneNumber: '', targetEventId: '' });
  const [activeFilters, setActiveFilters] = useState(filters);
  const [selected, setSelected] = useState<MemoryKnowledgeRow[]>([]);
  const [scope, setScope] = useState<MemoryKnowledgeScope>('UNKNOWN');
  const [classification, setClassification] = useState<MemoryTemporalStatus>('PAST_EVENT');
  const [granted, setGranted] = useState<string[]>([]);
  const [draftGrants, setDraftGrants] = useState<KnowledgeAcquisitionInput[]>([]);
  const [acquired, setAcquired] = useState({ episodeId: '', sceneId: '', eventId: '', method: 'WITNESSED' as KnowledgeMethod });
  const [confirmed, setConfirmed] = useState(false);
  const [retry, setRetry] = useState<MemoryKnowledgeCommand[]>([]);
  const [outcomes, setOutcomes] = useState<{ chunkId: string; label: string }[]>([]);
  const [approvals, setApprovals] = useState<EntryPage<MemoryKnowledgeApprovalEntry>>();
  const [history, setHistory] = useState<{ id: string; page: EntryPage<MemoryKnowledgeReceipt> }>();
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { setConfirmed(false); }, [selected, scope, classification, granted, acquired, draftGrants]);

  async function request<T>(suffix = '', params: Record<string, string> = {}, commands?: MemoryKnowledgeCommand[]) {
    const query = new URLSearchParams({ projectId });
    for (const [key, value] of Object.entries(params)) if (value) query.set(key, value);
    const response = await fetch('/api/rag/knowledge' + suffix + '?' + query, {
      headers: { Authorization: 'Bearer ' + token, ...(commands ? { 'Content-Type': 'application/json' } : {}) },
      method: commands ? 'POST' : 'GET',
      ...(commands ? { body: JSON.stringify({ projectId, confirmed: true, commands }) } : {}),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'MEMORY_KNOWLEDGE_UNAVAILABLE');
    return payload as T;
  }

  async function run(task: () => Promise<void>) {
    setBusy(true);
    setNotice('');
    try { await task(); }
    catch (error) { setNotice(error instanceof Error ? errors[error.message] ?? error.message : '요청을 처리할 수 없습니다.'); }
    finally { setBusy(false); }
  }

  async function load(after?: string, params = filters) {
    const result = await request<MemoryKnowledgePage>('', { ...params, after: after ?? '' });
    setPage(result);
    setActiveFilters(params);
    if (!after) setTotals({ all: result.totalDocuments, active: result.activeDocuments });
    setSelected([]);
  }

  async function summarize(resume: boolean) {
    let after = resume ? summaryNext : undefined;
    let accumulated = resume ? tally : undefined;
    // Each response contains aggregate counters only. Long works can be scanned in successive bounded steps.
    for (let i = 0; i < 12; i++) {
      const result = await request<MemoryKnowledgePage>('/summary', { after: after ?? '' });
      if (!after) setTotals({ all: result.totalDocuments, active: result.activeDocuments });
      const nextTally = { ...result.tally };
      for (const key of Object.keys(nextTally) as (keyof MemoryKnowledgeTally)[]) nextTally[key] += accumulated?.[key] ?? 0;
      accumulated = nextTally;
      after = result.next;
      setTally(nextTally);
      setSummaryNext(after);
      if (!after) break;
    }
  }

  function toggle(row: MemoryKnowledgeRow) {
    if (!selected.length) {
      setScope(row.annotation?.scope ?? row.candidateScope);
      setClassification(row.annotation?.classification ?? 'PAST_EVENT');
      setGranted([]);
      setDraftGrants(row.annotation?.acquisition.map(({ characterId, method, episodeId, sceneId, eventId }) =>
        ({ characterId, method, episodeId, ...(sceneId ? { sceneId } : {}), ...(eventId ? { eventId } : {}) })) ?? []);
    }
    setSelected((existing) => existing.some((entry) => entry.chunkId === row.chunkId)
      ? existing.filter((entry) => entry.chunkId !== row.chunkId)
      : existing.length < 16 && !existing.some((entry) => entry.annotationId === row.annotationId) ? [...existing, row] : existing);
  }

  function addGrants() {
    if (!acquired.episodeId) return;
    const byCharacter = new Map(draftGrants.map((grant) => [grant.characterId, grant]));
    for (const characterId of granted) {
      if (!byCharacter.has(characterId) && byCharacter.size >= 8) break;
      byCharacter.set(characterId, {
        characterId, method: acquired.method, episodeId: acquired.episodeId,
        ...(acquired.sceneId ? { sceneId: acquired.sceneId } : {}),
        ...(acquired.eventId ? { eventId: acquired.eventId } : {}),
      });
    }
    setDraftGrants([...byCharacter.values()]);
    setGranted([]);
  }

  function makeCommands() {
    return selected.flatMap((row): MemoryKnowledgeCommand[] => row.source ? [{
      chunkId: row.chunkId, source: row.source, operationId: crypto.randomUUID(), expectedVersion: row.annotation?.version ?? 0,
      scope, classification, acquisition: scope === 'CHARACTERS' ? draftGrants : [],
    }] : []);
  }

  async function save(commands: MemoryKnowledgeCommand[]) {
    setRetry(commands);
    const { results } = await request<{ results: MemoryKnowledgeWriteResult[] }>('', {}, commands);
    const byId = new Map(results.map((item) => [item.operationId, item]));
    const updated = commands.map((command) => {
      const result = byId.get(command.operationId);
      return { chunkId: command.chunkId, label: result?.ok ? '저장 완료 · v' + result.record.version :
        errors[result?.code ?? 'TEMPORARY_FAILURE'] ?? result?.code ?? '' };
    });
    setOutcomes((existing) => [...new Map([...existing, ...updated].map((entry) => [entry.chunkId, entry])).values()]);
    setRetry(commands.filter((command) => {
      const result = byId.get(command.operationId);
      return !result || (!result.ok && result.code === 'TEMPORARY_FAILURE');
    }));
    setConfirmed(false);
    await load(undefined, activeFilters);
  }

  const options = characters.filter((character) => character.canonStatus === 'CANON' ||
    (character.canonStatus === undefined && character.status === 'confirmed'));
  const characterLabel = (id: string) => characters.find((character) => character.id === id)?.name ?? id;
  const episodeLabel = (id: string) => {
    const episode = episodes.find((row) => row.id === id);
    return episode ? '제' + episode.episodeNumber + '화 ' + episode.title : id;
  };
  const setFilter = (key: keyof typeof filters, value: string) => setFilters((state) => ({ ...state, [key]: value }));
  const reviewHistory = (id: string, after?: string) => run(async () => {
    setHistory({ id, page: await request<EntryPage<MemoryKnowledgeReceipt>>('/history', { annotationId: id, after: after ?? '' }) });
  });

  return (
    <details className="rounded-xl border border-slate-800 bg-slate-900/75 p-4 text-sm text-slate-300">
      <summary className="cursor-pointer font-semibold text-indigo-200">영구 기억 관리</summary>
      <div className="mt-3 space-y-4" aria-busy={busy}>
        <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); void run(() => load()); }}>
          <div className="flex flex-wrap items-end gap-2">
            <label>기억 상태 <select aria-label="기억 상태" className={fieldClass} value={filters.status} onChange={(e) => setFilter('status', e.target.value)}>
              <option value="">전체</option>
              {Object.entries(statuses).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            </select></label>
            <label>인물 <select aria-label="인물" className={fieldClass} value={filters.characterId} onChange={(e) => setFilter('characterId', e.target.value)}>
              <option value="">전체</option>{options.map((character) => <option key={character.id} value={character.id}>{character.name}</option>)}
            </select></label>
            <label>시작 회차 <input type="number" min={1} className={fieldClass + ' w-20'} value={filters.minEpisode}
              onChange={(e) => setFilter('minEpisode', e.target.value)} /></label>
            <label>끝 회차 <input type="number" min={1} className={fieldClass + ' w-20'} value={filters.maxEpisode}
              onChange={(e) => setFilter('maxEpisode', e.target.value)} /></label>
            <label>출처 ID <input className={fieldClass} value={filters.sourceEntityId} maxLength={128}
              onChange={(e) => setFilter('sourceEntityId', e.target.value.trim())} /></label>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <label>지식 확인 기준 회차 <select aria-label="지식 확인 기준 회차" className={fieldClass} value={filters.targetEpisodeId}
              onChange={(e) => setFilters({ ...filters, targetEpisodeId: e.target.value, targetSceneNumber: '', targetEventId: '' })}>
              <option value="">선택 안 함</option>
              {episodes.map((episode) => <option key={episode.id} value={episode.id}>{episodeLabel(episode.id)}</option>)}
            </select></label>
            {filters.targetEpisodeId && <>
              <label>장면 번호 <input min={1} type="number" className={fieldClass + ' w-20'} value={filters.targetSceneNumber}
                onChange={(e) => setFilter('targetSceneNumber', e.target.value)} /></label>
              <label>작중 기준 사건 <select aria-label="작중 기준 사건" className={fieldClass} value={filters.targetEventId}
                onChange={(e) => setFilter('targetEventId', e.target.value)}>
                <option value="">회차·장면 순서 사용</option>
                {events.filter((event) => event.canonStatus === 'CANON').map((event) => <option key={event.id} value={event.id}>{event.title}</option>)}
              </select></label>
            </>}
            <button className={buttonClass} disabled={busy}>기억 조회</button>
            <button type="button" className={buttonClass} disabled={busy} onClick={() => void run(() => summarize(Boolean(summaryNext)))}>
              {summaryNext ? '이어서 집계' : '문서 현황 집계'}
            </button>
            <button type="button" className={buttonClass} disabled={busy}
              onClick={() => void run(async () => setApprovals(await request('/approvals')))}>승인 기록 조회</button>
          </div>
        </form>

        {totals.all !== undefined && <p className="text-xs text-slate-400">전체 {totals.all}문서 · 활성 {totals.active ?? 0}문서</p>}
        {tally && <div className="text-xs text-slate-400">
          <p>{summaryNext ? '현재까지 집계한 문서' : '프로젝트 문서 집계 완료'} · 한 문서가 여러 상태에 포함될 수 있습니다.</p>
          <ul className="flex flex-wrap gap-x-4">
            {(Object.entries(tally) as [keyof MemoryKnowledgeTally, number][]).map(([key, count]) =>
              <li key={key}>{tallyLabels[key]} {count}</li>)}
          </ul>
        </div>}

        {page && <>
          <div className="flex gap-2 flex-wrap">
            {MEMORY_KNOWLEDGE_SCOPES.map((key) => <button type="button" key={key} disabled={busy} className={buttonClass}
              onClick={() => {
                setScope(key);
                setGranted([]);
                setDraftGrants([]);
                setSelected(page.rows.filter((row) => row.source && row.candidateScope === key && !row.annotation)
                  .filter((row, index, rows) => rows.findIndex((other) => other.annotationId === row.annotationId) === index).slice(0, 16));
              }}>{scopes[key]} 후보 선택</button>)}
          </div>
          {page.rows.length === 0 && <p>이 페이지에 필터와 일치하는 기억이 없습니다.</p>}
          <ul className="space-y-2">
            {page.rows.map((row) => <li key={row.chunkId} className="rounded border border-slate-800 p-2">
              <div className="flex flex-wrap items-center gap-2">
                <label className="font-semibold">
                  <input type="checkbox" className="mr-2" disabled={!row.source || busy} checked={selected.some((entry) => entry.chunkId === row.chunkId)}
                    onChange={() => toggle(row)} />{row.title}
                </label>
                <span>{row.episodeNumber ? '제' + row.episodeNumber + '화' : '회차 없음'} · {statuses[row.status]}</span>
                {row.annotationId && row.annotation && <button type="button" className={buttonClass}
                  onClick={() => void reviewHistory(row.annotationId!)} disabled={busy}>이 출처의 승인 이력</button>}
                <button type="button" className={buttonClass} disabled={busy} onClick={() => {
                  const params = { ...filters, sourceEntityId: row.sourceEntityId };
                  setFilters(params);
                  void run(() => load(undefined, params));
                }}>같은 출처 보기</button>
              </div>
              <p className="break-all text-xs text-slate-400">{row.sourceEntityType} · {row.sourceEntityId} · Revision {row.sourceRevisionId}</p>
              {row.excerpt && <blockquote className="my-1 whitespace-pre-wrap border-l-2 border-indigo-500/50 pl-2">{row.excerpt}</blockquote>}
              <p className="text-xs">관련 {row.characterIds.map(characterLabel).join(', ') || '인물 미지정'} · {scopes[row.annotation?.scope ?? row.candidateScope]}
                {' · '}{row.knownAtTarget === true ? '이 장면에서 알고 있음' : row.knownAtTarget === false ? '이 장면에서 사용 불가'
                  : row.writerEligible ? '장면 조건에 따라 집필 후보' : '현재 집필 사용 불가'}</p>
              <p className="text-xs text-slate-400">{row.candidateReason === 'AUTHOR_METADATA' ? '분류 근거 · 기존 작가 설정'
                : row.candidateReason === 'DIRECT_QUOTE_REVIEW' ? '분류 근거 · 원문에 인용 표시가 있습니다. 실제 발언자와 청자를 확인하세요.'
                : row.candidateReason === 'SOURCE_EXCERPT' ? '분류 근거 · 검증된 원문, 공개 여부 검토 필요' : '분류 근거 · 원문 미검증'}
                {row.reason && ' · ' + (errors[row.reason] ?? row.reason)}</p>
              {row.annotation?.acquisition.map((grant) => <p key={grant.characterId} className="text-xs text-slate-400">
                {characterLabel(grant.characterId)} · {episodeLabel(grant.position.episodeId)}
                {grant.position.sceneNumber && ' · 장면 ' + grant.position.sceneNumber}{grant.position.eventId && ' · ' + grant.position.eventId} · {methods[grant.method]}
              </p>)}
            </li>)}
          </ul>
          {page.next && <button type="button" className={buttonClass} disabled={busy} onClick={() => void run(() => load(page.next, activeFilters))}>다음 페이지</button>}
        </>}

        {selected.length > 0 && <section className="space-y-2 rounded border border-indigo-500/35 p-3">
          <h3 className="font-semibold">선택한 원문 {selected.length}건</h3>
          <label className="mr-2">지식 범위 <select aria-label="지식 범위" className={fieldClass} value={scope} onChange={(e) => setScope(e.target.value as MemoryKnowledgeScope)}>
            {Object.entries(scopes).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </select></label>
          <label>시간 분류 <select aria-label="시간 분류" className={fieldClass} value={classification} onChange={(e) => setClassification(e.target.value as MemoryTemporalStatus)}>
            {Object.entries(classifications).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </select></label>
          {scope === 'CHARACTERS' && <fieldset className="space-y-2">
            <legend>동일 획득 근거를 적용할 인물 (최대 8명)</legend>
            <div className="flex flex-wrap gap-2">{options.map((character) => <label key={character.id}>
              <input type="checkbox" className="mr-1" checked={granted.includes(character.id)}
                disabled={granted.length >= 8 && !granted.includes(character.id)}
                onChange={() => setGranted((ids) => ids.includes(character.id) ? ids.filter((id) => id !== character.id) : [...ids, character.id])} />{character.name}
            </label>)}</div>
            <div className="flex flex-wrap gap-2">
              <label>획득 회차 <select aria-label="획득 회차" className={fieldClass} value={acquired.episodeId} onChange={(e) => setAcquired({ ...acquired, episodeId: e.target.value, sceneId: '', eventId: '' })}>
                <option value="">선택</option>{episodes.map((episode) => <option key={episode.id} value={episode.id}>{episodeLabel(episode.id)}</option>)}
              </select></label>
              <label>확정 장면 <select aria-label="확정 장면" className={fieldClass} value={acquired.sceneId} onChange={(e) => setAcquired({ ...acquired, sceneId: e.target.value, eventId: '' })}>
                <option value="">해당 없음</option>{scenes.filter((scene) => scene.episodeId === acquired.episodeId && scene.canonStatus === 'CANON')
                  .map((scene) => <option key={scene.id} value={scene.id}>{scene.sceneNumber}. {scene.title}</option>)}
              </select></label>
              <label>획득 사건 <select aria-label="획득 사건" className={fieldClass} value={acquired.eventId} onChange={(e) => setAcquired({ ...acquired, eventId: e.target.value })}>
                <option value="">해당 없음</option>{events.filter((event) => event.episodeId === acquired.episodeId && event.canonStatus === 'CANON' &&
                  (!acquired.sceneId || event.sceneId === acquired.sceneId)).map((event) => <option key={event.id} value={event.id}>{event.title}</option>)}
              </select></label>
              <label>획득 경로 <select aria-label="획득 경로" className={fieldClass} value={acquired.method} onChange={(e) => setAcquired({ ...acquired, method: e.target.value as KnowledgeMethod })}>
                {KNOWLEDGE_METHODS.map((key) => <option key={key} value={key}>{methods[key]}</option>)}
              </select></label>
            </div>
            <button type="button" className={buttonClass} disabled={busy || !granted.length || !acquired.episodeId} onClick={addGrants}>선택한 인물의 획득 근거 추가</button>
            <ul className="space-y-1 text-xs">
              {draftGrants.map((grant) => <li key={grant.characterId}>
                {characterLabel(grant.characterId)} · {episodeLabel(grant.episodeId)}
                {grant.sceneId && ' · ' + (scenes.find((scene) => scene.id === grant.sceneId)?.title ?? grant.sceneId)}
                {grant.eventId && ' · ' + (events.find((event) => event.id === grant.eventId)?.title ?? grant.eventId)}
                {' · '}{methods[grant.method]}{' '}
                <button type="button" className="text-amber-300" onClick={() => setDraftGrants((entries) =>
                  entries.filter((entry) => entry.characterId !== grant.characterId))}>제거</button>
              </li>)}
            </ul>
          </fieldset>}
          <details><summary className="cursor-pointer">저장 대상 원문 범위</summary>
            <ul>{selected.map((entry) => <li key={entry.chunkId}>{entry.title} · {entry.sourceRevisionId} · {entry.source?.sourceStartOffset}–{entry.source?.sourceEndOffset} · 현재 v{entry.annotation?.version ?? 0}</li>)}</ul>
          </details>
          <label className="block"><input type="checkbox" className="mr-2" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
            선택한 원문 범위와 {scopes[scope]} 변경을 작가가 확인했습니다.</label>
          <button type="button" className={buttonClass} disabled={busy || !confirmed || retry.length > 0 || (scope === 'CHARACTERS' && (!draftGrants.length || granted.length > 0))}
            onClick={() => void run(() => save(makeCommands()))}>선택한 기억 승인 저장</button>
          <button type="button" className="ml-2 text-slate-400" disabled={busy} onClick={() => setSelected([])}>선택 보류</button>
        </section>}

        {outcomes.length > 0 && <ul className="space-y-1 text-xs" aria-live="polite">
          {outcomes.map(({ chunkId, label }) => <li key={chunkId}>{chunkId} · {label}</li>)}
        </ul>}
        {retry.length > 0 && <button className={buttonClass} disabled={busy} onClick={() => void run(() => save(retry))}>
          결과 미확인 {retry.length}건 같은 요청으로 재시도
        </button>}

        {approvals && <section className="space-y-2">
          <h3 className="font-semibold">저장된 승인 기록</h3>
          {!approvals.entries.length && <p>저장된 기록이 없습니다.</p>}
          {approvals.entries.map(({ record, status }) => <p key={record.id} className="text-xs">
            {record.source.sourceEntityId} · {record.source.sourceRevisionId} · v{record.version} · {scopes[record.scope]} · {statuses[status]}{' '}
            <button type="button" className={buttonClass} disabled={busy} onClick={() => void reviewHistory(record.id)}>이력</button>
          </p>)}
          {approvals.next && <button type="button" className={buttonClass} disabled={busy}
            onClick={() => void run(async () => setApprovals(await request('/approvals', { after: approvals.next ?? '' })))}>다음 승인 기록</button>}
        </section>}
        {history && <section className="space-y-2">
          <h3 className="font-semibold">승인 변경 이력</h3>
          {history.page.entries.map(({ id, previous, record }) => <p key={id} className="text-xs">
            v{record.version} · {previous ? scopes[previous.scope] + ' → ' : ''}{scopes[record.scope]} · {new Date(record.updatedAt).toLocaleString('ko-KR')}
          </p>)}
          {history.page.next && <button type="button" className={buttonClass} disabled={busy}
            onClick={() => void reviewHistory(history.id, history.page.next)}>다음 변경 이력</button>}
        </section>}
        {notice && <p role="status" className="text-amber-300">{notice}</p>}
      </div>
    </details>
  );
}
