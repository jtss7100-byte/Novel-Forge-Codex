import {
  getConfiguredWritingModel,
  isGeminiApiKeyReady,
} from './geminiWritingEngine.ts';
import {
  getConfiguredEmbeddingDimension,
  getConfiguredEmbeddingModel,
} from './ragEngine.ts';

export interface EngineContextPayload {
  projectId: string;
  episodeId: string;
  confirmedCharactersCount: number;
  confirmedWorldbuildingCount: number;
}

export interface EngineModuleDescriptor {
  id: string;
  name: string;
  koreanTitle: string;
  phase: 'phase_2_active' | 'phase_3_active';
  status: 'active';
  description: string;
  requiredCollections: string[];
}

export function getEngineArchitectureStatus() {
  const hasServerApiKey = isGeminiApiKeyReady();
  const configuredModel = getConfiguredWritingModel();
  const embeddingModel = getConfiguredEmbeddingModel();
  const embeddingDimension = getConfiguredEmbeddingDimension();

  const modules: EngineModuleDescriptor[] = [
    {
      id: 'plot_planner',
      name: 'Module A — Plot Planner',
      koreanTitle: 'A. 장면 기획기 (Plot Planner)',
      phase: 'phase_2_active',
      status: 'active',
      description:
        '작가가 입력한 사건과 목표, 확정(CANON) 설정, 직전 회차 요약을 분석하여 승인 전 단계의 장면별 집필 기획안(WritingPlan)을 생성합니다.',
      requiredCollections: ['episodes', 'characters', 'worldbuilding', 'writingPlans'],
    },
    {
      id: 'novel_writer',
      name: 'Module B — Novel Writer + RAG Evidence',
      koreanTitle: 'B. 본문 집필기 (Novel Writer · RAG 장기 기억 연동)',
      phase: 'phase_3_active',
      status: 'active',
      description:
        '작가가 승인한 기획안, 확정(CANON) 장기 기억(RAG) 검색 근거, 문체·말투 프롬프트를 기반으로 순수 한국어 웹소설 원고를 생성합니다.',
      requiredCollections: [
        'episodes',
        'writingPlans',
        'writingPromptProfiles',
        'memoryDocuments',
        'memoryChunks',
      ],
    },
    {
      id: 'style_editor',
      name: 'Module C — Style Editor',
      koreanTitle: 'C. 문체 교정기 (Style Editor)',
      phase: 'phase_2_active',
      status: 'active',
      description:
        '작품별 문체 프로필을 최우선 기준으로 삼아 번역투, 반복 문장, 시점 흔들림, 대사 호흡에 대한 수정 제안(WritingIssue)을 생성합니다.',
      requiredCollections: ['styleProfiles', 'writingPromptProfiles'],
    },
    {
      id: 'continuity_checker',
      name: 'Module D — Continuity Checker',
      koreanTitle: 'D. 설정 충돌 검사기 (Continuity Checker)',
      phase: 'phase_2_active',
      status: 'active',
      description:
        '확정(CANON) 설정을 근거로 인물 상태, 위치, 소지품, 세계관 법칙 충돌을 CONFIRMED_CONFLICT / POTENTIAL_CONFLICT / INSUFFICIENT_DATA 3단계로 검증합니다.',
      requiredCollections: ['characters', 'worldbuilding', 'episodes'],
    },
    {
      id: 'memory_curator',
      name: 'Module E — Memory Curator & RAG Indexer',
      koreanTitle: 'E. 장기 기억 관리자 및 RAG 색인기 (Memory Curator & RAG Engine)',
      phase: 'phase_3_active',
      status: 'active',
      description:
        '원고 확정 시 회차 요약과 인물 상태 변화를 기록·벡터 색인하고 신규 설정 후보를 PROPOSED 상태의 ChangeProposal로 추출합니다.',
      requiredCollections: [
        'episodes',
        'changeProposals',
        'memoryDocuments',
        'memoryChunks',
      ],
    },
    {
      id: 'prompt_manager',
      name: 'Module F — Prompt Manager',
      koreanTitle: 'F. 프롬프트 관리기 (Prompt Manager)',
      phase: 'phase_2_active',
      status: 'active',
      description:
        'NOVEL FORGE — Master Writing Rules(v1.0)를 포함한 5대 집필·검수 프롬프트의 등록, 수정, 버전 기록 및 복원을 관리합니다.',
      requiredCollections: ['writingPromptProfiles'],
    },
  ];

  const foundationSystems = [
    {
      id: 'foreshadowing_system',
      entity: 'Foreshadowing',
      koreanTitle: '복선 추적 시스템 (Foreshadowing)',
      collection: 'foreshadowings',
      hierarchyLink: 'User → Project → Episode → Scene → Event → Character → Foreshadowing',
    },
    {
      id: 'relationship_system',
      entity: 'CharacterRelationship',
      koreanTitle: '인물 관계도 및 호감도 변화 (CharacterRelationship)',
      collection: 'relationships',
      hierarchyLink: 'Project → Character(Source/Target) → Episode → Event',
    },
    {
      id: 'timeline_system',
      entity: 'TimelineEvent',
      koreanTitle: '작품 연표 및 사건 기록 (TimelineEvent)',
      collection: 'timelineEvents',
      hierarchyLink: 'Project → Episode → Scene → Event → Character / Foreshadowing',
    },
    {
      id: 'memory_rag_system',
      entity: 'MemoryDocument / MemoryChunk',
      koreanTitle: '영구 장기 기억 및 하이브리드 RAG 엔진 (Persistent RAG Engine)',
      collection: 'memoryDocuments / memoryChunks',
      hierarchyLink: 'SourceEntity → RevisionId → MemoryDocument → MemoryChunk(Vector 768D)',
    },
    {
      id: 'style_profile_system',
      entity: 'StyleProfile',
      koreanTitle: '작가 문체 및 서술 시점 프로필 (StyleProfile)',
      collection: 'styleProfiles',
      hierarchyLink: 'Project → RevisionId → StyleProfile',
    },
    {
      id: 'change_proposal_system',
      entity: 'ChangeProposal',
      koreanTitle: 'AI 설정 변경 승인 요청 및 확정 보호 (ChangeProposal)',
      collection: 'changeProposals',
      hierarchyLink: 'AI_ENGINE Proposal → AUTHOR Approval → CANON Promotion',
    },
  ];

  return {
    serverSecretIsolated: true,
    geminiApiKeyConfiguredOnServer: hasServerApiKey,
    configuredModel,
    embeddingModel,
    embeddingDimension,
    ragEngineReady: true,
    currentStage: 'STAGE_3_PERSISTENT_RAG_MEMORY_ENGINE',
    canonStatuses: ['DRAFT', 'PROPOSED', 'CANON', 'NON_CANON_EXCEPTION', 'REJECTED', 'ARCHIVED'],
    canonProtectionEnabled: true,
    memorySearchProviderMethods: ['indexDocument', 'deleteDocument', 'search', 'getSource'],
    foundationSystems,
    modules,
  };
}

