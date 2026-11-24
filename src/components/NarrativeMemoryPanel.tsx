import { useEffect, useState } from 'react';
import type { Character } from '../types/novel';
import type { MemoryKnowledgePage, MemoryKnowledgeRow } from '../types/memoryKnowledge';
import { CHARACTER_STATE_AXES, NARRATIVE_NODES, NARRATIVE_RELATIONS, type NarrativeDecision,
  type NarrativeDerivedPreview, type NarrativeLinkCommand, type NarrativeLinkPage, type NarrativeMemoryLink,
  type NarrativeNode, type NarrativeRelation, type NarrativeState, type NarrativeVisibility } from '../types/narrativeMemory';

export const relationLabels: Record<NarrativeRelation, string> = {
  CAUSES: '원인', LEADS_TO: '사건 순서', PARTICIPATED_IN: '참여', WITNESSED: '목격', LEARNED_FROM: '지식 획득',
  CHANGES_RELATIONSHIP: '관계 변화', CHANGES_CHARACTER_STATE: '인물 상태 변화', PLANTS_FORESHADOWING: '복선 설치',
  REINFORCES_FORESHADOWING: '복선 강화', RESOLVES_FORESHADOWING: '복선 회수',
  CONTRADICTS: '모순', SUPPORTS: '뒷받침', RELATED_TO: '관련',
};
const labels: Record<string, string> = {
  TIMELINE_EVENT: '연표 사건', EPISODE: '회차', SCENE: '장면', CHARACTER: '인물', RELATIONSHIP: '관계',
  FORESHADOWING: '복선', WORLDBUILDING: '세계관', CANON: '정사',
  AUTHOR_CONFIRMED: '작가 승인', EXPLICITLY_VERIFIED: '기존 정사 연결', CANDIDATE: '작가 검토 후보',
  REJECTED: '거절', CONFLICTED: '충돌', STALE: '근거 변경', UNRESOLVED: '미회수',
  PLANTED: '설치', REINFORCED: '강화', RESOLVED: '회수 완료', ABANDONED: '회수 포기', PLANNED_RESOLUTION: '회수 계획', FUTURE_PLOT_PLAN: '작가용 계획',
  HEALTH: '신체·건강', IDENTITY: '신분', AFFILIATION: '소속', ABILITY: '능력', POSSESSION: '보유품', SURVIVAL: '생존', GOAL: '목표·신념', EMOTION: '감정',
  INVALID_LINK: '서로 다른 두 출처와 그에 맞는 근거를 선택하세요.', STALE_LINK: '근거나 색인이 바뀌었습니다. 출처를 다시 조회하세요.',
  CAUSAL_EVIDENCE_MISSING: '명시된 인과 근거와 올바른 연표 순서가 필요합니다.',
  VERSION_CONFLICT: '다른 기기에서 변경했습니다. 최신 기록을 조회하세요.', OPERATION_CONFLICT: '이 요청 ID는 다른 내용에 사용됐습니다.',
  FORBIDDEN: '이 작품에 접근할 수 없습니다.', DELETED_NODE: '해당 출처를 찾을 수 없습니다.', BAD_REQUEST: '선택한 연결과 근거를 확인하세요.',
};
const field = 'rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-slate-100';
const button = 'rounded border border-indigo-500/40 bg-indigo-500/15 px-2 py-1.5 text-indigo-200 disabled:opacity-40';
const emptyNode: NarrativeNode = { type: 'TIMELINE_EVENT', id: '' };
type Side = 'from' | 'to';
type ProofPage = { node: NarrativeNode; rows: MemoryKnowledgeRow[]; next?: string };
type History = { entries: NarrativeDecision[]; next?: string };

