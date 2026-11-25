import type { Episode, Character, WorldbuildingItem, Revision } from '../types/novel';
import { calculateCharCounts } from './novelValidation';

export interface ProjectDashboardStats {
  totalEpisodes: number;
  confirmedEpisodes: number;
  reviewEpisodes: number;
  draftEpisodes: number;
  totalCharsWithSpaces: number;
  totalCharsWithoutSpaces: number;
  avgCharsPerEpisode: number;
  totalCharacters: number;
  confirmedCharacters: number;
  draftCharacters: number;
  totalWorldbuilding: number;
  confirmedWorldbuilding: number;
  draftWorldbuilding: number;
  totalRevisions: number;
}

export function computeProjectDashboardStats(
  episodes: Episode[],
  characters: Character[],
  worldbuilding: WorldbuildingItem[],
  revisions: Revision[]
): ProjectDashboardStats {
  const totalEpisodes = episodes.length;
  let confirmedEpisodes = 0;
  let reviewEpisodes = 0;
  let draftEpisodes = 0;
  let totalCharsWithSpaces = 0;
  let totalCharsWithoutSpaces = 0;

  for (const ep of episodes) {
    if (ep.status === 'confirmed') confirmedEpisodes += 1;
    else if (ep.status === 'review') reviewEpisodes += 1;
    else draftEpisodes += 1;

    const counts = calculateCharCounts(ep.content);
    totalCharsWithSpaces += counts.withSpaces;
    totalCharsWithoutSpaces += counts.withoutSpaces;
  }

  const avgCharsPerEpisode =
    totalEpisodes > 0 ? Math.round(totalCharsWithSpaces / totalEpisodes) : 0;

  let confirmedCharacters = 0;
  let draftCharacters = 0;
  for (const ch of characters) {
    if (ch.status === 'confirmed') confirmedCharacters += 1;
    else draftCharacters += 1;
  }

  let confirmedWorldbuilding = 0;
  let draftWorldbuilding = 0;
  for (const wb of worldbuilding) {
    if (wb.status === 'confirmed') confirmedWorldbuilding += 1;
    else draftWorldbuilding += 1;
  }

  return {
    totalEpisodes,
    confirmedEpisodes,
    reviewEpisodes,
    draftEpisodes,
    totalCharsWithSpaces,
    totalCharsWithoutSpaces,
    avgCharsPerEpisode,
    totalCharacters: characters.length,
    confirmedCharacters,
    draftCharacters,
    totalWorldbuilding: worldbuilding.length,
    confirmedWorldbuilding,
    draftWorldbuilding,
    totalRevisions: revisions.length,
  };
}

export function computeRevisionDiffSummary(currentContent: string, revisionContent: string): {
  charDelta: number;
  formattedDelta: string;
  previewSnippet: string;
} {
  const currLen = (currentContent ?? '').length;
  const revLen = (revisionContent ?? '').length;
  const charDelta = revLen - currLen;
  const formattedDelta =
    charDelta === 0 ? '글자 수 동일' : charDelta > 0 ? `+${charDelta.toLocaleString()}자` : `${charDelta.toLocaleString()}자`;
  const previewSnippet = (revisionContent ?? '').trim().slice(0, 140) || '(빈 원고)';
  return { charDelta, formattedDelta, previewSnippet };
}

export {
  ENTITY_CONSTRAINTS,
  generateEntityId,
  isValidEntityId,
  sanitizeIdArray,
  type CharCountMetrics,
  calculateCharCounts,
  type ValidationResult,
  validateProjectInput,
  validateCharacterInput,
  validateWorldbuildingInput,
  validateEpisodeInput,
} from './novelValidation';
export { serializeProjectBundle, parseAndValidateProjectBundle } from '../services/repository/backup/projectBundleCodec';
