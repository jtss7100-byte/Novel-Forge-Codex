import type {
  ActorType,
  AdvancedFoundationCollections,
  CanonStatus,
} from './foundation';
import type {
  PromptProfile,
  WritingPlan,
  WritingResult,
} from './aiEngine';
import type { ChangeProposalApprovalAudit } from './changeProposalApproval';

export * from './foundation';
export * from './aiEngine';
export * from './manuscriptExtraction';
export * from './changeProposalApproval';
export * from './literaryQuality';
export * from './literaryRewriting';
export * from './authorStyle';
export type {
  BulkIndexingCostEstimate,
  IndexingScaleEstimate,
  LiveSourceSnapshotMap,
  MemoryIndexInput,
  MemoryIndexResult,
  MemorySearchHit,
  MemorySearchProvider,
  MemorySearchQuery,
  MemorySourceReference,
  ProjectRagStatusSummary,
} from '../services/memorySearchProvider';


export type SettingStatus = 'draft' | 'confirmed';
export type EpisodeStatus = 'draft' | 'review' | 'confirmed';
export type SaveState = 'idle' | 'saving' | 'saved' | 'error' | 'recovered';
export type NavTab =
  | 'dashboard'
  | 'manuscript'
  | 'ai_extraction'
  | 'proposal_review'
  | 'memory_search'
  | 'characters'
  | 'relationships'
  | 'timeline'
  | 'foreshadowing'
  | 'worldbuilding'
  | 'prompts'
  | 'settings';

export interface Project {
  id: string;
  ownerId: string;
  title: string;
  genre: string;
  synopsis: string;
  status: SettingStatus;
  canonStatus?: CanonStatus;
  createdAt: string;
  updatedAt: string;
}

export interface Character {
  id: string;
  ownerId: string;
  projectId: string;
  name: string;
  role: string;
  affiliation: string;
  appearance: string;
  personality: string;
  background: string;
  abilities: string;
  status: SettingStatus;
  canonStatus?: CanonStatus;
  linkedEpisodeIds: string[];
  linkedWorldbuildingIds: string[];
  linkedSceneIds?: string[];
  linkedEventIds?: string[];
  linkedForeshadowingIds?: string[];
  sourceRevisionId?: string;
  createdBy?: ActorType;
  createdAt: string;
  updatedAt: string;
}

export interface WorldbuildingItem {
  id: string;
  ownerId: string;
  projectId: string;
  title: string;
  category: string;
  summary: string;
  content: string;
  rules: string;
  status: SettingStatus;
  canonStatus?: CanonStatus;
  linkedCharacterIds: string[];
  linkedEpisodeIds: string[];
  linkedEventIds?: string[];
  linkedForeshadowingIds?: string[];
  sourceRevisionId?: string;
  createdBy?: ActorType;
  createdAt: string;
  updatedAt: string;
}

export interface Episode {
  id: string;
  ownerId: string;
  projectId: string;
  episodeNumber: number;
  title: string;
  content: string;
  synopsis: string;
  authorNote: string;
  charCountWithSpaces: number;
  charCountWithoutSpaces: number;
  status: EpisodeStatus;
  canonStatus?: CanonStatus;
  linkedCharacterIds: string[];
  linkedWorldbuildingIds: string[];
  linkedSceneIds?: string[];
  linkedEventIds?: string[];
  linkedForeshadowingIds?: string[];
  latestRevisionId?: string;
  contentHash?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Revision {
  id: string;
  ownerId: string;
  projectId: string;
  episodeId: string;
  episodeTitle: string;
  content: string;
  charCountWithSpaces: number;
  label: string;
  createdBy?: ActorType;
  createdAt: string;
}

export interface ProjectBundle extends AdvancedFoundationCollections {
  formatVersion: '1.0' | '1.5';
  exportedAt: string;
  project: Project;
  characters: Character[];
  worldbuilding: WorldbuildingItem[];
  episodes: Episode[];
  revisions: Revision[];
  writingPlans?: WritingPlan[];
  writingPromptProfiles?: PromptProfile[];
  generationRuns?: WritingResult[];
  approvalAudits?: ChangeProposalApprovalAudit[];
}

export interface EmergencyDraftBackup {
  projectId: string;
  episodeId: string;
  title: string;
  content: string;
  synopsis: string;
  authorNote: string;
  status: EpisodeStatus;
  savedAt: string;
  reason: 'typing_buffer' | 'save_error';
  errorMessage?: string;
}

export interface ServerAuthStatus {
  verified: boolean;
  uid?: string;
  email?: string;
  emailVerified?: boolean;
  mode: 'firebase_id_token' | 'unauthenticated';
  verifiedAt?: string;
  message: string;
}
