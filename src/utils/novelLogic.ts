import type {
  Character,
  Episode,
  EpisodeStatus,
  Project,
  ProjectBundle,
  Revision,
  SettingStatus,
  WorldbuildingItem,
} from '../types/novel';

// Exact schema boundaries synchronized with firebase-blueprint.json & firestore.rules
export const ENTITY_CONSTRAINTS = {
  ID_PATTERN: /^[a-zA-Z0-9_-]+$/,
  ID_MAX_LENGTH: 128,
  LIST_MAX_ITEMS: 50,
  PROJECT: {
    TITLE_MAX: 120,
    GENRE_MAX: 60,
    SYNOPSIS_MAX: 3000,
    STATUSES: ['draft', 'confirmed'] as const,
  },
  CHARACTER: {
    NAME_MAX: 100,
    ROLE_MAX: 60,
    AFFILIATION_MAX: 120,
    APPEARANCE_MAX: 2000,
    PERSONALITY_MAX: 2000,
    BACKGROUND_MAX: 4000,
    ABILITIES_MAX: 2000,
    STATUSES: ['draft', 'confirmed'] as const,
  },
  WORLDBUILDING: {
    TITLE_MAX: 120,
    CATEGORY_MAX: 60,
    SUMMARY_MAX: 500,
    CONTENT_MAX: 10000,
    RULES_MAX: 3000,
    STATUSES: ['draft', 'confirmed'] as const,
  },
  EPISODE: {
    NUMBER_MIN: 1,
    NUMBER_MAX: 10000,
    TITLE_MAX: 150,
    CONTENT_MAX: 200000,
    SYNOPSIS_MAX: 2000,
    AUTHOR_NOTE_MAX: 2000,
    STATUSES: ['draft', 'review', 'confirmed'] as const,
  },
  REVISION: {
    TITLE_MAX: 150,
    CONTENT_MAX: 200000,
    LABEL_MAX: 120,
  },
} as const;

export function generateEntityId(prefix: string): string {
  const cleanPrefix = prefix.replace(/[^a-zA-Z0-9_-]/g, '') || 'item';
  const rand = Math.random().toString(36).substring(2, 10);
  const ts = Date.now().toString(36);
  return `${cleanPrefix}_${ts}_${rand}`.slice(0, ENTITY_CONSTRAINTS.ID_MAX_LENGTH);
}

export function isValidEntityId(id: unknown): id is string {
  return (
    typeof id === 'string' &&
    id.length >= 1 &&
    id.length <= ENTITY_CONSTRAINTS.ID_MAX_LENGTH &&
    ENTITY_CONSTRAINTS.ID_PATTERN.test(id)
  );
}

export function sanitizeIdArray(arr: unknown): string[] {
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((item): item is string => isValidEntityId(item))
    .slice(0, ENTITY_CONSTRAINTS.LIST_MAX_ITEMS);
}

export interface CharCountMetrics {
  withSpaces: number;
  withoutSpaces: number;
  lineCount: number;
  paragraphCount: number;
  manuscriptPages200: number; // 200자 원고지 매수 환산
}

export function calculateCharCounts(content: string): CharCountMetrics {
  const safeContent = typeof content === 'string' ? content : '';
  const withSpaces = safeContent.length;
  const withoutSpaces = safeContent.replace(/\s+/g, '').length;
  const lines = safeContent.length === 0 ? [] : safeContent.split(/\r?\n/);
  const lineCount = lines.length;
  const paragraphCount = lines.filter((line) => line.trim().length > 0).length;
  const manuscriptPages200 = withSpaces === 0 ? 0 : Math.ceil(withSpaces / 200);

  return {
    withSpaces,
    withoutSpaces,
    lineCount,
    paragraphCount,
    manuscriptPages200,
  };
}

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

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

