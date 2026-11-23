import type { NarrativePerspective } from '../types/foundation';
import type { WritingContextBundle } from '../types/aiEngine';
import type { LiteraryQualityDimensionId } from '../types/literaryQuality';

export interface LiteraryQualityBenchmarkFixture {
  id: 'B1' | 'B2' | 'B3' | 'B4' | 'B5' | 'B6' | 'B7' | 'B8' | 'B9' | 'B10';
  titleKo: string;
  scenarioType: 'DEFECT_DETECTION' | 'FALSE_POSITIVE_GUARD';
  perspective: NarrativePerspective;
  manuscript: string;
  targetWeakDimensions: LiteraryQualityDimensionId[];
  mustNotPenalizeDimensions: LiteraryQualityDimensionId[];
  expectedMinimumOverallScore: number;
  expectedMaximumImportantFindings: number;
  contextOverrides?: Partial<WritingContextBundle>;
  mockReferenceAiOutput: {
    overallAssessment: string;
    dimensions: {
      category: LiteraryQualityDimensionId;
      score: number | null;
      confidence: 'HIGH' | 'MEDIUM' | 'LOW';
      explanation: string;
    }[];
    findings: {
      category: LiteraryQualityDimensionId;
      severity: 'INFO' | 'SUGGESTION' | 'IMPORTANT';
      originalExcerpt: string;
      startOffset: number | null;
      endOffset: number | null;
      problem: string;
      reason: string;
      suggestedRevision: string | null;
      expectedBenefit: string;
      canonRuleWarning: string | null;
    }[];
  };
}

const B1_MANUSCRIPT =
  '그녀는 그녀 자신의 검을 그녀의 손으로 들어 올렸다. 그것은 그녀에게 있어 피할 수 없는 선택이었던 것이다. 차가운 바람에 의해 흩날리는 붉은 망토는 마치 피와 같다고 그녀는 생각했다.';
const B2_MANUSCRIPT =
  '카엘은 심장이 뛰었다. 그는 두려움을 느꼈다. 공포가 그의 마음을 지배했다. 카엘은 다시 한번 심장이 두근거리는 것을 느꼈고, 주먹을 꽉 쥐며 불안감을 감추지 못했다.';
const B3_MANUSCRIPT =
  '“그렇군요, 기사님. 지금 당장 북쪽 성벽으로 이동하는 것이 합리적이라고 생각합니다.” 노병 가렌이 말했다.\n“네, 사령관님. 지금 당장 북쪽 성벽으로 이동하는 것이 합리적이라고 생각합니다.” 철부지 도적 리온이 말했다.';
const B4_MANUSCRIPT =
  '카엘은 검을 뽑았다. 참고로 이 검의 이름은 에테르 블레이드로, 300년 전 제1차 마도 전쟁 당시 엘프 대장장이가 미스릴과 별빛 광석을 합쳐 제작한 7대 신기 중 하나이며 총 3단계 해방 구조를 지니고 있다. 마력 순환율은 94%다.';
const B5_MANUSCRIPT =
  '문밖의 발소리가 멎었다. 세라피나는 검자루에 얹었던 손가락을 한 치도 떼지 않았다. 어제의 배신이 아직 손끝에 서늘하게 남아 있었기 때문이다. 카엘이 붕대를 감은 왼팔로 문고리를 밀었을 때, 그녀는 여전히 한 걸음 물러선 채 그의 눈이 아닌 검집의 봉인을 먼저 확인했다.';
const B6_MANUSCRIPT =
  '창끝이 스쳤다. 목덜미가 서늘했다. 한 발 물러선다. 호흡은 짧다. 바닥의 돌가루가 튀었다. 파고든다. 빈틈은 0.5초뿐이었다.';
