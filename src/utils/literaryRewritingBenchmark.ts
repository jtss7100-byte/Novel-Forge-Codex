import type { NarrativePerspective } from '../types/foundation';
import type { WritingContextBundle } from '../types/aiEngine';
import type {
  LiteraryRewriteAiDecision,
  LiteraryRewriteMode,
} from '../types/literaryRewriting';
import type { LiteraryRewriteAiOutput } from './literaryRewritingLogic';
import { createRewriteSelectionAnchor } from './manuscriptIntegrity';

export interface LiteraryRewritingBenchmarkFixture {
  id: 'RW1' | 'RW2' | 'RW3' | 'RW4' | 'RW5' | 'RW6' | 'RW7' | 'RW8';
  titleKo: string;
  perspective: NarrativePerspective;
  modes: LiteraryRewriteMode[];
  expectedDecision: LiteraryRewriteAiDecision;
  manuscript: string;
  targetExcerpt: string;
  authorInstruction: string;
  contextOverrides?: Partial<WritingContextBundle>;
  mockReferenceAiOutput: LiteraryRewriteAiOutput;
}

const RW1_MANUSCRIPT =
  '성문 밖 바람은 매서웠다.\n그녀는 그녀 자신의 검을 그녀의 손으로 들어 올렸다. 그것은 그녀에게 있어 피할 수 없는 선택이었던 것이다. 차가운 바람에 의해 흩날리는 붉은 망토는 마치 피와 같았다.\n멀리서 북소리가 울렸다.';

const RW2_MANUSCRIPT =
  '카엘은 어두운 복도 끝에 멈춰 섰다.\n카엘은 심장이 뛰었다. 그는 두려움을 느꼈다. 공포가 그의 마음을 지배했다. 그는 입꼬리가 올라갔으나 알 수 없는 감정에 눈빛이 흔들렸다.\n검집 끝이 돌바닥에 부딪혔다.';

const RW3_MANUSCRIPT =
  '작전 막사 안의 등불이 흔들렸다.\n“그렇군요, 기사님. 지금 당장 북쪽 성벽으로 이동하는 것이 합리적이라고 생각합니다.” 노병 가렌이 말했다.\n“네, 사령관님. 지금 당장 북쪽 성벽으로 이동하는 것이 합리적이라고 생각합니다.” 철부지 도적 리온이 말했다.\n지도 위에는 붉은 깃발 세 개가 꽂혀 있었다.';

const RW4_MANUSCRIPT =
  '검은 탑의 문이 천천히 열렸다.\n카엘은 검을 뽑았다. 참고로 이 검의 이름은 에테르 블레이드로 300년 전 제1차 마도 전쟁 당시 엘프 대장장이가 미스릴과 별빛 광석을 합쳐 제작한 7대 신기 중 하나이며 총 3단계 해방 구조를 지니고 있고 마력 순환율은 94%다.\n돌계단 아래에서 찬 공기가 밀려 올라왔다.';

const RW5_MANUSCRIPT =
  '전투 직후 성벽 위는 고요했다.\n카엘은 성벽에 기대었다. 카엘은 숨을 몰아쉬었다. 카엘은 검을 내려놓았다. 카엘은 하늘을 올려다보았다. 하늘에는 검은 연기가 피어오르고 있었다.\n아래쪽 성문에서 함성이 터져 나왔다.';

const RW6_MANUSCRIPT =
  '나는 왼팔 붕대를 매만지며 회랑 기둥 뒤에 몸을 숨겼다.\n나는 왼팔을 크게 휘둘러 대검을 뽑고 마법으로 순식간에 성벽 반대편으로 도약했다.\n등 뒤에서 발소리가 멈췄다.';

const RW7_MANUSCRIPT =
  '어제 배신이 있은 직후였다.\n나는 상대의 눈을 마주 보며 피식 웃으며 차가운 미소를 지었다. 심장이 멎는 듯했지만 그것은 나에게 있어 어쩔 수 없는 선택이었던 것이다.\n탁자 위의 찻잔이 식어 가고 있었다.';

