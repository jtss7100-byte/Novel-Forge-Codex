# 저장소 모듈 경계

## 분리 전 계약과 작업 순서

기준 커밋은 `9b36d0a4d5f43c624394155096a667ea4a46a037`이다. 작업 전 `src/services/novelRepository.ts`는 181,821바이트였으며, 프로젝트 조회부터 로컬 캐시, 회차·Revision 트랜잭션, 정사 변경 제안, 프로필 CAS까지 같은 파일에서 관리했다. 아래 인벤토리는 기준 파일의 export, 내부 참조와 외부 소비자를 기준으로 작성했다.

1. 기준 테스트와 저장 벤치마크를 재실행하고 공개 export 및 호출자를 기록한다.
2. 좁은 범위의 공통 코드인 Firestore Timestamp 정규화, 저장 필드, 로컬 저장소 타입, 기존 입력 검증을 분리한다.
3. 회차·Revision CAS 코어와 Firestore·LocalStorage 어댑터를 분리한다. 읽기·검증·쓰기 순서, 명시적 Revision과 자동 저장의 차이, 문서 크기 검사를 각각 현재 트랜잭션 안에 둔다.
4. 프로젝트 쓰기와 조회, UID별 로컬 캐시를 분리한다. 기존 전체 상세 조회는 동일한 네 컬렉션을 같은 순서로 읽는다.
5. 인물·세계관·장면·연표·인물 관계·복선, 집필 계획, Prompt·Style Profile, MemoryDocument·MemoryChunk와 변경 제안을 책임별로 나눈다. 관련 트랜잭션 전체는 같은 도메인 모듈에 둔다.
6. 백업 JSON 코덱과 Firestore ProjectBundle 업로드를 분리한다. 기존 `novelLogic.ts`와 `novelRepository.ts` 공개 경로를 유지한다.
7. 공개 API, 저장 크기, 로컬 보관, 합성 벤치마크, Emulator 및 기존 저장·집필 회귀를 검증한다.

## 저장 계약

- **Firestore**는 `users/{uid}/projects/{projectId}` 하위에 엔티티별 문서를 사용한다. 회차와 Revision의 실제 저장 필드, 누락된 Revision 처리, 쓰기 순서 및 Firebase 오류 경계는 기존과 같다. 회차 쓰기는 저장 전 700 KiB 경고와 900 KiB 차단을 사용한다. 직접 생성·수정, Revision, 회차 CAS, 가져오기의 회차·Revision 검사에 적용된다. 프로젝트, 장면, 인물, 세계관, 복선, 연표, 관계, 집필 계획, Prompt·Style Profile, 제안, 기억과 서버 전용 저장 경로는 이 회차 크기 검사의 대상 밖이다.
- **LocalStorage**는 UID별 키와 이전 캐시의 소유권 필터를 사용한다. 회차 CAS는 지원 환경에서 Web Locks를 사용한다. 이전 EmergencyDraftBackup의 저장 형식과 키는 그대로 유지한다. UID를 확인할 수 없는 레거시 사본의 자동 이관은 후속 범위다.
- **IndexedDB와 자동 저장**은 기존 모듈과 ManuscriptView 진입점을 사용한다. 복구본 트랜잭션 완료, 1,750ms debounce, 20초 최대 대기, 네트워크 최대 3회 시도, 동일 저장 범위 직렬화와 응답 순서 검사를 유지한다. 로그인 및 회차 전환 가드는 App과 ManuscriptView에 남는다.
- **색인**은 동일 자동 저장의 결과에서 생략되며, 검증된 원본 Revision과 CANON 상태를 만족한 호출만 App의 기존 색인 경로에 도달한다. 저장 모듈은 RAG 엔진이나 Gemini를 import하지 않는다.
- **백업**은 기존 v1.0 JSON에서 프로젝트, 인물, 세계관, 회차와 Revision을 왕복한다. 다운로드 코덱과 업로드 파이프라인은 원래 계약을 유지한다. 장면·집필 계획·프로필 등 추가 도메인의 모든 정보를 v1.0 다운로드가 담는 상태는 아니다. 내부 ProjectBundle이 전달하는 선택 필드와 실제 백업 파일의 범위는 다르다. 서버 전용 기억·승인 자료, 전체 확장 백업, 대량 가져오기의 중단 지점 재개는 별도 설계가 필요하다. 여러 Firestore 문서에 순차 저장하는 업로드는 중간까지 성공할 수 있다.

