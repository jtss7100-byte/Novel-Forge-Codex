import { useRef, useState } from 'react';
import type { Character, CharacterRelationship, Episode, PromptProfile, Revision } from '../types/novel';
import type { CharacterVoiceAnalysisCandidate, VoiceSourceReference } from '../types/characterVoice';
import type { ContinuitySceneKind, StyleContinuityReport } from '../types/styleContinuity';
import type { RewriteSelectionAnchor } from '../types/aiEngine';
import { VOICE_DIMENSIONS, buildApprovedVoiceContent, readApprovedVoiceSources, voiceProfileId } from '../utils/characterVoiceLogic';
import { computeManuscriptContentHash, createRewriteSelectionAnchor } from '../utils/manuscriptIntegrity';
import { createNewPromptProfile, restorePromptProfileToVersion, updatePromptProfileContent } from '../utils/aiEngineLogic';
import { generateEntityId } from '../utils/novelLogic';
import { VoiceContinuityDecisions, type DecisionAnalysisInput } from './VoiceContinuityDecisions';

export interface VoiceRewriteSelection { projectId: string; episodeId: string; characterIds: string[]; anchor: RewriteSelectionAnchor }
export interface CharacterVoicePanelProps {
  projectId: string;
  ownerId: string;
  character: Character;
  characters: Character[];
  episodes: Episode[];
  revisions: Revision[];
  relationships: CharacterRelationship[];
  profiles: PromptProfile[];
  cloud: boolean;
  getIdToken: () => Promise<string | null>;
  onSave: (next: PromptProfile, base: PromptProfile | null, sources?: VoiceSourceReference[]) => Promise<PromptProfile>;
  onReload: (profileId: string) => Promise<PromptProfile | null>;
  onOpenRewrite: (selection: VoiceRewriteSelection) => void;
}

const field = 'rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100';
const button = 'rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-200 hover:border-amber-500 disabled:opacity-40';
const attributionLabel = {
  AUTHOR_CONFIRMED: '작가 확인', EXPLICITLY_OBSERVED: '원문 명시', AMBIGUOUS: '모호함', UNKNOWN: '미확인', INFERRED: '추론',
};
const emptyDecisionInputs: DecisionAnalysisInput[] = [];

function changeVoiceActivation(profile: PromptProfile): PromptProfile {
  const now = new Date().toISOString();
  const id = generateEntityId('pver');
  const number = profile.currentVersionNumber + 1;
  return {
    ...profile, isActive: !profile.isActive, currentVersionNumber: number, currentVersionId: id, updatedAt: now,
    versions: [{ versionId: id, versionNumber: number, content: profile.content, label: profile.isActive ? '화법 비활성화' : '화법 활성화', createdAt: now }, ...profile.versions].slice(0, 30),
  };
}

