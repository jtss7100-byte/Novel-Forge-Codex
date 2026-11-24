# 집필 규칙과 응답 스키마 관리

| 자료 | 편집할 공식 원본 | 기존 다운로드 URL |
| --- | --- | --- |
| Master Writing Rules v1.0 | [masterWritingRulesV1.ts](../src/schemas/masterWritingRulesV1.ts) | `/assets/aistudio/NOVEL_FORGE_Master_Writing_Rules_v1.0_8eb8ffc7.md` |
| App Result Schema | [novelforge_app_result.schema.json](../src/schemas/novelforge_app_result.schema.json) | `/assets/aistudio/novelforge_app_result.schema_4c1c1864.json` |
| Writer Response Schema | [novelforge_writer_response.schema.json](../src/schemas/novelforge_writer_response.schema.json) | `/assets/aistudio/novelforge_writer_response.schema_e579aaf5.json` |

Master Writing Rules는 Node.js와 Vite에서 사용하던 TypeScript 문자열과 메타데이터를 공식 원본으로 관리합니다. JSON 두 종류는 기존 import와 직렬화 순서를 유지합니다. Gemini 요청용 변환과 Zod 응답 검증은 현재 코드 경로에서 이루어집니다.

공개 파일은 원본을 편집한 후 아래 명령으로 갱신합니다. 파일명과 URL은 기존 링크 호환에 쓰입니다. 공개 사본을 직접 편집하면 다음 생성에서 덮어쓰게 됩니다. 공개 Markdown에는 기존 규격대로 마지막 개행을 추가하고, 공개 JSON 두 파일은 기존 규격대로 마지막 개행을 뺍니다.

```powershell
bun run schemas:generate
bun run schemas:check
```

CI는 `schemas:check`로 세 사본의 바이트를 비교합니다. 사본이 누락됐거나 원본과 다르면 해당 경로를 표시하고 실패합니다.

## 프로그램에서 사용하는 경로

- [AI 엔진 공통 로직](../src/utils/aiEngineLogic.ts)은 기본 프로필과 Writer 문맥을 구성하고, Writer·감사용 Gemini 스키마와 Zod 검증기를 제공합니다.
- [Gemini Writer](../src/server/geminiWritingEngine.ts)는 집필·계획·Continuity Checker·Style Editor 요청에 선택된 규칙을 사용합니다. 원고 추출은 기존 별도 계약을 사용합니다. [추출 엔진](../src/server/manuscriptExtractionEngine.ts)
- [Prompt Manager](../src/components/PromptManagerView.tsx)에서 기본 프로필과 버전을 선택하거나 복원합니다. [작품 저장소](../src/services/novelRepository.ts)의 로컬 및 Firestore 로드가 이 프로필을 사용합니다.
- [문학 품질](../src/utils/literaryQualityLogic.ts)과 [재작성](../src/utils/literaryRewritingLogic.ts)은 집필 문맥의 활성 프롬프트를 사용합니다. [집필 A/B 평가](../src/server/novelWritingEvaluationPilot.ts)는 Writer용 스키마와 합성 집필 문맥을 재사용합니다.
- [작품 내보내기·가져오기](../src/components/SettingsView.tsx)와 [백업 및 복구](../src/services/novelRepository.ts)는 기존 작품 데이터 경로를 사용합니다. 공개 자료는 Vite가 복사하고 Express가 프로덕션에서 제공합니다. [서버 진입점](../server.ts)

## 기존 작품과 계약 개정

새 작품의 기본 규칙에는 공식 원본을 사용합니다. 기존 작품은 선택된 Prompt Profile 및 버전의 본문을 사용합니다. 자동 전환은 앱 초기 버전 ID, 레거시 제목, 원래 자리표시자 본문 및 일치하는 이력으로 식별되는 레거시 기본값에만 적용합니다. 작가의 v1 규칙과 승인 버전은 그대로 불러오며 이전 버전 복원은 기존과 같이 새 버전을 추가합니다.

집필 규칙의 의미를 개정하려면 버전·메타데이터, 적용 범위, 이전 작품의 선택·복원 동작을 먼저 검토하고 작가 승인을 받습니다. JSON 출력 계약 개정은 App Result와 Writer Response를 각각 버전 관리하고, 생산자·소비자, Gemini 변환, Zod 검증 및 기존 응답 호환성 테스트를 함께 검토합니다. 변경 근거에 따라 회귀 기준 해시와 호환 자료를 갱신합니다.
