import type { PromptProfile, RagRetrievedEvidenceItem, WritingContextBundle, WritingPlan } from '../types/aiEngine';
import type { MemoryChunk, MemoryDocument, NarrativePerspective } from '../types/foundation';
import { EVALUATION_SCENARIOS, type EvaluationScenarioId } from '../types/novelWritingEvaluation';
import { verifyChunkAgainstLiveSource } from '../services/memorySearchProvider';
import { createInitialPromptProfiles } from './aiEngineLogic';
import { analyzeVoiceSample, buildApprovedVoiceContent, voiceProfileId } from './characterVoiceLogic';
import { KOREAN_WEB_NOVEL_BENCHMARKS } from './literaryQualityBenchmark';
import { LITERARY_REWRITING_BENCHMARKS } from './literaryRewritingBenchmark';
import { computeManuscriptContentHash } from './manuscriptIntegrity';

export const EVALUATION_OWNER_ID = 'novel_writer_evaluation';
export const EVALUATION_DATASET_VERSION = 'synthetic-nw-v1';
const createdAt = '2026-11-23T00:00:00.000Z';
const cast = [
  { id: 'kael', name: '카엘', role: '수습 기사', affiliation: '회백 성채', personality: '조심스럽고 상대의 계급을 존중한다.', abilities: '왼팔에 붕대를 감았다.', appearance: '젖은 회색 망토를 입었다.' },
  { id: 'sera', name: '세라피나', role: '경비대장', affiliation: '회백 성채', personality: '판단이 빠르고 말이 짧다.', abilities: '성문과 신호 체계를 안다.', appearance: '남색 외투를 입었다.' },
  { id: 'garen', name: '가렌', role: '외곽 보초', affiliation: '회백 성채', personality: '오래된 비유로 말을 맺는다.', abilities: '초소 종을 맡는다.', appearance: '청동 배지를 찼다.' },
];
const commonCanon = '회백 성채에는 붉은 경보종과 푸른 실을 묶는 암호가 있다. 붉은 경보종은 낙뢰 파편에 금이 가 소리가 닿는 거리가 짧다.';

