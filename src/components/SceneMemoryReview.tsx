import { relationLabels } from './NarrativeMemoryPanel';
import type { SceneMemoryDiagnostics } from '../types/sceneMemory';

const statusLabels: Record<SceneMemoryDiagnostics['status'], string> = {
  SELECTED: '기억 선택 완료',
  NO_MATCHES: '검색 결과 없음',
  FILTERED: '장면에 사용할 수 있는 근거 없음',
  SEARCH_FAILED: '기억 검색 실패',
  AUTHORITY_UNAVAILABLE: '저장된 기획 또는 원본을 검증할 수 없음',
  BUDGET_EXCEEDED: '집필 실행의 검색 예산 소진',
};

const reasons: Record<SceneMemoryDiagnostics['rejected'][number]['reason'], string> = {
  STALE_SOURCE: '이전 리비전', SOURCE_UNVERIFIED: '출처 미검증', NON_CANON: '정사 미승인',
  CROSS_PROJECT: '다른 프로젝트', RETIRED_GENERATION: '비활성 색인', DELETED_SOURCE: '삭제된 출처',
  FUTURE_INFORMATION: '장면 이후의 정보', POV_KNOWLEDGE_RESTRICTED: '시점 인물의 지식 범위 밖',
  STALE_ANNOTATION: '다시 확인해야 할 이전 승인', KNOWLEDGE_SCOPE_CONFLICT: '기존 지식 범위와 충돌',
  TEMPORAL_EVIDENCE_MISSING: '검증된 획득 시점 없음',
  DUPLICATE_EVIDENCE: '중복 근거', BUDGET_EXCEEDED: '기억 예산 초과', LOW_RELEVANCE: '관련성 낮음',
};

const modes: Record<string, string> = {
  FIRESTORE_VECTOR_HYBRID: '벡터·키워드 혼합', FIRESTORE_VECTOR_ONLY: '벡터',
  KEYWORD_ONLY: '키워드', LOCAL_FALLBACK: '로컬 대체 검색', SEARCH_FAILED: '검색 실패',
};

const temporal = {
  CURRENT_VALID_STATE: '현재 유효', PAST_EVENT: '과거 사건', SUPERSEDED_HISTORICAL_STATE: '변경 전 상태',
};
const knowledge = {
  PUBLIC: '공개 정보', POV_CHARACTER_KNOWLEDGE: '시점 인물이 아는 정보',
  AUTHOR_KNOWLEDGE: '작가만 아는 정보', UNKNOWN_KNOWLEDGE_SCOPE: '전지적 서술 참고',
};
const signals: Record<SceneMemoryDiagnostics['selected'][number]['signals'][number], string> = {
  SEMANTIC: '의미', KEYWORD: '키워드', CHARACTER: '등장인물', SCENE_GOAL: '장면 목적',
  GRAPH: '서사 연결', FORESHADOWING: '복선', RELATIONSHIP: '관계', TEMPORAL: '시간 상태',
  AUTHOR_IMPORTANCE: '작가 지정 중요도', SOURCE_DIVERSITY: '출처 다양성', FRESHNESS: '원본 검증',
};

const graphStatuses = { DISABLED: '비활성', NO_SEEDS: '검증된 시작점 없음', NO_LINKS: '사용할 연결 없음', EXPANDED: '탐색 완료', BUDGET_LIMITED: '탐색 한도 도달', SEARCH_FAILED: '그래프 검색 실패' };
const narrativeStates = { HISTORICAL: '과거 상태', CURRENT: '현재 유효', FUTURE_PLANNED: '이후 상태', CONFLICTED: '충돌', UNKNOWN: '확인 필요' };
const graphReasons: Record<string, string> = {
  UNVERIFIED_LINK: '미검증 연결', STALE_LINK: '변경된 연결', DELETED_NODE: '삭제된 출처', CROSS_PROJECT_LINK: '다른 작품의 연결',
  CAUSAL_EVIDENCE_MISSING: '인과 근거 부족', FUTURE_EVENT: '이후 사건', POV_KNOWLEDGE_RESTRICTED: '시점 인물의 지식 범위 밖',
  GRAPH_DEPTH_EXCEEDED: '깊이 한도 도달', GRAPH_BUDGET_EXCEEDED: '탐색 예산 소진', DUPLICATE_NODE: '중복 방문', CYCLIC_PATH: '순환 경로',
};

