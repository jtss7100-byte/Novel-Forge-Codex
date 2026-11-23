import type { WritingContextBundle } from '../types/aiEngine';

export function isScopedVoicePrompt(profile: { profileId?: string; id?: string; targetCharacterId?: string }): boolean {
  return Boolean(profile.targetCharacterId || (profile.profileId ?? profile.id)?.startsWith('voice_'));
}

export function isEligibleDialoguePrompt(
  profile: { promptType: string; ownerId?: string; projectId?: string; isActive?: boolean; targetCharacterId?: string; id?: string; profileId?: string },
  scope: { ownerId?: string; projectId: string; characterIds?: readonly string[] }
): boolean {
  if (profile.promptType !== 'CHARACTER_DIALOGUE_RULES' || !isScopedVoicePrompt(profile)) return true;
  return Boolean(profile.targetCharacterId && scope.ownerId && profile.ownerId === scope.ownerId &&
    profile.projectId === scope.projectId && profile.isActive === true && scope.characterIds?.includes(profile.targetCharacterId));
}

export function restrictWritingVoiceScope(context: WritingContextBundle, characterIds = context.sceneCharacterIds) {
  const scope = { ownerId: context.ownerId, projectId: context.projectId, characterIds };
  const activePrompts = context.activePrompts.filter((profile) => isEligibleDialoguePrompt(profile, scope));
  const kept = new Set(activePrompts.map((profile) => profile.profileId));
  const excluded = new Set(context.activePrompts.filter((profile) => !kept.has(profile.profileId)).map((profile) => profile.profileId));
  return { ...context, sceneCharacterIds: characterIds, activePrompts,
    referencedSources: context.referencedSources.filter((source) => source.entityType !== 'PROMPT_PROFILE' || !excluded.has(source.entityId)) };
}