const B7_MANUSCRIPT =
  '보리차가 식어 가며 잔 표면에 옅은 물방울이 맺혔다. 카엘은 찻잔을 두 손으로 감싼 채 창밖 처마를 타고 떨어지는 빗방울을 보았다.\n“비 오는데, 오늘 순찰은 좀 일찍 접을까?”\n“그럴까. 젖은 망토 말리려면 화롯가에 장작부터 더 얹어야겠어.”';
const B8_MANUSCRIPT =
  '아무것도 남지 않았다. 불탄 서고에도, 꺾인 깃발 아래에도, 그가 지키려던 약속의 자리에도 아무것도 남지 않았다. 재만 바람을 타고 흘렀다.';
const B9_MANUSCRIPT =
  '[시점: 카엘]\n성벽 위에서 내려다본 협곡은 짙은 안개로 잠겨 있었다. 나는 망원경을 접으며 다음 신호를 기다렸다.\n\n***\n\n[시점: 세라피나]\n성채 지하 회랑의 횃불이 하나둘 꺼져 갔다. 세라피나는 돌벽에 손을 짚고 위층에서 울리는 종소리를 헤아렸다.';
const B10_MANUSCRIPT =
  '잿빛 눈발이 성벽 틈새로 스며들었다. 카엘은 장갑을 낀 채 창틀에 얹힌 서리를 쓸어내렸다. 며칠째 멎지 않은 눈 탓에 전령마저 끊긴 성채 안에는 장작 타는 냄새와 눅눅한 철 내음만 짙었다.\n“북문 쪽 보초 교대는 마쳤습니다.”\n세라피나가 젖은 외투를 털며 들어왔다. 그녀의 어깨에 내려앉은 눈이 난롯불 앞에서 천천히 녹아내렸다.';

function sliceOffsets(
  manuscript: string,
  excerpt: string
): { startOffset: number; endOffset: number } {
  const start = manuscript.indexOf(excerpt);
  if (start === -1) {
    throw new Error(`Fixture excerpt missing: ${excerpt}`);
  }
  return { startOffset: start, endOffset: start + excerpt.length };
}

