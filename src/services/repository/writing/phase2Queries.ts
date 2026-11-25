import { firestoreProjectPath } from '../core/projectPath';
import type { PromptProfile, WritingPlan, ChangeProposal } from '../../../types/novel';
import { getDocs, query, collection, where } from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../../../firebase';
import { toIsoString } from '../core/firestoreTimestamp';
import { sanitizeIdArray } from '../../../utils/novelValidation';
import { normalizeToCanonStatus } from '../../../utils/foundationLogic';
import { ensureMasterWritingRulesRegistered } from '../../../utils/aiEngineLogic';

export async function fetchFirestorePhase2Collections(
  uid: string,
  projectId: string,
  options: { includeChangeProposals?: boolean } = {}
): Promise<{
  writingPromptProfiles: PromptProfile[];
  writingPlans: WritingPlan[];
  changeProposals: ChangeProposal[];
}> {
  const basePath = firestoreProjectPath(uid, projectId);
  const writingPromptProfiles: PromptProfile[] = [];
  const writingPlans: WritingPlan[] = [];
  const changeProposals: ChangeProposal[] = [];

  try {
    const snap = await getDocs(
      query(collection(db, `${basePath}/writingPromptProfiles`), where('ownerId', '==', uid))
    );
    for (const d of snap.docs) {
      const data = d.data();
      writingPromptProfiles.push({
        id: String(data.id ?? d.id),
        ownerId: String(data.ownerId ?? uid),
        projectId: String(data.projectId ?? projectId),
        promptType:
          data.promptType === 'PROJECT_STYLE_PROFILE' ||
          data.promptType === 'CHARACTER_DIALOGUE_RULES' ||
          data.promptType === 'SCENE_INSTRUCTIONS' ||
          data.promptType === 'REVIEW_RULES'
            ? data.promptType
            : 'CORE_WRITING_RULES',
        title: String(data.title ?? ''),
        description: String(data.description ?? ''),
        targetCharacterId: data.targetCharacterId ? String(data.targetCharacterId) : undefined,
        content: String(data.content ?? ''),
        isActive: Boolean(data.isActive),
        currentVersionId: String(data.currentVersionId ?? 'pver_1'),
        currentVersionNumber: Number(data.currentVersionNumber ?? 1),
        versions: Array.isArray(data.versions) ? data.versions : [],
        createdAt: toIsoString(data.createdAt),
        updatedAt: toIsoString(data.updatedAt),
      });
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, `${basePath}/writingPromptProfiles`);
  }

  try {
    const snap = await getDocs(
      query(collection(db, `${basePath}/writingPlans`), where('ownerId', '==', uid))
    );
    for (const d of snap.docs) {
      const data = d.data();
      writingPlans.push({
        id: String(data.id ?? d.id),
        ownerId: String(data.ownerId ?? uid),
        projectId: String(data.projectId ?? projectId),
        episodeId: String(data.episodeId ?? ''),
        episodeTitle: String(data.episodeTitle ?? ''),
        episodeGoal: String(data.episodeGoal ?? ''),
        requiredEvents: Array.isArray(data.requiredEvents)
          ? data.requiredEvents.map(String)
          : [],
        forbiddenDevelopments: Array.isArray(data.forbiddenDevelopments)
          ? data.forbiddenDevelopments.map(String)
          : [],
        targetTotalCharCount: Number(data.targetTotalCharCount ?? 5000),
        narrativePerspective:
          data.narrativePerspective === 'FIRST_PERSON' ||
          data.narrativePerspective === 'OMNISCIENT' ||
          data.narrativePerspective === 'MIXED'
            ? data.narrativePerspective
            : 'THIRD_LIMITED',
        scenes: Array.isArray(data.scenes) ? data.scenes : [],
        plotDeviationWarnings: Array.isArray(data.plotDeviationWarnings)
          ? data.plotDeviationWarnings.map(String)
          : [],
        appliedPromptVersionIds: sanitizeIdArray(data.appliedPromptVersionIds),
        referencedSourceIds: sanitizeIdArray(data.referencedSourceIds),
        modelId: String(data.modelId ?? 'gemini-3.8-flash'),
        status:
          data.status === 'APPROVED' || data.status === 'SUPERSEDED'
            ? data.status
            : 'DRAFT_PLAN',
        approvedAt: data.approvedAt ? String(data.approvedAt) : undefined,
        createdAt: toIsoString(data.createdAt),
        updatedAt: toIsoString(data.updatedAt),
      });
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, `${basePath}/writingPlans`);
  }

  if (options.includeChangeProposals !== false) {
    try {
      const snap = await getDocs(
        query(collection(db, `${basePath}/changeProposals`), where('ownerId', '==', uid))
      );
      for (const d of snap.docs) {
        const data = d.data();
        changeProposals.push({
          id: String(data.id ?? d.id),
          ownerId: String(data.ownerId ?? uid),
          projectId: String(data.projectId ?? projectId),
          targetEntityType:
            data.targetEntityType === 'WORLDBUILDING' ||
            data.targetEntityType === 'EPISODE' ||
            data.targetEntityType === 'SCENE' ||
            data.targetEntityType === 'FORESHADOWING' ||
            data.targetEntityType === 'RELATIONSHIP' ||
            data.targetEntityType === 'TIMELINE_EVENT' ||
            data.targetEntityType === 'STYLE_PROFILE'
              ? data.targetEntityType
              : 'CHARACTER',
          targetEntityId: String(data.targetEntityId ?? ''),
          proposedAction:
            data.proposedAction === 'CREATE' || data.proposedAction === 'ARCHIVE'
              ? data.proposedAction
              : 'UPDATE',
          title: String(data.title ?? ''),
          rationale: String(data.rationale ?? ''),
          beforeSummary: String(data.beforeSummary ?? ''),
          afterSummary: String(data.afterSummary ?? ''),
          proposedPayloadJson: String(data.proposedPayloadJson ?? '{}'),
          canonStatus: normalizeToCanonStatus(data.canonStatus),
          triggerEpisodeId: String(data.triggerEpisodeId ?? ''),
          triggerSceneId: String(data.triggerSceneId ?? ''),
          sourceRevisionId: String(data.sourceRevisionId ?? ''),
          createdBy:
            data.createdBy === 'AUTHOR' || data.createdBy === 'SYSTEM'
              ? data.createdBy
              : 'AI_ENGINE',
          reviewedAt: String(data.reviewedAt ?? ''),
          createdAt: toIsoString(data.createdAt),
          updatedAt: toIsoString(data.updatedAt),
        });
      }
    } catch (error) {
      handleFirestoreError(error, OperationType.LIST, `${basePath}/changeProposals`);
    }
  }

  const normalizedProfiles =
    writingPromptProfiles.length > 0
      ? ensureMasterWritingRulesRegistered(writingPromptProfiles, uid, projectId)
      : [];

  return {
    writingPromptProfiles: normalizedProfiles,
    writingPlans,
    changeProposals,
  };
}