## 조회 경계

`fetchFirestoreProjects`는 프로젝트 목록을 제공한다. App의 로그인 시 초기 로드와 기존 프로젝트에 대한 ProjectBundle 업로드는 `fetchFirestoreProjectDetails`의 전체 결과를 소비한다. 상세 조회는 인물, 세계관, 회차, Revision을 각각 읽는다. App은 완성된 ProjectBundle을 Writer 문맥, 원고 검색, 복원, 내보내기에 사용한다. 100·300·500화 Emulator 검증은 네 SDK 요청과 각 100·300·500개의 반환 문서를 기준으로 삼는다. 실제 청구·인덱스 읽기는 별도의 측정 대상이다.

회차 목록·본문과 Revision 이력의 조회 코드를 분리하되 호출자가 받는 전체 자료 범위, 오류 처리, 읽기 순서를 유지한다. 향후 초기 메타데이터 조회 또는 페이지네이션을 추가할 때 전체 백업 및 Writer 문맥용 조회는 별도 경로로 유지해야 한다.

## 공개 API와 기준 소비자

다음 표에서 줄 번호는 기준 커밋의 선언 위치다. 내부 사용란은 같은 원본 파일의 참조이며, 외부 사용란은 실제 저장소 import 경로를 확인한 결과다. 외부 사용처가 없는 export도 공개 계약에 포함된다.

- A1 · [App.tsx](../src/App.tsx)
- A2 · [AiWritingPanel.tsx](../src/components/AiWritingPanel.tsx)
- A3 · [ManuscriptView.tsx](../src/components/ManuscriptView.tsx)
- E4 · [firestoreRulesEmulator.test.ts](../src/emulator/firestoreRulesEmulator.test.ts)
- T5 · [authorStyleStage1_1.test.ts](../src/utils/authorStyleStage1_1.test.ts)
- T6 · [characterVoice.test.ts](../src/utils/characterVoice.test.ts)
- T7 · [literaryRewritingLogic.test.ts](../src/utils/literaryRewritingLogic.test.ts)
- T8 · [literaryRewritingStage2.test.ts](../src/utils/literaryRewritingStage2.test.ts)
- T9 · [schemaSources.test.ts](../src/utils/schemaSources.test.ts)
- T10 · [storageHardening.test.ts](../src/utils/storageHardening.test.ts)