export function SceneMemoryReview({ records }: { records: SceneMemoryDiagnostics[] }) {
  return records.map((record) => {
    const { requirements, budget } = record;
    const missing = [...new Set([...record.missingRequiredEventIds, ...record.missingForeshadowingIds])];
    return (
      <details key={record.id} data-testid="scene-memory-review"
        className="rounded-lg border border-slate-800 bg-slate-900/60 p-3 text-slate-300">
        <summary className="cursor-pointer font-semibold text-indigo-300">
          {requirements.sceneNumber ? `제${requirements.sceneNumber}장면` : '현재 집필 구간'} · {statusLabels[record.status]} · {record.selected.length}건
        </summary>
        <div className="mt-2 space-y-2">
          <p>{requirements.sceneGoal || '장면 목표 없음'}</p>
          <p className="text-slate-400">
            {record.searchModes.map((mode) => modes[mode] ?? mode).join(' · ') || '실행된 검색 없음'}
            {record.vectorFallback && ' · 벡터 검색을 사용할 수 없어 키워드 사용'}
            {requirements.narrativeCutoff ? ' · 작중 시간 기준' : ' · 회차 기준'}
            {' · 후보 '}{record.candidateCount}{'건 · 제외 '}{record.rejected.length}{'건'}
          </p>
          <p className="text-slate-400">
            원문 {record.memoryChars.toLocaleString()}/{budget.maxMemoryChars.toLocaleString()}자
            {' · 추정 '}{record.estimatedMemoryTokens.toLocaleString()}/{budget.maxEstimatedMemoryTokens.toLocaleString()} 토큰
            {' · 실행 누적 검색 '}{record.retrievalRequests}/{budget.maxRetrievalRequests}
            {' · 임베딩 시도 '}{record.embeddingRequests}/{budget.maxEmbeddingRequests}
          </p>
          {record.graph && <div className="space-y-1 text-slate-400">
            <p>서사 그래프 · {graphStatuses[record.graph.status]} · 시작 {record.graph.seeds} · 노드 {record.graph.visitedNodes}
              {' · 연결 '}{record.graph.visitedEdges}{' · 깊이 '}{record.graph.depth}{' · 추가 후보 '}{record.graph.newCandidates}</p>
            <p>검증 연결 {record.graph.verifiedLinks} · 인과 {record.graph.causalLinks} · 관계 {record.graph.relationshipLinks} · 복선 {record.graph.foreshadowingLinks}
              {' · 실행 누적 탐색/검증 읽기 '}{record.graph.runDiscoveryReads}{' / '}{record.graph.runVerificationReads}</p>
            {(record.graph.relationshipStates ?? []).map(({ nodeId, status }) =>
              <p key={nodeId}>관계 {nodeId} · {narrativeStates[status]}</p>)}
            {(record.graph.characterStates ?? []).map(({ nodeId, characterId, axis, status }) =>
              <p key={nodeId + characterId + axis}>인물 상태 {characterId} · {axis} · {narrativeStates[status]} · {nodeId}</p>)}
            {Object.entries(record.graph.rejected).map(([reason, count]) => <p key={reason}>{graphReasons[reason] ?? reason} {count}건</p>)}
          </div>}
          {missing.length > 0 && <p className="break-all text-amber-300">회수하지 못한 중요 출처 {missing.join(', ')}</p>}
          {record.selected.length > 0 && (
            <ul className="space-y-1">
              {record.selected.map((item) => (
                <li key={item.chunkId} className="rounded border border-slate-800 p-2">
                  <p className="font-semibold">{item.title} · {item.episodeNumber ? `제${item.episodeNumber}화` : '공통 설정'}</p>
                  <p>{temporal[item.temporal]} · {knowledge[item.knowledge]} · {item.signals.map((signal) => signals[signal]).join(', ')}</p>
                  <p className="break-all text-slate-400">
                    {item.sourceEntityId} · Revision {item.sourceRevisionId}
                    {' · '}{item.retrievalSource ? modes[item.retrievalSource] ?? item.retrievalSource : '검색 방식 미기록'}
                    {item.annotationVersion && (' · 기억 승인 v' + item.annotationVersion)}
                    {item.graphDepth && (' · ' + item.graphDepth + '단계 ' + (item.graphRelation ? relationLabels[item.graphRelation] : '서사 연결'))}
                    {' · 의미 '}{item.semanticScore.toFixed(2)}{' · 키워드 '}{item.keywordScore.toFixed(2)}
                  </p>
                </li>
              ))}
            </ul>
          )}
          {record.rejected.length > 0 && (
            <details>
              <summary className="cursor-pointer text-slate-400">제외된 근거</summary>
              <ul className="mt-1 space-y-1">
                {record.rejected.map(({ chunkId, reason }) => <li className="break-all" key={chunkId}>{reasons[reason]} · {chunkId}</li>)}
              </ul>
            </details>
          )}
          <p className="break-all text-slate-500">검색 ID {record.id}</p>
        </div>
      </details>
    );
  });
}
