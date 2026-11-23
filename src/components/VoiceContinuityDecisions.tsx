import { useEffect, useState, useRef, useCallback, type ReactNode } from 'react';
import type { ContinuityFinding, ContinuitySceneKind, StyleContinuityReport } from '../types/styleContinuity';
import type { AuthorContinuityDecision, VoiceContinuityDecisionRecord, VoiceContinuityIdentity, VoiceDecisionAuditPage, VoiceDecisionCommand, VoiceDecisionPage, VoiceDecisionSaveResult, VoiceDecisionScope } from '../types/voiceContinuityDecision';
import { clearVoiceDecisionDraft, commitLocalVoiceDecision, legacyMatchesSources, listLegacyVoiceDecisions, listLocalVoiceAudits, listLocalVoiceDecisions, readVoiceDecisionDraft, writeVoiceDecisionDraft, type LegacyVoiceDecision } from '../services/voiceContinuityLocal';
import { isReviewableContinuityFinding, matchesVoiceDecision, normalizeDecisionCommand, selectVoiceDecisionOperation } from '../utils/voiceContinuityDecisionLogic';
import { generateEntityId } from '../utils/novelLogic';

export interface DecisionAnalysisInput {
  episodeId: string;
  revisionId: string;
  contentHash: string;
  sceneKind?: ContinuitySceneKind;
  assignments?: Record<string, string>;
}

interface Props {
  scope: VoiceDecisionScope;
  cloud: boolean;
  getIdToken: () => Promise<string | null>;
  report: StyleContinuityReport | null;
  inputs: DecisionAnalysisInput[];
  cohortStale: boolean;
  sourceStale: (record: Pick<VoiceContinuityIdentity, 'beforeRevisionId' | 'beforeContentHash' | 'afterRevisionId' | 'afterContentHash'>) => boolean;
  renderFindingActions: (finding: ContinuityFinding) => ReactNode;
}

const label: Record<AuthorContinuityDecision, string> = {
  INTENDED_VARIATION: '의도한 변화로 승인', REVIEW_REQUIRED: '추가 검토',
};
const analysisLabel = {
  CONSISTENT: '일관성 확인', INTENTIONAL_VARIATION: '의도적 변화 후보', POTENTIAL_DRIFT: '추가 검토 후보', INSUFFICIENT_EVIDENCE: '근거 부족',
};
const button = 'rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-200 hover:border-amber-500 disabled:opacity-40';
const control = 'rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100';

class DecisionHttpError extends Error {
  constructor(message: string, readonly code?: string) { super(message); }
}

function mergeRecords(existing: Record<string, VoiceContinuityDecisionRecord>, incoming: VoiceContinuityDecisionRecord[]) {
  const merged = { ...existing };
  for (const record of incoming) {
    if (!merged[record.id] || record.version >= merged[record.id].version) merged[record.id] = record;
  }
  return merged;
}

