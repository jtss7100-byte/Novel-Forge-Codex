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
  FORESHADOWING: '복선', RELATIONSHIP: '관계', TEMPORAL: '시간 상태',
  AUTHOR_IMPORTANCE: '작가 지정 중요도', SOURCE_DIVERSITY: '출처 다양성', FRESHNESS: '원본 검증',
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