| 공개 이름 | 기준 줄 | 분리 대상 | 외부 | 내부 참조 |
| --- | ---: | --- | --- | --- |
| `LOCAL_BUNDLES_KEY` | 82 | `local/localProjectStore` | T7, T9 | `localBundleKey`, `readOwnedLocalBundles`, `commitLocalEpisode` |
| `saveEmergencyDraft` | 102 | `local/localProjectStore` | — | — |
| `getEmergencyDraft` | 111 | `local/localProjectStore` | — | — |
| `clearEmergencyDraft` | 125 | `local/localProjectStore` | — | — |
| `listAllEmergencyDrafts` | 134 | `local/localProjectStore` | — | — |
| `loadLocalBundles` | 166 | `local/localProjectStore` | A1, T9 | — |
| `saveLocalBundles` | 227 | `local/localProjectStore` | A1 | — |
| `fetchFirestoreProjects` | 238 | `project/projectQueries` | A1 | `uploadProjectBundleToFirestore` |
| `fetchFirestoreProjectDetails` | 262 | `project/projectQueries` | A1, E4 | `uploadProjectBundleToFirestore` |
| `createFirestoreProject` | 407 | `project/projectMutations` | A1 | `uploadProjectBundleToFirestore` |
| `updateFirestoreProject` | 425 | `project/projectMutations` | A1 | `uploadProjectBundleToFirestore` |
| `deleteFirestoreProjectCascade` | 444 | `project/projectMutations` | A1 | — |
| `createFirestoreCharacter` | 490 | `lore/loreRepository` | A1 | `uploadProjectBundleToFirestore` |
| `updateFirestoreCharacter` | 519 | `lore/loreRepository` | A1 | `uploadProjectBundleToFirestore` |
| `deleteFirestoreCharacter` | 544 | `lore/loreRepository` | A1 | — |
| `createFirestoreWorldbuilding` | 557 | `lore/loreRepository` | A1 | `uploadProjectBundleToFirestore` |
| `updateFirestoreWorldbuilding` | 584 | `lore/loreRepository` | A1 | `uploadProjectBundleToFirestore` |
| `deleteFirestoreWorldbuilding` | 607 | `lore/loreRepository` | A1 | — |
| `createFirestoreEpisode` | 663 | `episode/episodeRepository` | A1, T10 | `uploadProjectBundleToFirestore` |
| `updateFirestoreEpisode` | 678 | `episode/episodeRepository` | — | `uploadProjectBundleToFirestore` |
| `EpisodeRevisionCasConflictCode` (타입) | 702 | `episode/episodeCas` | — | `EpisodeRevisionCasConflictError` |
| `EpisodeRevisionCasConflictError` | 708 | `episode/episodeCas` | E4, T7 | `executeAtomicEpisodeCasCommitCore`, `commitLocalEpisode` |
| `EpisodeRevisionCommitInput` (타입) | 735 | `episode/episodeCas` | — | `executeAtomicEpisodeCasCommitCore`, `commitEpisodeRevisionSafelyFirestore`, `LocalEpisodeCommitInput` |
| `EpisodeRevisionCommitResult` (타입) | 750 | `episode/episodeCas` | A1, A2, A3 | `executeAtomicEpisodeCasCommitCore`, `commitEpisodeRevisionSafelyFirestore`, `commitEpisodeRevisionSafelyLocal`, `commitLocalEpisode` |
| `AtomicEpisodeCasTxAdapter` (타입) | 757 | `episode/episodeCas` | — | `executeAtomicEpisodeCasCommitCore` |
| `executeAtomicEpisodeCasCommitCore` | 776 | `episode/episodeCas` | E4, T7, T8, T10 | `commitEpisodeRevisionSafelyFirestore`, `commitLocalEpisode` |
| `commitEpisodeRevisionSafelyFirestore` | 936 | `episode/episodeRepository` | A1, E4 | — |
| `LocalStorageLike` (타입) | 975 | `local/localProjectStore` | T7 | `readOwnedLocalBundles`, `LocalEpisodeCommitInput` |
| `commitEpisodeRevisionSafelyLocal` | 991 | `episode/localEpisodeRepository` | A1, T7 | — |
| `deleteFirestoreEpisode` | 1091 | `episode/episodeRepository` | A1 | — |
| `createFirestoreRevision` | 1104 | `episode/episodeRepository` | T10 | `uploadProjectBundleToFirestore` |
| `deleteFirestoreRevision` | 1119 | `episode/episodeRepository` | A1 | — |
| `uploadProjectBundleToFirestore` | 1132 | `backup/projectBundleImport` | A1, T10 | — |
| `createFirestoreScene` | 1389 | `lore/loreRepository` | — | `uploadProjectBundleToFirestore` |
| `updateFirestoreScene` | 1419 | `lore/loreRepository` | — | `uploadProjectBundleToFirestore` |
| `deleteFirestoreScene` | 1452 | `lore/loreRepository` | — | — |
| `createFirestoreForeshadowing` | 1472 | `lore/loreRepository` | A1 | `uploadProjectBundleToFirestore` |
| `updateFirestoreForeshadowing` | 1503 | `lore/loreRepository` | A1 | `uploadProjectBundleToFirestore` |
| `deleteFirestoreForeshadowing` | 1537 | `lore/loreRepository` | A1 | — |
| `createFirestoreRelationship` | 1557 | `lore/loreRepository` | A1 | `uploadProjectBundleToFirestore` |
| `updateFirestoreRelationship` | 1587 | `lore/loreRepository` | A1 | `uploadProjectBundleToFirestore` |
| `deleteFirestoreRelationship` | 1620 | `lore/loreRepository` | A1 | — |
| `createFirestoreTimelineEvent` | 1640 | `lore/loreRepository` | A1 | `uploadProjectBundleToFirestore` |
| `updateFirestoreTimelineEvent` | 1671 | `lore/loreRepository` | A1 | `uploadProjectBundleToFirestore` |
| `deleteFirestoreTimelineEvent` | 1705 | `lore/loreRepository` | A1 | — |
| `createFirestoreMemoryDocument` | 1725 | `memory/memoryRepository` | — | — |
| `createFirestoreMemoryChunk` | 1751 | `memory/memoryRepository` | — | — |
| `createFirestoreStyleProfile` | 1782 | `writing/styleProfileRepository` | A1 | — |
| `updateFirestoreStyleProfile` | 1811 | `writing/styleProfileRepository` | — | — |
| `classifyFirestorePersistenceError` | 1869 | `proposals/proposalValidation` | T8 | `persistChangeProposalsIdempotentlyCore` |
| `canonicalizeProposedPayloadJson` | 1995 | `proposals/proposalValidation` | T8 | `normalizeAndValidateChangeProposalPayload`, `normalizeComparableImmutableFields` |
| `NormalizedProposalValidationResult` (타입) | 2044 | `proposals/proposalValidation` | — | `normalizeAndValidateChangeProposalPayload` |
| `normalizeAndValidateChangeProposalPayload` | 2055 | `proposals/proposalValidation` | A1, T8 | `validateProposalBeforeFirestoreWrite`, `buildCanonicalChangeProposalWriteData`, `createFirestoreChangeProposal`, `persistSingleFirestoreProposalAtomically` |
| `validateProposalBeforeFirestoreWrite` | 2254 | `proposals/proposalValidation` | — | — |
| `areProposalsSemanticallyEquivalent` | 2296 | `proposals/proposalValidation` | T8 | `createFirestoreChangeProposal`, `persistChangeProposalsIdempotentlyCore`, `persistSingleFirestoreProposalAtomically` |
| `buildCanonicalChangeProposalWriteDataFromNormalized` | 2387 | `proposals/proposalValidation` | — | `buildCanonicalChangeProposalWriteData`, `createFirestoreChangeProposal`, `persistSingleFirestoreProposalAtomically` |
| `createFirestoreChangeProposal` | 2425 | `proposals/changeProposalRepository` | — | `uploadProjectBundleToFirestore` |
| `AtomicProposalPersistenceOutcome` (타입) | 2472 | `proposals/proposalPersistenceCore` | T8 | `IdempotentProposalPersistenceAdapter`, `persistSingleFirestoreProposalAtomically` |
| `SourceRevisionVerificationOutcome` (타입) | 2485 | `proposals/proposalPersistenceCore` | — | `IdempotentProposalPersistenceAdapter`, `verifyPersistedRevisionSnapshot` |
| `IdempotentProposalPersistenceAdapter` (타입) | 2493 | `proposals/proposalPersistenceCore` | — | `persistChangeProposalsIdempotentlyCore` |
| `verifyPersistedRevisionSnapshot` | 2516 | `proposals/proposalPersistenceCore` | A1, T8 | `persistSingleFirestoreProposalAtomically` |
| `persistChangeProposalsIdempotentlyCore` | 2610 | `proposals/proposalPersistenceCore` | A1, E4, T8 | `persistFirestoreChangeProposalsIdempotently` |
| `persistSingleFirestoreProposalAtomically` | 2864 | `proposals/changeProposalRepository` | E4 | `persistFirestoreChangeProposalsIdempotently` |
| `persistFirestoreChangeProposalsIdempotently` | 3085 | `proposals/changeProposalRepository` | A1, E4 | — |
| `formatProposalPersistenceErrorSummaryKo` | 3108 | `proposals/proposalPersistenceCore` | A1, A2, T8 | — |
| `updateFirestoreChangeProposal` | 3146 | `proposals/changeProposalRepository` | A1 | — |
| `fetchFirestoreFoundationCollections` | 3168 | `lore/foundationQueries` | A1 | `uploadProjectBundleToFirestore` |
| `createFirestorePromptProfile` | 3411 | `writing/promptProfileRepository` | A1 | — |
| `updateFirestorePromptProfile` | 3439 | `writing/promptProfileRepository` | — | — |
| `deleteFirestorePromptProfile` | 3463 | `writing/promptProfileRepository` | A1 | — |
| `parsePromptProfileFromFirestoreData` | 3495 | `writing/profileValidation` | — | `fetchFirestorePromptProfileById`, `updateFirestorePromptProfileWithCas`, `saveFirestoreCharacterVoicePrompt`, `persistApprovedStyleDnaAtomicallyFirestore` |
| `parseStyleProfileFromFirestoreData` | 3527 | `writing/profileValidation` | T5 | `persistApprovedStyleDnaAtomicallyFirestore` |
| `fetchFirestorePromptProfileById` | 3570 | `writing/promptProfileRepository` | A1, E4 | — |
| `validatePromptProfileForFirestoreSchema` | 3591 | `writing/profileValidation` | — | `updatePromptProfileWithCasCore`, `saveCharacterVoicePromptCore`, `persistApprovedStyleDnaAtomicallyCore` |
| `validateStyleProfileForFirestoreSchema` | 3643 | `writing/profileValidation` | — | `persistApprovedStyleDnaAtomicallyCore` |
| `classifyStylePersistenceError` | 3713 | `writing/profileValidation` | — | `updateFirestorePromptProfileWithCas`, `updateLocalPromptProfileWithCas`, `persistApprovedStyleDnaAtomicallyCore`, `persistApprovedStyleDnaAtomicallyFirestore` |
| `updatePromptProfileWithCasCore` | 3847 | `writing/promptProfileRepository` | T5 | `updateFirestorePromptProfileWithCas`, `saveCharacterVoicePromptCore`, `updateLocalPromptProfileWithCas` |
| `updateFirestorePromptProfileWithCas` | 3966 | `writing/promptProfileRepository` | A1, E4 | — |
| `saveCharacterVoicePromptCore` | 4031 | `writing/promptProfileRepository` | A1, T6 | `saveFirestoreCharacterVoicePrompt` |
| `saveFirestoreCharacterVoicePrompt` | 4068 | `writing/promptProfileRepository` | A1, E4 | — |
| `updateLocalPromptProfileWithCas` | 4122 | `writing/promptProfileRepository` | A1 | — |
| `AtomicStylePersistenceOptions` (타입) | 4164 | `writing/styleProfileRepository` | — | `resolveStyleApprovalTargets`, `persistApprovedStyleDnaAtomicallyCore`, `persistApprovedStyleDnaAtomicallyFirestore`, `persistApprovedStyleDnaAtomicallyLocal` |
| `persistApprovedStyleDnaAtomicallyCore` | 4205 | `writing/styleProfileRepository` | T5 | `persistApprovedStyleDnaAtomicallyFirestore`, `persistApprovedStyleDnaAtomicallyLocal` |
| `persistApprovedStyleDnaAtomicallyFirestore` | 4549 | `writing/styleProfileRepository` | A1, E4 | — |
| `persistApprovedStyleDnaAtomicallyLocal` | 4770 | `writing/styleProfileRepository` | A1 | — |
| `createFirestoreWritingPlan` | 4805 | `writing/writingPlanRepository` | A1 | — |
| `updateFirestoreWritingPlan` | 4838 | `writing/writingPlanRepository` | A1 | — |
| `fetchFirestorePhase2Collections` | 4865 | `writing/phase2Queries` | A1 | — |
| `fetchFirestoreApprovalAudits` | 5019 | `proposals/changeProposalRepository` | A1 | — |