export const KOREAN_WEB_NOVEL_BENCHMARKS: LiteraryQualityBenchmarkFixture[] = [
  {
    id: 'B1',
    titleKo: '번역투·불필요한 대명사 남발 문장',
    scenarioType: 'DEFECT_DETECTION',
    perspective: 'THIRD_LIMITED',
    manuscript: B1_MANUSCRIPT,
    targetWeakDimensions: ['Q1'],
    mustNotPenalizeDimensions: [],
    expectedMinimumOverallScore: 40,
    expectedMaximumImportantFindings: 3,
    mockReferenceAiOutput: {
      overallAssessment:
        '지시대명사("그녀", "그것")와 번역투 피동 표현("~에 의해", "~였던 것이다")이 겹쳐 한국어 독서 호흡이 부자연스럽습니다.',
      dimensions: [
        { category: 'Q1', score: 42, confidence: 'HIGH', explanation: '불필요한 대명사 반복과 번역투 피동문이 문장 몰입을 떨어뜨립니다.' },
        { category: 'Q2', score: 65, confidence: 'MEDIUM', explanation: '문장 길이는 무난하나 어미 단조로움이 남습니다.' },
        { category: 'Q3', score: 75, confidence: 'LOW', explanation: '대사가 없는 지문 구간입니다.' },
        { category: 'Q4', score: 68, confidence: 'MEDIUM', explanation: '선택의 비장함은 드러나나 표현이 관념적입니다.' },
        { category: 'Q5', score: 70, confidence: 'MEDIUM', explanation: '검을 드는 동작의 연결은 자연스럽습니다.' },
        { category: 'Q6', score: 70, confidence: 'MEDIUM', explanation: '망토와 바람의 시각 이미지는 있으나 관습적 비유입니다.' },
        { category: 'Q7', score: 78, confidence: 'MEDIUM', explanation: '정보 과잉은 없습니다.' },
        { category: 'Q8', score: 58, confidence: 'HIGH', explanation: '동일 주어가 한 문장 안에서 세 번 겹칩니다.' },
      ],
      findings: [
        (() => {
          const excerpt = '그녀는 그녀 자신의 검을 그녀의 손으로 들어 올렸다.';
          const { startOffset, endOffset } = sliceOffsets(B1_MANUSCRIPT, excerpt);
          return {
            category: 'Q1',
            severity: 'IMPORTANT',
            originalExcerpt: excerpt,
            startOffset,
            endOffset,
            problem: '한 문장 안에 대명사 "그녀"가 3회 연속 중복되어 번역투 인상을 줍니다.',
            reason: '한국어에서는 주어가 명확한 경우 소유격 대명사("그녀의", "그녀 자신의")를 생략해야 시선이 자연스럽게 이어집니다.',
            suggestedRevision: '그녀는 묵직한 검을 두 손으로 들어 올렸다.',
            expectedBenefit: '불필요한 대명사 중복을 덜어내어 첫 문장의 긴장감과 가독성이 올라갑니다.',
            canonRuleWarning: null,
          };
        })(),
      ],
    },
  },
  {
    id: 'B2',
    titleKo: '감정 직접 설명 및 신체 반응 반복 장면',
    scenarioType: 'DEFECT_DETECTION',
    perspective: 'THIRD_LIMITED',
    manuscript: B2_MANUSCRIPT,
    targetWeakDimensions: ['Q4', 'Q8'],
    mustNotPenalizeDimensions: [],
    expectedMinimumOverallScore: 40,
    expectedMaximumImportantFindings: 3,
    mockReferenceAiOutput: {
      overallAssessment:
        '"심장이 뛰었다", "두려움", "공포", "불안감"처럼 감정을 추상 명사로 거듭 못박아 인물의 내면이 피상적으로 보입니다.',
      dimensions: [
        { category: 'Q1', score: 72, confidence: 'MEDIUM', explanation: '문법적 오류는 적으나 서술이 단조롭습니다.' },
        { category: 'Q2', score: 62, confidence: 'HIGH', explanation: '짧은 단문이 동일한 주어-서술어 구조로 연속됩니다.' },
        { category: 'Q3', score: 75, confidence: 'LOW', explanation: '대사가 포함되지 않은 장면입니다.' },
        { category: 'Q4', score: 45, confidence: 'HIGH', explanation: '공포의 이유와 감각 대신 추상 감정명만 겹쳐 설득력이 약합니다.' },
        { category: 'Q5', score: 66, confidence: 'MEDIUM', explanation: '위협의 원인이 장면에 드러나지 않습니다.' },
        { category: 'Q6', score: 54, confidence: 'HIGH', explanation: '신체 반응 클리셰("심장", "주먹")에 의존합니다.' },
        { category: 'Q7', score: 74, confidence: 'MEDIUM', explanation: '불필요한 설정 설명은 없습니다.' },
        { category: 'Q8', score: 40, confidence: 'HIGH', explanation: '심장 박동 묘사가 바로 두 문장 뒤에서 반복됩니다.' },
      ],
      findings: [
        (() => {
          const excerpt =
            '그는 두려움을 느꼈다. 공포가 그의 마음을 지배했다. 카엘은 다시 한번 심장이 두근거리는 것을 느꼈고, 주먹을 꽉 쥐며 불안감을 감추지 못했다.';
          const { startOffset, endOffset } = sliceOffsets(B2_MANUSCRIPT, excerpt);
          return {
            category: 'Q4',
            severity: 'IMPORTANT',
            originalExcerpt: excerpt,
            startOffset,
            endOffset,
            problem: '유사한 추상 감정어(두려움·공포·불안감)와 심장 반응이 연달아 중복 설명됩니다.',
            reason: '감정 명사를 반복하기보다 시선이 향하는 대상이나 숨결·손끝의 미묘한 행동으로 공포를 구체화하면 몰입도가 높아집니다.',
            suggestedRevision:
              '등줄기를 타고 서늘한 땀이 흘렀다. 카엘은 칼집을 쥔 손가락에 힘을 주었지만, 어둠 너머에서 시선을 거둘 수 없었다.',
            expectedBenefit: '반복적인 감정 설명을 걷어내고 장면 내 긴장감을 행동으로 전달합니다.',
            canonRuleWarning: null,
          };
        })(),
      ],
    },
  },
  {
    id: 'B3',
    titleKo: '인물마다 말투와 어미가 똑같은 장면',
    scenarioType: 'DEFECT_DETECTION',
    perspective: 'THIRD_LIMITED',
    manuscript: B3_MANUSCRIPT,
    targetWeakDimensions: ['Q3'],
    mustNotPenalizeDimensions: [],
    expectedMinimumOverallScore: 45,
    expectedMaximumImportantFindings: 3,
    mockReferenceAiOutput: {
      overallAssessment:
        '노병 가렌과 철부지 도적 리온이 단어 하나까지 똑같은 문어체 경어("~하는 것이 합리적이라고 생각합니다")를 써 인물 구분이 사라졌습니다.',
      dimensions: [
        { category: 'Q1', score: 76, confidence: 'MEDIUM', explanation: '문법은 매끄럽습니다.' },
        { category: 'Q2', score: 72, confidence: 'MEDIUM', explanation: '대사 배치 길이가 동일합니다.' },
        { category: 'Q3', score: 35, confidence: 'HIGH', explanation: '연령·직업·성격이 다른 두 인물이 기계적으로 같은 문장을 말합니다.' },
        { category: 'Q4', score: 65, confidence: 'MEDIUM', explanation: '대사에서 인물의 개성이나 심리가 읽히지 않습니다.' },
        { category: 'Q5', score: 74, confidence: 'MEDIUM', explanation: '이동 방향 결정이라는 기능은 수행합니다.' },
        { category: 'Q6', score: 70, confidence: 'LOW', explanation: '지문 분량이 적습니다.' },
        { category: 'Q7', score: 75, confidence: 'MEDIUM', explanation: '상황 전달은 명확합니다.' },
        { category: 'Q8', score: 48, confidence: 'HIGH', explanation: '두 대사가 동일한 구문을 복제한 듯 반복됩니다.' },
      ],
      findings: [
        (() => {
          const excerpt =
            '“네, 사령관님. 지금 당장 북쪽 성벽으로 이동하는 것이 합리적이라고 생각합니다.” 철부지 도적 리온이 말했다.';
          const { startOffset, endOffset } = sliceOffsets(B3_MANUSCRIPT, excerpt);
          return {
            category: 'Q3',
            severity: 'IMPORTANT',
            originalExcerpt: excerpt,
            startOffset,
            endOffset,
            problem: '도적 리온의 대사가 앞선 노병 가렌의 딱딱한 보고 문장을 그대로 반복하고 있습니다.',
            reason: '인물의 출신과 성격(철부지 도적)에 맞춰 짧은 구어체와 현장감 있는 어휘로 화법을 차별화해야 대사가 살아납니다.',
            suggestedRevision:
              '“알았어요, 아저씨. 북쪽 담벼락으로 빠지면 되는 거죠? 늦기 전에 튀자고요.” 리온이 허리춤을 추스르며 투덜거렸다.',
            expectedBenefit: '인물 간 말투 대비가 선명해져 이름표 없이도 화자가 구분됩니다.',
            canonRuleWarning: 'CANON 인물의 존비칭/성격 설정이 따로 있다면 해당 말투 우선 적용 권장',
          };
        })(),
      ],
    },
  },
  {
    id: 'B4',
    titleKo: '장면 흐름을 끊는 과도한 설정 설명(인포덤프)',
    scenarioType: 'DEFECT_DETECTION',
    perspective: 'THIRD_LIMITED',
    manuscript: B4_MANUSCRIPT,
    targetWeakDimensions: ['Q7'],
    mustNotPenalizeDimensions: [],
    expectedMinimumOverallScore: 45,
    expectedMaximumImportantFindings: 3,
    mockReferenceAiOutput: {
      overallAssessment:
        '검을 뽑는 행동 직후에 백과사전식 제작 연대·소재·효율 수치 설명("참고로 이 검의 이름은...")이 삽입되어 장면의 몰입이 급격히 식습니다.',
      dimensions: [
        { category: 'Q1', score: 66, confidence: 'HIGH', explanation: '"참고로" 같은 해설자 어조가 소설 문체를 깹니다.' },
        { category: 'Q2', score: 58, confidence: 'HIGH', explanation: '한 문장에 수식절이 과도하게 길게 매달렸습니다.' },
        { category: 'Q3', score: 75, confidence: 'LOW', explanation: '대사가 없는 구간입니다.' },
        { category: 'Q4', score: 68, confidence: 'MEDIUM', explanation: '긴장감이 설명문으로 끊어집니다.' },
        { category: 'Q5', score: 64, confidence: 'HIGH', explanation: '검을 뽑는 물리적 행동과 배경 설정 설명이 인과적으로 연결되지 않습니다.' },
        { category: 'Q6', score: 60, confidence: 'MEDIUM', explanation: '감각적 질감 대신 스펙 나열이 앞섭니다.' },
        { category: 'Q7', score: 34, confidence: 'HIGH', explanation: '현장 장면에 불필요한 설정 설명(인포덤프)이 집중되었습니다.' },
        { category: 'Q8', score: 70, confidence: 'MEDIUM', explanation: '기계적 반복은 적습니다.' },
      ],
      findings: [
        (() => {
          const excerpt =
            '참고로 이 검의 이름은 에테르 블레이드로, 300년 전 제1차 마도 전쟁 당시 엘프 대장장이가 미스릴과 별빛 광석을 합쳐 제작한 7대 신기 중 하나이며 총 3단계 해방 구조를 지니고 있다. 마력 순환율은 94%다.';
          const { startOffset, endOffset } = sliceOffsets(B4_MANUSCRIPT, excerpt);
          return {
            category: 'Q7',
            severity: 'IMPORTANT',
            originalExcerpt: excerpt,
            startOffset,
            endOffset,
            problem: '"참고로"로 시작하는 해설조 인포덤프가 행동 장면의 리듬을 끊습니다.',
            reason: '장면 속에서 지금 당장 필요한 감각(검날의 반응·빛·무게감)만 남기고 나머지 연대기 정보는 뒤로 미루는 편이 독자 몰입에 유리합니다.',
            suggestedRevision:
              '검날 위로 푸른 마력 결이 천천히 깨어났다. 첫 번째 봉인이 풀리자 공기마저 팽팽하게 당겨졌다.',
            expectedBenefit: '설명문을 감각 서술로 바꿔 장면 긴장감을 유지합니다.',
            canonRuleWarning: '세계관 기존 설정(에테르 블레이드 3단계 구조)을 유지한 채 표현만 장면화함',
          };
        })(),
      ],
    },
  },
  {
    id: 'B5',
    titleKo: '트라우마를 즉시 지우지 않은 자연스러운 심리 변화',
    scenarioType: 'FALSE_POSITIVE_GUARD',
    perspective: 'THIRD_LIMITED',
    manuscript: B5_MANUSCRIPT,
    targetWeakDimensions: [],
    mustNotPenalizeDimensions: ['Q4', 'Q5'],
    expectedMinimumOverallScore: 80,
    expectedMaximumImportantFindings: 0,
    mockReferenceAiOutput: {
      overallAssessment:
        '어제의 배신이라는 기억과 신체 경계 행동(검자루의 손, 한 걸음 물러섬, 시선 순서)이 설득력 있게 맞물려 인물의 심리가 자연스럽게 축적됩니다.',
      dimensions: [
        { category: 'Q1', score: 88, confidence: 'HIGH', explanation: '한국어 문장 연결이 깔끔하고 어색한 피동이 없습니다.' },
        { category: 'Q2', score: 86, confidence: 'HIGH', explanation: '짧은 정지와 긴 호흡의 대비가 장면 긴장에 맞습니다.' },
        { category: 'Q3', score: 82, confidence: 'LOW', explanation: '침묵과 관찰 중심 장면입니다.' },
        { category: 'Q4', score: 92, confidence: 'HIGH', explanation: '불신과 경계가 즉각 해소되지 않고 행동으로 설득력 있게 유지됩니다.' },
        { category: 'Q5', score: 90, confidence: 'HIGH', explanation: '과거 사건 → 경계 동작 → 시선 확인의 인과가 치밀합니다.' },
        { category: 'Q6', score: 88, confidence: 'HIGH', explanation: '필요한 감각과 신체 위치만 절제해 포착했습니다.' },
        { category: 'Q7', score: 86, confidence: 'HIGH', explanation: '설명 과잉 없이 배경 맥락이 전달됩니다.' },
        { category: 'Q8', score: 87, confidence: 'HIGH', explanation: '진부한 표현이나 불필요한 반복이 없습니다.' },
      ],
      findings: [],
    },
  },
  {
    id: 'B6',
    titleKo: '긴박한 전투 장면 (짧은 문장 리듬 보호 검증)',
    scenarioType: 'FALSE_POSITIVE_GUARD',
    perspective: 'THIRD_LIMITED',
    manuscript: B6_MANUSCRIPT,
    targetWeakDimensions: [],
    mustNotPenalizeDimensions: ['Q2', 'Q6'],
    expectedMinimumOverallScore: 80,
    expectedMaximumImportantFindings: 0,
    mockReferenceAiOutput: {
      overallAssessment:
        '급박한 공방 리듬에 맞춰 문장 길이를 짧게 끊어 속도감을 살렸으며, 불필요한 수식 없이 전투의 순간을 정확히 포착했습니다.',
      dimensions: [
        { category: 'Q1', score: 86, confidence: 'HIGH', explanation: '간결하고 힘 있는 한국어 어조입니다.' },
        { category: 'Q2', score: 91, confidence: 'HIGH', explanation: '전투 템포에 최적화된 단문 리듬과 호흡을 구현했습니다.' },
        { category: 'Q3', score: 80, confidence: 'LOW', explanation: '전투 행동 중심 무대사 구간입니다.' },
        { category: 'Q4', score: 83, confidence: 'MEDIUM', explanation: '생존 본능과 순간 판단이 호흡에 배어 있습니다.' },
        { category: 'Q5', score: 89, confidence: 'HIGH', explanation: '회피-반격 진입의 물리적 인과가 분명합니다.' },
        { category: 'Q6', score: 88, confidence: 'HIGH', explanation: '필요한 감각(서늘함, 돌가루)만 절제해 속도감을 해치지 않습니다.' },
        { category: 'Q7', score: 85, confidence: 'HIGH', explanation: '군더더기 설명이 없습니다.' },
        { category: 'Q8', score: 85, confidence: 'HIGH', explanation: '의도적 짧은 스타카토 리듬이 효과적입니다.' },
      ],
      findings: [],
    },
  },
  {
    id: 'B7',
    titleKo: '차분한 일상 대화 장면 (억지 위기 강요 금지 검증)',
    scenarioType: 'FALSE_POSITIVE_GUARD',
    perspective: 'THIRD_LIMITED',
    manuscript: B7_MANUSCRIPT,
    targetWeakDimensions: [],
    mustNotPenalizeDimensions: ['Q2', 'Q5'],
    expectedMinimumOverallScore: 80,
    expectedMaximumImportantFindings: 0,
    mockReferenceAiOutput: {
      overallAssessment:
        '비 오는 날의 차분한 휴식 분위기와 두 인물의 자연스러운 대화 호흡이 조화를 이루며, 억지 사건이나 과도한 분할 없이 편안하게 읽힙니다.',
      dimensions: [
        { category: 'Q1', score: 90, confidence: 'HIGH', explanation: '매우 자연스러운 구어와 서술입니다.' },
        { category: 'Q2', score: 88, confidence: 'HIGH', explanation: '일상 장면의 차분한 템포에 어울리는 문장 길이입니다.' },
        { category: 'Q3', score: 90, confidence: 'HIGH', explanation: '편안한 동료 관계가 대사에 자연스럽게 묻어납니다.' },
        { category: 'Q4', score: 84, confidence: 'HIGH', explanation: '잔잔한 피로와 안도가 적절합니다.' },
        { category: 'Q5', score: 87, confidence: 'HIGH', explanation: '비 오는 상황과 순찰·화롯가 대화가 자연스럽게 이어집니다.' },
        { category: 'Q6', score: 88, confidence: 'HIGH', explanation: '물방울과 보리차 감각이 과장 없이 따뜻합니다.' },
        { category: 'Q7', score: 88, confidence: 'HIGH', explanation: '불필요한 설명 없이 일상 정경이 잡힙니다.' },
        { category: 'Q8', score: 89, confidence: 'HIGH', explanation: '클리셰가 없습니다.' },
      ],
      findings: [],
    },
  },
  {
    id: 'B8',
    titleKo: '의도적인 문학적 반복·수미상관 강조 장면',
    scenarioType: 'FALSE_POSITIVE_GUARD',
    perspective: 'THIRD_LIMITED',
    manuscript: B8_MANUSCRIPT,
    targetWeakDimensions: [],
    mustNotPenalizeDimensions: ['Q1', 'Q8'],
    expectedMinimumOverallScore: 82,
    expectedMaximumImportantFindings: 0,
    mockReferenceAiOutput: {
      overallAssessment:
        '"아무것도 남지 않았다"를 첫 문장과 두 번째 문장 끝에 수미상관으로 배치해 상실감의 여운을 의도적으로 증폭한 문학적 표현입니다.',
      dimensions: [
        { category: 'Q1', score: 90, confidence: 'HIGH', explanation: '의도적 대구와 반복이 한국어 리듬감을 높입니다.' },
        { category: 'Q2', score: 89, confidence: 'HIGH', explanation: '짧은 선언과 열거 뒤의 재확인이 울림을 만듭니다.' },
        { category: 'Q3', score: 80, confidence: 'LOW', explanation: '서술 중심 독백/풍경 구간입니다.' },
        { category: 'Q4', score: 88, confidence: 'HIGH', explanation: '직접 감정어 없이 상실의 공허가 전달됩니다.' },
        { category: 'Q5', score: 85, confidence: 'MEDIUM', explanation: '전쟁 이후의 현장을 효과적으로 정리합니다.' },
        { category: 'Q6', score: 87, confidence: 'HIGH', explanation: '서고·깃발·재의 구체적 사물이 감정을 지탱합니다.' },
        { category: 'Q7', score: 86, confidence: 'HIGH', explanation: '과잉 설명 없이 여운을 남깁니다.' },
        { category: 'Q8', score: 91, confidence: 'HIGH', explanation: '기계적 반복이 아니라 의도된 수미상관 모티프입니다.' },
      ],
      findings: [],
    },
  },
  {
    id: 'B9',
    titleKo: '작가가 지정한 장면별 다중 시점(MIXED) 전환',
    scenarioType: 'FALSE_POSITIVE_GUARD',
    perspective: 'MIXED',
    manuscript: B9_MANUSCRIPT,
    targetWeakDimensions: [],
    mustNotPenalizeDimensions: ['Q5'],
    expectedMinimumOverallScore: 80,
    expectedMaximumImportantFindings: 0,
    contextOverrides: {
      narrativePerspective: 'MIXED',
      scenePerspective: 'MIXED',
      episodePerspective: 'MIXED',
      projectDefaultPerspective: 'THIRD_LIMITED',
    },
    mockReferenceAiOutput: {
      overallAssessment:
        '장면 구분선(***)과 명시적 시점 표기를 통해 카엘(1인칭 관찰)에서 세라피나(3인칭 제한)로의 다중 시점 전환이 혼란 없이 처리되었습니다.',
      dimensions: [
        { category: 'Q1', score: 87, confidence: 'HIGH', explanation: '각 시점 문체가 깔끔합니다.' },
        { category: 'Q2', score: 85, confidence: 'HIGH', explanation: '장면 전환 호흡이 정돈되어 있습니다.' },
        { category: 'Q3', score: 82, confidence: 'LOW', explanation: '지문 중심의 시점 교차 장면입니다.' },
        { category: 'Q4', score: 85, confidence: 'HIGH', explanation: '두 인물의 관찰 초점이 시점 경계를 넘지 않습니다.' },
        { category: 'Q5', score: 88, confidence: 'HIGH', explanation: '신호 대기와 위층 종소리 등 동시간대 연결이 명확합니다.' },
        { category: 'Q6', score: 86, confidence: 'HIGH', explanation: '안개와 횃불의 대비가 시각적입니다.' },
        { category: 'Q7', score: 87, confidence: 'HIGH', explanation: '시점 구분 표식이 독자 혼란을 차단합니다.' },
        { category: 'Q8', score: 86, confidence: 'HIGH', explanation: '표현의 중복이 없습니다.' },
      ],
      findings: [],
    },
  },
  {
    id: 'B10',
    titleKo: '높은 완성도의 자연스러운 한국어 웹소설 원고',
    scenarioType: 'FALSE_POSITIVE_GUARD',
    perspective: 'THIRD_LIMITED',
    manuscript: B10_MANUSCRIPT,
    targetWeakDimensions: [],
    mustNotPenalizeDimensions: ['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7', 'Q8'],
    expectedMinimumOverallScore: 85,
    expectedMaximumImportantFindings: 0,
    mockReferenceAiOutput: {
      overallAssessment:
        '감각 묘사(서리, 장작·철 내음, 녹아내리는 눈)와 인물 대사가 자연스럽게 맞물리며 번역투나 과잉 수식 없이 높은 몰입도를 유지하는 원고입니다.',
      dimensions: [
        { category: 'Q1', score: 93, confidence: 'HIGH', explanation: '한국어 어순과 조사가 매끄럽습니다.' },
        { category: 'Q2', score: 91, confidence: 'HIGH', explanation: '문단 전환과 대사 연결 리듬이 탁월합니다.' },
        { category: 'Q3', score: 89, confidence: 'HIGH', explanation: '간결한 보고 대사가 상황과 어우러집니다.' },
        { category: 'Q4', score: 88, confidence: 'HIGH', explanation: '서리를 쓸어내리는 동작에서 고립감이 자연스럽게 배어납니다.' },
        { category: 'Q5', score: 90, confidence: 'HIGH', explanation: '눈보라→전령 두절→교대 보고의 흐름이 매끄럽습니다.' },
        { category: 'Q6', score: 92, confidence: 'HIGH', explanation: '시각·후각 묘사가 절제되면서도 선명합니다.' },
        { category: 'Q7', score: 90, confidence: 'HIGH', explanation: '상황 정보가 서술 속에 자연스럽게 녹아 있습니다.' },
        { category: 'Q8', score: 91, confidence: 'HIGH', explanation: '독창적이고 균형 잡힌 문체입니다.' },
      ],
      findings: [],
    },
  },
];
