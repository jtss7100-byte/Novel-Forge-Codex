import type { EmergencyDraftBackup, ProjectBundle } from '../../../types/novel';
import { createInitialSeedBundle } from '../../../utils/seedData';
import { isLegacyMasterWritingRulesPlaceholder, createInitialPromptProfiles } from '../../../utils/aiEngineLogic';

export const LOCAL_BUNDLES_KEY = 'novelforge_local_bundles_v1';

const EMERGENCY_PREFIX = 'novelforge_emergency_draft_';

export function saveEmergencyDraft(backup: EmergencyDraftBackup): void {
  try {
    const key = `${EMERGENCY_PREFIX}${backup.projectId}_${backup.episodeId}`;
    localStorage.setItem(key, JSON.stringify(backup));
  } catch (err) {
    console.warn('Emergency draft buffer save warning:', err);
  }
}

export function getEmergencyDraft(
  projectId: string,
  episodeId: string
): EmergencyDraftBackup | null {
  try {
    const key = `${EMERGENCY_PREFIX}${projectId}_${episodeId}`;
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as EmergencyDraftBackup;
  } catch {
    return null;
  }
}

export function clearEmergencyDraft(projectId: string, episodeId: string): void {
  try {
    const key = `${EMERGENCY_PREFIX}${projectId}_${episodeId}`;
    localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

export function listAllEmergencyDrafts(): EmergencyDraftBackup[] {
  const result: EmergencyDraftBackup[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(EMERGENCY_PREFIX)) {
        const raw = localStorage.getItem(k);
        if (raw) {
          result.push(JSON.parse(raw) as EmergencyDraftBackup);
        }
      }
    }
  } catch {
    // ignore
  }
  return result;
}

export const localBundleKey = (ownerId: string) => `${LOCAL_BUNDLES_KEY}:${ownerId}`;

export function readOwnedLocalBundles(storage: LocalStorageLike, ownerId: string): ProjectBundle[] | null {
  const raw = storage.getItem(localBundleKey(ownerId)) ?? storage.getItem(LOCAL_BUNDLES_KEY);
  if (!raw) return null;
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) return null;
  return (parsed as ProjectBundle[]).filter((bundle) => bundle?.project?.ownerId === ownerId);
}

export function loadLocalBundles(ownerId = 'local_author', seedIfMissing = true): ProjectBundle[] {
  try {
    const parsed = readOwnedLocalBundles(localStorage, ownerId);
    if (!parsed?.length) {
      if (!seedIfMissing) return [];
      const initial = [createInitialSeedBundle(ownerId)];
      localStorage.setItem(localBundleKey(ownerId), JSON.stringify(initial));
      return initial;
    }
    // Non-destructively ensure each existing project bundle has default prompt profiles if none exist yet,
    // and upgrade legacy placeholder content on the Advanced Writing Control Rules slot to Rules 1~10.
    const migrated = parsed.map((b) => {
      const baseProfiles =
        Array.isArray(b.writingPromptProfiles) && b.writingPromptProfiles.length > 0
          ? b.writingPromptProfiles.map((p) => {
              if (isLegacyMasterWritingRulesPlaceholder(p)) {
                const defaults = createInitialPromptProfiles(
                  b.project.ownerId || ownerId,
                  b.project.id
                );
                const freshCore = defaults.find((d) => d.promptType === 'CORE_WRITING_RULES');
                return freshCore ? { ...p, content: freshCore.content, description: freshCore.description } : p;
              }
              return p;
            })
          : createInitialPromptProfiles(b.project.ownerId || ownerId, b.project.id);

      const seedFallback =
        b.project?.id === 'proj_abyss_chronicle'
          ? createInitialSeedBundle(b.project.ownerId || ownerId)
          : null;

      return {
        ...b,
        writingPromptProfiles: baseProfiles,
        writingPlans: Array.isArray(b.writingPlans) ? b.writingPlans : [],
        changeProposals:
          Array.isArray(b.changeProposals) && b.changeProposals.length > 0
            ? b.changeProposals
            : seedFallback?.changeProposals || [],
        approvalAudits: Array.isArray(b.approvalAudits) ? b.approvalAudits : [],
        scenes: Array.isArray(b.scenes)
          ? b.scenes
          : seedFallback?.scenes || [],
        relationships: Array.isArray(b.relationships)
          ? b.relationships
          : seedFallback?.relationships || [],
        timelineEvents: Array.isArray(b.timelineEvents)
          ? b.timelineEvents
          : seedFallback?.timelineEvents || [],
        foreshadowings: Array.isArray(b.foreshadowings)
          ? b.foreshadowings
          : seedFallback?.foreshadowings || [],
      };
    });
    return migrated;
  } catch {
    return seedIfMissing ? [createInitialSeedBundle(ownerId)] : [];
  }
}

export function saveLocalBundles(bundles: ProjectBundle[], ownerId = bundles[0]?.project.ownerId ?? 'local_author'): void {
  if (bundles.some((bundle) => bundle.project.ownerId !== ownerId)) {
    throw new Error('[LOCAL_OWNER_MISMATCH] 다른 계정의 작품을 함께 저장할 수 없습니다.');
  }
  localStorage.setItem(localBundleKey(ownerId), JSON.stringify(bundles));
}

export interface LocalStorageLike {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}