## 분리 결과와 의존성

| 위치 | 주요 파일과 역할 |
| --- | --- |
| `core/` | `projectPath.ts`는 프로젝트 경로를 만들고 `firestoreTimestamp.ts`는 Timestamp를 정규화한다. |
| `local/` | `localProjectStore.ts`는 레거시 EmergencyDraftBackup API, UID별 캐시 및 기본 프로젝트 초기화를 제공한다. |
| `episode/` | `episodeQueries.ts`는 회차 및 Revision의 읽기와 정렬을 담당한다. `episodeDocuments.ts`는 Firestore 쓰기 필드를 만든다. `episodeCas.ts`는 CAS 검증과 커밋 순서를 유지한다. `episodeRepository.ts`와 `localEpisodeRepository.ts`는 각각 Client SDK 트랜잭션과 LocalStorage 어댑터를 제공한다. |
| `project/` | `projectQueries.ts`는 프로젝트 목록과 전체 상세를 조합하고 `projectMutations.ts`는 생성, 수정, 삭제를 담당한다. |
| `lore/`, `memory/` | `loreRepository.ts`는 인물, 세계관, 장면, 사건, 관계, 복선 쓰기를 유지한다. `foundationQueries.ts`는 기존 기반 데이터 조회를 제공한다. `memoryRepository.ts`는 기존 Client SDK 기억 문서·청크 쓰기를 담는다. |
| `proposals/` | `proposalValidation.ts`는 유효성, 동등성 및 오류 분류를 담당한다. `proposalPersistenceCore.ts`는 의존성을 주입받는 저장 흐름을 유지한다. `changeProposalRepository.ts`는 Firestore 제안 어댑터, 업데이트, 승인 감사 조회를 제공한다. |
| `writing/` | `profileValidation.ts`는 공통 읽기 정규화·검증과 버전 이력 보존을 담당한다. `promptProfileRepository.ts`와 `styleProfileRepository.ts`는 각각 버전 CAS와 원자적 스타일 승인 경로를 제공한다. `writingPlanRepository.ts`는 집필 계획을 쓰고 `phase2Queries.ts`는 기존 집필 데이터를 읽는다. |
| `backup/` | `projectBundleCodec.ts`는 기존 JSON 인코딩·검증을, `projectBundleImport.ts`는 기존 순차 Firestore 업로드를 담당한다. |
| `src/utils/novelValidation.ts` | 코덱·저장 모듈이 공유하는 기존 입력 검증을 담는다. 기존 `novelLogic.ts`의 import 경로가 계속 동작한다. |

