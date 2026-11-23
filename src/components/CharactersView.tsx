import React, { useMemo, useState } from 'react';
import {
  CheckCircle2,
  Clock,
  Edit3,
  Plus,
  Search,
  Trash2,
  UserPlus,
  Users,
} from 'lucide-react';
import type {
  Character,
  Episode,
  SettingStatus,
  WorldbuildingItem,
} from '../types/novel';
import { validateCharacterInput } from '../utils/novelLogic';
import { ConfirmModal } from './ConfirmModal';

interface CharactersViewProps {
  characters: Character[];
  episodes: Episode[];
  worldbuilding: WorldbuildingItem[];
  onCreateCharacter: (
    data: Omit<Character, 'id' | 'ownerId' | 'projectId' | 'createdAt' | 'updatedAt'>
  ) => Promise<void>;
  onUpdateCharacter: (character: Character) => Promise<void>;
  onDeleteCharacter: (characterId: string) => Promise<void>;
}

const ROLE_PRESETS = ['주인공', '주연', '조력자', '적대자', '조연', '흑막 / 보스'];

export const CharactersView: React.FC<CharactersViewProps> = ({
  characters,
  episodes,
  worldbuilding,
  onCreateCharacter,
  onUpdateCharacter,
  onDeleteCharacter,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | SettingStatus>('all');
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingCharacter, setEditingCharacter] = useState<Character | null>(null);

  const [name, setName] = useState('');
  const [role, setRole] = useState('주인공');
  const [affiliation, setAffiliation] = useState('');
  const [appearance, setAppearance] = useState('');
  const [personality, setPersonality] = useState('');
  const [background, setBackground] = useState('');
  const [abilities, setAbilities] = useState('');
  const [status, setStatus] = useState<SettingStatus>('confirmed');
  const [linkedEpisodeIds, setLinkedEpisodeIds] = useState<string[]>([]);
  const [linkedWorldbuildingIds, setLinkedWorldbuildingIds] = useState<string[]>([]);
  const [formError, setFormError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Character | null>(null);

  const filteredCharacters = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return characters.filter((c) => {
      if (statusFilter !== 'all' && c.status !== statusFilter) return false;
      if (!q) return true;
      return (
        c.name.toLowerCase().includes(q) ||
        c.role.toLowerCase().includes(q) ||
        c.affiliation.toLowerCase().includes(q) ||
        c.abilities.toLowerCase().includes(q) ||
        c.background.toLowerCase().includes(q)
      );
    });
  }, [characters, searchQuery, statusFilter]);

  const openCreateForm = () => {
    setEditingCharacter(null);
    setName('');
    setRole('주인공');
    setAffiliation('');
    setAppearance('');
    setPersonality('');
    setBackground('');
    setAbilities('');
    setStatus('draft');
    setLinkedEpisodeIds([]);
    setLinkedWorldbuildingIds([]);
    setFormError(null);
    setIsFormOpen(true);
  };

  const openEditForm = (char: Character) => {
    setEditingCharacter(char);
    setName(char.name);
    setRole(char.role);
    setAffiliation(char.affiliation);
    setAppearance(char.appearance);
    setPersonality(char.personality);
    setBackground(char.background);
    setAbilities(char.abilities);
    setStatus(char.status);
    setLinkedEpisodeIds(char.linkedEpisodeIds);
    setLinkedWorldbuildingIds(char.linkedWorldbuildingIds);
    setFormError(null);
    setIsFormOpen(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const check = validateCharacterInput({
      name,
      role,
      affiliation,
      appearance,
      personality,
      background,
      abilities,
      status,
    });
    if (!check.valid) {
      setFormError(check.error || '입력값을 확인해 주세요.');
      return;
    }

    setIsSubmitting(true);
    setFormError(null);
    try {
      if (editingCharacter) {
        await onUpdateCharacter({
          ...editingCharacter,
          name: name.trim(),
          role: role.trim(),
          affiliation: affiliation.trim(),
          appearance: appearance.trim(),
          personality: personality.trim(),
          background: background.trim(),
          abilities: abilities.trim(),
          status,
          linkedEpisodeIds,
          linkedWorldbuildingIds,
          updatedAt: new Date().toISOString(),
        });
      } else {
        await onCreateCharacter({
          name: name.trim(),
          role: role.trim(),
          affiliation: affiliation.trim(),
          appearance: appearance.trim(),
          personality: personality.trim(),
          background: background.trim(),
          abilities: abilities.trim(),
          status,
          linkedEpisodeIds,
          linkedWorldbuildingIds,
        });
      }
      setIsFormOpen(false);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : '등장인물 저장 중 오류 발생');
    } finally {
      setIsSubmitting(false);
    }
  };

  const toggleEpisodeLink = (epId: string) => {
    setLinkedEpisodeIds((prev) =>
      prev.includes(epId) ? prev.filter((id) => id !== epId) : [...prev, epId]
    );
  };

  const toggleWorldbuildingLink = (wbId: string) => {
    setLinkedWorldbuildingIds((prev) =>
      prev.includes(wbId) ? prev.filter((id) => id !== wbId) : [...prev, wbId]
    );
  };

  return (
    <div className="space-y-6">
      {/* Header & Search / Status Filter Bar */}
      <div className="flex flex-col justify-between gap-4 rounded-xl border border-slate-800 bg-slate-900/80 p-5 lg:flex-row lg:items-center">
        <div>
          <h1 className="text-xl font-bold text-slate-100">등장인물 도감 및 설정 관리</h1>
          <p className="mt-1 text-xs text-slate-400">
            확정된 캐릭터 설정과 기획 초안 설정을 분리하여 관리하고 등장 회차·세계관과 연결합니다
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="relative min-w-[240px]">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="이름, 역할, 소속, 능력 검색..."
              aria-label="등장인물 검색"
              className="w-full rounded-lg border border-slate-700 bg-slate-950 pl-9 pr-3 py-2 text-xs text-slate-100 placeholder:text-slate-500 focus:border-amber-500 focus:outline-none"
            />
          </div>

          <div className="flex items-center gap-1 rounded-lg bg-slate-950 p-1">
            {(
              [
                { key: 'all', label: `전체 (${characters.length})` },
                {
                  key: 'confirmed',
                  label: `확정 설정 (${characters.filter((c) => c.status === 'confirmed').length})`,
                },
                {
                  key: 'draft',
                  label: `초안 설정 (${characters.filter((c) => c.status === 'draft').length})`,
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
            <UserPlus className="h-4 w-4" />
            <span>새 등장인물 등록</span>
          </button>
        </div>
      </div>

      {/* Create / Edit Character Form */}
      {isFormOpen && (
        <section
          aria-label={editingCharacter ? '등장인물 수정' : '새 등장인물 등록'}
          className="rounded-xl border border-amber-500/40 bg-slate-900 p-6"
        >
          <div className="flex items-center justify-between border-b border-slate-800 pb-4">
            <h2 className="text-base font-semibold text-slate-100">
              {editingCharacter ? `'${editingCharacter.name}' 설정 수정` : '새 등장인물 프로필 작성'}
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

            <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
              <div>
                <label
                  htmlFor="char-name-input"
                  className="block text-xs font-medium text-slate-300 mb-1"
                >
                  이름 *
                </label>
                <input
                  id="char-name-input"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="예: 카엘 반스"
                  maxLength={100}
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-amber-500 focus:outline-none"
                />
              </div>

              <div>
                <label
                  htmlFor="char-role-input"
                  className="block text-xs font-medium text-slate-300 mb-1"
                >
                  작중 역할 *
                </label>
                <input
                  id="char-role-input"
                  type="text"
                  value={role}
                  onChange={(e) => setRole(e.target.value)}
                  placeholder="예: 주인공 / 감시단장"
                  maxLength={60}
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-amber-500 focus:outline-none"
                />
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {ROLE_PRESETS.map((r) => (
                    <button
                      key={r}
                      type="button"
                      onClick={() => setRole(r)}
                      className="rounded border border-slate-800 bg-slate-950 px-2 py-0.5 text-[11px] text-slate-400 hover:text-amber-300"
                    >
                      {r}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label
                  htmlFor="char-affiliation-input"
                  className="block text-xs font-medium text-slate-300 mb-1"
                >
                  소속 세력 / 집단
                </label>
                <input
                  id="char-affiliation-input"
                  type="text"
                  value={affiliation}
                  onChange={(e) => setAffiliation(e.target.value)}
                  placeholder="예: 침묵의 성채 녹턴 제1감시단"
                  maxLength={120}
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-amber-500 focus:outline-none"
                />
              </div>

              <div>
                <label
                  htmlFor="char-status-select"
                  className="block text-xs font-medium text-slate-300 mb-1"
                >
                  설정 확정 상태 *
                </label>
                <select
                  id="char-status-select"
                  value={status}
                  onChange={(e) => setStatus(e.target.value as SettingStatus)}
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-amber-500 focus:outline-none"
                >
                  <option value="confirmed">확정 설정 (Confirmed)</option>
                  <option value="draft">초안 설정 (Draft)</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div>
                <label
                  htmlFor="char-appearance-textarea"
                  className="block text-xs font-medium text-slate-300 mb-1"
                >
                  외형 및 복장 특징
                </label>
                <textarea
                  id="char-appearance-textarea"
                  rows={2}
                  value={appearance}
                  onChange={(e) => setAppearance(e.target.value)}
                  placeholder="머리색, 눈동자, 흉터, 장비 등을 기록하세요."
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 p-3 text-xs text-slate-100 focus:border-amber-500 focus:outline-none"
                />
              </div>

              <div>
                <label
                  htmlFor="char-personality-textarea"
                  className="block text-xs font-medium text-slate-300 mb-1"
                >
                  성격 및 말투 특징
                </label>
                <textarea
                  id="char-personality-textarea"
                  rows={2}
                  value={personality}
                  onChange={(e) => setPersonality(e.target.value)}
                  placeholder="가치관, 대사 톤, 버릇 등을 기록하세요."
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 p-3 text-xs text-slate-100 focus:border-amber-500 focus:outline-none"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div>
                <label
                  htmlFor="char-background-textarea"
                  className="block text-xs font-medium text-slate-300 mb-1"
                >
                  과거 배경 서사 및 동기
                </label>
                <textarea
                  id="char-background-textarea"
                  rows={3}
                  value={background}
                  onChange={(e) => setBackground(e.target.value)}
                  placeholder="캐릭터의 과거사, 트라우마, 핵심 목표를 기록하세요."
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 p-3 text-xs text-slate-100 focus:border-amber-500 focus:outline-none"
                />
              </div>

              <div>
                <label
                  htmlFor="char-abilities-textarea"
                  className="block text-xs font-medium text-slate-300 mb-1"
                >
                  고유 능력 / 마법 / 무력 수준
                </label>
                <textarea
                  id="char-abilities-textarea"
                  rows={3}
                  value={abilities}
                  onChange={(e) => setAbilities(e.target.value)}
                  placeholder="검술 위계, 마법 속성, 아티팩트, 약점 등을 기록하세요."
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 p-3 text-xs text-slate-100 focus:border-amber-500 focus:outline-none"
                />
              </div>
            </div>

            {/* Relational Links */}
            <div className="grid grid-cols-1 gap-4 border-t border-slate-800 pt-4 md:grid-cols-2">
              <div>
                <div className="text-xs font-medium text-slate-300 mb-2">
                  등장 회차 연결 ({linkedEpisodeIds.length}개 선택됨)
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

              <div>
                <div className="text-xs font-medium text-slate-300 mb-2">
                  관련 세계관 항목 연결 ({linkedWorldbuildingIds.length}개 선택됨)
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {worldbuilding.map((wb) => {
                    const active = linkedWorldbuildingIds.includes(wb.id);
                    return (
                      <button
                        key={wb.id}
                        type="button"
                        onClick={() => toggleWorldbuildingLink(wb.id)}
                        className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
                          active
                            ? 'bg-sky-500 text-slate-950 font-semibold'
                            : 'border border-slate-800 bg-slate-950 text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        {wb.title}
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
                {isSubmitting ? '저장 중...' : editingCharacter ? '등장인물 수정 저장' : '등장인물 저장'}
              </button>
            </div>
          </form>
        </section>
      )}

      {/* Characters Grid */}
      {filteredCharacters.length === 0 ? (
        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-12 text-center">
          <Users className="mx-auto h-8 w-8 text-slate-500 mb-2" />
          <p className="text-sm text-slate-300">조건에 맞는 등장인물이 없습니다.</p>
          <button
            type="button"
            onClick={openCreateForm}
            className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-amber-500 px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-amber-400"
          >
            <Plus className="h-4 w-4" />
            <span>등장인물 추가하기</span>
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {filteredCharacters.map((char) => {
            const linkedEps = episodes.filter((ep) => char.linkedEpisodeIds.includes(ep.id));
            const linkedWbs = worldbuilding.filter((wb) =>
              char.linkedWorldbuildingIds.includes(wb.id)
            );

            return (
              <article
                key={char.id}
                className="flex flex-col justify-between rounded-xl border border-slate-800 bg-slate-900/80 p-5 hover:border-slate-700 transition-colors"
              >
                <div className="space-y-3">
                  {/* Unboxed Metadata Kicker */}
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-1.5 text-xs text-slate-400">
                      <span className="font-medium text-amber-400">{char.role}</span>
                      {char.affiliation && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span>{char.affiliation}</span>
                        </>
                      )}
                      <span aria-hidden="true">·</span>
                      <span
                        className={`inline-flex items-center gap-1 font-medium ${
                          char.status === 'confirmed' ? 'text-emerald-400' : 'text-amber-300'
                        }`}
                      >
                        {char.status === 'confirmed' ? (
                          <CheckCircle2 className="h-3 w-3" />
                        ) : (
                          <Clock className="h-3 w-3" />
                        )}
                        <span>{char.status === 'confirmed' ? '확정 설정' : '초안 설정'}</span>
                      </span>
                    </div>

                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        type="button"
                        onClick={() => openEditForm(char)}
                        aria-label={`${char.name} 수정`}
                        className="rounded p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-100"
                      >
                        <Edit3 className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setDeleteTarget(char)}
                        aria-label={`${char.name} 삭제`}
                        className="rounded p-1.5 text-slate-400 hover:bg-rose-500/15 hover:text-rose-400"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>

                  <h2 className="text-lg font-bold text-slate-100">{char.name}</h2>

                  {char.background && (
                    <p className="text-xs leading-relaxed text-slate-300">{char.background}</p>
                  )}

                  <div className="space-y-1.5 border-t border-slate-800/80 pt-3 text-xs">
                    {char.appearance && (
                      <div className="text-slate-400">
                        <span className="font-medium text-slate-300">외형: </span>
                        {char.appearance}
                      </div>
                    )}
                    {char.personality && (
                      <div className="text-slate-400">
                        <span className="font-medium text-slate-300">성격: </span>
                        {char.personality}
                      </div>
                    )}
                    {char.abilities && (
                      <div className="text-slate-400">
                        <span className="font-medium text-amber-300/90">능력: </span>
                        {char.abilities}
                      </div>
                    )}
                  </div>
                </div>

                <div className="mt-4 border-t border-slate-800/80 pt-3 text-[11px] text-slate-400 space-y-1">
                  <div>
                    등장 회차:{' '}
                    {linkedEps.length > 0
                      ? linkedEps.map((e) => `제${e.episodeNumber}화`).join(' · ')
                      : '연결된 회차 없음'}
                  </div>
                  <div>
                    연결 세계관:{' '}
                    {linkedWbs.length > 0
                      ? linkedWbs.map((w) => w.title).join(' · ')
                      : '연결된 세계관 없음'}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}

      <ConfirmModal
        open={Boolean(deleteTarget)}
        title="등장인물 삭제 확인"
        description={
          deleteTarget
            ? `'${deleteTarget.name}' 등장인물 프로필을 영구 삭제하시겠습니까?`
            : ''
        }
        confirmLabel="등장인물 삭제"
        onConfirm={async () => {
          if (!deleteTarget) return;
          const id = deleteTarget.id;
          setDeleteTarget(null);
          await onDeleteCharacter(id);
        }}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
};