interface Scenario {
  goal: string;
  event: string;
  witness: RegExp;
  source: string;
  baseline: string;
  variant: string;
  perspective?: NarrativePerspective;
  cast?: string[];
}
const plots: Record<EvaluationScenarioId, Scenario> = {
  NW1: {
    goal: '빗속에서 순찰을 마치고 카엘이 평범한 휴식을 되찾는다.', event: '순찰을 일찍 마치기로 합의한다.', witness: /순찰.{0,24}(접|마치|끝|줄이)/,
    source: '비가 오면 물에 젖은 나무 계단 대신 안쪽 회랑으로 순찰한다.',
    baseline: KOREAN_WEB_NOVEL_BENCHMARKS[6].manuscript,
    variant: '처마 끝의 물방울이 찻물에 동그란 자국을 냈다. 카엘은 잔을 안으로 끌었다.\n\n“순찰은 여기서 마치겠습니다, 대장님.” 카엘이 말했다.\n\n“그래. 젖은 장갑부터 말려.” 세라피나가 말했다.',
  },
  NW2: {
    goal: '좁은 계단을 지키는 카엘이 후퇴로를 확보한다.', event: '동료가 물러날 틈을 만든다.', witness: /물러|퇴로|후퇴/,
    source: '젖은 서쪽 계단은 한 사람만 지나갈 폭이다.',
    baseline: '창끝이 돌을 긁었다. 나는 계단 모서리를 등지고 방패를 올렸다.\n\n“뒤로 물러서십시오.” 내가 외쳤다. 발자국 하나가 내 뒤의 웅덩이를 건넜다.',
    variant: KOREAN_WEB_NOVEL_BENCHMARKS[5].manuscript + '\n\n“물러서십시오!” 내가 외치며 창대를 계단 벽에 눌렀다.',
    perspective: 'FIRST_PERSON',
  },
  NW3: {
    goal: '순찰 지도의 오기로 두 사람이 대립하지만 담당을 다시 나눈다.', event: '카엘이 지도에 잘못 그린 길을 지운다.', witness: /지우|지웠|지워/,
    source: '지도에서 두 줄로 표시한 길은 지붕 있는 회랑을 뜻한다.',
    baseline: '카엘은 짐짓 못 본 체 지도를 접었다. 세라피나가 종이 한쪽을 잡았다.\n\n“틀린 곳부터 지워.” 세라피나가 말했다. 카엘은 잘못 그은 길을 지웠다.',
    variant: '종이의 모서리가 세라피나의 손가락 아래서 울었다. 카엘은 자기 쪽으로 당기던 손을 놓았다.\n\n“제가 지우겠습니다.” 카엘이 말했다. 먹점이 번진 쪽은 세라피나에게 밀어 주었다.',
  },
  NW4: {
    goal: '두 사람이 처음으로 감시를 서로에게 맡긴다.', event: '카엘이 열쇠를 세라피나에게 건넨다.', witness: /열쇠.{0,28}(건네|건넸|밀|내밀|올려|맡)/,
    source: '열쇠를 맡기는 사람은 마지막으로 확인한 출입 순서를 알려 준다.',
    baseline: '카엘이 잠금쇠를 한 번 더 확인했다. 복도에는 둘뿐이었다.\n\n“열쇠를 맡기겠습니다.” 카엘이 말했다. 그는 마지막 출입 순서도 덧붙였다.',
    variant: '열쇠는 주머니 바닥에서 손보다 차가웠다. 카엘은 출입 순서를 하나씩 불러 주고 닳은 이빨이 상대 손등을 긁지 않게 돌렸다.\n\n“대장님께 열쇠를 건네겠습니다.” 카엘이 말했다.',
  },
  NW5: {
    goal: '배신 직후 봉인을 보며 상대의 설명을 들을지 결정한다.', event: '봉인을 먼저 검사한다.', witness: /봉인/,
    source: '전날 문서고의 위치가 외부에 새었으며 부상한 카엘을 범인으로 확정할 증거는 없다.',
    baseline: KOREAN_WEB_NOVEL_BENCHMARKS[4].manuscript,
    variant: '문이 열릴 때 세라피나는 한 발만 물러났다. 어제와 같은 거리였다. 다만 이번에는 카엘의 눈보다 그의 검집 가장자리에 박힌 봉인을 살폈다.\n\n“거기에 내려놔.” 세라피나가 말했다.',
    cast: ['sera', 'kael'],
  },
  NW6: {
    goal: '종소리에 움츠러든 카엘이 시신이나 환상을 현실로 착각하지 않고 도움을 요청한다.', event: '숨을 고른 뒤 동료를 부른다.', witness: /대장님|도와|불렀/,
    source: '카엘은 지난 회차에 종이 울린 직후 계단의 붕괴를 겪었다.',
    baseline: '종이 울리자 카엘은 문턱을 붙잡았다. 무너지는 돌을 떠올리자 숨이 가빴다.\n\n“대장님, 잠시 도와주십시오.” 카엘이 말했다.',
    variant: '종이 한 번 울렸다. 카엘이 매달린 문턱은 그대로였다. 손바닥에 박힌 나뭇결을 셋까지 헤아리고서야 그는 복도를 보았다.\n\n“대장님.” 카엘이 불렀다. “잠시 옆에 서 주시겠습니까?”',
  },
  NW7: {
    goal: '세라피나가 추모 명단을 읽고도 감정을 절제한 채 근무를 계속한다.', event: '추모 명단을 접는다.', witness: /명단.{0,28}(접|개켰)/,
    source: '추모 명단은 인수인계가 끝날 때까지 경비대장이 보관한다.',
    baseline: '세라피나는 세 번째 이름에서 읽기를 멈췄다. 숨을 크게 들이쉬지 않으려고 했다. 추모 명단을 접고 등불을 제자리에 옮겼다.',
    variant: '세 번째 이름 아래서 종이가 축축해졌다. 세라피나는 젖은 부분이 활자에 닿지 않도록 명단을 접었다. 문밖에서 다음 교대의 굽 소리가 났다.',
    cast: ['sera'],
  },
  NW8: {
    goal: '같은 발자국을 두 인물이 다른 어조로 해석한다.', event: '두 사람이 발자국을 관찰한다.', witness: /발자국/,
    source: '북문 흙길의 발자국은 새벽 교대 때 확인한다.',
    baseline: '카엘은 문턱 너머 발자국을 가리켰다.\n\n“비가 오기 전 흔적 같습니다.” 카엘이 말했다.\n\n“그렇게 보이네.” 세라피나가 말했다.',
    variant: '빗물이 발자국 바닥에만 고여 있었다. 카엘은 장갑의 물기를 털고 쪼그렸다.\n\n“대장님, 비 오기 전에 지나간 것 같습니다.” 카엘이 말했다.\n\n“발끝을 봐. 돌아온 길은 아니야.” 세라피나가 말했다.',
  },
  NW9: {
    goal: '상급자에게 카엘이 실패를 보고하고 새 배치를 요청한다.', event: '카엘이 교대에 늦었음을 보고한다.', witness: /교대.{0,22}(늦|놓쳤|지연)/,
    source: '정해진 교대를 놓쳤을 때는 현장 책임자에게 먼저 보고한다.',
    baseline: '카엘은 가쁜 숨을 고르고 문턱 앞에 멈췄다.\n\n“교대에 늦었습니다.” 카엘이 말했다.\n\n“다음 배치는 네가 확인해.” 세라피나가 말했다.',
    variant: '문턱을 넘기 전에 카엘은 장갑에 밴 흙을 보았다. 그 장갑을 뒤로 숨기지 않았다.\n\n“대장님, 교대에 늦었습니다.” 카엘이 말했다.\n\n“알았어. 이젠 누가 비었는지부터 말해.” 세라피나가 말했다.',
  },
  NW10: {
    goal: '카엘이 자신의 판단을 의심하면서도 등불을 끄기로 결정한다.', event: '카엘이 등불을 끈다.', witness: /등불.{0,22}(끄|껐|꺼뜨|껐다)/,
    source: '감시자가 복도에 들면 등불은 바깥 창에서 보인다.',
    baseline: '나는 바람에 흔들리는 등불을 보았다. 내가 착각했을 수도 있지만 불빛은 밖에서도 보일 터였다. 손을 들어 등불을 껐다.',
    variant: '등불을 끄면 내가 본 발자국도 묻힐 것 같았다. 발자국은 불이 없어도 거기에 있겠지. 아마. 나는 유리 덮개를 열어 심지를 눌렀다. 등불이 꺼졌다.',
    perspective: 'FIRST_PERSON', cast: ['kael'],
  },
  NW11: {
    goal: '카엘이 세라피나의 표정만 보고 아직 말하지 않은 정보를 추측한다.', event: '카엘이 대답을 기다리기로 한다.', witness: /기다리|기다렸/,
    source: '세라피나의 비밀 서신에는 외벽 암호가 적혀 있으나 카엘은 본 적이 없다.',
    baseline: '세라피나는 외투 안쪽을 누르고 있었다. 그 손이 움직이지 않아 카엘은 말을 꺼내다 말았다. 그는 한 걸음 비켜 대답을 기다렸다.',
    variant: '세라피나의 손이 외투 안쪽에서 멎었다. 편지인지 상처인지는 카엘 자리에서 보이지 않았다. 그는 입술을 닫고 먼저 대답을 기다렸다.',
  },
  NW12: {
    goal: '푸른 실이 가리키는 통로에서 앞 회차의 경보종 단서를 되짚는다.', event: '카엘이 푸른 실을 발견한다.', witness: /푸른 실/,
    source: '앞 회차에서 푸른 실은 안쪽 통로의 표시였다. 붉은 경보종은 금이 간 뒤 교체되지 않았다.',
    baseline: '카엘은 기둥 밑에서 푸른 실을 발견했다. 그는 그것이 안쪽 통로의 표시임을 기억하고 금이 간 경보종을 올려다보았다.',
    variant: '기둥을 감은 푸른 실은 비에 색이 어두워졌다. 카엘은 매듭을 보고 안쪽 통로 쪽으로 몸을 틀었다. 금 간 경보종이라면 그 안에서 소리를 듣지 못할 수도 있었다.',
  },
};

