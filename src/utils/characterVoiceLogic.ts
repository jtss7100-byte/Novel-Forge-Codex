import type { CharacterVoiceAnalysisCandidate, CharacterVoiceFinding, VoiceDimensionId, VoiceExcerpt, VoiceMetrics, VoiceSourceReference } from '../types/characterVoice';
import { sanitizeStyleTextAgainstInjection } from './authorStyleLogic';
import { computeManuscriptContentHash } from './manuscriptIntegrity';

export const VOICE_DIMENSIONS: Record<VoiceDimensionId, string> = {
  V1: '존댓말과 반말', V2: '종결 어미', V3: '대사 길이와 리듬', V4: '감정 표현', V5: '어휘 습관',
  V6: '관계별 화법', V7: '독백과 발화', V8: '성격과 화법', V9: '상황별 변화', V10: '고유 화법 일관성',
};

export type VoiceCastMember = { id: string; name: string };
export type VoiceAssignments = Readonly<Record<string, string>>;

const SPEECH_VERB = '(?:말했다|말한다|외쳤다|물었다|대답했다|속삭였다|중얼거렸다|되물었다|명령했다|답했다|소리쳤다)';

export function extractVoiceExcerpts(
  source: string,
  cast: VoiceCastMember[],
  assignments: VoiceAssignments = {},
  directSpeakerId?: string,
  range?: { startOffset: number; endOffset: number }
): VoiceExcerpt[] {
  const parts = directSpeakerId ? /[^\r\n]+/g : /"[^"\r\n]+"|“[^”\r\n]+”|「[^」\r\n]+」/g;
  const matches: RegExpExecArray[] = [];
  for (const match of source.matchAll(parts)) {
    if (range && match.index + match[0].length <= range.startOffset) continue;
    if (range && match.index >= range.endOffset) break;
    matches.push(match);
    if (!range && matches.length === 180) break;
  }
  return matches.flatMap<VoiceExcerpt>((match) => {
    const quote = directSpeakerId ? match[0] : match[0].slice(1, -1);
    const text = quote.trim();
    if (!text || (!range && text.length > 600)) return [];
    const startOffset = match.index + (directSpeakerId ? 0 : 1) + quote.length - quote.trimStart().length;
    const endOffset = startOffset + text.length;
    if (range && (startOffset < range.startOffset || endOffset > range.endOffset)) return [];
    const id = `${startOffset}:${endOffset}`;
    const assignment = assignments[id] || directSpeakerId;
    if (assignment && cast.some((member) => member.id === assignment)) {
      return [{ id, text, startOffset, endOffset, characterId: assignment, attribution: 'AUTHOR_CONFIRMED' as const }];
    }
    const left = source.slice(0, match.index).slice(-150).split(/\r?\n/).at(-1) || '';
    const right = source.slice(match.index + match[0].length, match.index + match[0].length + 150).split(/\r?\n/)[0];
    // A name plus a grammatical speech attribution is evidence. Action beats and narration are not.
    const explicit = cast.filter(({ name }) => {
      if (!name) return false;
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`(?:^|[.!?。]\\s*)${escaped}(?:이|가|은|는)\\s+${SPEECH_VERB}[:. ]*\$`).test(left.trim()) ||
        new RegExp(`^\\s*(?:(?:라고|라며|하고)\\s+)?${escaped}(?:이|가|은|는)\\s+${SPEECH_VERB}(?:[.!?。\\s]|\$)`).test(right);
    });
    if (explicit.length === 1) {
      return [{ id, text, startOffset, endOffset, characterId: explicit[0].id, attribution: 'EXPLICITLY_OBSERVED' as const }];
    }
    return [{ id, text, startOffset, endOffset, attribution: explicit.length > 1 || cast.some(({ name }) => name && (left.includes(name) || right.includes(name))) ? 'AMBIGUOUS' as const : 'UNKNOWN' as const }];
  });
}

export function collectVoiceEvidence(excerpts: VoiceExcerpt[], characterId: string): VoiceExcerpt[] {
  return excerpts.filter((entry) => entry.characterId === characterId &&
    (entry.attribution === 'AUTHOR_CONFIRMED' || entry.attribution === 'EXPLICITLY_OBSERVED') &&
    sanitizeStyleTextAgainstInjection(entry.text).markerCount === 0);
}

