// Public compatibility entry point for storage consumers.
export {
  LOCAL_BUNDLES_KEY,
  saveEmergencyDraft,
  getEmergencyDraft,
  clearEmergencyDraft,
  listAllEmergencyDrafts,
  loadLocalBundles,
  saveLocalBundles,
  type LocalStorageLike,
} from './repository/local/localProjectStore';
export { fetchFirestoreProjects, fetchFirestoreProjectDetails } from './repository/project/projectQueries';
export {
  createFirestoreProject,
  updateFirestoreProject,
  deleteFirestoreProjectCascade,
} from './repository/project/projectMutations';
export {
  createFirestoreCharacter,
  updateFirestoreCharacter,
  deleteFirestoreCharacter,
  createFirestoreWorldbuilding,
  updateFirestoreWorldbuilding,
  deleteFirestoreWorldbuilding,
  createFirestoreScene,
  updateFirestoreScene,
  deleteFirestoreScene,
  createFirestoreForeshadowing,
  updateFirestoreForeshadowing,
  deleteFirestoreForeshadowing,
  createFirestoreRelationship,
  updateFirestoreRelationship,
  deleteFirestoreRelationship,
  createFirestoreTimelineEvent,
  updateFirestoreTimelineEvent,
  deleteFirestoreTimelineEvent,
} from './repository/lore/loreRepository';
export {
  createFirestoreEpisode,
  updateFirestoreEpisode,
  commitEpisodeRevisionSafelyFirestore,
  deleteFirestoreEpisode,
  createFirestoreRevision,
  deleteFirestoreRevision,
} from './repository/episode/episodeRepository';
export {
  type EpisodeRevisionCasConflictCode,
  EpisodeRevisionCasConflictError,
  type EpisodeRevisionCommitInput,
  type EpisodeRevisionCommitResult,
  type AtomicEpisodeCasTxAdapter,
  executeAtomicEpisodeCasCommitCore,
} from './repository/episode/episodeCas';
export { commitEpisodeRevisionSafelyLocal } from './repository/episode/localEpisodeRepository';
export { uploadProjectBundleToFirestore } from './repository/backup/projectBundleImport';
export { createFirestoreMemoryDocument, createFirestoreMemoryChunk } from './repository/memory/memoryRepository';
export {
  createFirestoreStyleProfile,
  updateFirestoreStyleProfile,
  type AtomicStylePersistenceOptions,
  persistApprovedStyleDnaAtomicallyCore,
  persistApprovedStyleDnaAtomicallyFirestore,
  persistApprovedStyleDnaAtomicallyLocal,
} from './repository/writing/styleProfileRepository';
export {
  classifyFirestorePersistenceError,
  canonicalizeProposedPayloadJson,
  type NormalizedProposalValidationResult,
  normalizeAndValidateChangeProposalPayload,
  validateProposalBeforeFirestoreWrite,
  areProposalsSemanticallyEquivalent,
  buildCanonicalChangeProposalWriteDataFromNormalized,
} from './repository/proposals/proposalValidation';
export {
  createFirestoreChangeProposal,
  persistSingleFirestoreProposalAtomically,
  persistFirestoreChangeProposalsIdempotently,
  updateFirestoreChangeProposal,
  fetchFirestoreApprovalAudits,
} from './repository/proposals/changeProposalRepository';
export {
  type AtomicProposalPersistenceOutcome,
  type SourceRevisionVerificationOutcome,
  type IdempotentProposalPersistenceAdapter,
  verifyPersistedRevisionSnapshot,
  persistChangeProposalsIdempotentlyCore,
  formatProposalPersistenceErrorSummaryKo,
} from './repository/proposals/proposalPersistenceCore';
export { fetchFirestoreFoundationCollections } from './repository/lore/foundationQueries';
export {
  createFirestorePromptProfile,
  updateFirestorePromptProfile,
  deleteFirestorePromptProfile,
  fetchFirestorePromptProfileById,
  updatePromptProfileWithCasCore,
  updateFirestorePromptProfileWithCas,
  saveCharacterVoicePromptCore,
  saveFirestoreCharacterVoicePrompt,
  updateLocalPromptProfileWithCas,
} from './repository/writing/promptProfileRepository';
export {
  parsePromptProfileFromFirestoreData,
  parseStyleProfileFromFirestoreData,
  validatePromptProfileForFirestoreSchema,
  validateStyleProfileForFirestoreSchema,
  classifyStylePersistenceError,
} from './repository/writing/profileValidation';
export { createFirestoreWritingPlan, updateFirestoreWritingPlan } from './repository/writing/writingPlanRepository';
export { fetchFirestorePhase2Collections } from './repository/writing/phase2Queries';
