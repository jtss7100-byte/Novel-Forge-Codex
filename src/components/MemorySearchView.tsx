import { NarrativeMemoryPanel } from './NarrativeMemoryPanel';
import type { NarrativeNode } from '../types/narrativeMemory';
import { MemoryKnowledgePanel } from './MemoryKnowledgePanel';
import type { Scene } from '../types/novel';
import React, { useState, useEffect, useCallback } from 'react';
import {
  Search,
  Database,
  RefreshCw,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  BookOpen,
  Users,
  Globe,
  FileText,
  Sparkles,
  ArrowUpRight,
  SlidersHorizontal,
  ShieldCheck,
  Clock,
  Layers,
  Eye,
  RotateCcw,
} from 'lucide-react';
import type {
  CanonStatus,
  Character,
  CharacterRelationship,
  Episode,
  Foreshadowing,
  MemoryChunk,
  MemoryDocument,
  MemorySearchHit,
  MemorySearchMode,
  MemorySourceEntityType,
  NavTab,
  Project,
  TimelineEvent,
  WorldbuildingItem,
} from '../types/novel';
import type {
  BulkIndexingCostEstimate,
  LiveSourceSnapshotMap,
} from '../services/memorySearchProvider';

interface MemorySearchViewProps {
  ownerId: string;
  idToken: string | null;
  narrativeFocus?: NarrativeNode;
  activeProject: Project;
  episodes: Episode[];
  characters: Character[];
  worldbuilding: WorldbuildingItem[];
  timelineEvents: TimelineEvent[];
  scenes?: Scene[];
  foreshadowings: Foreshadowing[];
  relationships?: CharacterRelationship[];
  onNavigateToSource: (params: {
    tab: NavTab;
    episodeId?: string;
    entityId?: string;
  }) => void;
}

interface RagStatusData {
  ownerId: string;
  projectId: string;
  embeddingModelId: string;
  embeddingDimension: number;
  totalDocuments: number;
  totalChunks: number;
  statusCounts: {
    NOT_INDEXED: number;
    INDEXING: number;
    INDEXED: number;
    STALE: number;
    FAILED: number;
  };
  documents: Array<{
    documentId: string;
    sourceEntityType: string;
    sourceEntityId: string;
    sourceEpisodeId?: string | null;
    sourceRevisionId: string;
    canonStatus: string;
    title: string;
    indexStatus: string;
    chunkCount: number;
    indexedAt: string;
    lastIndexError?: string;
  }>;
}

const SOURCE_TYPE_LABELS: Record<string, string> = {
  ALL: '전체 분류',
  EPISODE: '확정 원고 본문 (EPISODE)',
  EPISODE_SUMMARY: '회차 요약 (EPISODE_SUMMARY)',
  SCENE: '원고 장면 (SCENE)',
  CHARACTER: '등장인물 설정 (CHARACTER)',
  CHARACTER_STATE_CHANGE: '인물 상태 변화 (CHARACTER_STATE_CHANGE)',
  WORLDBUILDING: '세계관 설정 (WORLDBUILDING)',
  TIMELINE_EVENT: '사건 연표 (TIMELINE_EVENT)',
  FORESHADOWING: '복선/단서 (FORESHADOWING)',
  RELATIONSHIP: '인물 관계 (RELATIONSHIP)',
};

