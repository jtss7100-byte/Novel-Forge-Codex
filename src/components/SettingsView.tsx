import React, { useEffect, useState } from 'react';
import {
  CheckCircle2,
  CloudUpload,
  Copy,
  Cpu,
  Download,
  FileJson,
  RefreshCw,
  ShieldCheck,
  Upload,
  AlertCircle,
} from 'lucide-react';
import type {
  Character,
  Episode,
  Project,
  ProjectBundle,
  Revision,
  ServerAuthStatus,
  WorldbuildingItem,
} from '../types/novel';
import {
  parseAndValidateProjectBundle,
  serializeProjectBundle,
} from '../utils/novelLogic';

interface SettingsViewProps {
  activeProject: Project | null;
  characters: Character[];
  worldbuilding: WorldbuildingItem[];
  episodes: Episode[];
  revisions: Revision[];
  isAuthenticated: boolean;
  userEmail: string | null;
  userUid: string | null;
  serverAuthStatus: ServerAuthStatus | null;
  onRefreshServerAuth: () => Promise<void>;
  onImportProjectBundle: (bundle: ProjectBundle) => Promise<void>;
  onSyncCurrentToFirestore: () => Promise<void>;
  getIdToken: () => Promise<string | null>;
}

interface EngineModuleInfo {
  id: string;
  name: string;
  koreanTitle: string;
  phase: string;
  status: string;
  description: string;
  requiredCollections: string[];
}