export function validateProjectInput(input: {
  title: string;
  genre: string;
  synopsis: string;
  status: SettingStatus;
}): ValidationResult {
  const title = input.title?.trim() ?? '';
  const genre = input.genre?.trim() ?? '';
  const synopsis = input.synopsis ?? '';

  if (title.length < 1) {
    return { valid: false, error: '작품 제목을 입력해 주세요.' };
  }
  if (title.length > ENTITY_CONSTRAINTS.PROJECT.TITLE_MAX) {
    return {
      valid: false,
      error: `작품 제목은 최대 ${ENTITY_CONSTRAINTS.PROJECT.TITLE_MAX}자까지 입력할 수 있습니다.`,
    };
  }
  if (genre.length < 1) {
    return { valid: false, error: '장르를 입력하거나 선택해 주세요.' };
  }
  if (genre.length > ENTITY_CONSTRAINTS.PROJECT.GENRE_MAX) {
    return {
      valid: false,
      error: `장르는 최대 ${ENTITY_CONSTRAINTS.PROJECT.GENRE_MAX}자까지 입력할 수 있습니다.`,
    };
  }
  if (synopsis.length > ENTITY_CONSTRAINTS.PROJECT.SYNOPSIS_MAX) {
    return {
      valid: false,
      error: `시놉시스는 최대 ${ENTITY_CONSTRAINTS.PROJECT.SYNOPSIS_MAX}자까지 입력할 수 있습니다.`,
    };
  }
  if (!ENTITY_CONSTRAINTS.PROJECT.STATUSES.includes(input.status)) {
    return { valid: false, error: '유효하지 않은 작품 상태입니다.' };
  }
  return { valid: true };
}

export function validateCharacterInput(input: {
  name: string;
  role: string;
  affiliation: string;
  appearance: string;
  personality: string;
  background: string;
  abilities: string;
  status: SettingStatus;
}): ValidationResult {
  const name = input.name?.trim() ?? '';
  const role = input.role?.trim() ?? '';

  if (name.length < 1) {
    return { valid: false, error: '등장인물 이름을 입력해 주세요.' };
  }
  if (name.length > ENTITY_CONSTRAINTS.CHARACTER.NAME_MAX) {
    return {
      valid: false,
      error: `등장인물 이름은 최대 ${ENTITY_CONSTRAINTS.CHARACTER.NAME_MAX}자까지 입력할 수 있습니다.`,
    };
  }
  if (role.length < 1) {
    return { valid: false, error: '역할(예: 주인공, 조연, 적대자)을 입력해 주세요.' };
  }
  if (role.length > ENTITY_CONSTRAINTS.CHARACTER.ROLE_MAX) {
    return {
      valid: false,
      error: `역할은 최대 ${ENTITY_CONSTRAINTS.CHARACTER.ROLE_MAX}자까지 입력할 수 있습니다.`,
    };
  }
  if ((input.affiliation ?? '').length > ENTITY_CONSTRAINTS.CHARACTER.AFFILIATION_MAX) {
    return { valid: false, error: '소속/세력 텍스트가 허용 길이를 초과했습니다.' };
  }
  if ((input.appearance ?? '').length > ENTITY_CONSTRAINTS.CHARACTER.APPEARANCE_MAX) {
    return { valid: false, error: '외형 묘사가 허용 길이(2,000자)를 초과했습니다.' };
  }
  if ((input.personality ?? '').length > ENTITY_CONSTRAINTS.CHARACTER.PERSONALITY_MAX) {
    return { valid: false, error: '성격 묘사가 허용 길이(2,000자)를 초과했습니다.' };
  }
  if ((input.background ?? '').length > ENTITY_CONSTRAINTS.CHARACTER.BACKGROUND_MAX) {
    return { valid: false, error: '배경 서사가 허용 길이(4,000자)를 초과했습니다.' };
  }
  if ((input.abilities ?? '').length > ENTITY_CONSTRAINTS.CHARACTER.ABILITIES_MAX) {
    return { valid: false, error: '능력/스킬 설명이 허용 길이(2,000자)를 초과했습니다.' };
  }
  if (!ENTITY_CONSTRAINTS.CHARACTER.STATUSES.includes(input.status)) {
    return { valid: false, error: '유효하지 않은 설정 상태입니다.' };
  }
  return { valid: true };
}

