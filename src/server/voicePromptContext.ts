import type { WritingContextBundle } from '../types/aiEngine';
import { isEligibleDialoguePrompt, isScopedVoicePrompt } from '../utils/voicePromptScope';
import { getVoiceFirestore, VoiceRequestError } from './characterVoiceAnalyzer';

const safeId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);

export async function resolveVoicePromptContext(context: WritingContextBundle, ownerId: string, cloud: boolean) {
  const activePrompts = Array.isArray(context.activePrompts) ? context.activePrompts : [];
  const sceneCharacterIds = Array.isArray(context.sceneCharacterIds)
    ? [...new Set(context.sceneCharacterIds.filter(safeId))].slice(0, 80) : [];
  const voicePrompts = activePrompts.filter((profile) => profile.promptType === 'CHARACTER_DIALOGUE_RULES' || isScopedVoicePrompt(profile));
  if (!voicePrompts.length) return { ...context, ownerId, sceneCharacterIds, activePrompts };
  const scope = { ownerId, projectId: context.projectId, characterIds: sceneCharacterIds };
  let eligible = voicePrompts.filter((profile) => profile.promptType === 'CHARACTER_DIALOGUE_RULES' &&
    (!profile.ownerId || profile.ownerId === ownerId) && isEligibleDialoguePrompt(profile, scope));
  if (cloud) {
    if (!safeId(ownerId) || !safeId(context.projectId)) throw new VoiceRequestError(400, '유효하지 않은 작품입니다.');
    const db = getVoiceFirestore();
    const base = `users/${ownerId}/projects/${context.projectId}`;
    const project = await db.doc(base).get();
    if (!project.exists || project.data()?.ownerId !== ownerId || project.data()?.id !== context.projectId) {
      throw new VoiceRequestError(403, '화법 프로필의 작품 소유권을 확인할 수 없습니다.');
    }
    const refs = [...new Set(voicePrompts.map((profile) => profile.profileId).filter(safeId))].slice(0, 80);
    const readProfiles = await Promise.all(refs.map(async (id) => {
      const data = (await db.doc(`${base}/writingPromptProfiles/${id}`).get()).data();
      if (data?.id !== id || data?.ownerId !== ownerId || data?.projectId !== context.projectId ||
          data?.promptType !== 'CHARACTER_DIALOGUE_RULES' || data.isActive !== true ||
          typeof data.content !== 'string' || typeof data.title !== 'string' || !safeId(data.currentVersionId)) return null;
      const targetCharacterId = safeId(data.targetCharacterId) ? data.targetCharacterId : undefined;
      if (targetCharacterId) {
        if (!sceneCharacterIds.includes(targetCharacterId)) return null;
        const target = (await db.doc(`${base}/characters/${targetCharacterId}`).get()).data();
        if (target?.id !== targetCharacterId || target.projectId !== context.projectId || target.ownerId !== ownerId) return null;
      }
      const profile: WritingContextBundle['activePrompts'][number] = {
        profileId: id, promptType: 'CHARACTER_DIALOGUE_RULES', ownerId, projectId: context.projectId,
        targetCharacterId, isActive: true, title: data.title, content: data.content, versionId: data.currentVersionId,
        versionNumber: typeof data.currentVersionNumber === 'number' ? data.currentVersionNumber : undefined,
      };
      return isEligibleDialoguePrompt(profile, scope) ? profile : null;
    }));
    eligible = readProfiles.filter((profile) => profile !== null);
  }
  const scopedIds = new Set(voicePrompts.map((profile) => profile.profileId));
  return {
    ...context, ownerId, sceneCharacterIds,
    activePrompts: [...activePrompts.filter((profile) => !scopedIds.has(profile.profileId)), ...eligible],
    referencedSources: [
      ...context.referencedSources.filter((source) => source.entityType !== 'PROMPT_PROFILE' || !scopedIds.has(source.entityId)),
      ...eligible.map((profile) => ({ entityType: 'PROMPT_PROFILE' as const, entityId: profile.profileId,
        title: profile.title, canonStatus: 'CANON' as const, revisionId: profile.versionId })),
    ],
  };
}