export function VoiceContinuityDecisions({ scope, cloud, getIdToken, report, inputs, cohortStale, sourceStale, renderFindingActions }: Props) {
  const { ownerId, projectId, characterId } = scope;
  const [byId, setById] = useState<Record<string, VoiceContinuityDecisionRecord>>({});
  const [legacy, setLegacy] = useState<LegacyVoiceDecision[]>([]);
  const [next, setNext] = useState<string>();
  const [error, setError] = useState('');
  const [loadedReport, setLoadedReport] = useState<StyleContinuityReport | null>(null);
  const [history, setHistory] = useState<{ id: string; page: VoiceDecisionAuditPage }>();
  const [loading, setLoading] = useState(false);
  const exactLoaded = report !== null && loadedReport === report;

  const request = useCallback(async <T,>(query?: Record<string, string>, payload?: { command: VoiceDecisionCommand; inputs: DecisionAnalysisInput[] }): Promise<T> => {
    const token = await getIdToken();
    if (!token) throw new Error('Firebase 로그인을 다시 확인해 주세요.');
    const queryString = new URLSearchParams({ projectId, characterId, ...query }).toString();
    const response = await fetch(`/api/voice-continuity/decisions${payload ? '' : '?' + queryString}`, {
      method: payload ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${token}`, ...(payload ? { 'Content-Type': 'application/json' } : {}) },
      body: payload ? JSON.stringify({ projectId, characterId, ...payload }) : undefined,
    });
    const data = await response.json();
    if (!response.ok) throw new DecisionHttpError(data.error ?? '판단 기록 요청 실패', data.code);
    return data as T;
  }, [getIdToken, projectId, characterId]);

  const list = useCallback(async (after?: string) => {
    if (cloud) return request<VoiceDecisionPage>(after ? { after } : {});
    return { records: listLocalVoiceDecisions(localStorage, { ownerId, projectId, characterId }), next: undefined };
  }, [cloud, request, ownerId, projectId, characterId]);

  const loadExact = useCallback(async (ids: string[]) => {
    if (!ids.length) return [];
    if (!cloud) return listLocalVoiceDecisions(localStorage, { ownerId, projectId, characterId }).filter((record) => ids.includes(record.id));
    const batches: string[][] = [];
    for (let i = 0; i < ids.length; i += 20) batches.push(ids.slice(i, i + 20));
    return (await Promise.all(batches.map((batch) => request<VoiceDecisionPage>({ ids: batch.join(',') })))).flatMap((page) => page.records);
  }, [cloud, request, ownerId, projectId, characterId]);

  useEffect(() => {
    let active = true;
    void list().then((page) => {
      if (!active) return;
      setById((state) => mergeRecords(state, page.records));
      setNext(page.next);
    }).catch((caught: Error) => { if (active) setError(caught.message); });
    try { setLegacy(listLegacyVoiceDecisions(localStorage, { ownerId, projectId, characterId }, cloud)); }
    catch (caught) { setError(caught instanceof Error ? caught.message : '브라우저 기록 조회 실패'); }
    return () => { active = false; };
  }, [list, ownerId, projectId, characterId, cloud]);

  useEffect(() => {
    if (!report) return;
    let active = true;
    const ids = report.findings.flatMap((finding) => finding.decisionIdentity ? [finding.decisionIdentity.id] : []);
    void loadExact(ids).then((records) => {
      if (!active) return;
      setById((state) => mergeRecords(state, records));
      setLoadedReport(report);
    }).catch((caught: Error) => { if (active) setError(caught.message); });
    return () => { active = false; };
  }, [report, loadExact]);

  async function store(identity: VoiceContinuityIdentity, command: VoiceDecisionCommand) {
    if (cohortStale) throw new DecisionHttpError('STALE_SOURCE', 'STALE_SOURCE');
    const commit = () => commitLocalVoiceDecision(localStorage, identity, command);
    const response = cloud ? await request<VoiceDecisionSaveResult>(undefined, { command, inputs })
      : await (navigator.locks ? navigator.locks.request(`novel-forge-voice-decisions:${ownerId}:${projectId}:${characterId}`, commit) : commit());
    setById((state) => mergeRecords(state, [response.record]));
    return response;
  }

  async function refresh(id: string) {
    const records = await loadExact([id]);
    setById((state) => mergeRecords(state, records));
    return records[0];
  }

  async function showHistory(id: string, after?: string) {
    setLoading(true);
    setError('');
    try {
      const page = cloud ? await request<VoiceDecisionAuditPage>({ historyFor: id, ...(after ? { after } : {}) })
        : { entries: listLocalVoiceAudits(localStorage, scope, id) };
      setHistory((previous) => ({ id, page: {
        ...page, entries: after && previous?.id === id ? [...previous.page.entries, ...page.entries] : page.entries,
      } }));
    } catch (caught) { setError(caught instanceof Error ? caught.message : '변경 이력 조회 실패'); }
    finally { setLoading(false); }
  }

  const currentIdentities = new Map(report?.findings.flatMap((finding) => finding.decisionIdentity ? [[finding.decisionIdentity.id, finding.decisionIdentity] as const] : []) || []);
  return <div className="space-y-2">
    {error && <p role="alert" className="text-sm text-rose-300">{error}</p>}
    {report?.findings.map((finding) => {
      const identity = finding.decisionIdentity;
      if (!identity) return null;
      const candidate = byId[identity.id];
      const record = candidate && matchesVoiceDecision(candidate, identity) ? candidate : undefined;
      const previous = legacy.find((entry) => legacyMatchesSources(entry, identity));
      return <article key={identity.id} className="space-y-1 border-t border-slate-800 pt-2 text-xs">
        <p>{identity.beforeRevisionId} → {identity.afterRevisionId} · {finding.dimension} · {analysisLabel[finding.status]} · 신뢰도 {finding.confidence}</p>
        <p className="text-slate-400">{finding.description}</p>
        {cohortStale ? <p>STALE_SOURCE · 현재 분석을 다시 실행해 주세요.</p>
          : isReviewableContinuityFinding(finding.status) && exactLoaded
            ? <DecisionEditor identity={identity} record={record} legacy={previous} cloud={cloud}
                onSave={(command) => store(identity, command)} onReload={() => refresh(identity.id)} />
            : !exactLoaded && <button className={button} onClick={() => void loadExact([...currentIdentities.keys()]).then((records) => {
                setById((state) => mergeRecords(state, records)); setLoadedReport(report);
              }).catch((caught: Error) => setError(caught.message))}>저장된 판단 새로 불러오기</button>}
        {!cohortStale && isReviewableContinuityFinding(finding.status) && renderFindingActions(finding)}
      </article>;
    })}
    <details className="rounded-lg border border-slate-800 p-3">
      <summary>작가 판단 기록 · {cloud ? 'Firebase' : '이 브라우저'}</summary>
      <p className="my-2 text-xs text-slate-400">{cloud ? '계정의 저장 기록을 불러옵니다.' : '로컬 기록은 기기 간 동기화되지 않습니다.'}</p>
      {Object.values(byId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((record) => {
        const identity = currentIdentities.get(record.id);
        const status = sourceStale(record) ? 'STALE_SOURCE' :
          identity && !cohortStale && matchesVoiceDecision(record, identity) ? (cloud ? 'VERIFIED_CLOUD' : 'LOCAL') : 'REQUIRES_REVIEW';
        return <div key={record.id} className="my-2 space-y-1 text-xs">
          <p>{record.beforeRevisionId} → {record.afterRevisionId} · {record.dimension} · {label[record.decision]} · v{record.version} · {status}</p>
          {record.authorNote && <p className="whitespace-pre-wrap text-slate-400">{record.authorNote}</p>}
          <button className={button} disabled={loading} onClick={() => void showHistory(record.id)}>변경 이력 보기 · v{record.version}</button>
        </div>;
      })}
      {next && <button className={button} disabled={loading} onClick={() => {
        setLoading(true);
        void list(next).then((page) => { setById((state) => mergeRecords(state, page.records)); setNext(page.next); })
          .catch((caught: Error) => setError(caught.message)).finally(() => setLoading(false));
      }}>이전 판단 더 보기</button>}
      {legacy.map((entry) => <p key={entry.key} className="my-2 text-xs text-slate-400">
        {entry.beforeRevisionId} → {entry.afterRevisionId} · {entry.dimension} · {entry.value === 'intent' ? label.INTENDED_VARIATION : label.REVIEW_REQUIRED} · LEGACY_LOCAL · {sourceStale(entry) ? 'STALE_SOURCE' : 'REQUIRES_REVIEW'}
      </p>)}
      {history && <div className="mt-3 space-y-1 border-t border-slate-800 pt-2 text-xs" aria-label="판단 변경 이력">
        {[...history.page.entries].sort((a, b) => b.record.version - a.record.version).map((entry) => <p key={entry.id}>
          v{entry.record.version} · {entry.record.updatedAt} · {entry.ownerId} · {entry.previousDecision ? label[entry.previousDecision] : '첫 기록'} → {label[entry.record.decision]}{entry.reconfirmLegacy && ' · 기존 기록 재확인'}
          {entry.record.authorNote && <span className="ml-2 whitespace-pre-wrap text-slate-400">{entry.record.authorNote}</span>}
        </p>)}
        {history.page.next && <button className={button} disabled={loading} onClick={() => void showHistory(history.id, history.page.next)}>변경 이력 더 보기</button>}
      </div>}
    </details>
  </div>;
}

function DecisionEditor({ identity, record, legacy, cloud, onSave, onReload }: {
  identity: VoiceContinuityIdentity;
  record?: VoiceContinuityDecisionRecord;
  legacy?: LegacyVoiceDecision;
  cloud: boolean;
  onSave: (command: VoiceDecisionCommand) => Promise<VoiceDecisionSaveResult>;
  onReload: () => Promise<VoiceContinuityDecisionRecord | undefined>;
}) {
  const [draft, setDraft] = useState(() => {
    try { return readVoiceDecisionDraft(localStorage, identity, identity.id, cloud); } catch { return undefined; }
  });
  const [pending, setPending] = useState(draft);
  const [status, setStatus] = useState(draft ? '저장 응답 확인 필요 · 같은 작업을 재시도할 수 있습니다.' : '');
  const [saving, setSaving] = useState(false);
  const lock = useRef(false);

  function choose(decision: AuthorContinuityDecision, reconfirmLegacy = false) {
    setDraft({ decisionId: identity.id, dimension: identity.dimension, operationId: '', decision, reconfirmLegacy,
      authorNote: draft?.authorNote ?? record?.authorNote ?? '', expectedVersion: draft?.expectedVersion ?? record?.version ?? 0 });
  }

  async function save() {
    if (!draft || lock.current) return;
    lock.current = true;
    setSaving(true);
    let command: VoiceDecisionCommand | undefined;
    try {
      const note = draft.authorNote.trim().normalize('NFC').replace(/\r\n?/g, '\n');
      command = normalizeDecisionCommand(selectVoiceDecisionOperation({ ...draft, authorNote: note }, pending, () => globalThis.crypto?.randomUUID?.() ?? generateEntityId('vcd_operation')));
      writeVoiceDecisionDraft(localStorage, identity, command, cloud);
      setPending(command);
      const saved = await onSave(command);
      clearVoiceDecisionDraft(localStorage, identity, command, cloud);
      setPending(undefined);
      setDraft(undefined);
      setStatus(`${cloud ? 'Firebase 동기화 완료' : '이 브라우저에 저장 완료'} · v${saved.record.version}${saved.status === 'ALREADY_APPLIED' ? ' · 이전 커밋 확인' : ''}`);
    } catch (caught) {
      const code = typeof caught === 'object' && caught && 'code' in caught ? caught.code : undefined;
      if (command && (code === 'VERSION_CONFLICT' || code === 'OPERATION_CONFLICT' || code === 'STALE_SOURCE')) {
        clearVoiceDecisionDraft(localStorage, identity, command, cloud);
        setPending(undefined);
      }
      const message = caught instanceof Error ? caught.message : '저장 응답을 확인하지 못했습니다.';
      setStatus(code === 'VERSION_CONFLICT' ? 'VERSION_CONFLICT · 다른 기기에서 수정했습니다. 선택을 유지한 채 최신 판단을 불러오세요.'
        : command && !code ? `${message} · 저장 응답 확인 필요. 같은 작업으로 다시 시도할 수 있습니다.` : message);
    } finally { lock.current = false; setSaving(false); }
  }

  async function reload() {
    if (lock.current) return;
    lock.current = true;
    setSaving(true);
    try {
      const latest = await onReload();
      setDraft((current) => current ? { ...current, expectedVersion: latest?.version ?? 0 } : current);
      setStatus('최신 판단을 불러왔습니다. 편집 내용은 유지했습니다.');
    } catch (caught) { setStatus(caught instanceof Error ? caught.message : '최신 판단 조회 실패'); }
    finally { lock.current = false; setSaving(false); }
  }

  return <div className="space-y-2 text-xs">
    <p>작가 판단 {record ? `${label[record.decision]} · v${record.version} · ${cloud ? 'Firebase' : '이 브라우저'}` : '아직 없음'}</p>
    <div className="flex flex-wrap gap-2">
      <button className={button} disabled={saving} onClick={() => choose('INTENDED_VARIATION')}>{label.INTENDED_VARIATION}</button>
      <button className={button} disabled={saving} onClick={() => choose('REVIEW_REQUIRED')}>{label.REVIEW_REQUIRED}</button>
      <button className={button} disabled={saving} onClick={() => void reload()}>최신 판단 불러오기</button>
    </div>
    {legacy && !record && <div>
      <p>LEGACY_LOCAL · 같은 Revision 해시의 이전 기록입니다. 현재 조건에서 다시 검토한 뒤 저장할 수 있습니다.</p>
      <button className={button} disabled={saving} onClick={() => choose(legacy.value === 'intent' ? 'INTENDED_VARIATION' : 'REVIEW_REQUIRED', true)}>이전 판단을 검토용으로 가져오기</button>
    </div>}
    {draft && <div className="flex flex-wrap items-center gap-2">
      <span>편집 중 · {label[draft.decision]}</span>
      <input className={control} aria-label={`${identity.dimension} 판단 메모`} maxLength={1000} value={draft.authorNote} disabled={saving}
        onChange={(event) => setDraft({ ...draft, authorNote: event.target.value })} />
      <button className={button} disabled={saving || (!pending && !draft.reconfirmLegacy && record?.decision === draft.decision && record.authorNote === draft.authorNote.trim())}
        onClick={() => void save()}>{saving ? '저장 확인 중…' : '판단 저장'}</button>
    </div>}
    {status && <p role="status" className="text-slate-300">{status}</p>}
  </div>;
}