export function measureVoice(excerpts: VoiceExcerpt[]): VoiceMetrics {
  const endings: Record<string, number> = {};
  const words = new Map<string, number>();
  const result: VoiceMetrics = { count: excerpts.length, lengths: [], averageLength: 0, endings, questions: 0, commands: 0, polite: 0, informal: 0, brief: 0, pauses: 0, repeatedWords: [] };
  for (const { text } of excerpts) {
    const line = text.replace(/[.?!…~]+\s*$/, '');
    const length = text.replace(/\s/g, '').length;
    result.lengths.push(length);
    if (/\?/.test(text)) result.questions++;
    if (/(?:십시오|하세요|해라|하라|마라|가라|와라|어라|아라|해줘|가자)$/.test(line)) result.commands++;
    if (length <= 8) result.brief++;
    if (/(?:…|\.{2,}|침묵|머뭇)/.test(text)) result.pauses++;
    if (/(?:니다|니까|십시오|세요|해요|아요|어요|예요|이에요|겠어요|요)$/.test(line)) result.polite++;
    else if (/(?:냐|해라|하라|마라|어라|아라|지 않아|야|거든|잖아|해|가자|했어|됐어|알았어|았어|었어)$/.test(line)) result.informal++;
    const ending = line.match(/(?:습니다|습니까|니다|니까|십시오|세요|해요|아요|어요|예요|해라|하라|마라|어라|아라|지 않아|잖아|았어|었어|가자|냐|요|다|야|해)$/)?.[0];
    if (ending) endings[ending] = (endings[ending] ?? 0) + 1;
    for (const word of text.match(/[가-힣]{2,}/g) || []) words.set(word, (words.get(word) ?? 0) + 1);
  }
  result.averageLength = result.count ? Math.round(result.lengths.reduce((sum, item) => sum + item, 0) / result.count) : 0;
  result.repeatedWords = [...words].filter(([, count]) => count > 1).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([word]) => word);
  return result;
}

export function analyzeVoiceSample(params: {
  ownerId: string; projectId: string; characterId: string; text: string; cast: VoiceCastMember[];
  source?: VoiceSourceReference; assignments?: VoiceAssignments; directSpeakerId?: string;
  verifiedRelationCount?: number; hasCanonPersonality?: boolean;
  verifiedRelationTargets?: VoiceCastMember[];
}): CharacterVoiceAnalysisCandidate {
  const source = params.source ?? { contentHash: computeManuscriptContentHash(params.text) };
  const excerpts = extractVoiceExcerpts(params.text, params.cast, params.assignments, params.directSpeakerId);
  const confirmed = collectVoiceEvidence(excerpts, params.characterId);
  const metrics = measureVoice(confirmed);
  const enough = metrics.count >= 3 && metrics.lengths.reduce((sum, length) => sum + length, 0) >= 20;
  const evidence = confirmed.slice(0, 8).map((entry) => entry.id);
  const polite = confirmed.filter((entry) => measureVoice([entry]).polite > 0);
  const informal = confirmed.filter((entry) => measureVoice([entry]).informal > 0);
  const addresseeSamples = (params.verifiedRelationTargets || []).flatMap((person) => {
    const samples = confirmed.filter(({ text }) =>
      ['님,', ',', '아,', '야,', '님!', '!'].some((suffix) => text.startsWith(person.name + suffix)));
    if (!samples.length) return [];
    const counts = measureVoice(samples);
    return [{ person, samples, counts }];
  });
  const emotional = confirmed.filter(({ text }) => /[!]|(?:두렵|겁나|미안|화가|무섭|기뻐|슬프)/.test(text));
  const neutral = confirmed.filter((entry) => !emotional.includes(entry));
  const tonalContrast = emotional.length >= 2 && neutral.length >= 2 && measureVoice(emotional).averageLength < measureVoice(neutral).averageLength;
  const found = (dimensionId: VoiceDimensionId, observedTrait: string, suggestedRule: string | null, refs = evidence): CharacterVoiceFinding => ({
    dimensionId, observedTrait, suggestedRule: enough && refs.length ? suggestedRule : null,
    confidence: enough && refs.length && suggestedRule ? 'MEDIUM' : enough && refs.length ? 'LOW' : 'INSUFFICIENT_EVIDENCE',
    evidenceReferences: enough ? refs : [],
  });
  const dimensions = [
    found('V1', `존댓말 단서 ${metrics.polite}건 · 반말 단서 ${metrics.informal}건`, polite.length && informal.length ? '존비칭 변화는 상대와 상황에 맞추고 한 가지 말투로 통일하지 않는다.' : polite.length >= 2 ? '확인된 상대와의 장면에서는 존댓말 경향을 유지한다.' : informal.length >= 2 ? '확인된 상대와의 장면에서는 반말 경향을 유지한다.' : null, [...polite, ...informal].slice(0, 8).map((e) => e.id)),
    found('V2', `종결 단서 ${Object.entries(metrics.endings).map(([key, value]) => `${key} ${value}`).join(', ') || '없음'} · 의문 ${metrics.questions}건 · 명령 단서 ${metrics.commands}건`, Object.keys(metrics.endings).length ? '관찰된 종결 어미와 질문·명령의 쓰임을 문맥에 맞게 유지한다.' : null),
    found('V3', `대사 ${metrics.count}건 · 평균 ${metrics.averageLength}자 · 단답 ${metrics.brief}건 · 멈춤 단서 ${metrics.pauses}건`, '대사의 길이와 단답 리듬을 참고하되 장면마다 기계적으로 반복하지 않는다.'),
    found('V4', tonalContrast ? '감정 표현 단서가 있는 발화가 다른 발화보다 짧게 관찰됨' : '감정과 길이의 관계를 확정할 표본 부족', tonalContrast ? '긴장이 높은 발화의 짧은 호흡은 해당 상황에서만 참고한다.' : null, emotional.slice(0, 8).map((e) => e.id)),
    found('V5', metrics.repeatedWords.length ? `반복 어휘 후보 ${metrics.repeatedWords.join(', ')}` : '반복 어휘 근거 부족', metrics.repeatedWords.length ? '반복 어휘의 격식과 직접성만 참고하고 고유 대사를 복제하지 않는다.' : null),
    found('V6', addresseeSamples.length
      ? addresseeSamples.map(({ person, counts }) => `${person.name} 호칭 포함 발화: 존댓말 ${counts.polite}건, 반말 ${counts.informal}건`).join(' · ')
      : `확정 관계 ${params.verifiedRelationCount || 0}건 · 상대를 특정할 발화 근거 부족`,
      addresseeSamples.length ? '확인된 상대별 호칭과 존비칭을 유지하고, 다른 상대에게 일반화하지 않는다.' : null,
      addresseeSamples.flatMap(({ samples }) => samples.map((entry) => entry.id)).slice(0, 8)),
    found('V7', '따옴표 밖의 서술과 작은따옴표 독백은 실제 발화 표본에서 제외함', '내적 독백과 상대에게 하는 발화를 구분한다.'),
    found('V8', params.hasCanonPersonality ? '기존 확정 성격 설정이 있음. 발화와의 인과 관계는 검토 필요.' : '확정 성격 근거 부족', null),
    found('V9', tonalContrast ? '장면 변화에 따른 리듬 차이 후보' : '상황별 차이를 비교할 근거 부족', tonalContrast ? '감정이나 사건이 바뀌는 장면에는 자연스러운 말투 변화를 허용한다.' : null),
    found('V10', '단일 출처 분석. 회차 간 일관성은 별도 비교가 필요함.', null),
  ];
  return {
    candidateId: computeManuscriptContentHash(JSON.stringify([params.projectId, params.characterId, source, excerpts.map(({ id, characterId }) => [id, characterId])])),
    ownerId: params.ownerId, projectId: params.projectId, characterId: params.characterId,
    status: enough ? 'READY_FOR_REVIEW' : 'INSUFFICIENT_EVIDENCE',
    sourceReferences: [source], excerpts, dimensions, metrics,
    suggestedInstructions: dimensions.flatMap((finding) => finding.suggestedRule ? [finding.suggestedRule] : []),
    warnings: [
      ...(!enough ? ['확인된 발화 표본이 부족합니다. 화자를 확인하거나 대사 표본을 추가해 주세요.'] : []),
      ...(excerpts.some((e) => !e.characterId) ? ['화자가 불명확한 발화는 분석 근거에서 제외했습니다.'] : []),
      ...(sanitizeStyleTextAgainstInjection(params.text).markerCount ? ['원고에서 격리된 명령형 문구는 분석 근거로 사용하지 않았습니다.'] : []),
    ],
    geminiExecuted: false, requiresAuthorApproval: true, autoApplied: false,
  };
}

