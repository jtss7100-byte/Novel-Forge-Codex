import type { WritingPlan } from '../../../types/novel';
import { setDoc, doc, serverTimestamp, updateDoc } from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../../../firebase';
import { sanitizeStringTags } from '../../../utils/foundationLogic';
import { sanitizeIdArray } from '../../../utils/novelValidation';

export async function createFirestoreWritingPlan(
  uid: string,
  projectId: string,
  plan: WritingPlan
): Promise<void> {
  const path = `users/${uid}/projects/${projectId}/writingPlans/${plan.id}`;
  try {
    await setDoc(doc(db, path), {
      id: plan.id,
      ownerId: uid,
      projectId,
      episodeId: plan.episodeId,
      episodeTitle: plan.episodeTitle.slice(0, 200),
      episodeGoal: plan.episodeGoal.slice(0, 2000),
      requiredEvents: sanitizeStringTags(plan.requiredEvents, 30),
      forbiddenDevelopments: sanitizeStringTags(plan.forbiddenDevelopments, 30),
      targetTotalCharCount: Math.max(100, Math.min(100000, Math.round(plan.targetTotalCharCount))),
      narrativePerspective: plan.narrativePerspective,
      scenes: (plan.scenes || []).slice(0, 30),
      plotDeviationWarnings: sanitizeStringTags(plan.plotDeviationWarnings, 20),
      appliedPromptVersionIds: sanitizeIdArray(plan.appliedPromptVersionIds),
      referencedSourceIds: sanitizeIdArray(plan.referencedSourceIds),
      modelId: (plan.modelId || 'gemini-3.8-flash').slice(0, 80),
      status: plan.status,
      approvedAt: plan.approvedAt || '',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function updateFirestoreWritingPlan(
  uid: string,
  projectId: string,
  plan: WritingPlan
): Promise<void> {
  const path = `users/${uid}/projects/${projectId}/writingPlans/${plan.id}`;
  try {
    await updateDoc(doc(db, path), {
      episodeTitle: plan.episodeTitle.slice(0, 200),
      episodeGoal: plan.episodeGoal.slice(0, 2000),
      requiredEvents: sanitizeStringTags(plan.requiredEvents, 30),
      forbiddenDevelopments: sanitizeStringTags(plan.forbiddenDevelopments, 30),
      targetTotalCharCount: Math.max(100, Math.min(100000, Math.round(plan.targetTotalCharCount))),
      narrativePerspective: plan.narrativePerspective,
      scenes: (plan.scenes || []).slice(0, 30),
      plotDeviationWarnings: sanitizeStringTags(plan.plotDeviationWarnings, 20),
      appliedPromptVersionIds: sanitizeIdArray(plan.appliedPromptVersionIds),
      referencedSourceIds: sanitizeIdArray(plan.referencedSourceIds),
      status: plan.status,
      approvedAt: plan.approvedAt || '',
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}