export function validateWorldbuildingInput(input: {
  title: string;
  category: string;
  summary: string;
  content: string;
  rules: string;
  status: SettingStatus;
}): ValidationResult {
  const title = input.title?.trim() ?? '';
  const category = input.category?.trim() ?? '';

  if (title.length < 1) {
    return { valid: false, error: '세계관 항목 제목을 입력해 주세요.' };
  }
  if (title.length > ENTITY_CONSTRAINTS.WORLDBUILDING.TITLE_MAX) {
    return {
      valid: false,
      error: `세계관 제목은 최대 ${ENTITY_CONSTRAINTS.WORLDBUILDING.TITLE_MAX}자까지 입력할 수 있습니다.`,
    };
  }
  if (category.length < 1) {
    return { valid: false, error: '분류 카테고리를 선택하거나 입력해 주세요.' };
  }
  if (category.length > ENTITY_CONSTRAINTS.WORLDBUILDING.CATEGORY_MAX) {
    return { valid: false, error: '카테고리 이름이 너무 깁니다.' };
  }
  if ((input.summary ?? '').length > ENTITY_CONSTRAINTS.WORLDBUILDING.SUMMARY_MAX) {
    return { valid: false, error: '핵심 요약은 최대 500자까지 입력할 수 있습니다.' };
  }
  if ((input.content ?? '').length > ENTITY_CONSTRAINTS.WORLDBUILDING.CONTENT_MAX) {
    return { valid: false, error: '상세 설정은 최대 10,000자까지 입력할 수 있습니다.' };
  }
  if ((input.rules ?? '').length > ENTITY_CONSTRAINTS.WORLDBUILDING.RULES_MAX) {
    return { valid: false, error: '제약 법칙은 최대 3,000자까지 입력할 수 있습니다.' };
  }
  if (!ENTITY_CONSTRAINTS.WORLDBUILDING.STATUSES.includes(input.status)) {
    return { valid: false, error: '유효하지 않은 설정 상태입니다.' };
  }
  return { valid: true };
}