공개 진입점은 내부 모듈을 re-export한다. 내부 모듈은 공개 진입점을 거꾸로 참조하지 않는다. 회차 어댑터가 CAS 코어를 호출하며, Firestore 포트는 기존 트랜잭션 콜백 내부에서 읽기와 쓰기를 처리한다. IndexedDB 및 저장 스케줄러는 기존 인스턴스를 사용한다.

LF 기준으로 `novelRepository.ts`는 **181,821바이트 / 5,089줄 → 4,064바이트 / 109줄**이다. 두 원본 파일과 분리 후 해당 구현 전체를 비교하면 **202,570바이트 / 5,649줄 → 215,775바이트 / 5,977줄**이다. 분리 후 규모에는 내부 모듈 23개, 기존 진입점 두 개, 공통 입력 검증 모듈 한 개가 포함되며 테스트와 문서는 제외했다.

## 회귀 검증 연결

| 검증 | 근거 |
| --- | --- |
| AR1–AR3 공개 API·저장 경로·백업 JSON | `repositoryArchitecture.test.ts`에서 기준 79개 런타임 export·10개 타입, 저장 경로, 기준 백업과 역직렬화 해시를 확인한다. |
| AR4–AR9 회차·Revision, CAS, 중복 저장과 색인 | `firestoreRulesEmulator.test.ts`, `literaryRewritingLogic.test.ts`, `storageHardening.test.ts`, `ragEngine.test.ts`를 실행한다. App의 색인 연결과 저장 결과 처리 코드는 유지했다. |
| AR10–AR11, AR14–AR15 자동 저장과 범위 | `storageHardening.test.ts`의 제어 타이머·범위 직렬화와 Emulator의 UID 격리를 확인한다. 계정 전환과 회차 전환의 브라우저 화면 흐름은 별도 시나리오다. |
| AR12–AR13 Chromium 복구 | 실제 IndexedDB 트랜잭션, 페이지 재로드, 복수 편집 세션, 늦은 응답의 순서 보호를 확인한다. 용량 오류는 주입 방식이다. |
| AR16–AR18 크기 제한·삭제·레거시 | 문서 크기 추정과 차단, Emulator에서 원자적 취소 및 삭제된 회차의 저장 거부, 기존 UID별 캐시 및 EmergencyDraftBackup을 확인한다. |
| AR19–AR22 Style·Prompt·Proposal과 트랜잭션 | 일반 회귀 및 실제 Emulator의 승인 버전, 소유권, 원자성, 재시도 테스트를 재사용한다. |
| AR23–AR24 모듈 그래프와 인스턴스 | esbuild 런타임 그래프와 facade의 export 구현 동일성으로 역방향 import, 순환, 중복 인스턴스를 검사한다. |
| AR25 저장 벤치마크 | 동일한 제어 타이머, CAS 어댑터 및 100·300·500화 Emulator fixture를 분리 전후에 사용한다. |

후속 RAG 분리에서는 먼저 입출력 계약과 결정적 변환을 정리한 뒤 검색·조회 및 SDK 어댑터를 분리한다. 활성 세대 전환, Cleanup fencing, durable 승인과 재시도의 트랜잭션은 각 동작의 Emulator 케이스를 고정한 뒤 마지막에 옮긴다.
