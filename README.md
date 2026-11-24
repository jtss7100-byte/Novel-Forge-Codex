# Novel Forge

## 개발 환경

- Node.js 22.x (22.13 이상)
- Bun 1.4.4
- Firebase Emulator를 실행할 때는 Java 21

Windows PowerShell에서 `node --version`, `bun --version`, `java -version`으로 PATH와 버전을 확인합니다. Node.js는 서버 런타임이고, Bun은 의존성 설치와 스크립트 실행에 사용합니다.

## 설치 및 실행

저장소 루트에서 실행합니다.

```powershell
bun install --frozen-lockfile
bun run dev
```

기본 개발 주소는 `http://localhost:3000`입니다. Firebase 및 Gemini 환경 설정은 [`.env.example`](.env.example)을 참고합니다. 기존 로컬 `.env`는 보존하고 자격 증명이 든 파일은 커밋하지 않습니다.

의존성 버전은 `bun.lock`으로 고정합니다. 의존성을 바꿀 때는 Bun을 사용합니다. npm으로 의존성을 설치하면 별도의 잠금 파일이 생성될 수 있으며, CI는 루트의 중복 잠금 파일을 검사합니다.

## 회귀 검증

```powershell
bun run lint
bun run test
bun run build
bunx eslint firestore.rules
```

프로덕션 빌드를 로컬로 제공하려면 빌드 후 별도 PowerShell 세션에서 `$env:NODE_ENV = 'production'`을 설정하고 `bun run start`를 실행합니다. 이 명령에 필요한 `tsx`는 현재 개발 의존성에 포함됩니다.

### 실제 Auth·Firestore Emulator

개발 서버를 종료한 뒤 새 PowerShell 세션에서 CI와 같은 격리된 demo 프로젝트로 실행합니다. 포트 8080과 9099를 사용할 수 있어야 합니다.

```powershell
$env:RUN_LIVE_CLOUD_TESTS = 'false'
$env:RUN_LIVE_GEMINI_EVAL = 'false'
$env:NOVELFORGE_ENFORCE_CLOUD_AUTH = 'false'
$env:GCLOUD_PROJECT = 'demo-novelforge-rag-integrity'
$env:FIREBASE_PROJECT_ID = 'demo-novelforge-rag-integrity'
$env:TEST_FIREBASE_PROJECT_ID = 'demo-novelforge-rag-integrity'
$env:TEST_FIRESTORE_DATABASE_ID = '(default)'
$env:FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080'
$env:FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099'

bunx firebase-tools emulators:exec --project demo-novelforge-rag-integrity --config firebase.emulator.json --only auth,firestore "bun run test:emulator"
```