export function buildEvaluationFixture(scenarioId: EvaluationScenarioId, modelId: string) {
  const scene = plots[scenarioId];
  const title = EVALUATION_SCENARIOS.find(([id]) => id === scenarioId)![1];
  const projectId = `novel_eval_${scenarioId.toLowerCase()}`;
  const ownerId = EVALUATION_OWNER_ID;
  const episodeId = `${projectId}_episode`;
  const characterIds = scene.cast ?? ['kael', 'sera'];
  const pov = scene.perspective ?? 'THIRD_LIMITED';
  const sourceId = `${projectId}_previous`;
  const revisionId = `${sourceId}_v1`;
  const sourceText = `${commonCanon} ${scene.source}`;
  const document: MemoryDocument = {
    id: `${sourceId}_doc`, ownerId, projectId, sourceEntityType: 'EPISODE', sourceEntityId: sourceId,
    sourceRevisionId: revisionId, fullText: sourceText, title: '이전 회차 확정 단서', chunkCount: 1,
    canonStatus: 'CANON', indexStatus: 'INDEXED', createdAt, updatedAt: createdAt, contentHash: computeManuscriptContentHash(sourceText),
  };
  const chunk: MemoryChunk = {
    id: `${sourceId}_chunk`, documentId: document.id, ownerId, projectId, sourceEntityType: 'EPISODE',
    sourceEntityId: sourceId, sourceRevisionId: revisionId, chunkIndex: 0, content: sourceText,
    sourceStartOffset: 0, sourceEndOffset: sourceText.length, tokenEstimate: Math.ceil(sourceText.length / 2),
    keywords: [], episodeId: sourceId, sceneId: `${sourceId}_scene`, characterIds: [], foreshadowingIds: [], canonStatus: 'CANON', createdAt,
  };
  const source = { exists: true, latestRevisionId: revisionId, canonStatus: 'CANON' as const, fullText: sourceText };
  const rag = verifyEvaluationEvidence(chunk, document, source);
  const forbidden = ['공간 이동 마법 사용 금지', '죽은 인물 부활 금지', '상태창 생성 금지'];
  const plan: WritingPlan = {
    id: `${projectId}_plan`, ownerId, projectId, episodeId, episodeTitle: title, episodeGoal: scene.goal,
    requiredEvents: [scene.event], forbiddenDevelopments: forbidden, targetTotalCharCount: 550,
    narrativePerspective: 'THIRD_LIMITED', scenes: [{
      sceneNumber: 1, title, purpose: scene.goal, characterIds, characterNames: characterIds.map((id) => cast.find((person) => person.id === id)!.name),
      emotionalArc: '관찰에서 선택으로', targetCharCount: 550, connectionToNext: '선택의 여운', mustIncludeEvent: scene.event,
      narrativePerspective: pov, pointOfViewCharacterId: characterIds[0],
    }],
    plotDeviationWarnings: [], appliedPromptVersionIds: [], referencedSourceIds: [sourceId],
    modelId, status: 'APPROVED', approvedAt: createdAt, createdAt, updatedAt: createdAt,
  };
  const common = createInitialPromptProfiles(ownerId, projectId, createdAt).filter((profile) =>
    ['CORE_WRITING_RULES', 'CHARACTER_DIALOGUE_RULES', 'SCENE_INSTRUCTIONS'].includes(profile.promptType));
  const approvedProfile = (id: string, promptType: PromptProfile['promptType'], label: string, content: string, targetCharacterId?: string): PromptProfile => {
    const versionId = `${projectId}_${targetCharacterId ?? 'style'}_v1`;
    return {
      id, ownerId, projectId, promptType, title: label, description: '합성 벤치마크에서 명시적으로 승인한 고정 버전', content,
      targetCharacterId, isActive: true, currentVersionId: versionId, currentVersionNumber: 1,
      versions: [{ versionId, versionNumber: 1, content, label: 'v1', createdAt }], createdAt, updatedAt: createdAt,
    };
  };
  const styleSample = LITERARY_REWRITING_BENCHMARKS[7].manuscript;
  const style = approvedProfile(`${projectId}_style`, 'PROJECT_STYLE_PROFILE', '회백 성채의 문체', [
    '작가 승인 문체 지침. 확정 CANON과 Master Writing Rules 및 장면 시점이 우선이다.',
    '감각 단서와 행동의 변화를 번갈아 놓는다. 대답 앞에 필요한 여백만 두고 원문을 복제하지 않는다.',
    `<!-- STYLE_DNA_META sourceHash=${computeManuscriptContentHash(styleSample)} approvedAt=${createdAt} -->`,
  ].join('\n'));
  const voiceLines = [
    ['먼저 다녀오겠습니다.', '등불을 더 가져오겠습니다.', '확인해 주시겠습니까?'],
    ['자리를 비워.', '너는 여기 남아.', '이제 문을 닫아.'],
    ['쇠종의 그림자군.', '쇠종의 그림자 같군.', '쇠종의 그림자를 보게.'],
  ];
  const voice = cast.map((person, index) => {
    const text = voiceLines[index].map((line) => `“${line}” ${person.name}이 말했다.`).join('\n');
    const candidate = analyzeVoiceSample({ ownerId, projectId, characterId: person.id, text, cast });
    const rules = [
      '상급자를 대장님으로 부르고 존댓말로 확인한다.',
      '친숙한 부하에게 짧은 해체로 알린다.',
      '낯선 상황에는 오래된 종에 빗대어 말한다.',
    ];
    return approvedProfile(voiceProfileId(person.id), 'CHARACTER_DIALOGUE_RULES', `${person.name} 승인 화법`,
      buildApprovedVoiceContent(candidate, [rules[index]]), person.id);
  });
  const context: WritingContextBundle = {
    ownerId, projectId, episodeId, sceneCharacterIds: characterIds, projectTitle: '회백 성채', projectGenre: '한국 판타지',
    projectSynopsis: '쇠락한 산악 성채의 경비대가 비밀 통로와 경보의 내력을 추적한다.', episodeNumber: 2, episodeTitle: title,
    writingMode: 'SINGLE_SCENE', narrativePerspective: 'THIRD_LIMITED', projectDefaultPerspective: 'THIRD_LIMITED',
    scenePerspective: pov, pointOfViewCharacterId: characterIds[0], hasGameSystemInWorldbuilding: false,
    targetEpisodeCharCount: 550, targetSceneCharCount: 550, tolerancePercent: 25, plotOutline: scene.goal,
    requiredEvents: plan.requiredEvents, forbiddenDevelopments: forbidden, canonCharacters: cast,
    canonWorldbuilding: [{ id: `${projectId}_fort`, title: '회백 성채', category: '장소', summary: commonCanon, rules: '공간 이동 마법 사용 불가. 부활 불가. 상태창 없음.' }],
    previousEpisodeSummary: scene.source, previousEpisodeTailExcerpt: '', currentManuscript: '', approvedExceptions: [],
    activePrompts: common.map(toActivePrompt), referencedSources: [],
    retrievedMemoryChunks: [rag], missingEvidenceNotes: [],
  };
  return { scenarioId, title, scene, context, plan, style, voice, source: { chunk, document, source } };
}

