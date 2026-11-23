import React, { useMemo, useState } from 'react';
import {
  CheckCircle2,
  Clock,
  Edit3,
  Globe,
  Plus,
  Search,
  Trash2,
} from 'lucide-react';
import type {
  Character,
  Episode,
  SettingStatus,
  WorldbuildingItem,
} from '../types/novel';
import { validateWorldbuildingInput } from '../utils/novelLogic';
import { ConfirmModal } from './ConfirmModal';

interface WorldbuildingViewProps {
  worldbuilding: WorldbuildingItem[];
  characters: Character[];
  episodes: Episode[];
  onCreateWorldbuilding: (
    data: Omit<WorldbuildingItem, 'id' | 'ownerId' | 'projectId' | 'createdAt' | 'updatedAt'>
  ) => Promise<void>;
  onUpdateWorldbuilding: (item: WorldbuildingItem) => Promise<void>;
  onDeleteWorldbuilding: (itemId: string) => Promise<void>;
}

const CATEGORY_PRESETS = [
  '마법/이능 체계',
  '대륙/지리',
  '왕국/세력',
  '역사/신화',
  '아티팩트/무구',
  '종족/생태',
  '기타',
];

export const WorldbuildingView: React.FC<WorldbuildingViewProps> = ({
  worldbuilding,
  characters,
  episodes,
  onCreateWorldbuilding,
  onUpdateWorldbuilding,
  onDeleteWorldbuilding,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | SettingStatus>('all');
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<WorldbuildingItem | null>(null);

  const [title, setTitle] = useState('');
  const [category, setCategory] = useState(CATEGORY_PRESETS[0]);
  const [summary, setSummary] = useState('');
  const [content, setContent] = useState('');
  const [rules, setRules] = useState('');
  const [status, setStatus] = useState<SettingStatus>('confirmed');
  const [linkedCharacterIds, setLinkedCharacterIds] = useState<string[]>([]);
  const [linkedEpisodeIds, setLinkedEpisodeIds] = useState<string[]>([]);
  const [formError, setFormError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<WorldbuildingItem | null>(null);

  const filteredItems = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return worldbuilding.filter((wb) => {
      if (statusFilter !== 'all' && wb.status !== statusFilter) return false;
      if (categoryFilter !== 'all' && wb.category !== categoryFilter) return false;
      if (!q) return true;
      return (
        wb.title.toLowerCase().includes(q) ||
        wb.category.toLowerCase().includes(q) ||
        wb.summary.toLowerCase().includes(q) ||
        wb.content.toLowerCase().includes(q) ||
        wb.rules.toLowerCase().includes(q)
      );
    });
  }, [worldbuilding, searchQuery, categoryFilter, statusFilter]);

  const openCreateForm = () => {
    setEditingItem(null);
    setTitle('');
    setCategory(CATEGORY_PRESETS[0]);
    setSummary('');
    setContent('');
    setRules('');
    setStatus('draft');
    setLinkedCharacterIds([]);
    setLinkedEpisodeIds([]);
    setFormError(null);
    setIsFormOpen(true);
  };

  const openEditForm = (item: WorldbuildingItem) => {
    setEditingItem(item);
    setTitle(item.title);
    setCategory(item.category);
    setSummary(item.summary);
    setContent(item.content);
    setRules(item.rules);
    setStatus(item.status);
    setLinkedCharacterIds(item.linkedCharacterIds);
    setLinkedEpisodeIds(item.linkedEpisodeIds);
    setFormError(null);
    setIsFormOpen(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const check = validateWorldbuildingInput({
      title,
      category,
      summary,
      content,
      rules,
      status,
    });
    if (!check.valid) {
      setFormError(check.error || '입력값을 확인해 주세요.');
      return;
    }

    setIsSubmitting(true);
    setFormError(null);
    try {
      if (editingItem) {
        await onUpdateWorldbuilding({
          ...editingItem,
          title: title.trim(),
          category: category.trim(),
          summary: summary.trim(),
          content: content.trim(),
          rules: rules.trim(),
          status,
          linkedCharacterIds,
          linkedEpisodeIds,
          updatedAt: new Date().toISOString(),
        });
      } else {
        await onCreateWorldbuilding({
          title: title.trim(),
          category: category.trim(),
          summary: summary.trim(),
          content: content.trim(),
          rules: rules.trim(),
          status,
          linkedCharacterIds,
          linkedEpisodeIds,
        });
      }
      setIsFormOpen(false);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : '세계관 항목 저장 실패');
    } finally {
      setIsSubmitting(false);
    }
  };

  const toggleCharacterLink = (charId: string) => {
    setLinkedCharacterIds((prev) =>
      prev.includes(charId) ? prev.filter((id) => id !== charId) : [...prev, charId]
    );
  };

  const toggleEpisodeLink = (epId: string) => {
    setLinkedEpisodeIds((prev) =>
      prev.includes(epId) ? prev.filter((id) => id !== epId) : [...prev, epId]
    );
  };

  return (
    <div className="space-y-6">
      {/* Header & Filter Bar */}
      <div className="flex flex-col justify-between gap-4 rounded-xl border border-slate-800 bg-slate-900/80 p-5 lg:flex-row lg:items-center">
        <div>
          <h1 className="text-xl font-bold text-slate-100">세계관 대백과 및 고유 법칙</h1>
          <p className="mt-1 text-xs text-slate-400">
            마법 체계, 대륙 지리, 세력 구도, 절대 제약 법칙을 확정/초안 상태로 구분하여 기록합니다
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="relative min-w-[220px]">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="세계관 설정, 법칙 검색..."
              aria-label="세계관 설정 검색"
              className="w-full rounded-lg border border-slate-700 bg-slate-950 pl-9 pr-3 py-2 text-xs text-slate-100 placeholder:text-slate-500 focus:border-amber-500 focus:outline-none"
            />
          </div>

          <div className="flex items-center gap-1 rounded-lg bg-slate-950 p-1">
            {(
              [
                { key: 'all', label: `전체 (${worldbuilding.length})` },
                {
                  key: 'confirmed',
                  label: `확정 (${worldbuilding.filter((w) => w.status === 'confirmed').length})`,
                },
                {
                  key: 'draft',
                  label: `초안 (${worldbuilding.filter((w) => w.status === 'draft').length})`,
                },
              ] as const
            ).map((tab) => (
              <button
                key={tab.key}
                type="button"
                onClick={() => setStatusFilter(tab.key)}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
                  statusFilter === tab.key
                    ? 'bg-slate-800 text-amber-400'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={openCreateForm}
            className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500 px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-amber-400 transition-colors whitespace-nowrap shrink-0"
          >
            <Plus className="h-4 w-4" />
            <span>새 세계관 설정 추가</span>
          </button>
        </div>
      </div>

      {/* Category Filter Buttons */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setCategoryFilter('all')}
          className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
            categoryFilter === 'all'
              ? 'bg-amber-500 text-slate-950 font-semibold'
              : 'border border-slate-800 bg-slate-900 text-slate-400 hover:text-slate-200'
          }`}
        >
          모든 분류
        </button>
        {CATEGORY_PRESETS.map((cat) => (
          <button
            key={cat}
            type="button"
            onClick={() => setCategoryFilter(cat)}
            className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
              categoryFilter === cat
                ? 'bg-amber-500 text-slate-950 font-semibold'
                : 'border border-slate-800 bg-slate-900 text-slate-400 hover:text-slate-200'
            }`}
          >
            {cat}
          </button>
        ))}
      </div>

      {/* Create / Edit Worldbuilding Form */}
      {isFormOpen && (
        <section
          aria-label={editingItem ? '세계관 설정 수정' : '새 세계관 설정 추가'}
          className="rounded-xl border border-amber-500/40 bg-slate-900 p-6"
        >
          <div className="flex items-center justify-between border-b border-slate-800 pb-4">
            <h2 className="text-base font-semibold text-slate-100">
              {editingItem ? `'${editingItem.title}' 설정 수정` : '새 세계관 설정 항목 등록'}
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
                className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-4 py-2.5 text-xs text-rose-300"
              >
                {formError}
              </div>
            )}

            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <div>
                <label
                  htmlFor="wb-title-input"
                  className="block text-xs font-medium text-slate-300 mb-1"
                >
                  설정 항목명 *
                </label>
                <input
                  id="wb-title-input"
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="예: 에테르 공명 체계"
                  maxLength={120}
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-amber-500 focus:outline-none"
                />
              </div>

              <div>
                <label
                  htmlFor="wb-category-select"
                  className="block text-xs font-medium text-slate-300 mb-1"
                >
                  분류 카테고리 *
                </label>
                <select
                  id="wb-category-select"
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-amber-500 focus:outline-none"
                >
                  {CATEGORY_PRESETS.map((cat) => (
                    <option key={cat} value={cat}>
                      {cat}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label
                  htmlFor="wb-status-select"
                  className="block text-xs font-medium text-slate-300 mb-1"
                >
                  설정 확정 상태 *
                </label>
                <select
                  id="wb-status-select"
                  value={status}
                  onChange={(e) => setStatus(e.target.value as SettingStatus)}
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-amber-500 focus:outline-none"
                >
                  <option value="confirmed">확정 설정 (Confirmed)</option>
                  <option value="draft">초안 설정 (Draft)</option>
                </select>
              </div>
            </div>

            <div>
              <label
                htmlFor="wb-summary-input"
                className="block text-xs font-medium text-slate-300 mb-1"
              >
                한 줄 핵심 요약
              </label>
              <input
                id="wb-summary-input"
                type="text"
                value={summary}
                onChange={(e) => setSummary(e.target.value)}
                placeholder="이 설정의 핵심 정의를 한 문장으로 요약하세요."
                maxLength={500}
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-amber-500 focus:outline-none"
              />
            </div>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div>
                <label
                  htmlFor="wb-content-textarea"
                  className="block text-xs font-medium text-slate-300 mb-1"
                >
                  상세 세계관 설정 설명
                </label>
                <textarea
                  id="wb-content-textarea"
                  rows={4}
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  placeholder="기원, 구조, 작동 원리, 역사적 배경 등을 상세히 작성하세요."
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 p-3 text-xs leading-relaxed text-slate-100 focus:border-amber-500 focus:outline-none"
                />
              </div>

              <div>
                <label
                  htmlFor="wb-rules-textarea"
                  className="block text-xs font-medium text-slate-300 mb-1"
                >
                  절대 제약 및 패널티 법칙 (설정 충돌 방지용)
                </label>
                <textarea
                  id="wb-rules-textarea"
                  rows={4}
                  value={rules}
                  onChange={(e) => setRules(e.target.value)}
                  placeholder="원고 집필 시 절대 어기면 안 되는 제약 조건, 리스크, 한계치 등을 명시하세요."
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 p-3 text-xs leading-relaxed text-slate-100 focus:border-amber-500 focus:outline-none"
                />
              </div>
            </div>

            {/* Relational Links */}
            <div className="grid grid-cols-1 gap-4 border-t border-slate-800 pt-4 md:grid-cols-2">
              <div>
                <div className="text-xs font-medium text-slate-300 mb-2">
                  관련 등장인물 연결 ({linkedCharacterIds.length}명)
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {characters.map((ch) => {
                    const active = linkedCharacterIds.includes(ch.id);
                    return (
                      <button
                        key={ch.id}
                        type="button"
                        onClick={() => toggleCharacterLink(ch.id)}
                        className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
                          active
                            ? 'bg-sky-500 text-slate-950 font-semibold'
                            : 'border border-slate-800 bg-slate-950 text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        {ch.name}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div>
                <div className="text-xs font-medium text-slate-300 mb-2">
                  관련 회차 연결 ({linkedEpisodeIds.length}개)
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {episodes.map((ep) => {
                    const active = linkedEpisodeIds.includes(ep.id);
                    return (
                      <button
                        key={ep.id}
                        type="button"
                        onClick={() => toggleEpisodeLink(ep.id)}
                        className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
                          active
                            ? 'bg-amber-500 text-slate-950 font-semibold'
                            : 'border border-slate-800 bg-slate-950 text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        제{ep.episodeNumber}화
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setIsFormOpen(false)}
                className="rounded-lg border border-slate-700 bg-slate-800 px-4 py-2 text-xs font-medium text-slate-300 hover:bg-slate-700"
              >
                취소
              </button>
              <button
                type="submit"
                disabled={isSubmitting}
                className="rounded-lg bg-amber-500 px-5 py-2 text-xs font-semibold text-slate-950 hover:bg-amber-400 disabled:opacity-50"
              >
                {isSubmitting ? '저장 중...' : editingItem ? '세계관 설정 수정 저장' : '세계관 설정 저장'}
              </button>
            </div>
          </form>
        </section>
      )}

      {/* Worldbuilding Cards */}
      {filteredItems.length === 0 ? (
        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-12 text-center">
          <Globe className="mx-auto h-8 w-8 text-slate-500 mb-2" />
          <p className="text-sm text-slate-300">조건에 맞는 세계관 설정 항목이 없습니다.</p>
          <button
            type="button"
            onClick={openCreateForm}
            className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-amber-500 px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-amber-400"
          >
            <Plus className="h-4 w-4" />
            <span>세계관 항목 추가하기</span>
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {filteredItems.map((wb) => {
            const linkedChars = characters.filter((c) => wb.linkedCharacterIds.includes(c.id));
            const linkedEps = episodes.filter((e) => wb.linkedEpisodeIds.includes(e.id));

            return (
              <article
                key={wb.id}
                className="flex flex-col justify-between rounded-xl border border-slate-800 bg-slate-900/80 p-5 hover:border-slate-700 transition-colors"
              >
                <div className="space-y-3">
                  {/* Unboxed Metadata Kicker */}
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 text-xs text-slate-400">
                      <span className="font-medium text-amber-400">{wb.category}</span>
                      <span aria-hidden="true">·</span>
                      <span
                        className={`inline-flex items-center gap-1 font-medium ${
                          wb.status === 'confirmed' ? 'text-emerald-400' : 'text-amber-300'
                        }`}
                      >
                        {wb.status === 'confirmed' ? (
                          <CheckCircle2 className="h-3 w-3" />
                        ) : (
                          <Clock className="h-3 w-3" />
                        )}
                        <span>{wb.status === 'confirmed' ? '확정 설정' : '초안 설정'}</span>
                      </span>
                    </div>

                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        type="button"
                        onClick={() => openEditForm(wb)}
                        aria-label={`${wb.title} 수정`}
                        className="rounded p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-100"
                      >
                        <Edit3 className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setDeleteTarget(wb)}
                        aria-label={`${wb.title} 삭제`}
                        className="rounded p-1.5 text-slate-400 hover:bg-rose-500/15 hover:text-rose-400"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>

                  <h2 className="text-lg font-bold text-slate-100">{wb.title}</h2>

                  {wb.summary && (
                    <p className="text-xs font-medium text-slate-200">{wb.summary}</p>
                  )}

                  {wb.content && (
                    <p className="text-xs leading-relaxed text-slate-300 whitespace-pre-line">
                      {wb.content}
                    </p>
                  )}

                  {wb.rules && (
                    <div className="rounded-lg border border-amber-500/25 bg-slate-950/80 p-3 text-xs text-amber-200/90 whitespace-pre-line">
                      <div className="font-semibold text-amber-400 mb-1">
                        핵심 제약 및 법칙
                      </div>
                      {wb.rules}
                    </div>
                  )}
                </div>

                <div className="mt-4 border-t border-slate-800/80 pt-3 text-[11px] text-slate-400 space-y-1">
                  <div>
                    관련 등장인물:{' '}
                    {linkedChars.length > 0
                      ? linkedChars.map((c) => c.name).join(' · ')
                      : '연결된 인물 없음'}
                  </div>
                  <div>
                    등장 회차:{' '}
                    {linkedEps.length > 0
                      ? linkedEps.map((e) => `제${e.episodeNumber}화`).join(' · ')
                      : '연결된 회차 없음'}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}

      <ConfirmModal
        open={Boolean(deleteTarget)}
        title="세계관 설정 항목 삭제 확인"
        description={
          deleteTarget
            ? `'${deleteTarget.title}' 세계관 설정 항목을 영구 삭제하시겠습니까?`
            : ''
        }
        confirmLabel="세계관 항목 삭제"
        onConfirm={async () => {
          if (!deleteTarget) return;
          const id = deleteTarget.id;
          setDeleteTarget(null);
          await onDeleteWorldbuilding(id);
        }}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
};