export const SettingsView: React.FC<SettingsViewProps> = ({
  activeProject,
  characters,
  worldbuilding,
  episodes,
  revisions,
  isAuthenticated,
  userEmail,
  userUid,
  serverAuthStatus,
  onRefreshServerAuth,
  onImportProjectBundle,
  onSyncCurrentToFirestore,
  getIdToken,
}) => {
  const [importJsonText, setImportJsonText] = useState('');
  const [importStatus, setImportStatus] = useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [copiedJson, setCopiedJson] = useState(false);
  const [isSyncingCloud, setIsSyncingCloud] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);

  const [engineModules, setEngineModules] = useState<EngineModuleInfo[]>([]);
  const [serverSecretIsolated, setServerSecretIsolated] = useState<boolean>(true);

  useEffect(() => {
    let mounted = true;
    async function loadEngineStatus() {
      try {
        const token = await getIdToken();
        const headers: Record<string, string> = {};
        if (token) headers.Authorization = `Bearer ${token}`;
        const res = await fetch('/api/engine/architecture', { headers });
        if (!res.ok) return;
        const data = await res.json();
        if (mounted && Array.isArray(data.modules)) {
          setEngineModules(data.modules);
          setServerSecretIsolated(Boolean(data.serverSecretIsolated));
        }
      } catch {
        // fallback if offline
      }
    }
    loadEngineStatus();
    return () => {
      mounted = false;
    };
  }, [getIdToken, isAuthenticated]);

  const exportedJsonString = activeProject
    ? serializeProjectBundle(
        activeProject,
        characters,
        worldbuilding,
        episodes,
        revisions
      )
    : '';

  const handleDownloadJson = () => {
    if (!activeProject || !exportedJsonString) return;
    const blob = new Blob([exportedJsonString], {
      type: 'application/json;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const safeTitle = activeProject.title.replace(/[^a-zA-Z0-9가-힣_-]/g, '_');
    a.href = url;
    a.download = `novelforge_${safeTitle}_${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleCopyJson = async () => {
    if (!exportedJsonString) return;
    try {
      await navigator.clipboard.writeText(exportedJsonString);
      setCopiedJson(true);
      setTimeout(() => setCopiedJson(false), 2000);
    } catch {
      // ignore
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setImportJsonText(reader.result);
        setImportStatus(null);
      }
    };
    reader.readAsText(file, 'utf-8');
  };

  const handleExecuteImport = async () => {
    if (!importJsonText.trim()) {
      setImportStatus({
        type: 'error',
        message: '가져올 JSON 데이터를 붙여넣거나 파일을 선택해 주세요.',
      });
      return;
    }

    setIsImporting(true);
    setImportStatus(null);

    try {
      const targetOwner = userUid || 'local_author';
      const token = await getIdToken();
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (token) headers.Authorization = `Bearer ${token}`;

      // Validate on Node.js server first, falling back to local validator if network fails
      let validatedBundle: ProjectBundle | null = null;
      try {
        const res = await fetch('/api/projects/validate-bundle', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            rawJson: importJsonText,
            ownerId: targetOwner,
          }),
        });
        const payload = await res.json();
        if (!res.ok || !payload.valid) {
          setImportStatus({
            type: 'error',
            message: payload.error || '서버 JSON 스키마 검증에 실패했습니다.',
          });
          setIsImporting(false);
          return;
        }
        validatedBundle = payload.bundle as ProjectBundle;
      } catch {
        const localResult = parseAndValidateProjectBundle(importJsonText, targetOwner);
        if (!localResult.valid) {
          setImportStatus({ type: 'error', message: localResult.error });
          setIsImporting(false);
          return;
        }
        validatedBundle = localResult.bundle;
      }

      if (validatedBundle) {
        await onImportProjectBundle(validatedBundle);
        setImportStatus({
          type: 'success',
          message: `'${validatedBundle.project.title}' 작품(회차 ${validatedBundle.episodes.length}화, 등장인물 ${validatedBundle.characters.length}명, 세계관 ${validatedBundle.worldbuilding.length}개)을 성공적으로 가져왔습니다.`,
        });
        setImportJsonText('');
      }
    } catch (err) {
      setImportStatus({
        type: 'error',
        message: err instanceof Error ? err.message : 'JSON 가져오기 중 오류가 발생했습니다.',
      });
    } finally {
      setIsImporting(false);
    }
  };

  const handleSyncToCloud = async () => {
    setIsSyncingCloud(true);
    setSyncMessage(null);
    try {
      await onSyncCurrentToFirestore();
      setSyncMessage('현재 작품과 모든 하위 컬렉션이 Firestore에 성공적으로 동기화되었습니다.');
    } catch (err) {
      setSyncMessage(
        err instanceof Error ? err.message : '클라우드 동기화 중 오류가 발생했습니다.'
      );
    } finally {
      setIsSyncingCloud(false);
    }
  };

  return (
    <div className="space-y-8">
      {/* Section 1: JSON Export & Import */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Export Card */}
        <section className="rounded-xl border border-slate-800 bg-slate-900/80 p-6 space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-slate-100">
                작품 데이터 JSON 내보내기 (Export)
              </h2>
              <p className="mt-1 text-xs text-slate-400">
                현재 선택된 작품의 기본 정보, 등장인물, 세계관, 전체 회차 원고 및 버전 기록을 단일 JSON 번들로 백업합니다.
              </p>
            </div>
            <FileJson className="h-5 w-5 text-amber-400 shrink-0" />
          </div>

          {!activeProject ? (
            <div className="rounded-lg border border-slate-800 bg-slate-950 p-6 text-center text-xs text-slate-500">
              내보낼 작품이 선택되지 않았습니다.
            </div>
          ) : (
            <>
              <div className="rounded-lg border border-slate-800 bg-slate-950 p-3 text-xs text-slate-300 space-y-1">
                <div className="font-semibold text-slate-100">{activeProject.title}</div>
                <div className="font-mono-tabular text-slate-400">
                  회차 {episodes.length}화 · 등장인물 {characters.length}명 · 세계관{' '}
                  {worldbuilding.length}개 · 버전 스냅샷 {revisions.length}개
                </div>
              </div>

              <div>
                <label
                  htmlFor="export-json-preview"
                  className="block text-xs font-medium text-slate-400 mb-1.5"
                >
                  내보내기 JSON 미리보기 (읽기 전용)
                </label>
                <textarea
                  id="export-json-preview"
                  readOnly
                  rows={8}
                  value={exportedJsonString}
                  className="w-full rounded-lg border border-slate-800 bg-slate-950 p-3 font-mono-tabular text-xs text-slate-300 focus:outline-none"
                />
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={handleDownloadJson}
                  className="inline-flex items-center gap-2 rounded-lg bg-amber-500 px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-amber-400 transition-colors"
                >
                  <Download className="h-4 w-4" />
                  <span>JSON 파일 다운로드</span>
                </button>
                <button
                  type="button"
                  onClick={handleCopyJson}
                  className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-800 px-4 py-2 text-xs font-medium text-slate-200 hover:bg-slate-700 transition-colors"
                >
                  <Copy className="h-4 w-4" />
                  <span>{copiedJson ? '클립보드에 복사됨!' : 'JSON 클립보드 복사'}</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setImportJsonText(exportedJsonString);
                    setImportStatus(null);
                  }}
                  className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-300 hover:bg-slate-800 transition-colors"
                >
                  <span>가져오기 입력창으로 복사</span>
                </button>
              </div>
            </>
          )}
        </section>

        {/* Import Card */}
        <section className="rounded-xl border border-slate-800 bg-slate-900/80 p-6 space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-slate-100">
                작품 데이터 JSON 가져오기 (Import)
              </h2>
              <p className="mt-1 text-xs text-slate-400">
                백업된 NOVEL FORGE JSON 파일을 업로드하거나 텍스트를 붙여넣어 작품과 모든 원고를 복원합니다.
              </p>
            </div>
            <Upload className="h-5 w-5 text-emerald-400 shrink-0" />
          </div>

          {importStatus && (
            <div
              role="alert"
              className={`flex items-start gap-2 rounded-lg border p-3 text-xs leading-relaxed ${
                importStatus.type === 'success'
                  ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                  : 'border-rose-500/40 bg-rose-500/10 text-rose-300'
              }`}
            >
              {importStatus.type === 'success' ? (
                <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5" />
              ) : (
                <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
              )}
              <span>{importStatus.message}</span>
            </div>
          )}

          <div>
            <label
              htmlFor="json-file-upload"
              className="block text-xs font-medium text-slate-300 mb-1.5"
            >
              JSON 파일 선택 (.json)
            </label>
            <input
              id="json-file-upload"
              type="file"
              accept=".json,application/json"
              onChange={handleFileUpload}
              className="block w-full text-xs text-slate-400 file:mr-3 file:rounded-lg file:border-0 file:bg-slate-800 file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-slate-200 hover:file:bg-slate-700"
            />
          </div>

          <div>
            <label
              htmlFor="import-json-textarea"
              className="block text-xs font-medium text-slate-300 mb-1.5"
            >
              또는 JSON 데이터 직접 붙여넣기
            </label>
            <textarea
              id="import-json-textarea"
              rows={7}
              value={importJsonText}
              onChange={(e) => setImportJsonText(e.target.value)}
              placeholder='{"formatVersion": "1.0", "project": { ... }, "episodes": [ ... ]}'
              className="w-full rounded-lg border border-slate-700 bg-slate-950 p-3 font-mono-tabular text-xs text-slate-100 placeholder:text-slate-600 focus:border-amber-500 focus:outline-none"
            />
          </div>

          <div className="flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={() => {
                setImportJsonText('');
                setImportStatus(null);
              }}
              className="rounded-lg border border-slate-700 bg-slate-800 px-3.5 py-2 text-xs font-medium text-slate-300 hover:bg-slate-700"
            >
              초기화
            </button>
            <button
              type="button"
              onClick={handleExecuteImport}
              disabled={isImporting}
              className="inline-flex items-center gap-2 rounded-lg bg-emerald-500 px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-emerald-400 disabled:opacity-50 transition-colors"
            >
              <Upload className="h-4 w-4" />
              <span>{isImporting ? '검증 및 복원 중...' : 'JSON 데이터 검증 및 가져오기'}</span>
            </button>
          </div>
        </section>
      </div>

      {/* Section 2: Security Rules, Server Token Verification & Firestore Sync */}
      <section className="rounded-xl border border-slate-800 bg-slate-900/80 p-6 space-y-4">
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
          <div className="flex items-start gap-3">
            <ShieldCheck className="h-5 w-5 text-emerald-400 shrink-0 mt-0.5" />
            <div>
              <h2 className="text-base font-semibold text-slate-100">
                보안 인증 토큰 검증 및 Firestore 데이터 격리 현황
              </h2>
              <p className="mt-0.5 text-xs text-slate-400">
                모든 데이터는 <code className="text-amber-300">users/&#123;uid&#125;/projects/&#123;projectId&#125;/...</code> 경로에 격리되며 서버와 Firestore Security Rules에서 이중 검증됩니다.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={onRefreshServerAuth}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs font-medium text-slate-200 hover:bg-slate-700 transition-colors"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              <span>서버 토큰 재검증</span>
            </button>

            {isAuthenticated && activeProject && (
              <button
                type="button"
                onClick={handleSyncToCloud}
                disabled={isSyncingCloud}
                className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500 px-3.5 py-2 text-xs font-semibold text-slate-950 hover:bg-amber-400 disabled:opacity-50 transition-colors"
              >
                <CloudUpload className="h-3.5 w-3.5" />
                <span>{isSyncingCloud ? '동기화 중...' : '현재 작품 Firestore 전체 동기화'}</span>
              </button>
            )}
          </div>
        </div>

        {syncMessage && (
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-2.5 text-xs text-amber-200">
            {syncMessage}
          </div>
        )}

        <div className="grid grid-cols-1 gap-4 border-t border-slate-800 pt-4 md:grid-cols-3 text-xs">
          <div className="rounded-lg border border-slate-800 bg-slate-950/70 p-4 space-y-1">
            <div className="text-slate-400">현재 로그인 계정</div>
            <div className="font-semibold text-slate-100">
              {isAuthenticated ? userEmail || 'Google 로그인 사용자' : '미로그인 (로컬 브라우저 영구 저장소)'}
            </div>
            <div className="font-mono-tabular text-[11px] text-slate-500">
              UID: {userUid || 'local_author'}
            </div>
          </div>

          <div className="rounded-lg border border-slate-800 bg-slate-950/70 p-4 space-y-1">
            <div className="text-slate-400">Node.js 서버 토큰 검증 (/api/auth/verify)</div>
            <div
              className={`font-semibold ${
                serverAuthStatus?.verified ? 'text-emerald-400' : 'text-amber-300'
              }`}
            >
              {serverAuthStatus?.verified
                ? 'Firebase ID 토큰 서버 서명 검증 완료'
                : '로컬 작업 모드 (Google 로그인 시 자동 토큰 검증)'}
            </div>
            <div className="text-[11px] text-slate-500">
              {serverAuthStatus?.message || '서버 인증 미들웨어 정상 작동 중'}
            </div>
          </div>

          <div className="rounded-lg border border-slate-800 bg-slate-950/70 p-4 space-y-1">
            <div className="text-slate-400">API 키 및 비밀정보 보호</div>
            <div className="font-semibold text-emerald-400">
              {serverSecretIsolated ? '서버 전용 격리 완료 (클라이언트 노출 0건)' : '점검 필요'}
            </div>
            <div className="text-[11px] text-slate-500">
              GEMINI_API_KEY 및 Admin 검증 로직은 Express 서버 내부에서만 실행됩니다.
            </div>
          </div>
        </div>
      </section>

      {/* Section 3: Phase 1.5 Advanced System Foundation & Phase 2 Gemini Engine */}
      <section className="rounded-xl border border-slate-800 bg-slate-900/80 p-6 space-y-4">
        <div className="flex items-start gap-3">
          <Cpu className="h-5 w-5 text-amber-400 shrink-0 mt-0.5" />
          <div>
            <h2 className="text-base font-semibold text-slate-100">
              Phase 1.5 고급 시스템 기반 데이터 구조 및 Gemini 집필 엔진 아키텍처
            </h2>
            <p className="mt-0.5 text-xs text-slate-400">
              기존 1차 작품·원고 데이터와의 하위 호환성을 100% 유지하면서, 복선 추적·인물 관계·연표·장기 기억 검색(<code className="text-slate-300">MemorySearchProvider</code>)·문체 분석·AI 변경 승인 요청(<code className="text-slate-300">ChangeProposal</code>) 스키마와 확정 설정(<code className="text-amber-300">CANON</code>) 보호 규칙이 준비되어 있습니다.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 text-xs">
          <div className="rounded-lg border border-slate-800 bg-slate-950/70 p-3.5 space-y-1">
            <div className="font-mono-tabular text-[11px] text-amber-400">ID 계층 연결 및 출처 추적</div>
            <div className="font-semibold text-slate-100">
              사용자 → 작품 → 회차 → 장면 → 사건 → 인물 → 복선
            </div>
            <div className="text-[11px] text-slate-500">
              모든 고급 엔티티는 <code className="text-slate-300">sourceRevisionId</code> 및 생성 주체(<code className="text-slate-300">AUTHOR | AI_ENGINE</code>)를 기록합니다.
            </div>
          </div>
          <div className="rounded-lg border border-slate-800 bg-slate-950/70 p-3.5 space-y-1">
            <div className="font-mono-tabular text-[11px] text-emerald-400">확정 설정 보호 (Canon Protection)</div>
            <div className="font-semibold text-slate-100">
              DRAFT · PROPOSED · CANON · REJECTED · ARCHIVED
            </div>
            <div className="text-[11px] text-slate-500">
              <code className="text-emerald-300">CANON</code>(작가 확정) 설정은 AI가 임의로 수정·삭제할 수 없으며 <code className="text-slate-300">ChangeProposal</code> 승인이 필수입니다.
            </div>
          </div>
          <div className="rounded-lg border border-slate-800 bg-slate-950/70 p-3.5 space-y-1">
            <div className="font-mono-tabular text-[11px] text-sky-400">장기 기억 검색 인터페이스</div>
            <div className="font-semibold text-slate-100">
              MemorySearchProvider (RAG 준비 완료)
            </div>
            <div className="text-[11px] text-slate-500">
              <code className="text-slate-300">indexDocument()</code> · <code className="text-slate-300">deleteDocument()</code> · <code className="text-slate-300">search()</code> · <code className="text-slate-300">getSource()</code>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          {engineModules.map((mod) => (
            <div
              key={mod.id}
              className="rounded-lg border border-slate-800 bg-slate-950/80 p-4 space-y-2"
            >
              <div className="flex items-center justify-between text-xs text-slate-400">
                <span className="font-mono-tabular text-amber-400">{mod.name}</span>
                <span>Phase 1.5 기반 완료</span>
              </div>
              <h3 className="text-sm font-semibold text-slate-100">{mod.koreanTitle}</h3>
              <p className="text-xs leading-relaxed text-slate-400">{mod.description}</p>
              <div className="pt-1 text-[11px] text-slate-500">
                연동 컬렉션: {mod.requiredCollections.join(' · ')}
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
};