const RW8_MANUSCRIPT =
  '잿빛 눈발이 성벽 틈새로 스며들었다.\n카엘은 장갑을 낀 손으로 창틀에 얹힌 서리를 쓸어내렸다. 며칠째 멎지 않은 눈 탓에 전령마저 끊긴 성채 안에는 장작 타는 냄새와 눅눅한 철 내음만 짙었다.\n“북문 쪽 보초 교대는 마쳤습니다.”\n세라피나가 젖은 외투를 털며 들어왔다.';

export const LITERARY_REWRITING_BENCHMARKS: LiteraryRewritingBenchmarkFixture[] = [
  {
    id: 'RW1',
    titleKo: 'R1: 번역투·지시대명사 과다 문장 자연화 (비선택 영역 보존)',
    perspective: 'THIRD_LIMITED',
    modes: ['R1'],
    expectedDecision: 'REWRITTEN',
    manuscript: RW1_MANUSCRIPT,
    targetExcerpt:
      '그녀는 그녀 자신의 검을 그녀의 손으로 들어 올렸다. 그것은 그녀에게 있어 피할 수 없는 선택이었던 것이다. 차가운 바람에 의해 흩날리는 붉은 망토는 마치 피와 같았다.',
    authorInstruction: '중복 지시대명사와 번역투 피동형을 자연스러운 한국어 서술로 다듬어 주세요.',
    mockReferenceAiOutput: {
      decision: 'REWRITTEN',
      appliedModes: ['R1'],
      rewrittenExcerpt:
        '세라피나는 검자루를 고쳐 쥔 채 칼날을 들어 올렸다. 물러설 길 없는 선택이었다. 찬 바람을 맞고 나부끼는 붉은 망토가 핏빛처럼 어른거렸다.',
      changeRationale:
        '"그녀는/그녀 자신의/그녀의" 반복과 "~었던 것이다", "~에 의해" 번역투 피동형을 덜어내어 능동적이고 자연스러운 한국어 서사로 정돈했습니다.',
      preservedElements: [
        '3인칭 제한 시점 유지',
        '세라피나가 검을 들어 올린 행동과 붉은 망토 시각 정보 보존',
      ],
      noOpReason: null,
      canonConflictAlerts: [],
      perspectiveCheck: {
        expectedPerspective: 'THIRD_LIMITED',
        maintained: true,
        note: '3인칭 제한 시점이 일관되게 유지되었습니다.',
      },
      characterVoiceNotes: ['시점 인물 중심의 절제된 서술 어조 유지'],
      candidateLoreProposals: [],
    },
  },
  {
    id: 'RW2',
    titleKo: 'R2: 추상적 공포/상투어 -> 신체 감각·구체적 행동 묘사',
    perspective: 'THIRD_LIMITED',
    modes: ['R2'],
    expectedDecision: 'REWRITTEN',
    manuscript: RW2_MANUSCRIPT,
    targetExcerpt:
      '카엘은 심장이 뛰었다. 그는 두려움을 느꼈다. 공포가 그의 마음을 지배했다. 그는 입꼬리가 올라갔으나 알 수 없는 감정에 눈빛이 흔들렸다.',
    authorInstruction: '"두려움/공포" 직접 설명과 AI 상투어를 신체 감각과 주변 사물 디테일로 대체해 주세요.',
    mockReferenceAiOutput: {
      decision: 'REWRITTEN',
      appliedModes: ['R2'],
      rewrittenExcerpt:
        '카엘의 갈비뼈 안쪽이 둔탁하게 울렸다. 검자루를 쥔 손바닥에 눅눅한 식은땀이 배어 나와 가죽 끈이 미끄러졌다. 어둠 너머에서 스며드는 기척에, 그는 숨을 죽인 채 한 발 뒤로 물러섰다.',
      changeRationale:
        '추상적 감정 명사("두려움", "공포")와 상투구("입꼬리가 올라갔으나", "알 수 없는 감정", "눈빛이 흔들렸다")를 맥박·식은땀·손바닥 감각 묘사로 구체화했습니다.',
      preservedElements: [
        '어두운 복도 끝에서 긴장하는 카엘의 상태',
        '3인칭 제한 시점',
      ],
      noOpReason: null,
      canonConflictAlerts: [],
      perspectiveCheck: {
        expectedPerspective: 'THIRD_LIMITED',
        maintained: true,
        note: '카엘 시점의 내·외부 감각만 서술했습니다.',
      },
      characterVoiceNotes: ['전장 경험자다운 억제된 긴장 반응 유지'],
      candidateLoreProposals: [],
    },
  },
  {
    id: 'RW3',
    titleKo: 'R3: 캐릭터 말투·호칭 차별화 (노병 vs 철부지 도적)',
    perspective: 'THIRD_LIMITED',
    modes: ['R3'],
    expectedDecision: 'REWRITTEN',
    manuscript: RW3_MANUSCRIPT,
    targetExcerpt:
      '“그렇군요, 기사님. 지금 당장 북쪽 성벽으로 이동하는 것이 합리적이라고 생각합니다.” 노병 가렌이 말했다.\n“네, 사령관님. 지금 당장 북쪽 성벽으로 이동하는 것이 합리적이라고 생각합니다.” 철부지 도적 리온이 말했다.',
    authorInstruction: '노병과 철부지 도적의 CANON 성격·말투·호칭을 대사에 드러내 주세요.',
    mockReferenceAiOutput: {
      decision: 'REWRITTEN',
      appliedModes: ['R3'],
      rewrittenExcerpt:
        '“단장, 뜸 들일 틈이 없소. 당장 북쪽 성벽으로 병력을 돌려야 하오.” 수염을 쓸며 가렌이 잘라 말했다.\n“에이, 사령관님! 계산 따질 시간 있으면 지금 바로 북쪽 성벽 쪽으로 뛰는 게 남는 장사라니까요?” 리온이 단검을 돌리며 낄낄거렸다.',
      changeRationale:
        '기계적으로 동일하던 두 인물의 합리적 문어체를, 노병 가렌의 투박한 하오체와 도적 리온의 가볍고 넉살 좋은 말투·동작으로 분리했습니다.',
      preservedElements: [
        '북쪽 성벽으로 이동하자고 주장하는 사건 핵심',
        '두 인물의 상하 호칭 및 관계',
      ],
      noOpReason: null,
      canonConflictAlerts: [],
      perspectiveCheck: {
        expectedPerspective: 'THIRD_LIMITED',
        maintained: true,
        note: '관찰 가능한 대사와 동작만으로 구성했습니다.',
      },
      characterVoiceNotes: [
        '가렌: 전장 베테랑 특유의 단호한 하오체',
        '리온: 경쾌하고 실리적인 도적 어투',
      ],
      candidateLoreProposals: [],
    },
  },
  {
    id: 'RW4',
    titleKo: 'R5: 과도한 설정 설명(인포덤프) 압축 및 장면 정보 균형',
    perspective: 'THIRD_LIMITED',
    modes: ['R5'],
    expectedDecision: 'REWRITTEN',
    manuscript: RW4_MANUSCRIPT,
    targetExcerpt:
      '카엘은 검을 뽑았다. 참고로 이 검의 이름은 에테르 블레이드로 300년 전 제1차 마도 전쟁 당시 엘프 대장장이가 미스릴과 별빛 광석을 합쳐 제작한 7대 신기 중 하나이며 총 3단계 해방 구조를 지니고 있고 마력 순환율은 94%다.',
    authorInstruction: '긴박한 문 열리는 장면에서 늘어지는 백과사전식 설명을 행동 위주로 압축하세요.',
    mockReferenceAiOutput: {
      decision: 'REWRITTEN',
      appliedModes: ['R5'],
      rewrittenExcerpt:
        '카엘이 에테르 블레이드를 뽑아 들자, 미스릴 칼날을 타고 300년 된 마력 각인이 푸르게 깨어났다.',
      changeRationale:
        '장면 템포를 끊던 "참고로~", 수치 나열(94%) 인포덤프를 덜어내고 검의 이름과 마력 반응만 행동 속에 녹여 압축했습니다.',
      preservedElements: [
        '검 이름(에테르 블레이드)과 미스릴 재질 정보',
        '카엘이 검을 뽑아 든 핵심 동작',
      ],
      noOpReason: null,
      canonConflictAlerts: [],
      perspectiveCheck: {
        expectedPerspective: 'THIRD_LIMITED',
        maintained: true,
        note: '3인칭 제한 시점 유지',
      },
      characterVoiceNotes: ['행동 중심의 간결한 판타지 서술 유지'],
      candidateLoreProposals: [],
    },
  },
  {
    id: 'RW5',
    titleKo: 'R4: 단조로운 "카엘은~" 연속 주어 제거 및 문장 호흡 변주',
    perspective: 'THIRD_LIMITED',
    modes: ['R4'],
    expectedDecision: 'REWRITTEN',
    manuscript: RW5_MANUSCRIPT,
    targetExcerpt:
      '카엘은 성벽에 기대었다. 카엘은 숨을 몰아쉬었다. 카엘은 검을 내려놓았다. 카엘은 하늘을 올려다보았다. 하늘에는 검은 연기가 피어오르고 있었다.',
    authorInstruction: '반복 주어 나열을 호흡감 있는 문장으로 엮어 모바일 가독성을 높여 주세요.',
    mockReferenceAiOutput: {
      decision: 'REWRITTEN',
      appliedModes: ['R4'],
      rewrittenExcerpt:
        '성벽 돌담에 등을 기댄 채 거친 숨을 골랐다. 카엘은 묵직해진 검을 발치에 내려놓고 고개를 젖혔다. 잿빛 하늘 너머로 여전히 검은 연기가 피어오르고 있었다.',
      changeRationale:
        '네 문장 연속 반복되던 "카엘은" 주어를 통합하고 짧은 호흡과 긴 시선 이동을 교차해 독서 리듬을 개선했습니다.',
      preservedElements: [
        '성벽에 기대어 숨을 고르고 검을 내려놓은 뒤 검은 연기를 올려다보는 동작 순서',
      ],
      noOpReason: null,
      canonConflictAlerts: [],
      perspectiveCheck: {
        expectedPerspective: 'THIRD_LIMITED',
        maintained: true,
        note: '3인칭 제한 시점 유지',
      },
      characterVoiceNotes: ['피로감이 묻어나는 정적인 장면 호흡'],
      candidateLoreProposals: [],
    },
  },
  {
    id: 'RW6',
    titleKo: 'R6: CANON 물리 제약(왼팔 부상) 및 1인칭 시점 일관성 교정',
    perspective: 'FIRST_PERSON',
    modes: ['R6'],
    expectedDecision: 'REWRITTEN',
    manuscript: RW6_MANUSCRIPT,
    targetExcerpt:
      '나는 왼팔을 크게 휘둘러 대검을 뽑고 마법으로 순식간에 성벽 반대편으로 도약했다.',
    authorInstruction: '왼팔 중상 제약과 성채 내 공간이동 금지 CANON 규칙을 반영해 수정하세요.',
    mockReferenceAiOutput: {
      decision: 'REWRITTEN',
      appliedModes: ['R6'],
      rewrittenExcerpt:
        '나는 쓰리지 않는 왼팔 대신 오른손으로 단검 자루를 움켜쥔 채, 무너진 성벽 회랑을 따라 낮은 포복으로 반대편 그늘까지 몸을 굴렸다.',
      changeRationale:
        '확정 설정(왼팔 중상 및 공간이동 마법 금지)과 어긋나던 대검 양손 사용·마법 도약 서술을 현실적인 오른손 행동과 물리 이동으로 바로잡았습니다.',
      preservedElements: [
        '1인칭 화자("나는") 유지',
        '회랑 기둥 뒤에서 반대편으로 이동하는 장면 목표',
      ],
      noOpReason: null,
      canonConflictAlerts: [
        {
          severity: 'WARNING',
          referenceLoreId: null,
          description:
            '원문의 마법 도약 표현은 성채 내 공간이동 금지 규칙과 어긋나 물리 이동으로 정정했습니다.',
        },
      ],
      perspectiveCheck: {
        expectedPerspective: 'FIRST_PERSON',
        maintained: true,
        note: '1인칭 시점("나는")이 정확히 유지되었습니다.',
      },
      characterVoiceNotes: ['부상당한 1인칭 화자의 절박하고 냉정한 상황 판단'],
      candidateLoreProposals: [],
    },
  },
  {
    id: 'RW7',
    titleKo: 'R1+R3+R5 복합 모드: 번역투+상투어 동시 제거 (1인칭 화자 보존)',
    perspective: 'FIRST_PERSON',
    modes: ['R1', 'R3', 'R5'],
    expectedDecision: 'REWRITTEN',
    manuscript: RW7_MANUSCRIPT,
    targetExcerpt:
      '나는 상대의 눈을 마주 보며 피식 웃으며 차가운 미소를 지었다. 심장이 멎는 듯했지만 그것은 나에게 있어 어쩔 수 없는 선택이었던 것이다.',
    authorInstruction: '상투어와 번역투를 함께 덜어내고 화자의 냉소적인 개성을 살려 주세요.',
    mockReferenceAiOutput: {
      decision: 'REWRITTEN',
      appliedModes: ['R1', 'R3', 'R5'],
      rewrittenExcerpt:
        '나는 상대의 시선을 피하지 않은 채 건조하게 입술을 뗐다. 가슴 안쪽이 서늘하게 가라앉았지만, 처음부터 다른 패는 손에 없었다.',
      changeRationale:
        '"피식 웃으며 차가운 미소", "심장이 멎는 듯", "~었던 것이다" 상투어와 번역투를 제거하고 1인칭 화자 고유의 건조한 비유로 재구성했습니다.',
      preservedElements: [
        '1인칭 화자의 냉소적 태도와 선택의 불가피성',
        '직후 이어지는 식은 찻잔 장면 연결성',
      ],
      noOpReason: null,
      canonConflictAlerts: [],
      perspectiveCheck: {
        expectedPerspective: 'FIRST_PERSON',
        maintained: true,
        note: '1인칭 화자 중심 서술 유지',
      },
      characterVoiceNotes: ['차분하고 계산적인 1인칭 독백 어투 유지'],
      candidateLoreProposals: [],
    },
  },
  {
    id: 'RW8',
    titleKo: 'NO_OP_OPTIMAL: 이미 완성도 높은 한국어 문장의 과잉 수정 방지',
    perspective: 'THIRD_LIMITED',
    modes: ['R1', 'R2'],
    expectedDecision: 'NO_OP_OPTIMAL',
    manuscript: RW8_MANUSCRIPT,
    targetExcerpt:
      '카엘은 장갑을 낀 손으로 창틀에 얹힌 서리를 쓸어내렸다. 며칠째 멎지 않은 눈 탓에 전령마저 끊긴 성채 안에는 장작 타는 냄새와 눅눅한 철 내음만 짙었다.',
    authorInstruction: '문장이 이미 자연스럽다면 불필요하게 고치지 말아 주세요.',
    mockReferenceAiOutput: {
      decision: 'NO_OP_OPTIMAL',
      appliedModes: [],
      rewrittenExcerpt:
        '카엘은 장갑을 낀 손으로 창틀에 얹힌 서리를 쓸어내렸다. 며칠째 멎지 않은 눈 탓에 전령마저 끊긴 성채 안에는 장작 타는 냄새와 눅눅한 철 내음만 짙었다.',
      changeRationale:
        '시각(서리·눈), 후각(장작 타는 냄새·철 내음), 서사적 고립 정보(전령 두절)가 이미 간결하고 균형 잡힌 호흡으로 결합되어 있어 수정 시 문체의 밀도가 오히려 떨어질 우려가 있습니다.',
      preservedElements: [
        '원문 감각 묘사와 호흡 전체 보존',
      ],
      noOpReason:
        '감각 묘사·리듬·서사 정보가 이미 최적 균형을 이루고 있어 수정하지 않는 선택(NO_OP_OPTIMAL)이 가장 적절합니다.',
      canonConflictAlerts: [],
      perspectiveCheck: {
        expectedPerspective: 'THIRD_LIMITED',
        maintained: true,
        note: '원문 그대로 유지되어 시점 변형 위험 없음',
      },
      characterVoiceNotes: ['고유 문체 및 리듬 원형 보존'],
      candidateLoreProposals: [],
    },
  },
];

export function buildAnchorForBenchmark(
  fixture: LiteraryRewritingBenchmarkFixture,
  sourceRevisionId = 'rev_bench_01'
) {
  const startOffset = fixture.manuscript.indexOf(fixture.targetExcerpt);
  if (startOffset === -1) {
    throw new Error(
      `Benchmark ${fixture.id} excerpt not found in fixture manuscript.`
    );
  }
  return createRewriteSelectionAnchor({
    manuscript: fixture.manuscript,
    startOffset,
    endOffset: startOffset + fixture.targetExcerpt.length,
    sourceRevisionId,
  });
}