export function NarrativeMemoryPanel({ projectId, token, characters, focus }: {
  projectId: string; token: string; characters: Character[]; focus?: NarrativeNode;
}) {
  const [filter, setFilter] = useState<NarrativeNode>(focus ?? emptyNode);
  const [page, setPage] = useState<NarrativeLinkPage>();
  const [derived, setDerived] = useState<NarrativeDerivedPreview>();
  const [history, setHistory] = useState<{ id: string; page: History }>();
  const [editing, setEditing] = useState<NarrativeMemoryLink>();
  const [nodes, setNodes] = useState({ from: focus ?? emptyNode, to: emptyNode });
  const [relation, setRelation] = useState<NarrativeRelation>('RELATED_TO');
  const [visibility, setVisibility] = useState<NarrativeVisibility>('AUTHOR_ONLY');
  const [state, setState] = useState<NarrativeState>({ characterId: '', axis: 'HEALTH' });
  const [candidates, setCandidates] = useState<Partial<Record<Side, ProofPage>>>({});
  const [proof, setProof] = useState<Partial<Record<Side, MemoryKnowledgeRow>>>({});
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState<NarrativeLinkCommand>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  useEffect(() => { setConfirmed(false); }, [nodes, proof, relation, visibility, state]);

  async function request<T>(route: string, params: Record<string, string> = {}, command?: NarrativeLinkCommand): Promise<T> {
    const qs = new URLSearchParams({ projectId });
    for (const [key, value] of Object.entries(params)) if (value) qs.set(key, value);
    const reply = await fetch(route + '?' + qs, { method: command ? 'POST' : 'GET',
      headers: { Authorization: 'Bearer ' + token, ...(command ? { 'Content-Type': 'application/json' } : {}) },
      ...(command ? { body: JSON.stringify(command) } : {}) });
    const body = await reply.json();
    if (!reply.ok) throw new Error(body.error ?? 'NARRATIVE_MEMORY_UNAVAILABLE');
    return body as T;
  }

  async function run(action: () => Promise<void>) {
    setBusy(true); setNotice('');
    try { await action(); }
    catch (error) { setNotice(error instanceof Error ? labels[error.message] ?? error.message : '요청을 처리할 수 없습니다.'); }
    finally { setBusy(false); }
  }

  async function load(after?: string) {
    const params: Record<string, string> = filter.id ? { nodeId: filter.id, nodeType: filter.type } : {};
    setPage(await request('/api/rag/narrative', { ...params, after: after ?? '' }));
    if (!after) setDerived(filter.id ? await request('/api/rag/narrative/preview', params) : undefined);
  }
  async function lookup(side: Side, after?: string) {
    const node = nodes[side];
    const result = await request<MemoryKnowledgePage>('/api/rag/knowledge', { sourceEntityId: node.id, after: after ?? '' });
    setCandidates((all) => ({ ...all, [side]: { node, rows: result.rows.filter((row) => row.source && row.source.sourceEntityType === node.type), next: result.next } }));
  }
  function start(from: NarrativeNode, to: NarrativeNode, kind: NarrativeRelation, stored?: NarrativeMemoryLink) {
    setEditing(stored); setNodes({ from, to }); setRelation(kind); setVisibility(stored?.visibility ?? 'AUTHOR_ONLY');
    setState(stored?.state ?? { characterId: '', axis: 'HEALTH' }); setProof({}); setCandidates({}); setPending(undefined);
  }
  function setNode(side: Side, node: NarrativeNode) {
    setNodes((all) => ({ ...all, [side]: node }));
    setProof((previous) => ({ ...previous, [side]: undefined }));
    setCandidates((previous) => ({ ...previous, [side]: undefined }));
  }
  async function save(command: NarrativeLinkCommand) {
    setPending(command);
    let saved: NarrativeMemoryLink;
    try { saved = await request('/api/rag/narrative', {}, command); }
    catch (error) {
      if (error instanceof Error && labels[error.message]) setPending(undefined);
      throw error;
    }
    setPending(undefined); setEditing(saved); setConfirmed(false);
    await load();
    setNotice(labels[saved.status] + ' · v' + saved.version);
  }
  function submit(status: NarrativeLinkCommand['status']) {
    const chosen = status === 'REJECTED' && editing ? editing.evidence : (['from', 'to'] as const).flatMap((side) =>
      proof[side]?.source ? [{ chunkId: proof[side]!.chunkId, source: proof[side]!.source! }] : []);
    if (chosen.length !== 2 || !confirmed) return;
    const command: NarrativeLinkCommand = {
      projectId, from: nodes.from, to: nodes.to, relation, visibility, status, evidence: [chosen[0], chosen[1]],
      ...(relation === 'CHANGES_CHARACTER_STATE' ? { state } : {}), operationId: crypto.randomUUID(), confirmed: true,
      expectedVersion: editing?.version ?? 0,
    };
    void run(() => save(command));
  }
  const getHistory = (id: string, after?: string) => run(async () =>
    setHistory({ id, page: await request('/api/rag/narrative/history', { linkId: id, after: after ?? '' }) }));
  const locked = Boolean(editing) || busy || Boolean(pending);
  const ready = confirmed && !busy && !pending && (relation !== 'CHANGES_CHARACTER_STATE' || state.characterId) &&
    Boolean(proof.from?.source && proof.to?.source);

  return <details open={focus ? true : undefined} className="space-y-3 rounded-xl border border-slate-800 bg-slate-900/75 p-4 text-sm text-slate-300">
    <summary className="cursor-pointer font-semibold text-indigo-200">서사 기억 연결</summary>
    <div className="mt-3 space-y-4">
      <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); void run(() => load()); }}>
        <select aria-label="조회할 출처 유형" className={field} value={filter.type} onChange={(e) => setFilter({ ...filter, type: e.target.value as NarrativeNode['type'] })}>
          {NARRATIVE_NODES.map((key) => <option key={key} value={key}>{labels[key]}</option>)}
        </select>
        <input aria-label="조회할 출처 ID" placeholder="출처 ID (비워두면 전체)" className={field} value={filter.id}
          onChange={(e) => setFilter({ ...filter, id: e.target.value.trim() })} />
        <button className={button} disabled={busy}>연결 조회</button>
      </form>
      {derived && <section className="space-y-1">
        <h3 className="font-semibold">기존 엔티티에서 확인한 연결</h3>
        {derived.entries.length === 0 && <p>표시할 연결이 없습니다.</p>}
        {derived.entries.map(({ edge, titles, orders, clueStatus }) => <p key={edge.id} className="text-xs">
          {titles.join(' → ')} · {relationLabels[edge.relation]} · {labels[edge.status]}
          {clueStatus && (' · ' + (labels[clueStatus] ?? clueStatus))}
          {(orders[0] !== null || orders[1] !== null) && (' · 작중 순서 ' + orders.map((item) => item ?? '—').join(' → '))}
          {' '}<button className={button} disabled={busy || Boolean(pending)}
            onClick={() => start(edge.from, edge.to, edge.relation)}>근거 검토</button>
        </p>)}
      </section>}
      {page && <section className="space-y-2">
        <h3 className="font-semibold">저장한 후보와 승인 기록</h3>
        {page.entries.length === 0 && <p>이 페이지에 저장한 연결이 없습니다.</p>}
        {page.entries.map(({ link, status, reason, titles, orders }) => <div key={link.id} className="rounded border border-slate-800 p-2 text-xs">
          <p className="font-semibold">{(titles ?? [link.from.id, link.to.id]).join(' → ')} · {relationLabels[link.relation]} · {labels[status]} · v{link.version}</p>
          <p>{status !== 'AUTHOR_CONFIRMED' || link.visibility === 'AUTHOR_ONLY' ? '작가 검토용' : '장면의 시점과 지식 검증 후 집필에 활용 가능'}
            {reason && (' · ' + (labels[reason] ?? reason))}
            {orders && (orders[0] !== null || orders[1] !== null) && (' · 작중 순서 ' + orders.map((item) => item ?? '—').join(' → '))}</p>
          <p className="break-all text-slate-400">{link.evidence.map(({ source }) =>
            source.sourceRevisionId + ' [' + source.sourceStartOffset + '–' + source.sourceEndOffset + ']').join(' · ')}</p>
          <button className={button} disabled={busy || Boolean(pending)} onClick={() => start(link.from, link.to, link.relation, link)}>검토·승인·거절</button>
          {' '}<button className={button} disabled={busy} onClick={() => void getHistory(link.id)}>변경 이력</button>
        </div>)}
        {page.next && <button className={button} disabled={busy} onClick={() => void run(() => load(page.next))}>다음 연결</button>}
      </section>}
      {history && <section className="space-y-1">
        <h3 className="font-semibold">연결 변경 이력</h3>
        {history.page.entries.map(({ record, previous, id }) => <p key={id} className="text-xs">
          v{record.version} · {previous ? labels[previous.status] + ' → ' : ''}{labels[record.status]} · {new Date(record.updatedAt).toLocaleString('ko-KR')}
        </p>)}
        {history.page.next && <button className={button} disabled={busy} onClick={() => void getHistory(history.id, history.page.next)}>다음 이력</button>}
      </section>}
      <section className="space-y-2 rounded border border-indigo-500/30 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-semibold">{editing ? '저장된 연결 검토 · v' + editing.version : '새 연결 검토'}</h3>
          {editing && <button className={button} disabled={busy || Boolean(pending)} onClick={() => start(focus ?? emptyNode, emptyNode, 'RELATED_TO')}>새 연결</button>}
        </div>
        <div className="grid gap-2 md:grid-cols-2">
          {(['from', 'to'] as const).map((side) => {
            const name = side === 'from' ? '출발' : '도착';
            return <fieldset className="space-y-1" key={side}><legend>{name} 출처</legend>
              <select aria-label={name + ' 유형'} className={field} disabled={locked} value={nodes[side].type}
                onChange={(e) => setNode(side, { ...nodes[side], type: e.target.value as NarrativeNode['type'] })}>
                {NARRATIVE_NODES.map((key) => <option key={key} value={key}>{labels[key]}</option>)}
              </select>{' '}
              <input aria-label={name + ' 출처 ID'} className={field} disabled={locked} value={nodes[side].id}
                onChange={(e) => setNode(side, { ...nodes[side], id: e.target.value.trim() })} />{' '}
              <button type="button" className={button} disabled={busy || !nodes[side].id} onClick={() => void run(() => lookup(side))}>근거 조회</button>
              {candidates[side]?.rows.map((row) => <label key={row.chunkId} className="block rounded border border-slate-800 p-1 text-xs">
                <input type="radio" name={'proof-' + side} checked={proof[side]?.chunkId === row.chunkId} disabled={busy || Boolean(pending)}
                  onChange={() => setProof((all) => ({ ...all, [side]: row }))} /> {row.title} · {row.sourceRevisionId} · {row.episodeNumber ? '제' + row.episodeNumber + '화' : '공통'}
                <span className="block whitespace-pre-wrap">{row.excerpt}</span>
              </label>)}
              {candidates[side] && !candidates[side]?.rows.length && <p className="text-xs">이 페이지에서 확인한 원문이 없습니다.</p>}
              {candidates[side]?.next && <button className={button} disabled={busy} onClick={() => void run(() => lookup(side, candidates[side]?.next))}>더 많은 근거</button>}
            </fieldset>;
          })}
        </div>
        <label>연결 유형 <select aria-label="연결 유형" className={field} value={relation} disabled={locked}
          onChange={(e) => setRelation(e.target.value as NarrativeRelation)}>
          {NARRATIVE_RELATIONS.map((kind) => <option key={kind} value={kind}>{relationLabels[kind]}</option>)}
        </select></label>
        {relation === 'CHANGES_CHARACTER_STATE' && <div className="flex gap-2">
          <select aria-label="상태가 바뀐 인물" className={field} value={state.characterId} disabled={locked}
            onChange={(e) => setState({ ...state, characterId: e.target.value })}>
            <option value="">상태가 바뀐 인물 선택</option>
            {characters.filter((character) => character.canonStatus === 'CANON' || (character.canonStatus === undefined && character.status === 'confirmed'))
              .map((character) => <option key={character.id} value={character.id}>{character.name}</option>)}
          </select>
          <select aria-label="상태의 종류" className={field} value={state.axis} disabled={locked} onChange={(e) => setState({ ...state, axis: e.target.value as NarrativeState['axis'] })}>
            {CHARACTER_STATE_AXES.map((axis) => <option key={axis} value={axis}>{labels[axis]}</option>)}
          </select>
        </div>}
        <label className="block"><input type="checkbox" checked={visibility === 'SOURCE_KNOWLEDGE'} disabled={busy || Boolean(pending)}
          onChange={(e) => setVisibility(e.target.checked ? 'SOURCE_KNOWLEDGE' : 'AUTHOR_ONLY')} /> 두 원문에서 공개된 연결이며, 해당 사실을 아는 시점 인물의 집필에 사용할 수 있습니다.</label>
        <label className="block"><input type="checkbox" checked={confirmed} disabled={busy || Boolean(pending)}
          onChange={(e) => setConfirmed(e.target.checked)} /> 선택한 원문 범위와 연결 유형을 확인했습니다.</label>
        <div className="flex flex-wrap gap-2">
          <button className={button} disabled={!ready} onClick={() => submit('CANDIDATE')}>검토 후보 저장</button>
          <button className={button} disabled={!ready} onClick={() => submit('AUTHOR_CONFIRMED')}>연결 승인</button>
          <button className={button} disabled={!editing || !confirmed || busy || Boolean(pending)} onClick={() => submit('REJECTED')}>연결 거절</button>
          {pending && <button className={button} disabled={busy} onClick={() => void run(() => save(pending))}>같은 요청으로 재시도</button>}
        </div>
      </section>
      {notice && <p role="status">{notice}</p>}
    </div>
  </details>;
}