export const MemorySearchView: React.FC<MemorySearchViewProps> = ({
  ownerId,
  idToken,
  narrativeFocus,
  activeProject,
  episodes,
  characters,
  worldbuilding,
  timelineEvents,
  scenes = [],
  foreshadowings,
  relationships = [],
  onNavigateToSource,
}) => {
  const [queryText, setQueryText] = useState('');
  const [searchMode, setSearchMode] = useState<MemorySearchMode>('HYBRID');
  const [onlyCanon, setOnlyCanon] = useState(true);
  const [includeNonCanon, setIncludeNonCanon] = useState(false);
  const [includeDrafts, setIncludeDrafts] = useState(false);
  const [sourceTypeFilter, setSourceTypeFilter] = useState<string>('ALL');
  const [episodeFilter, setEpisodeFilter] = useState<string>('ALL');
  const [characterFilter, setCharacterFilter] = useState<string>('ALL');
  const [topK, setTopK] = useState<number>(8);

  const [hits, setHits] = useState<MemorySearchHit[]>([]);
  const [searchMeta, setSearchMeta] = useState<{
    embeddingUsed: boolean;
    embeddingModelId: string;
    vectorSearchMode: string;
    searchLatencyMs: number;
  } | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);

  const [ragStatus, setRagStatus] = useState<RagStatusData | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Bulk rebuild confirmation modal state
  const [bulkConfirmEstimate, setBulkConfirmEstimate] =
    useState<BulkIndexingCostEstimate | null>(null);

  // Source preview modal state
  const [selectedSourceDetail, setSelectedSourceDetail] = useState<{
    document: MemoryDocument;
    chunk?: MemoryChunk;
    hit: MemorySearchHit;
  } | null>(null);
  const [isLoadingSource, setIsLoadingSource] = useState(false);

  const buildAuthHeaders = useCallback((): Record<string, string> => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (idToken) {
      headers.Authorization = `Bearer ${idToken}`;
    }
    return headers;
  }, [idToken]);

  const buildLiveSnapshots = useCallback((): LiveSourceSnapshotMap => {
    const map: LiveSourceSnapshotMap = {};
    for (const ep of episodes) {
      const epRevId =
        ep.latestRevisionId || `rev_ep_${ep.id}_${ep.updatedAt || 'v1'}`;
      const epCanon: CanonStatus =
        ep.canonStatus ?? (ep.status === 'confirmed' ? 'CANON' : 'DRAFT');
      map[ep.id] = {
        exists: true,
        latestRevisionId: epRevId,
        canonStatus: epCanon,
      };
      map[`EPISODE:${ep.id}`] = {
        exists: true,
        latestRevisionId: epRevId,
        canonStatus: epCanon,
      };
      map[`EPISODE_SUMMARY:${ep.id}`] = {
        exists: true,
        latestRevisionId: epRevId,
        canonStatus: epCanon,
      };
    }
    for (const ch of characters) {
      const chRevId =
        ch.sourceRevisionId || `rev_char_${ch.updatedAt || 'v1'}`;
      map[ch.id] = {
        exists: true,
        latestRevisionId: chRevId,
        canonStatus: ch.canonStatus || 'CANON',
      };
      map[`CHARACTER:${ch.id}`] = {
        exists: true,
        latestRevisionId: chRevId,
        canonStatus: ch.canonStatus || 'CANON',
      };
    }
    for (const wb of worldbuilding) {
      const wbRevId =
        wb.sourceRevisionId || `rev_wb_${wb.updatedAt || 'v1'}`;
      map[wb.id] = {
        exists: true,
        latestRevisionId: wbRevId,
        canonStatus: wb.canonStatus || 'CANON',
      };
      map[`WORLDBUILDING:${wb.id}`] = {
        exists: true,
        latestRevisionId: wbRevId,
        canonStatus: wb.canonStatus || 'CANON',
      };
    }
    for (const ev of timelineEvents) {
      const evRevId =
        ev.sourceRevisionId || `rev_ev_${ev.updatedAt || 'v1'}`;
      map[ev.id] = {
        exists: true,
        latestRevisionId: evRevId,
        canonStatus: ev.canonStatus || 'CANON',
      };
      map[`TIMELINE_EVENT:${ev.id}`] = {
        exists: true,
        latestRevisionId: evRevId,
        canonStatus: ev.canonStatus || 'CANON',
      };
    }
    for (const fs of foreshadowings) {
      const fsRevId =
        fs.sourceRevisionId || `rev_fs_${fs.updatedAt || 'v1'}`;
      map[fs.id] = {
        exists: true,
        latestRevisionId: fsRevId,
        canonStatus: fs.canonStatus || 'CANON',
      };
      map[`FORESHADOWING:${fs.id}`] = {
        exists: true,
        latestRevisionId: fsRevId,
        canonStatus: fs.canonStatus || 'CANON',
      };
    }
    for (const rel of relationships) {
      const relRevId =
        rel.sourceRevisionId || `rev_rel_${rel.updatedAt || 'v1'}`;
      map[rel.id] = {
        exists: true,
        latestRevisionId: relRevId,
        canonStatus: rel.canonStatus || 'CANON',
      };
      map[`RELATIONSHIP:${rel.id}`] = {
        exists: true,
        latestRevisionId: relRevId,
        canonStatus: rel.canonStatus || 'CANON',
      };
    }
    return map;
  }, [episodes, characters, worldbuilding, timelineEvents, foreshadowings, relationships]);

  const fetchRagStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/rag/status', {
        method: 'POST',
        headers: buildAuthHeaders(),
        body: JSON.stringify({
          ownerId: idToken ? undefined : ownerId,
          projectId: activeProject.id,
        }),
      });
      if (!res.ok) return;
      const data = (await res.json()) as RagStatusData;
      setRagStatus(data);
    } catch {
      // Ignore transient status fetch failure
    }
  }, [activeProject.id, buildAuthHeaders, idToken, ownerId]);

  const handleSyncProjectIndex = useCallback(
    async (silent = false) => {
      if (!silent) {
        setIsSyncing(true);
        setErrorMessage(null);
        setStatusMessage('작품의 확정 설정 및 원고 장기 기억 색인을 동기화하고 있습니다...');
      }
      try {
        const res = await fetch('/api/rag/sync-project', {
          method: 'POST',
          headers: buildAuthHeaders(),
          body: JSON.stringify({
            ownerId: idToken ? undefined : ownerId,
            project: activeProject,
            characters,
            worldbuilding,
            episodes,
            timelineEvents,
            foreshadowings,
            relationships,
            includeDrafts,
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || '색인 동기화 중 오류가 발생했습니다.');
        }
        await fetchRagStatus();
        if (!silent) {
          setStatusMessage(
            `장기 기억 색인 동기화 완료: 문서 ${data.indexedDocuments}건 갱신 (${data.indexedChunks}청크), 변경 없음 ${data.skippedUnchanged}건 스킵 (${data.durationMs}ms)`
          );
        }
      } catch (err) {
        if (!silent) {
          setErrorMessage(
            err instanceof Error ? err.message : '색인 동기화 실패'
          );
        }
      } finally {
        if (!silent) {
          setIsSyncing(false);
        }
      }
    },
    [
      activeProject,
      buildAuthHeaders,
      characters,
      episodes,
      fetchRagStatus,
      foreshadowings,
      idToken,
      includeDrafts,
      ownerId,
      relationships,
      timelineEvents,
      worldbuilding,
    ]
  );

  useEffect(() => {
    void (async () => {
      await handleSyncProjectIndex(true);
      await fetchRagStatus();
    })();
  }, [activeProject.id, fetchRagStatus, handleSyncProjectIndex]);

  const handleRequestFullRebuild = async () => {
    setIsSyncing(true);
    setErrorMessage(null);
    try {
      const estRes = await fetch('/api/rag/estimate', {
        method: 'POST',
        headers: buildAuthHeaders(),
        body: JSON.stringify({
          ownerId: idToken ? undefined : ownerId,
          project: activeProject,
          characters,
          worldbuilding,
          episodes,
          timelineEvents,
          foreshadowings,
          relationships,
          includeDrafts,
        }),
      });
      const estData = await estRes.json();
      if (!estRes.ok) {
        throw new Error(estData.error || '색인 비용 산정 실패');
      }
      const estimate = estData.estimate as BulkIndexingCostEstimate;
      setBulkConfirmEstimate(estimate);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : '재구축 준비 실패');
    } finally {
      setIsSyncing(false);
    }
  };

  const handleExecuteConfirmedRebuild = async () => {
    setBulkConfirmEstimate(null);
    setIsSyncing(true);
    setErrorMessage(null);
    setStatusMessage('전체 장기 기억 인덱스를 처음부터 재구축하고 있습니다...');
    try {
      const res = await fetch('/api/rag/rebuild-project', {
        method: 'POST',
        headers: buildAuthHeaders(),
        body: JSON.stringify({
          ownerId: idToken ? undefined : ownerId,
          project: activeProject,
          characters,
          worldbuilding,
          episodes,
          timelineEvents,
          foreshadowings,
          relationships,
          includeDrafts,
          authorConfirmedBulk: true,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || '전체 색인 재구축 실패');
      }
      await fetchRagStatus();
      setStatusMessage(
        `전체 색인 재구축 완료: 총 ${data.indexedDocuments}개 문서 · ${data.indexedChunks}개 청크 색인 (${data.durationMs}ms)`
      );
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : '전체 색인 재구축 실패');
    } finally {
      setIsSyncing(false);
    }
  };

  const handleRetryFailed = async () => {
    setIsSyncing(true);
    setErrorMessage(null);
    try {
      const res = await fetch('/api/rag/retry-failed', {
        method: 'POST',
        headers: buildAuthHeaders(),
        body: JSON.stringify({
          ownerId: idToken ? undefined : ownerId,
          project: activeProject,
          characters,
          worldbuilding,
          episodes,
          timelineEvents,
          foreshadowings,
          relationships,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || '실패 항목 재시도 실패');
      }
      await fetchRagStatus();
      setStatusMessage(
        `실패/구버전 항목 재시도 완료: ${data.retriedCount}건 중 ${data.succeededCount}건 복구 성공`
      );
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : '재시도 실패');
    } finally {
      setIsSyncing(false);
    }
  };

  const executeSearch = async (overrideQuery?: string) => {
    const q = (overrideQuery ?? queryText).trim();
    if (!q) {
      setErrorMessage('검색할 질문이나 키워드를 입력해 주세요.');
      return;
    }
    if (overrideQuery !== undefined) {
      setQueryText(overrideQuery);
    }

    setIsSearching(true);
    setErrorMessage(null);
    try {
      const selectedEpisodeObj =
        episodeFilter !== 'ALL'
          ? episodes.find((e) => e.id === episodeFilter)
          : undefined;

      const res = await fetch('/api/rag/search', {
        method: 'POST',
        headers: buildAuthHeaders(),
        body: JSON.stringify({
          ownerId: idToken ? undefined : ownerId,
          query: {
            ownerId,
            projectId: activeProject.id,
            queryText: q,
            searchMode,
            onlyCanon,
            includeNonCanonPlaceholder: includeNonCanon,
            includeDrafts,
            sourceEntityTypes:
              sourceTypeFilter !== 'ALL'
                ? ([sourceTypeFilter] as MemorySourceEntityType[])
                : undefined,
            episodeIdFilter:
              episodeFilter !== 'ALL' ? episodeFilter : undefined,
            episodeNumberRange: selectedEpisodeObj
              ? {
                  min: selectedEpisodeObj.episodeNumber,
                  max: selectedEpisodeObj.episodeNumber,
                }
              : undefined,
            characterIds:
              characterFilter !== 'ALL' ? [characterFilter] : undefined,
            topK,
          },
          liveSnapshots: buildLiveSnapshots(),
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || '장기 기억 검색에 실패했습니다.');
      }

      setHits(data.hits || []);
      setSearchMeta({
        embeddingUsed: Boolean(data.embeddingUsed),
        embeddingModelId: data.embeddingModelId || 'gemini-embedding-001',
        vectorSearchMode: data.vectorSearchMode || 'HYBRID_RRF',
        searchLatencyMs: data.searchLatencyMs || 0,
      });
      setHasSearched(true);
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : '장기 기억 검색 중 오류 발생'
      );
    } finally {
      setIsSearching(false);
    }
  };

  const handleOpenSourceModal = async (hit: MemorySearchHit) => {
    setIsLoadingSource(true);
    setErrorMessage(null);
    try {
      const res = await fetch('/api/rag/source', {
        method: 'POST',
        headers: buildAuthHeaders(),
        body: JSON.stringify({
          ownerId: idToken ? undefined : ownerId,
          projectId: activeProject.id,
          documentOrChunkId: hit.chunk.id,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || '출처 상세 조회에 실패했습니다.');
      }
      setSelectedSourceDetail({
        document: data.document,
        chunk: data.chunk,
        hit,
      });
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : '출처 조회 실패');
    } finally {
      setIsLoadingSource(false);
    }
  };

  const handleJumpToManuscriptOrSetting = (hit: MemorySearchHit) => {
    const type = hit.document.sourceEntityType;
    if (
      type === 'EPISODE' ||
      type === 'EPISODE_SUMMARY' ||
      type === 'SCENE' ||
      type === 'CHARACTER_STATE_CHANGE'
    ) {
      const epId =
        hit.document.sourceEpisodeId ||
        hit.chunk.sourceEpisodeId ||
        (type === 'EPISODE' ? hit.document.sourceEntityId : undefined);
      onNavigateToSource({
        tab: 'manuscript',
        episodeId: epId || undefined,
        entityId: hit.document.sourceEntityId,
      });
      return;
    }
    if (type === 'CHARACTER') {
      onNavigateToSource({
        tab: 'characters',
        entityId: hit.document.sourceEntityId,
      });
      return;
    }
    if (type === 'WORLDBUILDING') {
      onNavigateToSource({
        tab: 'worldbuilding',
        entityId: hit.document.sourceEntityId,
      });
      return;
    }
    if (type === 'TIMELINE_EVENT') {
      onNavigateToSource({
        tab: 'timeline',
        entityId: hit.document.sourceEntityId,
      });
      return;
    }
    if (type === 'FORESHADOWING') {
      onNavigateToSource({
        tab: 'foreshadowing',
        entityId: hit.document.sourceEntityId,
      });
      return;
    }
    if (type === 'RELATIONSHIP') {
      onNavigateToSource({
        tab: 'relationships',
        entityId: hit.document.sourceEntityId,
      });
      return;
    }
    onNavigateToSource({ tab: 'dashboard' });
  };

  const presetQueries = [
    characters[0]
      ? `${characters[0].name}의 능력과 부상 또는 신체 제약 조건`
      : '주인공이 다쳤던 부상 사건과 신체 상태',
    worldbuilding[0]
      ? `${worldbuilding[0].title}의 절대 법칙과 제약 조건`
      : '공간 이동 마법 제약과 세계관 절대 법칙',
    episodes[0]
      ? `${episodes[0].title}에서 벌어진 핵심 사건과 대사`
      : '1화에서 일어난 핵심 사건과 등장인물 대사',
  ];

  return (
    <div className="space-y-6" data-testid="memory-search-view">
      {idToken && <NarrativeMemoryPanel key={activeProject.id + ':' + (narrativeFocus?.id ?? '')}
        projectId={activeProject.id} token={idToken} characters={characters} focus={narrativeFocus} />}
      {idToken && <MemoryKnowledgePanel key={activeProject.id} projectId={activeProject.id} token={idToken}
        characters={characters} episodes={episodes} scenes={scenes} events={timelineEvents} />}
      {/* Header & Index Status Banner */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-6 shadow-lg">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
          <div>
            <div className="flex items-center gap-2.5">
              <div className="w-9 h-9 rounded-lg bg-indigo-500/15 border border-indigo-500/30 flex items-center justify-center text-indigo-400">
                <Database className="w-5 h-5" />
              </div>
              <div>
                <h2 className="text-lg font-bold text-slate-100 flex items-center gap-2">
                  AI 장기 기억 검색 엔진 (Persistent Hybrid RAG)
                  <span className="text-xs px-2 py-0.5 rounded bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 font-medium">
                    Phase 3 Vector + RRF
                  </span>
                </h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  수백~수천 화의 확정(CANON) 원고, 등장인물 설정, 세계관 법칙, 사건 기록을 하이브리드(한국어 형태소·키워드 + 768차원 벡터 코사인 유사도)로 검색하고 출처 정합성을 검증합니다.
                </p>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void handleSyncProjectIndex(false)}
              disabled={isSyncing}
              data-testid="rag-sync-btn"
              className="px-3.5 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-medium flex items-center gap-1.5 transition cursor-pointer"
            >
              <RefreshCw
                className={`w-3.5 h-3.5 ${isSyncing ? 'animate-spin' : ''}`}
              />
              증분 색인 동기화
            </button>
            <button
              type="button"
              onClick={() => void handleRequestFullRebuild()}
              disabled={isSyncing}
              data-testid="rag-rebuild-btn"
              className="px-3.5 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-200 border border-slate-700 text-xs font-medium flex items-center gap-1.5 transition cursor-pointer"
            >
              <Layers className="w-3.5 h-3.5 text-amber-400" />
              전체 색인 재구축
            </button>
            {(ragStatus?.statusCounts.FAILED || 0) +
              (ragStatus?.statusCounts.STALE || 0) >
              0 && (
              <button
                type="button"
                onClick={() => void handleRetryFailed()}
                disabled={isSyncing}
                data-testid="rag-retry-failed-btn"
                className="px-3 py-2 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/30 text-xs font-medium flex items-center gap-1.5 transition cursor-pointer"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                실패/구버전 재시도
              </button>
            )}
          </div>
        </div>

        {/* Index Metrics Bar */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mt-5 pt-4 border-t border-slate-800/80">
          <div className="bg-slate-950/70 border border-slate-800/80 rounded-lg p-3">
            <div className="text-[11px] text-slate-400">총 색인 문서 (Documents)</div>
            <div
              className="text-lg font-bold text-slate-100 mt-0.5"
              data-testid="rag-total-docs"
            >
              {ragStatus ? `${ragStatus.totalDocuments}건` : '동기화 중...'}
            </div>
          </div>
          <div className="bg-slate-950/70 border border-slate-800/80 rounded-lg p-3">
            <div className="text-[11px] text-slate-400">총 벡터 청크 (Chunks)</div>
            <div
              className="text-lg font-bold text-indigo-300 mt-0.5"
              data-testid="rag-total-chunks"
            >
              {ragStatus ? `${ragStatus.totalChunks}개` : '-'}
            </div>
          </div>
          <div className="bg-slate-950/70 border border-slate-800/80 rounded-lg p-3">
            <div className="text-[11px] text-slate-400">색인 상태 (INDEXED)</div>
            <div className="text-sm font-semibold text-emerald-400 mt-1 flex items-center gap-1.5">
              <CheckCircle2 className="w-4 h-4" />
              정상 {ragStatus?.statusCounts.INDEXED ?? 0}건
            </div>
          </div>
          <div className="bg-slate-950/70 border border-slate-800/80 rounded-lg p-3">
            <div className="text-[11px] text-slate-400">구버전/실패 (STALE/FAILED)</div>
            <div className="text-sm font-semibold text-amber-300 mt-1 flex items-center gap-1.5">
              <AlertTriangle className="w-4 h-4" />
              STALE {ragStatus?.statusCounts.STALE ?? 0} · 실패{' '}
              {ragStatus?.statusCounts.FAILED ?? 0}
            </div>
          </div>
          <div className="bg-slate-950/70 border border-slate-800/80 rounded-lg p-3">
            <div className="text-[11px] text-slate-400">임베딩 모델 · 차원</div>
            <div className="text-xs font-mono text-slate-200 mt-1 truncate">
              {ragStatus?.embeddingModelId || 'gemini-embedding-001'} (
              {ragStatus?.embeddingDimension || 768}D)
            </div>
          </div>
          <div className="bg-slate-950/70 border border-slate-800/80 rounded-lg p-3">
            <div className="text-[11px] text-slate-400">영구 저장소 구조</div>
            <div className="text-xs text-emerald-300 mt-1 flex items-center gap-1">
              <ShieldCheck className="w-3.5 h-3.5 shrink-0" />
              Firestore + 로컬 스냅샷
            </div>
          </div>
        </div>

        {statusMessage && (
          <div className="mt-4 px-3.5 py-2.5 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-xs flex items-center justify-between">
            <span>{statusMessage}</span>
            <button
              type="button"
              onClick={() => setStatusMessage(null)}
              className="text-emerald-400 hover:text-emerald-200 text-xs ml-3 cursor-pointer"
            >
              닫기
            </button>
          </div>
        )}

        {errorMessage && (
          <div className="mt-4 px-3.5 py-2.5 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs flex items-center justify-between">
            <span className="flex items-center gap-1.5">
              <XCircle className="w-4 h-4 shrink-0" />
              {errorMessage}
            </span>
            <button
              type="button"
              onClick={() => setErrorMessage(null)}
              className="text-rose-400 hover:text-rose-200 text-xs ml-3 cursor-pointer"
            >
              닫기
            </button>
          </div>
        )}
      </div>

      {/* Bulk Rebuild Cost Confirmation Modal */}
      {bulkConfirmEstimate && (
        <div
          className="bg-amber-950/40 border border-amber-500/40 rounded-xl p-5 space-y-3"
          data-testid="rag-bulk-confirm-modal"
        >
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold text-amber-300 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4" />
              전체 장기 기억 색인 재구축 규모 및 예상 비용 확인
            </h3>
            <span className="text-[11px] px-2 py-0.5 rounded bg-amber-500/20 text-amber-200">
              작가 승인 필요
            </span>
          </div>
          <p className="text-xs text-slate-300 leading-relaxed">
            전체 색인 재구축은 현재 작품의 모든 대상 문서를 문단·장면 경계로 다시 분할하고 임베딩 벡터를 재생성합니다. 아래 예상 작업 규모를 확인한 뒤 실행해 주세요.
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
            <div className="bg-slate-900/90 border border-slate-800 rounded-lg p-2.5">
              <div className="text-slate-400">대상 문서 수</div>
              <div className="text-slate-100 font-bold mt-0.5">
                {bulkConfirmEstimate.totalDocuments}건
              </div>
            </div>
            <div className="bg-slate-900/90 border border-slate-800 rounded-lg p-2.5">
              <div className="text-slate-400">예상 생성 청크 수</div>
              <div className="text-indigo-300 font-bold mt-0.5">
                {bulkConfirmEstimate.estimatedChunks}개
              </div>
            </div>
            <div className="bg-slate-900/90 border border-slate-800 rounded-lg p-2.5">
              <div className="text-slate-400">총 글자 수 / 예상 토큰</div>
              <div className="text-slate-100 font-bold mt-0.5">
                {bulkConfirmEstimate.totalCharacters.toLocaleString()}자 / 약{' '}
                {bulkConfirmEstimate.estimatedTokens.toLocaleString()} 토큰
              </div>
            </div>
            <div className="bg-slate-900/90 border border-slate-800 rounded-lg p-2.5">
              <div className="text-slate-400">예상 임베딩 비용</div>
              <div className="text-emerald-300 font-bold mt-0.5">
                ${bulkConfirmEstimate.estimatedCostUsd.toFixed(6)} USD
              </div>
            </div>
          </div>
          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => setBulkConfirmEstimate(null)}
              className="px-3.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs cursor-pointer"
            >
              취소
            </button>
            <button
              type="button"
              onClick={() => void handleExecuteConfirmedRebuild()}
              data-testid="rag-confirm-rebuild-btn"
              className="px-4 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 font-semibold text-xs cursor-pointer"
            >
              규모 확인 및 전체 재구축 승인
            </button>
          </div>
        </div>
      )}

      {/* Search Input & Filters Card */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-6 space-y-4">
        <div className="flex flex-col sm:flex-row gap-2.5">
          <div className="relative flex-1">
            <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={queryText}
              onChange={(e) => setQueryText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  void executeSearch();
                }
              }}
              placeholder="자연어 질문 또는 키워드 입력 (예: 주인공이 처음 부상을 입었던 사건, 붉은 성채의 공간 이동 법칙, 주요 대사...)"
              data-testid="rag-search-input"
              className="w-full pl-10 pr-4 py-2.5 rounded-lg bg-slate-950 border border-slate-700 text-slate-100 text-sm focus:outline-none focus:border-indigo-500"
            />
          </div>
          <button
            type="button"
            onClick={() => void executeSearch()}
            disabled={isSearching}
            data-testid="rag-search-submit"
            className="px-5 py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm font-semibold flex items-center justify-center gap-2 transition cursor-pointer shrink-0"
          >
            <Sparkles className="w-4 h-4" />
            {isSearching ? '검색 중...' : '기억 검색 실행'}
          </button>
        </div>

        {/* Preset Query Chips */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] text-slate-400">빠른 예시 검색:</span>
          {presetQueries.map((pq, idx) => (
            <button
              key={idx}
              type="button"
              onClick={() => void executeSearch(pq)}
              data-testid={`rag-preset-query-${idx}`}
              className="text-xs px-2.5 py-1 rounded-md bg-slate-800/90 hover:bg-slate-700 text-slate-300 border border-slate-700/80 transition cursor-pointer"
            >
              “{pq}”
            </button>
          ))}
        </div>

        {/* Filter Bar */}
        <div className="pt-3 border-t border-slate-800/80 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-3">
          <div>
            <label className="block text-[11px] text-slate-400 mb-1 flex items-center gap-1">
              <SlidersHorizontal className="w-3 h-3" />
              검색 방식 (Search Mode)
            </label>
            <select
              value={searchMode}
              onChange={(e) => setSearchMode(e.target.value as MemorySearchMode)}
              data-testid="rag-mode-select"
              className="w-full px-2.5 py-1.5 rounded-lg bg-slate-950 border border-slate-700 text-xs text-slate-200"
            >
              <option value="HYBRID">하이브리드 (키워드 + 의미 벡터 RRF)</option>
              <option value="SEMANTIC">의미론적 벡터 유사도 (Semantic)</option>
              <option value="KEYWORD">한국어 어간·키워드 매칭 (Keyword)</option>
            </select>
          </div>

          <div>
            <label className="block text-[11px] text-slate-400 mb-1">
              출처 분류 필터
            </label>
            <select
              value={sourceTypeFilter}
              onChange={(e) => setSourceTypeFilter(e.target.value)}
              data-testid="rag-source-type-select"
              className="w-full px-2.5 py-1.5 rounded-lg bg-slate-950 border border-slate-700 text-xs text-slate-200"
            >
              {Object.entries(SOURCE_TYPE_LABELS).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-[11px] text-slate-400 mb-1">
              회차별 필터
            </label>
            <select
              value={episodeFilter}
              onChange={(e) => setEpisodeFilter(e.target.value)}
              data-testid="rag-episode-select"
              className="w-full px-2.5 py-1.5 rounded-lg bg-slate-950 border border-slate-700 text-xs text-slate-200"
            >
              <option value="ALL">전체 회차</option>
              {episodes.map((ep) => (
                <option key={ep.id} value={ep.id}>
                  제{ep.episodeNumber}화 — {ep.title} (
                  {ep.status === 'confirmed' ? '확정' : '초안'})
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-[11px] text-slate-400 mb-1">
              등장인물별 필터
            </label>
            <select
              value={characterFilter}
              onChange={(e) => setCharacterFilter(e.target.value)}
              data-testid="rag-character-select"
              className="w-full px-2.5 py-1.5 rounded-lg bg-slate-950 border border-slate-700 text-xs text-slate-200"
            >
              <option value="ALL">전체 등장인물</option>
              {characters.map((ch) => (
                <option key={ch.id} value={ch.id}>
                  {ch.name} ({ch.role})
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-[11px] text-slate-400 mb-1">
              최대 반환 청크 수 (Top-K)
            </label>
            <select
              value={topK}
              onChange={(e) => setTopK(Number(e.target.value))}
              className="w-full px-2.5 py-1.5 rounded-lg bg-slate-950 border border-slate-700 text-xs text-slate-200"
            >
              <option value={5}>상위 5개 청크</option>
              <option value={8}>상위 8개 청크 (권장)</option>
              <option value={15}>상위 15개 청크</option>
              <option value={25}>상위 25개 청크</option>
            </select>
          </div>
        </div>

        {/* Canon & Exception Toggle Checkboxes */}
        <div className="flex flex-wrap items-center gap-5 pt-2">
          <label className="inline-flex items-center gap-2 text-xs text-slate-200 cursor-pointer">
            <input
              type="checkbox"
              checked={onlyCanon}
              onChange={(e) => {
                setOnlyCanon(e.target.checked);
                if (e.target.checked) {
                  setIncludeDrafts(false);
                }
              }}
              data-testid="rag-only-canon-checkbox"
              className="rounded border-slate-600 bg-slate-900 text-indigo-600"
            />
            <span className="font-medium text-emerald-300">
              확정 설정·확정 원고(CANON)만 보기 (기본값)
            </span>
          </label>

          <label className="inline-flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
            <input
              type="checkbox"
              checked={includeNonCanon}
              onChange={(e) => setIncludeNonCanon(e.target.checked)}
              data-testid="rag-include-noncanon-checkbox"
              className="rounded border-slate-600 bg-slate-900 text-amber-500"
            />
            <span>비정사 일회성 예외(NON_CANON_EXCEPTION) 포함</span>
          </label>

          <label className="inline-flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
            <input
              type="checkbox"
              checked={includeDrafts}
              onChange={(e) => {
                setIncludeDrafts(e.target.checked);
                if (e.target.checked) {
                  setOnlyCanon(false);
                }
              }}
              data-testid="rag-include-drafts-checkbox"
              className="rounded border-slate-600 bg-slate-900 text-indigo-500"
            />
            <span>작성 중 초안(DRAFT/PROPOSED) 포함</span>
          </label>
        </div>
      </div>

      {/* Search Results Section */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-6 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 border-b border-slate-800 pb-3">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-bold text-slate-100">
              장기 기억 검색 결과
            </h3>
            <span
              className="text-xs px-2 py-0.5 rounded bg-slate-800 text-slate-300"
              data-testid="rag-results-count"
            >
              {hits.length}건
            </span>
          </div>

          {searchMeta && (
            <div className="flex flex-wrap items-center gap-3 text-[11px] text-slate-400">
              <span className="flex items-center gap-1">
                <Clock className="w-3.5 h-3.5 text-indigo-400" />
                검색 소요: <strong className="text-slate-200">{searchMeta.searchLatencyMs}ms</strong>
              </span>
              <span>
                검색 엔진: <strong className="text-indigo-300">{searchMeta.vectorSearchMode}</strong>
              </span>
              <span>
                임베딩 모델: <code className="text-slate-300">{searchMeta.embeddingModelId}</code>
              </span>
            </div>
          )}
        </div>

        {!hasSearched ? (
          <div className="py-12 text-center space-y-2 text-slate-400">
            <Search className="w-8 h-8 mx-auto text-slate-600" />
            <p className="text-sm font-medium text-slate-300">
              위 검색창에 사건, 인물, 세계관 규칙, 대사 키워드나 자연어 질문을 입력해 보세요.
            </p>
            <p className="text-xs text-slate-500">
              검색된 청크는 출처 버전(sourceRevisionId)과 오프셋 정합성(FRESH / STALE / SOURCE_UNVERIFIED)을 실시간 검증하여 표시합니다.
            </p>
          </div>
        ) : hits.length === 0 ? (
          <div
            className="py-10 text-center space-y-2 text-slate-400"
            data-testid="rag-empty-results"
          >
            <AlertTriangle className="w-7 h-7 mx-auto text-amber-400/80" />
            <p className="text-sm font-semibold text-slate-200">
              검색 조건과 일치하는 장기 기억 근거가 없습니다.
            </p>
            <p className="text-xs text-slate-400">
              NOVEL FORGE는 존재하지 않는 과거 사건이나 설정을 임의로 날조하지 않고 빈 결과를 반환합니다.
            </p>
          </div>
        ) : (
          <div className="space-y-3" data-testid="rag-results-list">
            {hits.map((hit, idx) => {
              const doc = hit.document;
              const chunk = hit.chunk;
              const freshness = hit.freshnessStatus || 'FRESH';
              const isFresh = freshness === 'FRESH';

              return (
                <div
                  key={chunk.id}
                  data-testid={`rag-hit-card-${idx}`}
                  className="bg-slate-950/90 border border-slate-800 hover:border-slate-700 rounded-xl p-4 space-y-3 transition"
                >
                  <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs font-bold px-2 py-0.5 rounded bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
                        #{idx + 1} · 관련도 {(hit.relevanceScore * 100).toFixed(1)}%
                      </span>
                      <span className="text-xs px-2 py-0.5 rounded bg-slate-800 text-slate-200 font-medium flex items-center gap-1">
                        {doc.sourceEntityType === 'CHARACTER' ||
                        doc.sourceEntityType === 'CHARACTER_STATE_CHANGE' ? (
                          <Users className="w-3 h-3 text-sky-400" />
                        ) : doc.sourceEntityType === 'WORLDBUILDING' ? (
                          <Globe className="w-3 h-3 text-amber-400" />
                        ) : (
                          <BookOpen className="w-3 h-3 text-indigo-400" />
                        )}
                        {SOURCE_TYPE_LABELS[doc.sourceEntityType] ||
                          doc.sourceEntityType}
                      </span>
                      <span
                        className={`text-[11px] px-2 py-0.5 rounded font-semibold ${
                          doc.canonStatus === 'CANON'
                            ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                            : 'bg-amber-500/15 text-amber-300 border border-amber-500/30'
                        }`}
                      >
                        {doc.canonStatus}
                      </span>
                      <span
                        className={`text-[11px] px-2 py-0.5 rounded font-medium ${
                          isFresh
                            ? 'bg-emerald-950/80 text-emerald-300 border border-emerald-700/50'
                            : freshness === 'STALE'
                            ? 'bg-amber-950/80 text-amber-300 border border-amber-700/50'
                            : 'bg-rose-950/80 text-rose-300 border border-rose-700/50'
                        }`}
                      >
                        {isFresh
                          ? 'FRESH (출처 최신 정합)'
                          : freshness === 'STALE'
                          ? 'STALE (원본 수정됨·재색인 권장)'
                          : 'SOURCE_UNVERIFIED (출처 미확인)'}
                      </span>
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void handleOpenSourceModal(hit)}
                        disabled={isLoadingSource}
                        className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs flex items-center gap-1 transition cursor-pointer"
                      >
                        <Eye className="w-3.5 h-3.5 text-indigo-400" />
                        출처 상세
                      </button>
                      <button
                        type="button"
                        onClick={() => handleJumpToManuscriptOrSetting(hit)}
                        data-testid={`rag-jump-btn-${idx}`}
                        className="px-2.5 py-1 rounded-lg bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-300 border border-indigo-500/30 text-xs font-medium flex items-center gap-1 transition cursor-pointer"
                      >
                        해당 원고/설정으로 이동
                        <ArrowUpRight className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>

                  <div>
                    <h4 className="text-sm font-semibold text-slate-100">
                      {doc.title}
                      {typeof chunk.episodeNumber === 'number' && (
                        <span className="ml-2 text-xs font-normal text-indigo-300">
                          (제{chunk.episodeNumber}화 · 청크 #{chunk.chunkIndex + 1})
                        </span>
                      )}
                    </h4>
                    <div className="mt-2 p-3 rounded-lg bg-slate-900/90 border border-slate-800/90 text-xs text-slate-200 leading-relaxed whitespace-pre-wrap">
                      {chunk.originalText || chunk.chunkText}
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-400 pt-1">
                    <div className="flex flex-wrap items-center gap-3">
                      <span>
                        출처 ID: <code className="text-slate-300">{doc.sourceEntityId}</code>
                      </span>
                      <span>
                        버전 ID:{' '}
                        <code className="text-slate-300">{chunk.sourceRevisionId}</code>
                      </span>
                      <span>
                        원문 오프셋:{' '}
                        <code className="text-slate-300">
                          {chunk.sourceStartOffset ?? 0}~
                          {chunk.sourceEndOffset ??
                            (chunk.chunkText || chunk.content || '').length}
                          자
                        </code>
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {typeof hit.keywordScore === 'number' && (
                        <span>키워드 점수: {(hit.keywordScore * 100).toFixed(0)}%</span>
                      )}
                      {typeof hit.semanticScore === 'number' && (
                        <span>벡터 유사도: {(hit.semanticScore * 100).toFixed(0)}%</span>
                      )}
                      {hit.retrievalSource && (
                        <span>
                          {hit.retrievalSource === 'KEYWORD_ONLY' ? '키워드' :
                            hit.retrievalSource === 'FIRESTORE_VECTOR_ONLY' ? 'Firestore 벡터' :
                            hit.retrievalSource === 'LOCAL_HYBRID' ? '로컬 혼합' : 'Firestore 벡터·키워드 혼합'}
                        </span>
                      )}
                      {hit.vectorRank !== undefined && <span>벡터 순위 {hit.vectorRank}</span>}
                      {hit.keywordRank !== undefined && <span>키워드 순위 {hit.keywordRank}</span>}
                      {hit.matchedTerms.length > 0 && (
                        <span className="text-indigo-300">
                          매칭 키워드: {hit.matchedTerms.slice(0, 6).join(', ')}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Source Document Detail Modal */}
      {selectedSourceDetail && (
        <div
          className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4"
          data-testid="rag-source-modal"
        >
          <div className="bg-slate-900 border border-slate-700 rounded-xl max-w-2xl w-full max-h-[85vh] flex flex-col shadow-2xl">
            <div className="p-4 border-b border-slate-800 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <FileText className="w-4 h-4 text-indigo-400" />
                <h3 className="text-sm font-bold text-slate-100">
                  기억 문서 및 청크 출처 검증 상세 정보
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setSelectedSourceDetail(null)}
                className="text-xs px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 cursor-pointer"
              >
                닫기
              </button>
            </div>
            <div className="p-5 overflow-y-auto space-y-4 text-xs">
              <div className="grid grid-cols-2 gap-3 bg-slate-950 p-3.5 rounded-lg border border-slate-800">
                <div>
                  <span className="text-slate-400 block">문서 제목</span>
                  <span className="text-slate-100 font-semibold">
                    {selectedSourceDetail.document.title}
                  </span>
                </div>
                <div>
                  <span className="text-slate-400 block">출처 엔티티 분류 / ID</span>
                  <span className="text-slate-200 font-mono">
                    {selectedSourceDetail.document.sourceEntityType} /{' '}
                    {selectedSourceDetail.document.sourceEntityId}
                  </span>
                </div>
                <div>
                  <span className="text-slate-400 block">확정 상태 / 색인 상태</span>
                  <span className="text-emerald-300 font-semibold">
                    {selectedSourceDetail.document.canonStatus} ·{' '}
                    {selectedSourceDetail.document.indexStatus || 'INDEXED'}
                  </span>
                </div>
                <div>
                  <span className="text-slate-400 block">원본 버전(sourceRevisionId) / 해시</span>
                  <span className="text-slate-200 font-mono">
                    {selectedSourceDetail.document.sourceRevisionId} (
                    {selectedSourceDetail.document.contentHash || '-'})
                  </span>
                </div>
                <div>
                  <span className="text-slate-400 block">임베딩 모델 / 차원</span>
                  <span className="text-indigo-300 font-mono">
                    {selectedSourceDetail.document.embeddingModelId} (
                    {selectedSourceDetail.document.embeddingDimension}D)
                  </span>
                </div>
                <div>
                  <span className="text-slate-400 block">청크 오프셋 범위</span>
                  <span className="text-slate-200 font-mono">
                    {selectedSourceDetail.chunk?.sourceStartOffset ?? 0}자 ~{' '}
                    {selectedSourceDetail.chunk?.sourceEndOffset ?? 0}자 (청크 #
                    {(selectedSourceDetail.chunk?.chunkIndex ?? 0) + 1})
                  </span>
                </div>
              </div>

              <div>
                <div className="text-slate-400 mb-1.5 font-medium">
                  검출된 청크 원문 (originalText)
                </div>
                <div className="p-3.5 rounded-lg bg-slate-950 border border-slate-800 text-slate-100 leading-relaxed whitespace-pre-wrap">
                  {selectedSourceDetail.chunk?.originalText ||
                    selectedSourceDetail.chunk?.chunkText}
                </div>
              </div>

              <div>
                <div className="text-slate-400 mb-1.5 font-medium">
                  문서 요약 및 키워드 태그
                </div>
                <div className="p-3 rounded-lg bg-slate-950 border border-slate-800 text-slate-300 space-y-2">
                  <p>{selectedSourceDetail.document.summary}</p>
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {(selectedSourceDetail.document.keywordTags || []).map(
                      (tag, i) => (
                        <span
                          key={i}
                          className="px-2 py-0.5 rounded bg-slate-800 text-slate-300 text-[11px]"
                        >
                          #{tag}
                        </span>
                      )
                    )}
                  </div>
                </div>
              </div>
            </div>
            <div className="p-4 border-t border-slate-800 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  const hit = selectedSourceDetail.hit;
                  setSelectedSourceDetail(null);
                  handleJumpToManuscriptOrSetting(hit);
                }}
                className="px-4 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium cursor-pointer"
              >
                해당 원고/설정 편집기로 이동
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
