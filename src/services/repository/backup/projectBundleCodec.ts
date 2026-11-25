import type {
  Project,
  Character,
  WorldbuildingItem,
  Episode,
  Revision,
  ProjectBundle,
  EpisodeStatus,
} from '../../../types/novel';
import {
  isValidEntityId,
  generateEntityId,
  ENTITY_CONSTRAINTS,
  validateProjectInput,
  sanitizeIdArray,
  validateCharacterInput,
  validateWorldbuildingInput,
  calculateCharCounts,
  validateEpisodeInput,
} from '../../../utils/novelValidation';

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
