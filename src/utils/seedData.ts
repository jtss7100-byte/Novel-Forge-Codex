import type { ProjectBundle } from '../types/novel';
import { calculateCharCounts } from './novelLogic';
import { createInitialPromptProfiles } from './aiEngineLogic';
import { computeManuscriptContentHash } from './manuscriptIntegrity';

export function createInitialSeedBundle(ownerId: string): ProjectBundle {
  const projectId = 'proj_abyss_chronicle';
  const ep1Id = 'ep_abyss_001';
  const ep2Id = 'ep_abyss_002';
  const ep3Id = 'ep_abyss_003';
  const char1Id = 'char_kael_vance';
  const char2Id = 'char_seraphina_lux';
  const char3Id = 'char_malakor_ash';
  const wb1Id = 'wb_ether_resonance';
  const wb2Id = 'wb_citadel_nocturne';
  const wb3Id = 'wb_ash_crown_oath';

  const ep1Content = `검은 눈보라가 몰아치는 북부 끝자락, '침묵의 성채' 녹턴의 철문이 칠십 년 만에 처음으로 열렸다.

카엘 반스는 얼어붙은 강철 장갑 너머로 검자루의 맥동을 느꼈다. 부러진 성검 '에테르나'의 파편이 그의 흉골 아래에 심어진 지 벌써 오 년째였다. 숨을 들이마실 때마다 폐부 깊숙이 서늘한 마력 결정이 긁히는 듯한 통증이 일었지만, 그는 표정을 바꾸지 않았다.

"제7봉인 구역의 공명 수치가 한계를 넘었습니다, 단장님."

부관 세라피나가 은빛 성서에서 눈을 떼지 않은 채 낮게 보고했다. 그녀의 손끝에서 피어오른 정화의 문장이 어두운 회랑을 창백하게 비추었다.

"심연의 잔불이 다시 깨어나고 있다는 뜻이군."

카엘은 성벽 아래로 펼쳐진 잿빛 평원을 내려다보았다. 한때 일곱 왕국의 수도였던 왕도 발할라는 대균열 이후 거대한 검은 분화구로 변해 있었다. 그 중심에서 붉은 번개가 하늘을 향해 역류하듯 솟구쳤다.

"명령을 내리십시오. 성좌의 감시자들에게 알릴까요, 아니면 저희 감시단이 단독으로 봉인핵을 회수할까요?"

"성좌의 귀족들은 심연이 코앞까지 차올라도 자신들의 의석 수를 먼저 계산할 자들이다."

카엘이 검집에서 반쯤 부러진 흑강 검신을 뽑아 들었다. 절단면 위로 푸른 에테르 불꽃이 길게 이어지며 완전한 검의 형상을 빚어냈다.

"녹턴 제1감시단은 지금 즉시 대균열 심층부로 강하한다. 오늘 밤이 지나기 전에 잿빛 왕관의 첫 번째 쐐기를 회수한다."`;

  const ep2Content = `대균열의 제1층 '망각의 회랑'은 중력조차 뒤틀린 기이한 유적지였다. 무너진 고대 신전의 기둥들이 허공에 부유한 채 천천히 자전하고 있었고, 발밑으로는 끝을 알 수 없는 심연의 안개가 소용돌이쳤다.

"모두 에테르 호흡기를 고정해라. 안개 속의 마력 농도가 지상의 열두 배다."

카엘의 목소리가 통신 마도구를 타고 대원들의 귓가에 울렸다. 세라피나는 선두에 서서 '성광의 나침반'을 전개했다. 나침반의 바늘이 격렬하게 떨리더니 동남쪽의 거대한 흑요석 제단을 가리켰다.

"전방 삼백 미터 지점에 고밀도 마력 반응이 감지됩니다. 그런데... 파형이 이상합니다."

"몬스터 무리인가?"

"아닙니다. 이건 고대 서약의 문장입니다. 누군가 의도적으로 봉인핵 주변에 역장 결계를 재구축하고 있어요."

그 순간, 안개 너머에서 검은 갑주를 두른 기사의 실루엣이 걸어 나왔다. 3년 전 대균열 토벌전에서 전사한 것으로 기록되었던 구 왕국의 수호기사단장, 말라코르였다.`;

  const ep3Content = `말라코르의 대검이 허공을 가르자 검은 마력 파동이 신전 기둥 세 개를 동시에 두 동강 냈다.

"물러서라, 카엘 반스. 네 심장에 박힌 에테르나의 파편은 원래 네 것이 아니다."

말라코르의 투구 틈새로 일렁이는 잿빛 안광이 카엘을 꿰뚫듯 노려보았다. 카엘은 역류하는 마력 회로를 강제로 개방하며 제3위계 공명식을 발동했다.

[작성 중 메모: 3화 후반부에서 카엘이 에테르 역류 부작용을 겪으며도 말라코르의 첫 번째 갑주 봉인을 깨뜨리는 장면 추가 예정]`;

  const c1 = calculateCharCounts(ep1Content);
  const c2 = calculateCharCounts(ep2Content);
  const c3 = calculateCharCounts(ep3Content);

  return {
    formatVersion: '1.0',
    exportedAt: '2026-11-09T12:00:00.000Z',
    project: {
      id: projectId,
      ownerId,
      title: '심연의 연대기: 잿빛 왕관의 계승자',
      genre: '다크 판타지 / 전기 판타지',
      synopsis:
        '대균열로 멸망한 발할라 제국의 마지막 감시단장 카엘 반스가 심장에 이식된 성검의 파편으로 심연의 군주들과 맞서며 일곱 개의 잿빛 왕관 쐐기를 회수하는 장편 다크 판타지 연대기.',
      status: 'confirmed',
      createdAt: '2026-11-01T09:00:00.000Z',
      updatedAt: '2026-11-09T12:00:00.000Z',
    },
    characters: [
      {
        id: char1Id,
        ownerId,
        projectId,
        name: '카엘 반스 (Kael Vance)',
        role: '주인공 / 제1감시단장',
        affiliation: '침묵의 성채 녹턴 제1감시단',
        appearance: '칠흑 같은 짧은 머리카락과 잿빛 눈동자. 왼쪽 쇄골부터 흉골까지 푸른 에테르 문신 같은 흉터가 새겨져 있다.',
        personality: '냉철하고 과묵한 현실주의자. 부하들의 목숨을 최우선으로 여기며 귀족 원로원의 부패를 경멸한다.',
        background: '5년 전 발할라 대균열 사태 당시 부러진 성검 에테르나의 코어를 심장에 이식받고 유일하게 생환한 기사.',
        abilities: '에테르 공명 검술(제1~4위계), 파편 해방을 통한 허공 검신 구현, 심연 마력 감지.',
        status: 'confirmed',
        linkedEpisodeIds: [ep1Id, ep2Id, ep3Id],
        linkedWorldbuildingIds: [wb1Id, wb2Id],
        createdAt: '2026-11-01T09:10:00.000Z',
        updatedAt: '2026-11-08T15:00:00.000Z',
      },
      {
        id: char2Id,
        ownerId,
        projectId,
        name: '세라피나 룩스 (Seraphina Lux)',
        role: '주연 / 수석 성서 해독관',
        affiliation: '녹턴 감시단 전술참모부',
        appearance: '은백색 긴 머리를 단정하게 묶고 다니며, 고대 룬 문자가 각인된 백금 테 안경과 은빛 성서를 휴대한다.',
        personality: '치밀하고 분석적인 완벽주의자. 전투 중에도 침착하게 마력 파형을 계산하지만 고대 유물 앞에서는 호기심이 앞선다.',
        background: '황실 마탑의 최연소 수석 연구원이었으나 금서 열람 사건으로 파문당한 뒤 카엘에게 거두어졌다.',
        abilities: '성광의 나침반 전개, 고대 봉인식 해독 및 정화 결계 구축.',
        status: 'confirmed',
        linkedEpisodeIds: [ep1Id, ep2Id],
        linkedWorldbuildingIds: [wb1Id, wb2Id],
        createdAt: '2026-11-01T09:20:00.000Z',
        updatedAt: '2026-11-08T15:10:00.000Z',
      },
      {
        id: char3Id,
        ownerId,
        projectId,
        name: '말라코르 (Malakor the Ash Knight)',
        role: '적대자 / 심연의 수호기사',
        affiliation: '구 발할라 왕실 수호기사단 (현재 심연 귀속)',
        appearance: '검게 그을린 중갑주와 얼굴 전체를 가리는 투구, 투구 틈에서 새어 나오는 잿빛 안광.',
        personality: '과거의 맹세에 묶인 비극적 무인. 감정을 거의 드러내지 않으며 오직 왕관의 봉인을 지키는 데 집착한다.',
        background: '카엘의 옛 스승이자 왕국의 최강 방패였으나 대균열 당시 왕도를 구하기 위해 스스로 심연의 서약을 받아들였다.',
        abilities: '심연 중력 제어, 흑요석 대검술, 고대 서약 결계.',
        status: 'draft',
        linkedEpisodeIds: [ep2Id, ep3Id],
        linkedWorldbuildingIds: [wb3Id],
        createdAt: '2026-11-03T11:00:00.000Z',
        updatedAt: '2026-11-09T10:00:00.000Z',
      },
    ],
    worldbuilding: [
      {
        id: wb1Id,
        ownerId,
        projectId,
        title: '에테르 공명 체계 (Ether Resonance)',
        category: '마법/이능 체계',
        summary: '심장 주변의 마력 회로와 고대 성유물 파편을 공명시켜 초자연적 무력을 발현하는 전투 체계.',
        content:
          '에테르 공명은 제1위계(점화)부터 제7위계(성좌 강림)까지 구분된다. 일반적인 감시단 기사는 제2위계까지 안전하게 사용할 수 있으며, 제3위계 이상부터는 혈관과 신경계에 에테르 결정화 현상이 누적된다.',
        rules:
          '1. 제3위계 이상 공명 시 하루 최대 지속 시간은 15분을 넘길 수 없다.\n2. 심연 오염 구역에서는 정화 성서나 중화제 없이 공명식을 개방하면 마력 역류가 발생한다.',
        status: 'confirmed',
        linkedCharacterIds: [char1Id, char2Id],
        linkedEpisodeIds: [ep1Id, ep3Id],
        createdAt: '2026-11-01T10:00:00.000Z',
        updatedAt: '2026-11-07T18:00:00.000Z',
      },
      {
        id: wb2Id,
        ownerId,
        projectId,
        title: '침묵의 성채 녹턴 (Citadel Nocturne)',
        category: '대륙/지리',
        summary: '대균열 최북단 절벽 위에 세워진 인류 최후의 방어 요새이자 감시단 본거지.',
        content:
          '고대 거인들이 깎아 만든 흑철 절벽 위에 세워진 삼중 성곽 요새. 성채 지하에는 대균열의 확장을 억제하는 제7봉인 구역이 자리 잡고 있다.',
        rules:
          '외부인의 출입은 엄격히 금지되며, 성채 내부에서는 공간 이동 마법이 원천 차단된다.',
        status: 'confirmed',
        linkedCharacterIds: [char1Id, char2Id],
        linkedEpisodeIds: [ep1Id],
        createdAt: '2026-11-02T14:00:00.000Z',
        updatedAt: '2026-11-07T18:30:00.000Z',
      },
      {
        id: wb3Id,
        ownerId,
        projectId,
        title: '잿빛 왕관과 일곱 쐐기',
        category: '아티팩트/무구',
        summary: '대균열 심층부를 영구 봉인하거나 반대로 심연의 문을 완전히 열 수 있는 태고의 유물.',
        content:
          '왕관 본체는 구 왕도 발할라의 최심층에 잠들어 있으며, 왕관을 제어하는 일곱 개의 쐐기가 대균열 각 계층의 수호자들에게 흩어져 있다.',
        rules:
          '쐐기 소유자를 쓰러뜨리거나 서약자의 자발적 양도가 있어야만 쐐기의 소유권이 이전된다.',
        status: 'draft',
        linkedCharacterIds: [char1Id, char3Id],
        linkedEpisodeIds: [ep1Id, ep2Id],
        createdAt: '2026-11-04T16:00:00.000Z',
        updatedAt: '2026-11-09T11:00:00.000Z',
      },
    ],
    episodes: [
      {
        id: ep1Id,
        ownerId,
        projectId,
        episodeNumber: 1,
        title: '제1화. 칠십 년 만에 열린 철문',
        content: ep1Content,
        synopsis: '북부 침묵의 성채 녹턴에서 제7봉인 구역의 이상 공명이 감지되고, 카엘 반스 단장이 대균열 강하를 결단한다.',
        authorNote: '도입부 분위기 잡기 완료. 성검 에테르나 파편 복선 1차 제시.',
        charCountWithSpaces: c1.withSpaces,
        charCountWithoutSpaces: c1.withoutSpaces,
        status: 'confirmed',
        latestRevisionId: 'rev_abyss_001_v2',
        contentHash: computeManuscriptContentHash(ep1Content),
        linkedCharacterIds: [char1Id, char2Id],
        linkedWorldbuildingIds: [wb1Id, wb2Id],
        createdAt: '2026-11-02T09:00:00.000Z',
        updatedAt: '2026-11-06T20:00:00.000Z',
      },
      {
        id: ep2Id,
        ownerId,
        projectId,
        episodeNumber: 2,
        title: '제2화. 망각의 회랑과 옛 스승',
        content: ep2Content,
        synopsis: '대균열 제1층으로 진입한 감시단이 역장 결계를 발견하고, 전사한 줄 알았던 수호기사단장 말라코르와 조우한다.',
        authorNote: '말라코르 등장 씬 호흡 점검 중. 세라피나의 나침반 연출 보강 검토.',
        charCountWithSpaces: c2.withSpaces,
        charCountWithoutSpaces: c2.withoutSpaces,
        status: 'review',
        contentHash: computeManuscriptContentHash(ep2Content),
        linkedCharacterIds: [char1Id, char2Id, char3Id],
        linkedWorldbuildingIds: [wb3Id],
        createdAt: '2026-11-05T11:00:00.000Z',
        updatedAt: '2026-11-08T21:00:00.000Z',
      },
      {
        id: ep3Id,
        ownerId,
        projectId,
        episodeNumber: 3,
        title: '제3화. 부러진 성검의 공명',
        content: ep3Content,
        synopsis: '말라코르와의 첫 격돌. 카엘이 에테르 제3위계 공명식을 개방하여 정면 승부에 나선다.',
        authorNote: '초안 작성 중. 제3위계 패널티 묘사를 세계관 제약 법칙(15분 제한)과 일치시킬 것.',
        charCountWithSpaces: c3.withSpaces,
        charCountWithoutSpaces: c3.withoutSpaces,
        status: 'draft',
        contentHash: computeManuscriptContentHash(ep3Content),
        linkedCharacterIds: [char1Id, char3Id],
        linkedWorldbuildingIds: [wb1Id, wb3Id],
        createdAt: '2026-11-08T14:00:00.000Z',
        updatedAt: '2026-11-09T11:30:00.000Z',
      },
    ],
    revisions: [
      {
        id: 'rev_abyss_001_v1',
        ownerId,
        projectId,
        episodeId: ep1Id,
        episodeTitle: '제1화. 칠십 년 만에 열린 철문',
        content: `검은 눈보라가 몰아치는 북부 끝자락, '침묵의 성채' 녹턴의 철문이 열렸다.\n\n카엘 반스는 얼어붙은 강철 장갑 너머로 검자루의 맥동을 느꼈다. (초기 초안 버전 스냅샷)`,
        charCountWithSpaces: 96,
        label: '1차 초안 백업',
        createdAt: '2026-11-03T18:00:00.000Z',
      },
      {
        id: 'rev_abyss_001_v2',
        ownerId,
        projectId,
        episodeId: ep1Id,
        episodeTitle: '제1화. 칠십 년 만에 열린 철문',
        content: ep1Content,
        charCountWithSpaces: c1.withSpaces,
        label: '확정 원고 스냅샷',
        createdAt: '2026-11-06T20:00:00.000Z',
      },
    ],
    writingPromptProfiles: createInitialPromptProfiles(ownerId, projectId),
    writingPlans: [],
    changeProposals: (() => {
      const q1 =
        '"제7봉인 구역의 공명 수치가 한계를 넘었습니다, 단장님."';
      const q1Start = Math.max(0, ep1Content.indexOf(q1));
      const q1End = q1Start + q1.length;

      const q2 =
        '"녹턴 제1감시단은 지금 즉시 대균열 심층부로 강하한다. 오늘 밤이 지나기 전에 잿빛 왕관의 첫 번째 쐐기를 회수한다."';
      const q2Start = Math.max(0, ep1Content.indexOf(q2));
      const q2End = q2Start + q2.length;

      return [
        {
          id: 'prop_abyss_rel_update_001',
          ownerId,
          projectId,
          targetEntityType: 'RELATIONSHIP' as const,
          targetEntityId: 'rel_kael_seraphina',
          proposedAction: 'UPDATE' as const,
          title:
            '[인물 관계 갱신] 카엘 반스 ↔ 세라피나 룩스: 단독 강하 작전 결행으로 신뢰도 상승',
          rationale:
            '1화에서 성좌 원로원의 지시를 기다리지 않고 제7봉인 단독 강하를 결행하며 두 사람의 전술적 신뢰가 한층 강화되었습니다.',
          beforeSummary:
            '생사를 맡긴 상관과 전술 부관 (신뢰도 +82)',
          afterSummary:
            '성좌의 명령을 넘어선 운명 공동체 상관과 수석 부관 (신뢰도 +90)',
          proposedPayloadJson: JSON.stringify({
            schemaVersion: 'PHASE_4_2_1_V1',
            proposalId: 'prop_abyss_rel_update_001',
            fingerprint: 'fp_seed_abyss_rel_update_001',
            extractionRunId: 'extrun_seed_abyss_001',
            targetEntityType: 'RELATIONSHIP',
            targetEntityId: 'rel_kael_seraphina',
            proposedAction: 'UPDATE',
            sourceRevisionId: 'rev_abyss_001_v2',
            sourceEpisodeId: ep1Id,
            sourceSceneId: 'scene_abyss_ep1_s1',
            confidenceScore: 0.94,
            temporalContext: 'PRESENT_EVENT',
            uncertaintyFlags: [],
            canonConflicts: [],
            verifiedExcerpt: {
              excerpt: q1,
              matchedText: q1,
              startOffset: q1Start,
              endOffset: q1End,
              matchMethod: 'EXACT',
              matchCount: 1,
            },
            provenance: {
              sourceType: 'MANUSCRIPT',
              createdBy: 'AI_ENGINE',
              ownerId,
              projectId,
              episodeId: ep1Id,
              sceneId: 'scene_abyss_ep1_s1',
              revisionId: 'rev_abyss_001_v2',
              excerpt: q1,
              startOffset: q1Start,
              endOffset: q1End,
            },
            relationshipDraft: {
              id: 'rel_kael_seraphina',
              ownerId,
              projectId,
              sourceCharacterId: char1Id,
              sourceCharacterName: '카엘 반스',
              targetCharacterId: char2Id,
              targetCharacterName: '세라피나 룩스',
              relationType: '운명 공동체 상관과 수석 전술 부관',
              affinityScore: 90,
              isDirectional: false,
              description:
                '성좌 원로원의 승인을 기다리지 않고 대균열 심층부 단독 강하를 함께 결행하며 생사와 기밀을 공유하는 절대적 신뢰 관계.',
              lastChangedEpisodeId: ep1Id,
              canonStatus: 'PROPOSED',
              sourceRevisionId: 'rev_abyss_001_v2',
              createdBy: 'AI_ENGINE',
              provenance: {
                sourceType: 'MANUSCRIPT',
                createdBy: 'AI_ENGINE',
                ownerId,
                projectId,
                episodeId: ep1Id,
                sceneId: 'scene_abyss_ep1_s1',
                revisionId: 'rev_abyss_001_v2',
                excerpt: q1,
                startOffset: q1Start,
                endOffset: q1End,
              },
            },
            existingEntitySnapshot: {
              id: 'rel_kael_seraphina',
              ownerId,
              projectId,
              sourceCharacterId: char1Id,
              targetCharacterId: char2Id,
              relationType: '생사를 맡긴 상관과 전술 부관',
              affinityScore: 82,
              isDirectional: false,
              description:
                '황실 마탑에서 파문당한 세라피나를 카엘이 제1감시단으로 거두어들인 이래, 성검 파편의 부작용 비밀을 공유하는 유일한 신뢰 관계.',
              canonStatus: 'CANON',
              effectiveEpisodeId: ep1Id,
              effectiveEventId: 'evt_abyss_002',
              sourceRevisionId: 'rev_abyss_001_v2',
              createdBy: 'AUTHOR',
              createdAt: '2026-11-02T10:00:00.000Z',
              updatedAt: '2026-11-06T20:00:00.000Z',
            },
          }),
          canonStatus: 'PROPOSED' as const,
          triggerEpisodeId: ep1Id,
          triggerSceneId: 'scene_abyss_ep1_s1',
          sourceRevisionId: 'rev_abyss_001_v2',
          createdBy: 'AI_ENGINE' as const,
          reviewedAt: '',
          createdAt: '2026-11-09T12:10:00.000Z',
          updatedAt: '2026-11-09T12:10:00.000Z',
        },
        {
          id: 'prop_abyss_fsh_create_001',
          ownerId,
          projectId,
          targetEntityType: 'FORESHADOWING' as const,
          targetEntityId: 'fsh_abyss_004_seed',
          proposedAction: 'CREATE' as const,
          title:
            '[신규 복선 후보] 오늘 밤 회수해야 할 잿빛 왕관의 첫 번째 쐐기',
          rationale:
            '1화 마지막 대사에서 카엘이 오늘 밤이 지나기 전에 회수하겠다고 선언한 핵심 유물 단서입니다.',
          beforeSummary: '',
          afterSummary:
            '대균열 심층부에 봉인된 일곱 개의 잿빛 왕관 쐐기 중 첫 번째 유물의 정체와 봉인핵 회수 작전 (PLANTED)',
          proposedPayloadJson: JSON.stringify({
            schemaVersion: 'PHASE_4_2_1_V1',
            proposalId: 'prop_abyss_fsh_create_001',
            fingerprint: 'fp_seed_abyss_fsh_create_001',
            extractionRunId: 'extrun_seed_abyss_001',
            targetEntityType: 'FORESHADOWING',
            targetEntityId: 'fsh_abyss_004_seed',
            proposedAction: 'CREATE',
            sourceRevisionId: 'rev_abyss_001_v2',
            sourceEpisodeId: ep1Id,
            sourceSceneId: 'scene_abyss_ep1_s1',
            confidenceScore: 0.96,
            temporalContext: 'PRESENT_EVENT',
            uncertaintyFlags: [],
            canonConflicts: [],
            verifiedExcerpt: {
              excerpt: q2,
              matchedText: q2,
              startOffset: q2Start,
              endOffset: q2End,
              matchMethod: 'EXACT',
              matchCount: 1,
            },
            provenance: {
              sourceType: 'MANUSCRIPT',
              createdBy: 'AI_ENGINE',
              ownerId,
              projectId,
              episodeId: ep1Id,
              sceneId: 'scene_abyss_ep1_s1',
              revisionId: 'rev_abyss_001_v2',
              excerpt: q2,
              startOffset: q2Start,
              endOffset: q2End,
            },
            foreshadowingDraft: {
              id: 'fsh_abyss_004_seed',
              ownerId,
              projectId,
              title: '잿빛 왕관의 첫 번째 쐐기 회수 작전',
              description:
                '카엘 반스가 제1감시단을 이끌고 대균열 심층부로 강하하여 오늘 밤 안에 회수하려 하는 고대 봉인 유물.',
              cluePhase: 'PLANTED',
              plantedEpisodeId: ep1Id,
              plantedSceneId: 'scene_abyss_ep1_s1',
              resolvedEpisodeId: '',
              resolvedSceneId: '',
              relatedCharacterIds: [char1Id, char2Id],
              relatedCharacterNames: ['카엘 반스', '세라피나 룩스'],
              relatedEventIds: ['evt_abyss_002'],
              payoffNote: '제1층 강하 작전 중 흑요석 제단 봉인핵에서 1차 회수 예정.',
              canonStatus: 'PROPOSED',
              sourceRevisionId: 'rev_abyss_001_v2',
              createdBy: 'AI_ENGINE',
              provenance: {
                sourceType: 'MANUSCRIPT',
                createdBy: 'AI_ENGINE',
                ownerId,
                projectId,
                episodeId: ep1Id,
                sceneId: 'scene_abyss_ep1_s1',
                revisionId: 'rev_abyss_001_v2',
                excerpt: q2,
                startOffset: q2Start,
                endOffset: q2End,
              },
            },
            existingEntitySnapshot: null,
          }),
          canonStatus: 'PROPOSED' as const,
          triggerEpisodeId: ep1Id,
          triggerSceneId: 'scene_abyss_ep1_s1',
          sourceRevisionId: 'rev_abyss_001_v2',
          createdBy: 'AI_ENGINE' as const,
          reviewedAt: '',
          createdAt: '2026-11-09T12:12:00.000Z',
          updatedAt: '2026-11-09T12:12:00.000Z',
        },
      ];
    })(),
    scenes: [
      {
        id: 'scene_abyss_ep1_s1',
        ownerId,
        projectId,
        episodeId: ep1Id,
        sceneNumber: 1,
        title: '침묵의 성채 철문 개방과 제7봉인 경보',
        summary: '카엘 반스와 세라피나 룩스가 제7봉인 구역의 임계 돌파를 확인하고 대균열 심층 강하를 결정한다.',
        location: '침묵의 성채 녹턴 북측 성벽 회랑',
        pointOfViewCharacterId: char1Id,
        eventIds: ['evt_abyss_002'],
        characterIds: [char1Id, char2Id],
        foreshadowingIds: ['fsh_abyss_001', 'fsh_abyss_002'],
        canonStatus: 'CANON',
        sourceRevisionId: 'rev_abyss_001_v2',
        createdAt: '2026-11-02T09:30:00.000Z',
        updatedAt: '2026-11-06T20:00:00.000Z',
      },
      {
        id: 'scene_abyss_ep2_s1',
        ownerId,
        projectId,
        episodeId: ep2Id,
        sceneNumber: 1,
        title: '망각의 회랑 진입과 흑요석 제단 조우',
        summary: '중력이 뒤틀린 제1층 유적지에서 고대 서약 결계와 옛 스승 말라코르가 모습을 드러낸다.',
        location: '대균열 제1층 망각의 회랑 흑요석 제단',
        pointOfViewCharacterId: char1Id,
        eventIds: ['evt_abyss_003'],
        characterIds: [char1Id, char2Id, char3Id],
        foreshadowingIds: ['fsh_abyss_001', 'fsh_abyss_003'],
        canonStatus: 'CANON',
        sourceRevisionId: '',
        createdAt: '2026-11-05T11:30:00.000Z',
        updatedAt: '2026-11-08T21:00:00.000Z',
      },
    ],
    relationships: [
      {
        id: 'rel_kael_seraphina',
        ownerId,
        projectId,
        sourceCharacterId: char1Id,
        targetCharacterId: char2Id,
        relationType: '생사를 맡긴 상관과 전술 부관',
        affinityScore: 82,
        isDirectional: false,
        description:
          '황실 마탑에서 파문당한 세라피나를 카엘이 제1감시단으로 거두어들인 이래, 성검 파편의 부작용 비밀을 공유하는 유일한 신뢰 관계.',
        canonStatus: 'CANON',
        effectiveEpisodeId: ep1Id,
        effectiveEventId: 'evt_abyss_002',
        sourceRevisionId: 'rev_abyss_001_v2',
        createdBy: 'AUTHOR',
        createdAt: '2026-11-02T10:00:00.000Z',
        updatedAt: '2026-11-06T20:00:00.000Z',
      },
      {
        id: 'rel_kael_malakor',
        ownerId,
        projectId,
        sourceCharacterId: char1Id,
        targetCharacterId: char3Id,
        relationType: '옛 사제 관계에서 심연의 적대자로 대립',
        affinityScore: -65,
        isDirectional: false,
        description:
          '검술과 기사도의 스승이었으나 대균열 토벌전 이후 심연에 귀속된 말라코르와 잿빛 왕관의 첫 번째 쐐기를 두고 숙명적으로 격돌한다.',
        canonStatus: 'CANON',
        effectiveEpisodeId: ep2Id,
        effectiveEventId: 'evt_abyss_003',
        sourceRevisionId: '',
        createdBy: 'AUTHOR',
        createdAt: '2026-11-05T12:00:00.000Z',
        updatedAt: '2026-11-08T21:00:00.000Z',
      },
      {
        id: 'rel_malakor_kael_secret',
        ownerId,
        projectId,
        sourceCharacterId: char3Id,
        targetCharacterId: char1Id,
        relationType: '성검 파편의 각성을 시험하는 감시자',
        affinityScore: -15,
        isDirectional: true,
        description:
          '말라코르가 카엘을 적대하면서도 죽이지 않고 제3위계 공명 개방을 유도하는 숨겨진 의도가 있다는 기획 초안.',
        canonStatus: 'DRAFT',
        effectiveEpisodeId: ep3Id,
        effectiveEventId: 'evt_abyss_004',
        sourceRevisionId: '',
        createdBy: 'AUTHOR',
        createdAt: '2026-11-08T16:00:00.000Z',
        updatedAt: '2026-11-09T11:30:00.000Z',
      },
    ],
    timelineEvents: [
      {
        id: 'evt_abyss_001',
        ownerId,
        projectId,
        title: '발할라 대균열 발발 및 성검 에테르나 파열',
        summary:
          '일곱 왕국의 수도 발할라가 대균열로 붕괴하고, 말라코르가 실종된 날 카엘 반스의 심장에 부러진 성검 에테르나 코어가 이식되다.',
        inUniverseDate: '제국력 407년 검은 동지 (작중 5년 전)',
        chronologicalOrder: -50,
        episodeId: ep1Id,
        sceneId: 'scene_abyss_ep1_s1',
        participantCharacterIds: [char1Id, char3Id],
        linkedForeshadowingIds: ['fsh_abyss_001'],
        linkedWorldbuildingIds: [wb1Id, wb3Id],
        canonStatus: 'CANON',
        sourceRevisionId: 'rev_abyss_001_v2',
        createdBy: 'AUTHOR',
        createdAt: '2026-11-02T09:40:00.000Z',
        updatedAt: '2026-11-06T20:00:00.000Z',
      },
      {
        id: 'evt_abyss_002',
        ownerId,
        projectId,
        title: '침묵의 성채 녹턴 제7봉인 임계 돌파 및 강하 출격',
        summary:
          '칠십 년 만에 녹턴의 철문이 열리고, 제1감시단이 성좌 원로원의 승인 없이 대균열 심층부 강하 작전을 개시하다.',
        inUniverseDate: '제국력 412년 겨울 첫째 밤',
        chronologicalOrder: 10,
        episodeId: ep1Id,
        sceneId: 'scene_abyss_ep1_s1',
        participantCharacterIds: [char1Id, char2Id],
        linkedForeshadowingIds: ['fsh_abyss_002'],
        linkedWorldbuildingIds: [wb1Id, wb2Id],
        canonStatus: 'CANON',
        sourceRevisionId: 'rev_abyss_001_v2',
        createdBy: 'AUTHOR',
        createdAt: '2026-11-02T10:10:00.000Z',
        updatedAt: '2026-11-06T20:00:00.000Z',
      },
      {
        id: 'evt_abyss_003',
        ownerId,
        projectId,
        title: '망각의 회랑 고대 서약 결계 발견 및 말라코르 조우',
        summary:
          '대균열 제1층 흑요석 제단에서 역장 결계가 작동 중임을 확인하고, 심연의 수호기사가 된 옛 스승 말라코르와 대면하다.',
        inUniverseDate: '제국력 412년 겨울 둘째 날 새벽',
        chronologicalOrder: 20,
        episodeId: ep2Id,
        sceneId: 'scene_abyss_ep2_s1',
        participantCharacterIds: [char1Id, char2Id, char3Id],
        linkedForeshadowingIds: ['fsh_abyss_001', 'fsh_abyss_003'],
        linkedWorldbuildingIds: [wb3Id],
        canonStatus: 'CANON',
        sourceRevisionId: '',
        createdBy: 'AUTHOR',
        createdAt: '2026-11-05T12:15:00.000Z',
        updatedAt: '2026-11-08T21:00:00.000Z',
      },
      {
        id: 'evt_abyss_004',
        ownerId,
        projectId,
        title: '제3위계 에테르 공명 개방과 갑주 제1봉인 파쇄',
        summary:
          '카엘이 15분 제한 패널티를 감수하며 제3위계 공명식을 발동해 말라코르의 흑요석 갑주 첫 번째 봉인을 타격하는 사건 초안.',
        inUniverseDate: '제국력 412년 겨울 둘째 날 새벽 (직후)',
        chronologicalOrder: 30,
        episodeId: ep3Id,
        sceneId: '',
        participantCharacterIds: [char1Id, char3Id],
        linkedForeshadowingIds: ['fsh_abyss_001'],
        linkedWorldbuildingIds: [wb1Id, wb3Id],
        canonStatus: 'DRAFT',
        sourceRevisionId: '',
        createdBy: 'AUTHOR',
        createdAt: '2026-11-08T16:10:00.000Z',
        updatedAt: '2026-11-09T11:30:00.000Z',
      },
    ],
    foreshadowings: [
      {
        id: 'fsh_abyss_001',
        ownerId,
        projectId,
        title: '카엘의 심장에 이식된 에테르나 파편의 진짜 주인',
        description:
          '1화에서 흉골 아래 서늘한 통증으로 제시되고, 3화에서 말라코르가 "네 심장에 박힌 파편은 원래 네 것이 아니다"라고 언급하며 강화된 핵심 복선.',
        cluePhase: 'REINFORCED',
        canonStatus: 'CANON',
        plantedEpisodeId: ep1Id,
        plantedSceneId: 'scene_abyss_ep1_s1',
        resolvedEpisodeId: '',
        resolvedSceneId: '',
        relatedEventIds: ['evt_abyss_001', 'evt_abyss_003', 'evt_abyss_004'],
        relatedCharacterIds: [char1Id, char3Id],
        sourceRevisionId: 'rev_abyss_001_v2',
        createdBy: 'AUTHOR',
        createdAt: '2026-11-02T10:30:00.000Z',
        updatedAt: '2026-11-08T21:00:00.000Z',
      },
      {
        id: 'fsh_abyss_002',
        ownerId,
        projectId,
        title: '성좌 원로원이 제7봉인 경보를 묵살한 정치적 내막',
        description:
          '성좌의 귀족들이 대균열의 재활성화를 알고도 의석 수 계산에만 몰두하며 감시단의 지원을 차단한 배경.',
        cluePhase: 'PLANTED',
        canonStatus: 'CANON',
        plantedEpisodeId: ep1Id,
        plantedSceneId: 'scene_abyss_ep1_s1',
        resolvedEpisodeId: '',
        resolvedSceneId: '',
        relatedEventIds: ['evt_abyss_002'],
        relatedCharacterIds: [char1Id, char2Id],
        sourceRevisionId: 'rev_abyss_001_v2',
        createdBy: 'AUTHOR',
        createdAt: '2026-11-02T10:45:00.000Z',
        updatedAt: '2026-11-06T20:00:00.000Z',
      },
      {
        id: 'fsh_abyss_003',
        ownerId,
        projectId,
        title: '봉인핵 주변에 재구축된 고대 서약 역장 결계의 목적',
        description:
          '말라코르가 심연의 괴물들을 깨우는 것이 아니라 오히려 봉인핵 주변에 역장 결계를 유지하고 있었다는 정황 단서.',
        cluePhase: 'PLANTED',
        canonStatus: 'DRAFT',
        plantedEpisodeId: ep2Id,
        plantedSceneId: 'scene_abyss_ep2_s1',
        resolvedEpisodeId: '',
        resolvedSceneId: '',
        relatedEventIds: ['evt_abyss_003'],
        relatedCharacterIds: [char2Id, char3Id],
        sourceRevisionId: '',
        createdBy: 'AUTHOR',
        createdAt: '2026-11-05T12:30:00.000Z',
        updatedAt: '2026-11-09T11:00:00.000Z',
      },
    ],
  };
}