export function toActivePrompt(profile: PromptProfile): WritingContextBundle['activePrompts'][number] {
  return {
    profileId: profile.id, ownerId: profile.ownerId, projectId: profile.projectId, title: profile.title, content: profile.content,
    promptType: profile.promptType, targetCharacterId: profile.targetCharacterId, isActive: profile.isActive,
    versionId: profile.currentVersionId, versionNumber: profile.currentVersionNumber, versionLabel: profile.versionLabel,
  };
}

export function verifyEvaluationEvidence(chunk: MemoryChunk, document: MemoryDocument,
  source: { exists: boolean; latestRevisionId: string; fullText: string; canonStatus: 'CANON' }): RagRetrievedEvidenceItem {
  const { sourceStartOffset: start, sourceEndOffset: end } = chunk;
  const verification = verifyChunkAgainstLiveSource({ chunk, document, liveSources: { [chunk.sourceEntityId]: source } });
  if (!verification.verifiedForWriting || verification.freshnessStatus !== 'FRESH' ||
      chunk.documentId !== document.id || chunk.sourceEntityId !== document.sourceEntityId ||
      chunk.sourceRevisionId !== document.sourceRevisionId || chunk.projectId !== document.projectId ||
      chunk.ownerId !== EVALUATION_OWNER_ID || document.ownerId !== EVALUATION_OWNER_ID || chunk.canonStatus !== 'CANON' ||
      document.contentHash !== computeManuscriptContentHash(source.fullText) ||
      start === undefined || end === undefined || start < 0 || end <= start || end > source.fullText.length ||
      source.fullText.slice(start, end) !== chunk.content) throw new Error('RAG_PROVENANCE_FAILURE');
  return {
    chunkId: chunk.id, documentId: document.id, projectId: chunk.projectId, sourceEntityType: chunk.sourceEntityType,
    sourceEntityId: chunk.sourceEntityId, sourceRevisionId: chunk.sourceRevisionId, episodeId: chunk.episodeId,
    sceneId: chunk.sceneId, title: document.title, originalText: chunk.content, sourceStartOffset: start, sourceEndOffset: end,
    score: 1, relevanceScore: 1, keywordScore: 1, semanticScore: 0, matchedTerms: [], canonStatus: 'CANON', ...verification,
  };
}

export type EvaluationFixture = ReturnType<typeof buildEvaluationFixture>;