export function voiceProfileId(characterId: string): string {
  return `voice_${computeManuscriptContentHash(characterId).slice(7)}`;
}

export function buildApprovedVoiceContent(candidate: CharacterVoiceAnalysisCandidate, instructions: string[]): string {
  const rules = instructions.map((item) => sanitizeStyleTextAgainstInjection(item).sanitized.trim()).filter(Boolean);
  if (candidate.status !== 'READY_FOR_REVIEW' || !rules.length) throw new Error('확인된 대사와 승인할 지침이 필요합니다.');
  const sources = candidate.sourceReferences.map(({ episodeId, revisionId, contentHash }) => ({ episodeId, revisionId, contentHash }));
  return [
    '이 규칙은 지정된 등장인물의 발화에만 적용한다. CANON, Master Writing Rules, 동적 시점과 확인된 관계가 우선이다.',
    '원문 대사는 복제하지 않는다. 관계·감정·성장에 따른 의도적인 변화는 유지한다.',
    ...rules.map((rule) => `- ${rule}`),
    `<!-- VOICE_DNA_SOURCES ${JSON.stringify(sources)} -->`,
  ].join('\n');
}

export function readApprovedVoiceSources(content: string): VoiceSourceReference[] {
  const trailer = content.match(/\n<!-- VOICE_DNA_SOURCES (.*) -->$/)?.[1];
  if (!trailer) return [];
  try {
    const parsed: unknown = JSON.parse(trailer);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is VoiceSourceReference =>
      entry && typeof entry === 'object' && typeof entry.contentHash === 'string' &&
      /^sha256_[a-f0-9]{64}$/.test(entry.contentHash) &&
      (entry.episodeId === undefined || typeof entry.episodeId === 'string') &&
      (entry.revisionId === undefined || typeof entry.revisionId === 'string'));
  } catch {
    return [];
  }
}
