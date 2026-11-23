import React, { useState } from 'react';
import {
  BookOpen,
  Edit3,
  FileText,
  FolderPlus,
  Globe,
  Layers,
  Plus,
  Trash2,
  Users,
  CheckCircle2,
  Clock,
} from 'lucide-react';
import type {
  Character,
  Episode,
  NavTab,
  Project,
  Revision,
  SettingStatus,
  WorldbuildingItem,
} from '../types/novel';
import {
  computeProjectDashboardStats,
  validateProjectInput,
} from '../utils/novelLogic';
import { ConfirmModal } from './ConfirmModal';

interface DashboardViewProps {
  projects: Project[];
  activeProject: Project | null;
  episodes: Episode[];
  characters: Character[];
  worldbuilding: WorldbuildingItem[];
  revisions: Revision[];
  onSelectProject: (projectId: string) => void;
  onCreateProject: (data: {
    title: string;
    genre: string;
    synopsis: string;
    status: SettingStatus;
  }) => Promise<void>;
  onUpdateProject: (
    projectId: string,
    data: {
      title: string;
      genre: string;
      synopsis: string;
      status: SettingStatus;
    }
  ) => Promise<void>;
  onDeleteProject: (projectId: string) => Promise<void>;
  onNavigate: (tab: NavTab, targetId?: string) => void;
}

const GENRE_PRESETS = [
  '다크 판타지 / 전기 판타지',
  '정통 하이 판타지',
  '회귀 / 헌터 판타지',
  '아카데미 / 마법 판타지',
  '성좌 / 차원 판타지',
  '무협 / 동양 판타지',
];