export function CharacterVoicePanel(props: CharacterVoicePanelProps) {
  const { character, ownerId, projectId, episodes, revisions, profiles } = props;
  const [mode, setMode] = useState<'PASTED' | 'SAVED'>('PASTED');
  const [sampleText, setSampleText] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [useGemini, setUseGemini] = useState(true);
  const [revisionId, setRevisionId] = useState('');
  const [candidate, setCandidate] = useState<CharacterVoiceAnalysisCandidate | null>(null);
  const [instructions, setInstructions] = useState('');
  const [activate, setActivate] = useState(true);
  const [approvedCandidate, setApprovedCandidate] = useState<string>();
  const [base, setBase] = useState<PromptProfile | null>(null);
  const [assignments, setAssignments] = useState<Record<string, Record<string, string>>>({});
  const [selectedRevisions, setSelectedRevisions] = useState<Record<string, ContinuitySceneKind>>({});
  const [comparison, setComparison] = useState<{ report: StyleContinuityReport; inputs: DecisionAnalysisInput[] } | null>(null);
  const report = comparison?.report ?? null;
  const [busy, setBusy] = useState('');
  const busyRef = useRef(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [restoreId, setRestoreId] = useState('');
  const current = profiles.find((item) => item.id === voiceProfileId(character.id) && item.ownerId === ownerId &&
    item.projectId === projectId && item.promptType === 'CHARACTER_DIALOGUE_RULES' && item.targetCharacterId === character.id) ?? null;
  const eligibleRevisions = revisions.filter((revision) => revision.ownerId === ownerId && revision.projectId === projectId &&
    episodes.some((ep) => ep.id === revision.episodeId && ep.projectId === projectId && ep.ownerId === ownerId));
  const sourceFor = (id: string) => {
    const revision = eligibleRevisions.find((item) => item.id === id);
    const episode = episodes.find((item) => item.id === revision?.episodeId);
    if (!revision || !episode) throw new Error('저장된 회차 Revision을 선택해 주세요.');
    const contentHash = computeManuscriptContentHash(revision.content);
    return { episode, revision, contentHash };
  };
  const candidateSource = candidate?.sourceReferences[0];
  const currentSourceKey = candidateSource && `${candidateSource.revisionId || 'paste'}:${candidateSource.contentHash}`;
  const stalenessKey = (source: VoiceSourceReference) => {
    if (source.revisionId) {
      const rev = eligibleRevisions.find((item) => item.id === source.revisionId);
      const ep = episodes.find((item) => item.id === source.episodeId);
      return !rev || !ep || rev.episodeId !== ep.id || (ep.latestRevisionId || undefined) !== (source.latestRevisionId || undefined) ||
        computeManuscriptContentHash(rev.content) !== source.contentHash;
    }
    return computeManuscriptContentHash(sampleText) !== source.contentHash;
  };
  const staleCandidate = candidate?.sourceReferences.some(stalenessKey);
  const savedInput = (id: string, sceneKind?: ContinuitySceneKind) => {
    const { episode, revision, contentHash } = sourceFor(id);
    return {
      episodeId: episode.id, revisionId: revision.id, contentHash, sceneKind,
      assignments: assignments[`${revision.id}:${contentHash}`],
      local: props.cloud ? undefined : { episode, revision },
    };
  };

  async function action(label: string, job: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(label);
    setError('');
    setNotice('');
    try { await job(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : '요청을 처리하지 못했습니다.'); }
    finally { busyRef.current = false; setBusy(''); }
  }
  async function request<T>(endpoint: string, body: object): Promise<T> {
    const token = await props.getIdToken();
    if (props.cloud && !token) throw new Error('로그인을 다시 확인해 주세요.');
    const response = await fetch(endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({
        ...body, projectId, characterId: character.id,
        localCast: props.cloud ? undefined : props.characters,
        localRelationships: props.cloud ? undefined : props.relationships,
      }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '분석에 실패했습니다.');
    return result as T;
  }

  function analyze(override?: Record<string, string>) {
    return action('화법 분석 중', async () => {
      const analyzed = await request<CharacterVoiceAnalysisCandidate>('/api/ai/analyze-character-voice', {
        input: mode === 'PASTED'
          ? { mode, text: sampleText, confirmed, assignments: override ?? assignments[`paste:${computeManuscriptContentHash(sampleText)}`] }
          : { mode, ...savedInput(revisionId), assignments: override ?? savedInput(revisionId).assignments },
        useGemini: override ? false : useGemini,
      });
      setCandidate(analyzed);
      setBase(current);
      setApprovedCandidate(undefined);
      setInstructions(analyzed.suggestedInstructions.join('\n'));
    });
  }

  function approve() {
    return action('버전 저장 중', async () => {
      if (!candidate || staleCandidate) throw new Error('STALE_SOURCE: 출처를 다시 분석해 주세요.');
      const content = buildApprovedVoiceContent(candidate, instructions.split('\n'));
      const next = base
        ? updatePromptProfileContent(base, { content, isActive: activate, versionLabel: '작가 승인 화법' })
        : { ...createNewPromptProfile({
            ownerId, projectId, targetCharacterId: character.id, promptType: 'CHARACTER_DIALOGUE_RULES',
            title: `${character.name} · Character Voice DNA`.slice(0, 150), description: '작가 승인 인물별 화법', content, isActive: activate,
          }), id: voiceProfileId(character.id) };
      const versioned = base && next.currentVersionId === base.currentVersionId && next.isActive !== base.isActive
        ? changeVoiceActivation(base) : next;
      const committed = await props.onSave(versioned, base, candidate.sourceReferences);
      setBase(committed);
      setApprovedCandidate(candidate.candidateId);
      setNotice(`v${committed.currentVersionNumber} 저장 완료 · ${committed.isActive ? '활성' : '비활성'}`);
    });
  }

  return (
    <section aria-label="Character Voice DNA" className="space-y-4 rounded-2xl border border-slate-800 bg-slate-900/70 p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-lg font-semibold text-amber-300">{character.name} · Character Voice DNA</h3>
        <span className="text-sm text-slate-400">{current ? `승인됨 · ${current.isActive ? '활성' : '비활성'} · v${current.currentVersionNumber}` : '저장된 화법 없음'}</span>
      </div>
      {current && <details className="text-sm text-slate-300">
        <summary>현재 적용 규칙 및 화법 버전</summary>
        <pre className="my-2 whitespace-pre-wrap rounded bg-slate-950 p-3">{current.content.replace(/\n<!-- VOICE_DNA_SOURCES .* -->$/, '')}</pre>
        {readApprovedVoiceSources(current.content).map((source) =>
          <p key={`${source.revisionId || 'paste'}:${source.contentHash}`} className="mb-2 break-all text-xs text-slate-400">
            승인 근거 {source.revisionId || '직접 입력'} · {source.contentHash}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <button className={button} disabled={Boolean(busy)} onClick={() => void action('적용 상태 저장 중', async () => {
            const saved = await props.onSave(changeVoiceActivation(current), current);
            setNotice(`v${saved.currentVersionNumber} · ${saved.isActive ? '활성' : '비활성'}`);
          })}>{current.isActive ? '비활성화' : '활성화'}</button>
          <select aria-label="복원할 화법 버전" className={field} value={restoreId} onChange={(e) => setRestoreId(e.target.value)}>
            <option value="">이전 버전 선택</option>
            {current.versions.filter((version) => version.versionId !== current.currentVersionId && version.content !== current.content).map((version) => <option key={version.versionId} value={version.versionId}>v{version.versionNumber} · {version.label}</option>)}
          </select>
          <button className={button} disabled={!restoreId || Boolean(busy)} onClick={() => void action('이전 버전 복원 중', async () => {
            await props.onSave(restorePromptProfileToVersion(current, restoreId), current);
            setRestoreId('');
            setNotice('이전 규칙을 새 버전으로 복원했습니다.');
          })}>새 버전으로 복원</button>
        </div>
      </details>}
      <div className="grid gap-2">
        <label className="text-sm">원고 출처 <select className={field} value={mode} onChange={(e) => { setMode(e.target.value === 'SAVED' ? 'SAVED' : 'PASTED'); setCandidate(null); }}>
          <option value="PASTED">직접 입력</option><option value="SAVED">저장된 Revision</option>
        </select></label>
        {mode === 'PASTED' ? <>
          <textarea aria-label="인물의 대사 샘플" className={field} rows={4} maxLength={20_000} value={sampleText} onChange={(e) => setSampleText(e.target.value)} />
          <label className="text-sm"><input type="checkbox" checked={confirmed} onChange={(e) => { setConfirmed(e.target.checked); setCandidate(null); }} /> 각 줄이 모두 {character.name}의 실제 발화임을 확인</label>
        </> : <select aria-label="분석할 저장 Revision" className={field} value={revisionId} onChange={(e) => { setRevisionId(e.target.value); setCandidate(null); }}>
          <option value="">회차와 Revision 선택</option>
          {eligibleRevisions.map((revision) => <option key={revision.id} value={revision.id}>{episodes.find((ep) => ep.id === revision.episodeId)?.title} · {revision.label} · {revision.id}</option>)}
        </select>}
        <label className="text-sm"><input type="checkbox" checked={useGemini} onChange={(e) => setUseGemini(e.target.checked)} /> Gemini 문학 분석 포함</label>
        <button className={button + ' justify-self-start'} disabled={Boolean(busy) || (mode === 'PASTED' ? !sampleText.trim() : !revisionId)} onClick={() => void analyze()}>화법 분석</button>
      </div>
      {busy && <p role="status" className="text-sm text-amber-300">{busy}…</p>}
      {error && <p role="alert" className="text-sm text-rose-300">{error}</p>}
      {notice && <p role="status" className="text-sm text-emerald-300">{notice}</p>}
      {candidate && <div className="space-y-3 rounded-xl bg-slate-950/70 p-4">
        <p className="text-sm text-amber-200">{staleCandidate ? 'STALE_SOURCE · 출처 변경됨' : approvedCandidate === candidate.candidateId ? '작가 승인 저장 완료' : candidate.status === 'READY_FOR_REVIEW' ? '검토 대기 · 미승인' : '화자 또는 표본 확인 필요'} · {candidate.geminiExecuted ? 'Gemini 근거 확인' : '결정적 분석'} · 확인된 발화 {candidate.metrics.count}개</p>
        <p className="break-all text-xs text-slate-400">근거 {candidateSource?.revisionId || '직접 입력'} · {candidateSource?.contentHash}</p>
        {candidate.warnings.map((warning) => <p key={warning} className="text-xs text-slate-400">{warning}</p>)}
        <details open><summary>V1–V10 분석 및 근거</summary>
          <dl className="grid gap-2 pt-3 sm:grid-cols-2">{candidate.dimensions.map((finding) => <div key={finding.dimensionId} className="rounded border border-slate-800 p-2">
            <dt className="text-sm font-medium">{finding.dimensionId} · {VOICE_DIMENSIONS[finding.dimensionId]}</dt>
            <dd className="text-xs text-slate-300">{finding.observedTrait}</dd>
            <dd className="text-xs text-slate-400">{finding.confidence} · {finding.evidenceReferences.join(', ') || '확인된 근거 없음'}</dd>
          </div>)}</dl>
        </details>
        <details><summary>발화별 화자 검토</summary>
          <div className="max-h-80 space-y-2 overflow-auto py-2">{candidate.excerpts.map((excerpt) => <div key={excerpt.id} className="grid gap-1 border-b border-slate-800 pb-2">
            <blockquote className="text-sm">{excerpt.text}</blockquote>
            <label className="text-xs text-slate-400">근거 {excerpt.id} · {attributionLabel[excerpt.attribution]} <select aria-label={`발화 ${excerpt.id} 화자`} disabled={Boolean(busy) || staleCandidate} className={field} value={excerpt.characterId || ''} onChange={(e) => {
              const who = e.target.value;
              if (!currentSourceKey || !who) return;
              const next = { ...assignments[currentSourceKey], [excerpt.id]: who };
              setAssignments({ ...assignments, [currentSourceKey]: next });
              setComparison(null);
              void analyze(next);
            }}><option value="" disabled>화자 지정</option>{props.characters.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}</select></label>
          </div>)}</div>
        </details>
        <label className="block text-sm">승인할 규칙 · 줄별로 편집하거나 제외
          <textarea className={field + ' mt-1 block w-full'} rows={5} maxLength={5000} value={instructions} onChange={(e) => { setInstructions(e.target.value); setApprovedCandidate(undefined); }} />
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-sm"><input type="checkbox" checked={activate} onChange={(e) => { setActivate(e.target.checked); setApprovedCandidate(undefined); }} /> 승인 후 활성화</label>
          <button className={button + ' border-amber-600'} disabled={Boolean(busy) || staleCandidate || !instructions.trim() || candidate.status !== 'READY_FOR_REVIEW' || approvedCandidate === candidate.candidateId} onClick={() => void approve()}>작가 승인 및 저장</button>
          <button className={button} disabled={Boolean(busy)} onClick={() => void action('최신 버전 확인 중', async () => { setBase(await props.onReload(voiceProfileId(character.id))); setNotice('최신 버전을 불러왔습니다. 지침을 확인 후 승인해 주세요.'); })}>최신 버전 확인</button>
        </div>
      </div>}
      <details className="space-y-3 rounded-xl border border-slate-800 p-4">
        <summary className="font-semibold">회차 간 문체·대사 일관성 검사</summary>
        <div className="my-3 max-h-52 space-y-2 overflow-auto">
          {eligibleRevisions.map((revision) => <div key={revision.id} className="flex flex-wrap items-center gap-2 text-sm">
            <label><input type="checkbox" checked={revision.id in selectedRevisions} disabled={Boolean(busy)} onChange={(e) => {
              const next = { ...selectedRevisions };
              if (e.target.checked && Object.keys(next).length < 12) next[revision.id] = 'UNKNOWN';
              else delete next[revision.id];
              setSelectedRevisions(next);
              setComparison(null);
            }} /> {episodes.find((ep) => ep.id === revision.episodeId)?.title} · {revision.label} · {revision.id}</label>
            {revision.id in selectedRevisions && <select aria-label={`${revision.id} 장면 유형`} className={field} value={selectedRevisions[revision.id]} onChange={(e) => {
              setSelectedRevisions({ ...selectedRevisions, [revision.id]: e.target.value as ContinuitySceneKind }); setComparison(null);
            }}><option value="UNKNOWN">장면 유형 미지정</option><option value="DAILY">일상</option><option value="COMBAT">전투</option><option value="CRISIS">위기</option><option value="REFLECTION">성찰</option></select>}
          </div>)}
        </div>
        <button className={button} disabled={Boolean(busy) || Object.keys(selectedRevisions).length < 2} onClick={() => void action('회차 비교 중', async () => {
          const selections = Object.entries(selectedRevisions).map(([id, sceneKind]) => savedInput(id, sceneKind));
          const report = await request<StyleContinuityReport>('/api/ai/review-style-continuity', { inputs: selections });
          const inputs = selections.map(({ episodeId, revisionId, contentHash, sceneKind, assignments }) =>
            ({ episodeId, revisionId, contentHash, sceneKind, assignments }));
          setComparison({ report, inputs });
        })}>선택한 Revision 비교</button>
        {report && <div className="space-y-3 pt-3">
          {report.samples.map(({ source, episodeTitle, style, voice }) => <p key={source.revisionId} className="text-xs text-slate-300">
            {episodeTitle} · {source.revisionId} · {style.sentenceCount}문장 / {style.paragraphCount}문단 · 대사 {style.dialogueRatioPercent}% · 확인 발화 {voice.count}개 {stalenessKey(source) ? ' · STALE_SOURCE' : ''}
          </p>)}
        </div>}
        <VoiceContinuityDecisions
          scope={{ ownerId, projectId, characterId: character.id }}
          cloud={props.cloud}
          getIdToken={props.getIdToken}
          report={report}
          inputs={comparison?.inputs ?? emptyDecisionInputs}
          cohortStale={report?.samples.some(({ source }) => stalenessKey(source)) ?? false}
          sourceStale={(record) => ![
            [record.beforeRevisionId, record.beforeContentHash],
            [record.afterRevisionId, record.afterContentHash],
          ].every(([id, hash]) => {
            const revision = eligibleRevisions.find((item) => item.id === id);
            return revision !== undefined && computeManuscriptContentHash(revision.content) === hash;
          })}
          renderFindingActions={(finding) => {
            if (!report || finding.dimension !== 'VOICE') return null;
            const after = report.samples[finding.after];
            const excerpt = after.voiceExcerpts[0];
            const episode = episodes.find((item) => item.id === after.source.episodeId);
            if (!excerpt || !episode || !after.source.revisionId || episode.latestRevisionId !== after.source.revisionId ||
                computeManuscriptContentHash(episode.content) !== after.source.contentHash) return null;
            const anchor = createRewriteSelectionAnchor({ manuscript: episode.content, startOffset: excerpt.startOffset, endOffset: excerpt.endOffset, sourceRevisionId: after.source.revisionId });
            return <button className={button} onClick={() => props.onOpenRewrite({
              projectId, episodeId: episode.id, characterIds: [character.id], anchor,
            })}>R3 리라이팅 후보 준비</button>;
          }}
        />
      </details>
    </section>
  );
}