export function validateEpisodeInput(input: {
  episodeNumber: number;
  title: string;
  content: string;
  synopsis: string;
  authorNote: string;
  status: EpisodeStatus;
}): ValidationResult {
  const title = input.title?.trim() ?? '';
  const epNum = Number(input.episodeNumber);

  if (!Number.isInteger(epNum) || epNum < ENTITY_CONSTRAINTS.EPISODE.NUMBER_MIN || epNum > ENTITY_CONSTRAINTS.EPISODE.NUMBER_MAX) {
    return { valid: false, error: '회차 번호는 1 이상 10,000 이하의 정수여야 합니다.' };
  }
  if (title.length < 1) {
    return { valid: false, error: '회차 제목을 입력해 주세요.' };
  }
  if (title.length > ENTITY_CONSTRAINTS.EPISODE.TITLE_MAX) {
    return {
      valid: false,
      error: `회차 제목은 최대 ${ENTITY_CONSTRAINTS.EPISODE.TITLE_MAX}자까지 입력할 수 있습니다.`,
    };
  }
  if ((input.content ?? '').length > ENTITY_CONSTRAINTS.EPISODE.CONTENT_MAX) {
    return { valid: false, error: '원고 본문이 최대 허용 길이(200,000자)를 초과했습니다.' };
  }
  if ((input.synopsis ?? '').length > ENTITY_CONSTRAINTS.EPISODE.SYNOPSIS_MAX) {
    return { valid: false, error: '회차 요약이 최대 허용 길이(2,000자)를 초과했습니다.' };
  }
  if ((input.authorNote ?? '').length > ENTITY_CONSTRAINTS.EPISODE.AUTHOR_NOTE_MAX) {
    return { valid: false, error: '작가 노트가 최대 허용 길이(2,000자)를 초과했습니다.' };
  }
  if (!ENTITY_CONSTRAINTS.EPISODE.STATUSES.includes(input.status)) {
    return { valid: false, error: '유효하지 않은 회차 상태입니다.' };
  }
  return { valid: true };
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

export function serializeProjectBundle(
  project: Project,
  characters: Character[],
  worldbuilding: WorldbuildingItem[],
  episodes: Episode[],
  revisions: Revision[]
): string {
  const bundle: ProjectBundle = {
    formatVersion: '1.0',
    exportedAt: new Date().toISOString(),
    project,
    characters,
    worldbuilding,
    episodes,
    revisions,
  };
  return JSON.stringify(bundle, null, 2);
}

export function parseAndValidateProjectBundle(
  rawJson: string,
  targetOwnerId: string
): { valid: true; bundle: ProjectBundle } | { valid: false; error: string } {
  if (!isValidEntityId(targetOwnerId)) {
    return { valid: false, error: '유효하지 않은 사용자 ID입니다.' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return { valid: false, error: '유효한 JSON 형식이 아닙니다. 파일 내용을 확인해 주세요.' };
  }

  if (!parsed || typeof parsed !== 'object') {
    return { valid: false, error: 'JSON 루트 객체가 올바르지 않습니다.' };
  }

  const obj = parsed as Record<string, unknown>;
  const rawProject = obj.project as Record<string, unknown> | undefined;
  if (!rawProject || typeof rawProject !== 'object') {
    return { valid: false, error: 'JSON 데이터에 작품(project) 정보가 포함되어 있지 않습니다.' };
  }

  const nowIso = new Date().toISOString();
  const projectId = isValidEntityId(rawProject.id)
    ? rawProject.id
    : generateEntityId('proj');

  const projectCandidate: Project = {
    id: projectId,
    ownerId: targetOwnerId,
    title: String(rawProject.title ?? '').trim().slice(0, ENTITY_CONSTRAINTS.PROJECT.TITLE_MAX),
    genre: String(rawProject.genre ?? '판타지').trim().slice(0, ENTITY_CONSTRAINTS.PROJECT.GENRE_MAX),
    synopsis: String(rawProject.synopsis ?? '').slice(0, ENTITY_CONSTRAINTS.PROJECT.SYNOPSIS_MAX),
    status: rawProject.status === 'confirmed' ? 'confirmed' : 'draft',
    createdAt: typeof rawProject.createdAt === 'string' ? rawProject.createdAt : nowIso,
    updatedAt: nowIso,
  };

  const projCheck = validateProjectInput(projectCandidate);
  if (!projCheck.valid) {
    return { valid: false, error: `작품 정보 검증 실패: ${projCheck.error}` };
  }

  const rawCharacters = Array.isArray(obj.characters) ? obj.characters : [];
  const characters: Character[] = [];
  for (const item of rawCharacters) {
    if (!item || typeof item !== 'object') continue;
    const c = item as Record<string, unknown>;
    const charObj: Character = {
      id: isValidEntityId(c.id) ? c.id : generateEntityId('char'),
      ownerId: targetOwnerId,
      projectId,
      name: String(c.name ?? '').trim().slice(0, ENTITY_CONSTRAINTS.CHARACTER.NAME_MAX),
      role: String(c.role ?? '조연').trim().slice(0, ENTITY_CONSTRAINTS.CHARACTER.ROLE_MAX),
      affiliation: String(c.affiliation ?? '').slice(0, ENTITY_CONSTRAINTS.CHARACTER.AFFILIATION_MAX),
      appearance: String(c.appearance ?? '').slice(0, ENTITY_CONSTRAINTS.CHARACTER.APPEARANCE_MAX),
      personality: String(c.personality ?? '').slice(0, ENTITY_CONSTRAINTS.CHARACTER.PERSONALITY_MAX),
      background: String(c.background ?? '').slice(0, ENTITY_CONSTRAINTS.CHARACTER.BACKGROUND_MAX),
      abilities: String(c.abilities ?? '').slice(0, ENTITY_CONSTRAINTS.CHARACTER.ABILITIES_MAX),
      status: c.status === 'confirmed' ? 'confirmed' : 'draft',
      linkedEpisodeIds: sanitizeIdArray(c.linkedEpisodeIds),
      linkedWorldbuildingIds: sanitizeIdArray(c.linkedWorldbuildingIds),
      createdAt: typeof c.createdAt === 'string' ? c.createdAt : nowIso,
      updatedAt: nowIso,
    };
    const check = validateCharacterInput(charObj);
    if (!check.valid) {
      return { valid: false, error: `등장인물(${charObj.name || '이름 없음'}) 검증 실패: ${check.error}` };
    }
    characters.push(charObj);
  }

  const rawWb = Array.isArray(obj.worldbuilding) ? obj.worldbuilding : [];
  const worldbuilding: WorldbuildingItem[] = [];
  for (const item of rawWb) {
    if (!item || typeof item !== 'object') continue;
    const w = item as Record<string, unknown>;
    const wbObj: WorldbuildingItem = {
      id: isValidEntityId(w.id) ? w.id : generateEntityId('wb'),
      ownerId: targetOwnerId,
      projectId,
      title: String(w.title ?? '').trim().slice(0, ENTITY_CONSTRAINTS.WORLDBUILDING.TITLE_MAX),
      category: String(w.category ?? '기타').trim().slice(0, ENTITY_CONSTRAINTS.WORLDBUILDING.CATEGORY_MAX),
      summary: String(w.summary ?? '').slice(0, ENTITY_CONSTRAINTS.WORLDBUILDING.SUMMARY_MAX),
      content: String(w.content ?? '').slice(0, ENTITY_CONSTRAINTS.WORLDBUILDING.CONTENT_MAX),
      rules: String(w.rules ?? '').slice(0, ENTITY_CONSTRAINTS.WORLDBUILDING.RULES_MAX),
      status: w.status === 'confirmed' ? 'confirmed' : 'draft',
      linkedCharacterIds: sanitizeIdArray(w.linkedCharacterIds),
      linkedEpisodeIds: sanitizeIdArray(w.linkedEpisodeIds),
      createdAt: typeof w.createdAt === 'string' ? w.createdAt : nowIso,
      updatedAt: nowIso,
    };
    const check = validateWorldbuildingInput(wbObj);
    if (!check.valid) {
      return { valid: false, error: `세계관(${wbObj.title || '제목 없음'}) 검증 실패: ${check.error}` };
    }
    worldbuilding.push(wbObj);
  }

  const rawEpisodes = Array.isArray(obj.episodes) ? obj.episodes : [];
  const episodes: Episode[] = [];
  for (const item of rawEpisodes) {
    if (!item || typeof item !== 'object') continue;
    const e = item as Record<string, unknown>;
    const content = String(e.content ?? '').slice(0, ENTITY_CONSTRAINTS.EPISODE.CONTENT_MAX);
    const counts = calculateCharCounts(content);
    const status: EpisodeStatus =
      e.status === 'confirmed' || e.status === 'review' ? e.status : 'draft';
    const epObj: Episode = {
      id: isValidEntityId(e.id) ? e.id : generateEntityId('ep'),
      ownerId: targetOwnerId,
      projectId,
      episodeNumber: Math.max(1, Math.min(10000, Math.trunc(Number(e.episodeNumber) || episodes.length + 1))),
      title: String(e.title ?? '').trim().slice(0, ENTITY_CONSTRAINTS.EPISODE.TITLE_MAX),
      content,
      synopsis: String(e.synopsis ?? '').slice(0, ENTITY_CONSTRAINTS.EPISODE.SYNOPSIS_MAX),
      authorNote: String(e.authorNote ?? '').slice(0, ENTITY_CONSTRAINTS.EPISODE.AUTHOR_NOTE_MAX),
      charCountWithSpaces: counts.withSpaces,
      charCountWithoutSpaces: counts.withoutSpaces,
      status,
      linkedCharacterIds: sanitizeIdArray(e.linkedCharacterIds),
      linkedWorldbuildingIds: sanitizeIdArray(e.linkedWorldbuildingIds),
      createdAt: typeof e.createdAt === 'string' ? e.createdAt : nowIso,
      updatedAt: nowIso,
    };
    const check = validateEpisodeInput(epObj);
    if (!check.valid) {
      return { valid: false, error: `회차(${epObj.title || '제목 없음'}) 검증 실패: ${check.error}` };
    }
    episodes.push(epObj);
  }

  const validEpisodeIdSet = new Set(episodes.map((ep) => ep.id));
  const rawRevisions = Array.isArray(obj.revisions) ? obj.revisions : [];
  const revisions: Revision[] = [];
  for (const item of rawRevisions) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const epId = String(r.episodeId ?? '');
    if (!isValidEntityId(epId) || !validEpisodeIdSet.has(epId)) continue;
    const content = String(r.content ?? '').slice(0, ENTITY_CONSTRAINTS.REVISION.CONTENT_MAX);
    const counts = calculateCharCounts(content);
    revisions.push({
      id: isValidEntityId(r.id) ? r.id : generateEntityId('rev'),
      ownerId: targetOwnerId,
      projectId,
      episodeId: epId,
      episodeTitle: String(r.episodeTitle ?? '원고 스냅샷').trim().slice(0, ENTITY_CONSTRAINTS.REVISION.TITLE_MAX) || '원고 스냅샷',
      content,
      charCountWithSpaces: counts.withSpaces,
      label: String(r.label ?? '가져온 버전').trim().slice(0, ENTITY_CONSTRAINTS.REVISION.LABEL_MAX) || '가져온 버전',
      createdAt: typeof r.createdAt === 'string' ? r.createdAt : nowIso,
    });
  }

  return {
    valid: true,
    bundle: {
      formatVersion: '1.0',
      exportedAt: typeof obj.exportedAt === 'string' ? obj.exportedAt : nowIso,
      project: projectCandidate,
      characters,
      worldbuilding,
      episodes,
      revisions,
    },
  };
}