export const DashboardView: React.FC<DashboardViewProps> = ({
  projects,
  activeProject,
  episodes,
  characters,
  worldbuilding,
  revisions,
  onSelectProject,
  onCreateProject,
  onUpdateProject,
  onDeleteProject,
  onNavigate,
}) => {
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [genre, setGenre] = useState(GENRE_PRESETS[0]);
  const [synopsis, setSynopsis] = useState('');
  const [status, setStatus] = useState<SettingStatus>('confirmed');
  const [formError, setFormError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null);

  const stats = computeProjectDashboardStats(
    episodes,
    characters,
    worldbuilding,
    revisions
  );

  const openCreateModal = () => {
    setEditingProjectId(null);
    setTitle('');
    setGenre(GENRE_PRESETS[0]);
    setSynopsis('');
    setStatus('draft');
    setFormError(null);
    setIsFormOpen(true);
  };

  const openEditModal = (proj: Project) => {
    setEditingProjectId(proj.id);
    setTitle(proj.title);
    setGenre(proj.genre);
    setSynopsis(proj.synopsis);
    setStatus(proj.status);
    setFormError(null);
    setIsFormOpen(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const validation = validateProjectInput({ title, genre, synopsis, status });
    if (!validation.valid) {
      setFormError(validation.error || '입력값을 확인해 주세요.');
      return;
    }

    setIsSubmitting(true);
    setFormError(null);
    try {
      if (editingProjectId) {
        await onUpdateProject(editingProjectId, {
          title: title.trim(),
          genre: genre.trim(),
          synopsis: synopsis.trim(),
          status,
        });
      } else {
        await onCreateProject({
          title: title.trim(),
          genre: genre.trim(),
          synopsis: synopsis.trim(),
          status,
        });
      }
      setIsFormOpen(false);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : '작품 저장 중 오류가 발생했습니다.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    const targetId = deleteTarget.id;
    setDeleteTarget(null);
    await onDeleteProject(targetId);
  };

  const formatEpisodeStatus = (st: Episode['status']) => {
    if (st === 'confirmed') return '확정 원고';
    if (st === 'review') return '검토 중';
    return '초안';
  };

  return (
    <div className="space-y-8">
      {/* Section 1: Active Project Hero & Primary Actions */}
      <section className="rounded-xl border border-slate-800 bg-slate-900/80 p-6">
        <div className="flex flex-col justify-between gap-6 lg:flex-row lg:items-start">
          <div className="space-y-2 max-w-3xl">
            <div className="flex items-center gap-2 text-xs text-slate-400">
              <span>현재 선택된 작품</span>
              <span aria-hidden="true">·</span>
              <span>{activeProject ? activeProject.genre : '작품 미선택'}</span>
              {activeProject && (
                <>
                  <span aria-hidden="true">·</span>
                  <span
                    className={
                      activeProject.status === 'confirmed'
                        ? 'text-emerald-400 font-medium'
                        : 'text-amber-400 font-medium'
                    }
                  >
                    {activeProject.status === 'confirmed' ? '확정 설정 작품' : '기획 초안 작품'}
                  </span>
                </>
              )}
            </div>

            <h1 className="text-2xl font-bold tracking-tight text-slate-100 sm:text-3xl">
              {activeProject ? activeProject.title : '새 판타지 작품을 생성해 주세요'}
            </h1>

            <p className="text-sm leading-relaxed text-slate-300">
              {activeProject?.synopsis ||
                '작품 시놉시스가 아직 등록되지 않았습니다. 작품 수정 버튼을 눌러 세계관 로그라인과 핵심 줄거리를 기록하세요.'}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3 shrink-0">
            {activeProject && (
              <>
                <button
                  type="button"
                  onClick={() => onNavigate('manuscript')}
                  className="inline-flex items-center gap-2 rounded-lg bg-amber-500 px-4 py-2.5 text-sm font-semibold text-slate-950 hover:bg-amber-400 transition-colors whitespace-nowrap shrink-0"
                >
                  <BookOpen className="h-4 w-4" />
                  <span>원고 집필하기</span>
                </button>
                <button
                  type="button"
                  onClick={() => openEditModal(activeProject)}
                  className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-800 px-4 py-2.5 text-sm font-medium text-slate-200 hover:bg-slate-700 transition-colors whitespace-nowrap shrink-0"
                >
                  <Edit3 className="h-4 w-4" />
                  <span>현재 작품 수정</span>
                </button>
              </>
            )}
            <button
              type="button"
              onClick={openCreateModal}
              className="inline-flex items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-2.5 text-sm font-medium text-amber-300 hover:bg-amber-500/20 transition-colors whitespace-nowrap shrink-0"
            >
              <FolderPlus className="h-4 w-4" />
              <span>새 작품 만들기</span>
            </button>
          </div>
        </div>

        {/* KPI Metric Strip for Active Project */}
        {activeProject && (
          <div className="mt-6 grid grid-cols-2 gap-4 border-t border-slate-800 pt-6 sm:grid-cols-4">
            <div className="space-y-1">
              <div className="flex items-center gap-1.5 text-xs text-slate-400">
                <FileText className="h-3.5 w-3.5 text-amber-400" />
                <span>총 집필 회차</span>
              </div>
              <p
                data-testid="dashboard-total-episodes"
                className="font-mono-tabular text-2xl font-bold text-slate-100"
              >
                {stats.totalEpisodes.toLocaleString()}화
              </p>
              <p className="text-xs text-slate-400">
                확정 {stats.confirmedEpisodes} · 검토 {stats.reviewEpisodes} · 초안 {stats.draftEpisodes}
              </p>
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1.5 text-xs text-slate-400">
                <Layers className="h-3.5 w-3.5 text-emerald-400" />
                <span>총 누적 글자 수 (공백 포함)</span>
              </div>
              <p
                data-testid="dashboard-total-chars"
                className="font-mono-tabular text-2xl font-bold text-slate-100"
              >
                {stats.totalCharsWithSpaces.toLocaleString()}자
              </p>
              <p className="font-mono-tabular text-xs text-slate-400">
                공백 제외 {stats.totalCharsWithoutSpaces.toLocaleString()}자 · 회당 평균{' '}
                {stats.avgCharsPerEpisode.toLocaleString()}자
              </p>
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1.5 text-xs text-slate-400">
                <Users className="h-3.5 w-3.5 text-sky-400" />
                <span>등록된 등장인물</span>
              </div>
              <p className="font-mono-tabular text-2xl font-bold text-slate-100">
                {stats.totalCharacters.toLocaleString()}명
              </p>
              <p className="text-xs text-slate-400">
                확정 설정 {stats.confirmedCharacters} · 초안 설정 {stats.draftCharacters}
              </p>
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1.5 text-xs text-slate-400">
                <Globe className="h-3.5 w-3.5 text-purple-400" />
                <span>세계관 설정 및 버전</span>
              </div>
              <p className="font-mono-tabular text-2xl font-bold text-slate-100">
                {stats.totalWorldbuilding.toLocaleString()}개
              </p>
              <p className="text-xs text-slate-400">
                확정 {stats.confirmedWorldbuilding} · 초안 {stats.draftWorldbuilding} · 백업 버전{' '}
                {stats.totalRevisions}개
              </p>
            </div>
          </div>
        )}
      </section>

      {/* Create / Edit Project Modal Form */}
      {isFormOpen && (
        <section
          aria-label={editingProjectId ? '작품 정보 수정' : '새 작품 생성'}
          className="rounded-xl border border-amber-500/40 bg-slate-900 p-6"
        >
          <div className="flex items-center justify-between border-b border-slate-800 pb-4">
            <h2 className="text-lg font-semibold text-slate-100">
              {editingProjectId ? '작품 정보 수정' : '새 장편 판타지 작품 생성'}
            </h2>
            <button
              type="button"
              onClick={() => setIsFormOpen(false)}
              className="text-xs text-slate-400 hover:text-slate-200"
            >
              닫기
            </button>
          </div>

          <form onSubmit={handleSubmit} className="mt-4 space-y-4">
            {formError && (
              <div
                role="alert"
                className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-4 py-2.5 text-sm text-rose-300"
              >
                {formError}
              </div>
            )}

            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <div className="md:col-span-2">
                <label
                  htmlFor="project-title-input"
                  className="block text-xs font-medium text-slate-300 mb-1.5"
                >
                  작품 제목 *
                </label>
                <input
                  id="project-title-input"
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="예: 심연의 연대기: 잿빛 왕관의 계승자"
                  maxLength={120}
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3.5 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-amber-500 focus:outline-none"
                />
              </div>

              <div>
                <label
                  htmlFor="project-status-select"
                  className="block text-xs font-medium text-slate-300 mb-1.5"
                >
                  설정 상태 구분 *
                </label>
                <select
                  id="project-status-select"
                  value={status}
                  onChange={(e) => setStatus(e.target.value as SettingStatus)}
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3.5 py-2 text-sm text-slate-100 focus:border-amber-500 focus:outline-none"
                >
                  <option value="confirmed">확정 설정 (Confirmed)</option>
                  <option value="draft">기획 초안 (Draft)</option>
                </select>
              </div>
            </div>

            <div>
              <label
                htmlFor="project-genre-input"
                className="block text-xs font-medium text-slate-300 mb-1.5"
              >
                세부 장르 *
              </label>
              <div className="flex flex-wrap gap-2 mb-2">
                {GENRE_PRESETS.map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => setGenre(preset)}
                    className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                      genre === preset
                        ? 'bg-amber-500 text-slate-950'
                        : 'border border-slate-800 bg-slate-950 text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {preset}
                  </button>
                ))}
              </div>
              <input
                id="project-genre-input"
                type="text"
                value={genre}
                onChange={(e) => setGenre(e.target.value)}
                placeholder="직접 장르 입력 (최대 60자)"
                maxLength={60}
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3.5 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-amber-500 focus:outline-none"
              />
            </div>

            <div>
              <label
                htmlFor="project-synopsis-input"
                className="block text-xs font-medium text-slate-300 mb-1.5"
              >
                작품 시놉시스 및 핵심 로그라인
              </label>
              <textarea
                id="project-synopsis-input"
                rows={3}
                value={synopsis}
                onChange={(e) => setSynopsis(e.target.value)}
                placeholder="작품의 중심 갈등, 주인공의 목표, 핵심 세계관 설정을 요약해 두세요."
                maxLength={3000}
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3.5 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-amber-500 focus:outline-none"
              />
            </div>

            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setIsFormOpen(false)}
                className="rounded-lg border border-slate-700 bg-slate-800 px-4 py-2 text-sm font-medium text-slate-300 hover:bg-slate-700 transition-colors"
              >
                취소
              </button>
              <button
                type="submit"
                disabled={isSubmitting}
                className="rounded-lg bg-amber-500 px-5 py-2 text-sm font-semibold text-slate-950 hover:bg-amber-400 disabled:opacity-50 transition-colors"
              >
                {isSubmitting ? '저장 중...' : editingProjectId ? '작품 수정 저장' : '작품 생성하기'}
              </button>
            </div>
          </form>
        </section>
      )}

      {/* Section 2: Two-Column Workspace Overview (Projects List + Episode Progress Table) */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* Left 5 Cols: All Projects List */}
        <section className="space-y-4 lg:col-span-5">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-base font-semibold text-slate-100">전체 작품 목록</h2>
              <p className="text-xs text-slate-400">
                작품을 선택하여 집필 공간을 전환하거나 관리합니다 ({projects.length}개)
              </p>
            </div>
            <button
              type="button"
              onClick={openCreateModal}
              aria-label="작품 목록에서 새 작품 추가"
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs font-medium text-slate-200 hover:border-amber-500/50 hover:text-amber-300 transition-colors"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>작품 추가</span>
            </button>
          </div>

          {projects.length === 0 ? (
            <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-8 text-center">
              <p className="text-sm text-slate-400">등록된 작품이 없습니다.</p>
              <button
                type="button"
                onClick={openCreateModal}
                className="mt-4 inline-flex items-center gap-2 rounded-lg bg-amber-500 px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-amber-400"
              >
                첫 작품 생성하기
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              {projects.map((proj) => {
                const isSelected = activeProject?.id === proj.id;
                return (
                  <div
                    key={proj.id}
                    className={`rounded-xl border p-4 transition-colors ${
                      isSelected
                        ? 'border-amber-500/60 bg-slate-900'
                        : 'border-slate-800 bg-slate-900/50 hover:border-slate-700'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <button
                        type="button"
                        onClick={() => onSelectProject(proj.id)}
                        className="text-left flex-1 group"
                      >
                        <div className="flex items-center gap-2 text-xs text-slate-400">
                          <span>{proj.genre}</span>
                          <span aria-hidden="true">·</span>
                          <span
                            className={
                              proj.status === 'confirmed'
                                ? 'text-emerald-400'
                                : 'text-amber-400'
                            }
                          >
                            {proj.status === 'confirmed' ? '확정' : '초안'}
                          </span>
                          {isSelected && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span className="font-semibold text-amber-400">현재 작업 중</span>
                            </>
                          )}
                        </div>
                        <h3 className="mt-1 text-base font-semibold text-slate-100 group-hover:text-amber-300 transition-colors">
                          {proj.title}
                        </h3>
                        {proj.synopsis && (
                          <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-slate-400">
                            {proj.synopsis}
                          </p>
                        )}
                      </button>

                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          type="button"
                          onClick={() => openEditModal(proj)}
                          aria-label={`${proj.title} 수정`}
                          className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-200 transition-colors"
                        >
                          <Edit3 className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => setDeleteTarget(proj)}
                          aria-label={`${proj.title} 삭제`}
                          className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-500/15 hover:text-rose-400 transition-colors"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* Right 7 Cols: Episode Status & Character Count Table */}
        <section className="space-y-4 lg:col-span-7">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-base font-semibold text-slate-100">
                회차별 원고 현황 및 글자 수
              </h2>
              <p className="text-xs text-slate-400">
                회차 클릭 시 해당 원고 집필 편집기로 즉시 이동합니다
              </p>
            </div>
            <button
              type="button"
              onClick={() => onNavigate('manuscript')}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs font-medium text-slate-200 hover:border-amber-500/50 hover:text-amber-300 transition-colors"
            >
              <BookOpen className="h-3.5 w-3.5" />
              <span>집필실 열기</span>
            </button>
          </div>

          <div className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900/70">
            {episodes.length === 0 ? (
              <div className="p-8 text-center">
                <p className="text-sm text-slate-400">
                  아직 작성된 회차 원고가 없습니다. 원고 집필 메뉴에서 첫 회차를 시작하세요.
                </p>
                <button
                  type="button"
                  onClick={() => onNavigate('manuscript')}
                  className="mt-4 inline-flex items-center gap-2 rounded-lg bg-amber-500 px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-amber-400"
                >
                  첫 회차 작성하기
                </button>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-800 bg-slate-950/60 text-xs font-medium text-slate-400">
                      <th className="py-3 pl-4 pr-2 whitespace-nowrap">회차</th>
                      <th className="px-3 py-3 whitespace-nowrap">제목 및 요약</th>
                      <th className="px-3 py-3 whitespace-nowrap">원고 상태</th>
                      <th className="py-3 pl-3 pr-4 text-right whitespace-nowrap">글자 수 (공백 포함)</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/70 text-sm">
                    {episodes.map((ep) => (
                      <tr
                        key={ep.id}
                        onClick={() => onNavigate('manuscript', ep.id)}
                        className="cursor-pointer hover:bg-slate-800/50 transition-colors"
                      >
                        <td className="py-3.5 pl-4 pr-2 font-mono-tabular text-xs font-semibold text-amber-400 whitespace-nowrap">
                          제{ep.episodeNumber}화
                        </td>
                        <td className="px-3 py-3.5">
                          <div className="font-medium text-slate-100">{ep.title}</div>
                          {ep.synopsis && (
                            <div className="mt-0.5 line-clamp-1 text-xs text-slate-400">
                              {ep.synopsis}
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-3.5 whitespace-nowrap text-xs">
                          <span
                            className={`inline-flex items-center gap-1 font-medium ${
                              ep.status === 'confirmed'
                                ? 'text-emerald-400'
                                : ep.status === 'review'
                                ? 'text-amber-400'
                                : 'text-slate-400'
                            }`}
                          >
                            {ep.status === 'confirmed' ? (
                              <CheckCircle2 className="h-3.5 w-3.5" />
                            ) : (
                              <Clock className="h-3.5 w-3.5" />
                            )}
                            <span>{formatEpisodeStatus(ep.status)}</span>
                          </span>
                        </td>
                        <td className="py-3.5 pl-3 pr-4 text-right font-mono-tabular text-xs text-slate-200 whitespace-nowrap">
                          <div>{ep.charCountWithSpaces.toLocaleString()}자</div>
                          <div className="text-slate-500">
                            공백 제외 {ep.charCountWithoutSpaces.toLocaleString()}자
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>
      </div>

      <ConfirmModal
        open={Boolean(deleteTarget)}
        title="작품 영구 삭제 확인"
        description={
          deleteTarget
            ? `'${deleteTarget.title}' 작품과 그에 속한 모든 회차 원고, 등장인물, 세계관 설정 및 버전 기록이 함께 삭제됩니다. 계속하시겠습니까?`
            : ''
        }
        confirmLabel="작품 영구 삭제"
        onConfirm={handleConfirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
};
