import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  type User,
} from 'firebase/auth';
import {
  AlertCircle,
  BookOpen,
  CalendarClock,
  CheckCircle2,
  Cloud,
  Clock,
  Database,
  Feather,
  FileSearch,
  Globe,
  HardDrive,
  LayoutDashboard,
  LogIn,
  LogOut,
  Menu,
  Network,
  RotateCcw,
  Settings,
  ShieldCheck,
  Sliders,
  Sparkles,
  Users,
  X,
} from 'lucide-react';
import { auth, googleProvider } from './firebase';
import type {
  CanonStatus,
  ChangeProposal,
  Character,
  CharacterRelationship,
  Episode,
  EpisodeStatus,
  Foreshadowing,
  NavTab,
  PersistChangeProposalsOptions,
  PersistChangeProposalsResult,
  Project,
  ProjectBundle,
  PromptProfile,
  PromptProfileCasResult,
  Revision,
  SaveState,
  Scene,
  ServerAuthStatus,
  SettingStatus,
  StyleApprovalPayload,
  StyleProfile,
  StyleProfileApplicationResult,
  TimelineEvent,
  WorldbuildingItem,
  WritingPlan,
} from './types/novel';
import {
  calculateCharCounts,
  generateEntityId,
} from './utils/novelLogic';
import { assertCanonProtection } from './utils/foundationLogic';
import { createInitialPromptProfiles } from './utils/aiEngineLogic';
import { computeManuscriptContentHash } from './utils/manuscriptIntegrity';
import {
  commitEpisodeRevisionSafelyFirestore,
  commitEpisodeRevisionSafelyLocal,
  type EpisodeRevisionCommitResult,
  createFirestoreCharacter,
  createFirestoreEpisode,
  createFirestoreForeshadowing,
  createFirestoreProject,
  createFirestorePromptProfile,
  createFirestoreRelationship,
  createFirestoreStyleProfile,
  createFirestoreTimelineEvent,
  createFirestoreWorldbuilding,
  createFirestoreWritingPlan,
  formatProposalPersistenceErrorSummaryKo,
  normalizeAndValidateChangeProposalPayload,
  persistChangeProposalsIdempotentlyCore,
  persistFirestoreChangeProposalsIdempotently,
  verifyPersistedRevisionSnapshot,
  deleteFirestoreCharacter,
  deleteFirestoreEpisode,
  deleteFirestoreForeshadowing,
  deleteFirestoreProjectCascade,
  deleteFirestorePromptProfile,
  deleteFirestoreRelationship,
  deleteFirestoreRevision,
  deleteFirestoreTimelineEvent,
  deleteFirestoreWorldbuilding,
  fetchFirestoreApprovalAudits,
  fetchFirestoreFoundationCollections,
  fetchFirestorePhase2Collections,
  fetchFirestoreProjectDetails,
  fetchFirestoreProjects,
  fetchFirestorePromptProfileById,
  loadLocalBundles,
  persistApprovedStyleDnaAtomicallyFirestore,
  persistApprovedStyleDnaAtomicallyLocal,
  saveLocalBundles,
  saveCharacterVoicePromptCore,
  saveFirestoreCharacterVoicePrompt,
  updateFirestoreChangeProposal,
  updateFirestoreCharacter,
  updateFirestoreForeshadowing,
  updateFirestoreProject,
  updateFirestorePromptProfileWithCas,
  updateFirestoreRelationship,
  updateFirestoreTimelineEvent,
  updateFirestoreWorldbuilding,
  updateFirestoreWritingPlan,
  updateLocalPromptProfileWithCas,
  uploadProjectBundleToFirestore,
} from './services/novelRepository';
import { DashboardView } from './components/DashboardView';
import { ManuscriptView } from './components/ManuscriptView';
import { AiExtractionPanel } from './components/AiExtractionPanel';
import {
  ChangeProposalReviewPanel,
  type ApprovalExecutionOutcome,
} from './components/ChangeProposalReviewPanel';
import { CharactersView } from './components/CharactersView';
import { RelationshipsView } from './components/RelationshipsView';
import { TimelineView } from './components/TimelineView';
import { ForeshadowingView } from './components/ForeshadowingView';
import { WorldbuildingView } from './components/WorldbuildingView';
import { SettingsView } from './components/SettingsView';
import { PromptManagerView } from './components/PromptManagerView';
import { MemorySearchView } from './components/MemorySearchView';
import {
  evaluateRagAutoIndexEligibility,
  interpretRagApiResponse,
  resolveVerifiedSourceRevisionId,
  type RagSyncSummary,
} from './utils/phase4ManagementLogic';
import type { ChangeProposalApprovalAudit } from './types/changeProposalApproval';
import type { VoiceSourceReference } from './types/characterVoice';
import type { VoiceRewriteSelection } from './components/CharacterVoicePanel';
import {
  buildPreviewTargetEntityCandidate,
  computeDeterministicApprovalAuditId,
  isSupportedApprovalEntityType,
} from './utils/changeProposalApprovalLogic';
import {
  buildApprovedStyleProfilesForPersistence,
  buildStyleApplicationResult,
} from './utils/authorStyleLogic';

const ACTIVE_PROJECT_STORAGE_KEY = 'novelforge_active_project_id_v1';
const ACTIVE_EPISODE_STORAGE_KEY = 'novelforge_active_episode_id_v1';

export default function App() {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState<boolean>(false);
  const [serverAuthStatus, setServerAuthStatus] = useState<ServerAuthStatus | null>(null);

  const [bundles, setBundles] = useState<ProjectBundle[]>(() => loadLocalBundles());
  const [activeProjectId, setActiveProjectId] = useState<string>(() => {
    const savedId = localStorage.getItem(ACTIVE_PROJECT_STORAGE_KEY);
    const initial = loadLocalBundles();
    if (savedId && initial.some((b) => b.project.id === savedId)) {
      return savedId;
    }
    return initial[0]?.project.id || '';
  });

  const [selectedEpisodeId, setSelectedEpisodeId] = useState<string | null>(() => {
    return localStorage.getItem(ACTIVE_EPISODE_STORAGE_KEY);
  });

  const [activeTab, setActiveTab] = useState<NavTab>('dashboard');
  const [voiceRewriteSelection, setVoiceRewriteSelection] = useState<VoiceRewriteSelection | null>(null);
  const [selectedProposalForReviewId, setSelectedProposalForReviewId] =
    useState<string | null>(null);
  const [mobileNavOpen, setMobileNavOpen] = useState<boolean>(false);
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(() => new Date().toISOString());
  const [ragSyncSummary, setRagSyncSummary] = useState<RagSyncSummary>({
    status: 'IDLE',
    message: '',
    updatedAt: new Date().toISOString(),
  });
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [isLoadingCloud, setIsLoadingCloud] = useState<boolean>(false);

  const [idTokenState, setIdTokenState] = useState<string | null>(null);

  const getIdToken = useCallback(async (): Promise<string | null> => {
    if (!auth.currentUser) return null;
    try {
      const token = await auth.currentUser.getIdToken();
      setIdTokenState(token);
      return token;
    } catch {
      return null;
    }
  }, []);

  const triggerRagApiInBackground = useCallback(
    async (endpoint: string, payload: Record<string, unknown>) => {
      setRagSyncSummary({
        status: 'PENDING',
        message: 'RAG 색인 동기화 중...',
        updatedAt: new Date().toISOString(),
      });
      try {
        const token = await getIdToken();
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
        };
        if (token) {
          headers.Authorization = `Bearer ${token}`;
        }
        const res = await fetch(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            ...payload,
            ownerId: token ? undefined : 'local_author',
          }),
        });
        let body: unknown = null;
        try {
          body = await res.json();
        } catch {
          body = null;
        }
        const interpreted = interpretRagApiResponse({
          ok: res.ok,
          status: res.status,
          body,
        });
        if (interpreted.ragStatus === 'FAILED') {
          setRagSyncSummary({
            status: 'FAILED',
            message:
              interpreted.errorMessage ||
              'RAG 색인 실패 (원고/설정은 정상 저장됨)',
            updatedAt: new Date().toISOString(),
            retryable: interpreted.retryable,
          });
        } else {
          setRagSyncSummary({
            status: 'INDEXED',
            message: 'RAG 색인 완료',
            updatedAt: new Date().toISOString(),
          });
        }
      } catch (err) {
        // Non-blocking background RAG index sync: record RAG failure separately from saveState
        setRagSyncSummary({
          status: 'FAILED',
          message:
            err instanceof Error
              ? `RAG 색인 통신 오류: ${err.message}`
              : 'RAG 색인 통신 오류 (원고/설정은 정상 저장됨)',
          updatedAt: new Date().toISOString(),
          retryable: true,
        });
      }
    },
    [getIdToken]
  );

  const verifyTokenWithServer = useCallback(async (user: User | null) => {
    try {
      const headers: Record<string, string> = {};
      if (user) {
        const token = await user.getIdToken();
        headers.Authorization = `Bearer ${token}`;
      }
      const res = await fetch('/api/auth/verify', { headers });
      if (res.ok) {
        const data = (await res.json()) as ServerAuthStatus;
        setServerAuthStatus(data);
      }
    } catch {
      // ignore if offline
    }
  }, []);

  // Listen to Firebase Auth state and load Firestore data when signed in
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      setCurrentUser(user);
      setAuthReady(true);
      await verifyTokenWithServer(user);

      if (user) {
        setIsLoadingCloud(true);
        setErrorBanner(null);
        try {
          const cloudProjects = await fetchFirestoreProjects(user.uid);
          if (cloudProjects.length === 0) {
            // Seed initial local bundle into user's Firestore so they immediately have data in cloud
            const local = loadLocalBundles(user.uid);
            const uploaded: ProjectBundle[] = [];
            for (const b of local) {
              const synced = await uploadProjectBundleToFirestore(user.uid, b);
              uploaded.push(synced);
            }
            setBundles(uploaded);
            saveLocalBundles(uploaded);
            if (uploaded[0]) {
              setActiveProjectId(uploaded[0].project.id);
            }
          } else {
            const loadedBundles: ProjectBundle[] = [];
            for (const proj of cloudProjects) {
              const details = await fetchFirestoreProjectDetails(user.uid, proj.id);
              const phase2 = await fetchFirestorePhase2Collections(user.uid, proj.id);
              const foundation = await fetchFirestoreFoundationCollections(user.uid, proj.id);
              const approvalAudits = await fetchFirestoreApprovalAudits(user.uid, proj.id);
              let promptProfiles = phase2.writingPromptProfiles;
              if (promptProfiles.length === 0) {
                promptProfiles = createInitialPromptProfiles(
                  user.uid,
                  proj.id,
                  new Date().toISOString()
                );
                for (const p of promptProfiles) {
                  await createFirestorePromptProfile(user.uid, proj.id, p);
                }
              }
              const mergedProposalsMap = new Map<string, ChangeProposal>();
              for (const cp of foundation.changeProposals) {
                mergedProposalsMap.set(cp.id, cp);
              }
              for (const cp of phase2.changeProposals) {
                mergedProposalsMap.set(cp.id, cp);
              }
              loadedBundles.push({
                formatVersion: '1.0',
                exportedAt: new Date().toISOString(),
                project: proj,
                ...details,
                scenes: foundation.scenes,
                foreshadowings: foundation.foreshadowings,
                relationships: foundation.relationships,
                timelineEvents: foundation.timelineEvents,
                styleProfiles: foundation.styleProfiles,
                writingPromptProfiles: promptProfiles,
                writingPlans: phase2.writingPlans,
                changeProposals: Array.from(mergedProposalsMap.values()),
                approvalAudits,
              });
            }
            setBundles(loadedBundles);
            saveLocalBundles(loadedBundles);
            setActiveProjectId((prev) =>
              loadedBundles.some((b) => b.project.id === prev)
                ? prev
                : loadedBundles[0]?.project.id || ''
            );
          }
        } catch (err) {
          const msg =
            err instanceof Error ? err.message : 'Firestore 데이터를 불러오는 중 오류가 발생했습니다.';
          setErrorBanner(msg);
        } finally {
          setIsLoadingCloud(false);
        }
      } else {
        const local = loadLocalBundles('local_author');
        setBundles(local);
      }
    });

    return () => unsubscribe();
  }, [verifyTokenWithServer]);

  // Persist active project and episode IDs
  useEffect(() => {
    if (activeProjectId) {
      localStorage.setItem(ACTIVE_PROJECT_STORAGE_KEY, activeProjectId);
    }
  }, [activeProjectId]);

  useEffect(() => {
    if (selectedEpisodeId) {
      localStorage.setItem(ACTIVE_EPISODE_STORAGE_KEY, selectedEpisodeId);
    }
  }, [selectedEpisodeId]);

  const projects = useMemo(() => bundles.map((b) => b.project), [bundles]);

  const activeBundle = useMemo(() => {
    if (!bundles.length) return null;
    return bundles.find((b) => b.project.id === activeProjectId) || bundles[0];
  }, [bundles, activeProjectId]);

  const activeProject = activeBundle?.project || null;
  const characters = activeBundle?.characters || [];
  const worldbuilding = activeBundle?.worldbuilding || [];
  const episodes = activeBundle?.episodes || [];
  const revisions = activeBundle?.revisions || [];
  const scenes: Scene[] = activeBundle?.scenes || [];
  const relationships: CharacterRelationship[] = activeBundle?.relationships || [];
  const timelineEvents: TimelineEvent[] = activeBundle?.timelineEvents || [];
  const foreshadowings: Foreshadowing[] = activeBundle?.foreshadowings || [];
  const styleProfiles: StyleProfile[] = activeBundle?.styleProfiles || [];
  const promptProfiles = useMemo(() => {
    if (!activeBundle || !activeProject) return [];
    if (
      Array.isArray(activeBundle.writingPromptProfiles) &&
      activeBundle.writingPromptProfiles.length > 0
    ) {
      return activeBundle.writingPromptProfiles;
    }
    return createInitialPromptProfiles(
      activeProject.ownerId,
      activeProject.id,
      activeProject.createdAt
    );
  }, [activeBundle, activeProject]);
  const writingPlans = activeBundle?.writingPlans || [];
  const changeProposals = activeBundle?.changeProposals || [];
  const approvalAudits: ChangeProposalApprovalAudit[] =
    activeBundle?.approvalAudits || [];

  const updateBundlesAndPersist = useCallback(
    (updater: (prev: ProjectBundle[]) => ProjectBundle[]) => {
      setBundles((prev) => {
        const next = updater(prev);
        saveLocalBundles(next);
        return next;
      });
    },
    []
  );

  const handleGoogleSignIn = async () => {
    setErrorBanner(null);
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : 'Google 로그인 중 오류가 발생했습니다.';
      setErrorBanner(`Google 로그인 안내: ${msg}`);
    }
  };

  const handleGoogleSignOut = async () => {
    setErrorBanner(null);
    try {
      await signOut(auth);
      await verifyTokenWithServer(null);
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : '로그아웃 실패');
    }
  };

  // ============================================================================
  // Project CRUD Handlers
  // ============================================================================

  const handleCreateProject = async (input: {
    title: string;
    genre: string;
    synopsis: string;
    status: SettingStatus;
  }) => {
    setSaveState('saving');
    const nowIso = new Date().toISOString();
    const ownerId = currentUser?.uid || 'local_author';
    const newProject: Project = {
      id: generateEntityId('proj'),
      ownerId,
      title: input.title,
      genre: input.genre,
      synopsis: input.synopsis,
      status: input.status,
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    const initialProfiles = createInitialPromptProfiles(ownerId, newProject.id, nowIso);

    const newBundle: ProjectBundle = {
      formatVersion: '1.0',
      exportedAt: nowIso,
      project: newProject,
      characters: [],
      worldbuilding: [],
      episodes: [],
      revisions: [],
      scenes: [],
      relationships: [],
      timelineEvents: [],
      foreshadowings: [],
      writingPromptProfiles: initialProfiles,
      writingPlans: [],
      changeProposals: [],
    };

    if (currentUser) {
      await createFirestoreProject(currentUser.uid, newProject);
      for (const p of initialProfiles) {
        await createFirestorePromptProfile(currentUser.uid, newProject.id, p);
      }
    }

    updateBundlesAndPersist((prev) => [newBundle, ...prev]);
    setActiveProjectId(newProject.id);
    setSelectedEpisodeId(null);
    setSaveState('saved');
    setLastSavedAt(nowIso);
  };

  const handleUpdateProject = async (
    projectId: string,
    updates: {
      title: string;
      genre: string;
      synopsis: string;
      status: SettingStatus;
    }
  ) => {
    setSaveState('saving');
    const nowIso = new Date().toISOString();

    if (currentUser) {
      await updateFirestoreProject(currentUser.uid, projectId, updates);
    }

    updateBundlesAndPersist((prev) =>
      prev.map((b) =>
        b.project.id === projectId
          ? {
              ...b,
              project: {
                ...b.project,
                ...updates,
                updatedAt: nowIso,
              },
            }
          : b
      )
    );
    setSaveState('saved');
    setLastSavedAt(nowIso);
  };

  const handleDeleteProject = async (projectId: string) => {
    setSaveState('saving');
    const target = bundles.find((b) => b.project.id === projectId);
    if (currentUser && target) {
      await deleteFirestoreProjectCascade(currentUser.uid, projectId, {
        characters: target.characters,
        worldbuilding: target.worldbuilding,
        episodes: target.episodes,
        revisions: target.revisions,
        scenes: target.scenes,
        relationships: target.relationships,
        timelineEvents: target.timelineEvents,
        foreshadowings: target.foreshadowings,
      });
    }

    void triggerRagApiInBackground('/api/rag/delete-project', {
      projectId,
    });

    updateBundlesAndPersist((prev) => {
      const remaining = prev.filter((b) => b.project.id !== projectId);
      if (activeProjectId === projectId) {
        setActiveProjectId(remaining[0]?.project.id || '');
      }
      return remaining;
    });
    setSaveState('saved');
    setLastSavedAt(new Date().toISOString());
  };

  // ============================================================================
  // Episode & Revision Handlers
  // ============================================================================

  const handleCreateEpisode = async (input: {
    episodeNumber: number;
    title: string;
    status: EpisodeStatus;
  }): Promise<Episode> => {
    if (!activeProject) {
      throw new Error('선택된 작품이 없습니다.');
    }
    setSaveState('saving');
    const nowIso = new Date().toISOString();
    const ownerId = currentUser?.uid || 'local_author';
    const newEpisode: Episode = {
      id: generateEntityId('ep'),
      ownerId,
      projectId: activeProject.id,
      episodeNumber: input.episodeNumber,
      title: input.title,
      content: '',
      synopsis: '',
      authorNote: '',
      charCountWithSpaces: 0,
      charCountWithoutSpaces: 0,
      status: input.status,
      linkedCharacterIds: [],
      linkedWorldbuildingIds: [],
      contentHash: computeManuscriptContentHash(''),
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    if (currentUser) {
      await createFirestoreEpisode(currentUser.uid, activeProject.id, newEpisode);
    }

    updateBundlesAndPersist((prev) =>
      prev.map((b) =>
        b.project.id === activeProject.id
          ? {
              ...b,
              episodes: [...b.episodes, newEpisode].sort(
                (a, c) => a.episodeNumber - c.episodeNumber
              ),
            }
          : b
      )
    );

    setSaveState('saved');
    setLastSavedAt(nowIso);
    return newEpisode;
  };

  const handleSaveEpisode = async (
    updated: Episode,
    options?: {
      createRevision?: boolean;
      revisionLabel?: string;
      createBackupRevisionFirst?: boolean;
      backupRevisionLabel?: string;
      expectedRevisionId?: string;
      expectedContentHash?: string;
    }
  ): Promise<EpisodeRevisionCommitResult | void> => {
    if (!activeProject) return;
    const nowIso = new Date().toISOString();
    const uid = currentUser?.uid || 'local_author';
    const commitInput = {
      uid,
      projectId: activeProject.id,
      updatedEpisode: updated,
      expectedRevisionId: options?.expectedRevisionId,
      expectedContentHash: options?.expectedContentHash,
      createBackupRevisionFirst: Boolean(options?.createBackupRevisionFirst),
      backupRevisionLabel: options?.backupRevisionLabel,
      createRevision: Boolean(options?.createRevision),
      revisionLabel: options?.revisionLabel,
      nowIso,
    };

    let commitResult: EpisodeRevisionCommitResult;
    try {
      if (currentUser) {
        commitResult = await commitEpisodeRevisionSafelyFirestore(commitInput);
        setBundles((prev) => {
          const next = prev.map((b) => {
            if (b.project.id !== activeProject.id) return b;
            const addedRevs = [
              ...(commitResult.targetRevision ? [commitResult.targetRevision] : []),
              ...(commitResult.backupRevision ? [commitResult.backupRevision] : []),
            ];
            return {
              ...b,
              project: { ...b.project, updatedAt: nowIso },
              episodes: b.episodes
                .map((ep) =>
                  ep.id === commitResult.episode.id ? commitResult.episode : ep
                )
                .sort((a, c) => a.episodeNumber - c.episodeNumber),
              revisions: [...addedRevs, ...b.revisions],
            };
          });
          try {
            saveLocalBundles(next);
          } catch {
            // Best-effort local mirror when cloud commit has succeeded
          }
          return next;
        });
      } else {
        const localRes = await commitEpisodeRevisionSafelyLocal({
          bundles,
          commitInput,
        });
        commitResult = {
          episode: localRes.episode,
          backupRevision: localRes.backupRevision,
          targetRevision: localRes.targetRevision,
        };
        setBundles(localRes.nextBundles);
      }
    } catch (error) {
      const msg =
        error instanceof Error
          ? error.message
          : '원고 안전 저장(CAS) 중 오류가 발생해 원고를 롤백했습니다.';
      setSaveState('error');
      setErrorBanner(msg);
      throw error;
    }

    const committedEpisode = commitResult.episode;
    const addedRevisions = [
      ...(commitResult.targetRevision ? [commitResult.targetRevision] : []),
      ...(commitResult.backupRevision ? [commitResult.backupRevision] : []),
    ];

    if (committedEpisode.status === 'confirmed' && committedEpisode.content.trim()) {
      const availableRevisions = [...addedRevisions, ...revisions];
      const latestEpisodeRevisionId =
        commitResult.targetRevision?.id ||
        committedEpisode.latestRevisionId ||
        availableRevisions.find(
          (r) =>
            r.projectId === activeProject.id &&
            r.episodeId === committedEpisode.id
        )?.id ||
        '';
      const eligibility = evaluateRagAutoIndexEligibility({
        canonStatus: 'CANON',
        sourceRevisionId: latestEpisodeRevisionId,
        projectRevisions: availableRevisions,
        projectId: activeProject.id,
        rawText: committedEpisode.content,
      });

      if (eligibility.eligible) {
        void triggerRagApiInBackground('/api/rag/index-entity', {
          input: {
            projectId: activeProject.id,
            sourceEntityType: 'EPISODE',
            sourceEntityId: committedEpisode.id,
            sourceEpisodeId: committedEpisode.id,
            sourceRevisionId: eligibility.verifiedRevisionId,
            canonStatus: 'CANON',
            title: `제${committedEpisode.episodeNumber}화: ${committedEpisode.title}`,
            summary: (committedEpisode.synopsis || committedEpisode.content).slice(0, 380),
            rawText: committedEpisode.content,
            episodeNumber: committedEpisode.episodeNumber,
            relatedCharacterIds: committedEpisode.linkedCharacterIds || [],
            keywordTags: [committedEpisode.title, `제${committedEpisode.episodeNumber}화`],
          },
        });
      } else if (eligibility.skipReason === 'UNVERIFIED_SOURCE_REVISION') {
        setRagSyncSummary({
          status: 'SKIPPED_UNVERIFIED_SOURCE',
          message: '색인 미실행: 검증된 원고 리비전 출처 없음',
          updatedAt: nowIso,
        });
      }
    }

    setLastSavedAt(nowIso);
    return commitResult;
  };

  const handleDeleteEpisode = async (episodeId: string) => {
    if (!activeProject) return;
    setSaveState('saving');
    if (currentUser) {
      await deleteFirestoreEpisode(currentUser.uid, activeProject.id, episodeId);
    }

    void triggerRagApiInBackground('/api/rag/delete-entity', {
      projectId: activeProject.id,
      sourceEntityId: episodeId,
      isEpisodeDelete: true,
    });

    updateBundlesAndPersist((prev) =>
      prev.map((b) => {
        if (b.project.id !== activeProject.id) return b;
        const nextEpisodes = b.episodes.filter((ep) => ep.id !== episodeId);
        if (selectedEpisodeId === episodeId) {
          setSelectedEpisodeId(nextEpisodes[0]?.id || null);
        }
        return {
          ...b,
          episodes: nextEpisodes,
        };
      })
    );
    setSaveState('saved');
    setLastSavedAt(new Date().toISOString());
  };

  const handleDeleteRevision = async (revisionId: string) => {
    if (!activeProject) return;
    if (currentUser) {
      await deleteFirestoreRevision(currentUser.uid, activeProject.id, revisionId);
    }
    updateBundlesAndPersist((prev) =>
      prev.map((b) =>
        b.project.id === activeProject.id
          ? { ...b, revisions: b.revisions.filter((r) => r.id !== revisionId) }
          : b
      )
    );
  };

  // ============================================================================
  // Character CRUD Handlers
  // ============================================================================

  const handleCreateCharacter = async (
    data: Omit<Character, 'id' | 'ownerId' | 'projectId' | 'createdAt' | 'updatedAt'>
  ) => {
    if (!activeProject) return;
    setSaveState('saving');
    const nowIso = new Date().toISOString();
    const newChar: Character = {
      ...data,
      id: generateEntityId('char'),
      ownerId: currentUser?.uid || 'local_author',
      projectId: activeProject.id,
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    if (currentUser) {
      await createFirestoreCharacter(currentUser.uid, activeProject.id, newChar);
    }

    updateBundlesAndPersist((prev) =>
      prev.map((b) =>
        b.project.id === activeProject.id
          ? { ...b, characters: [newChar, ...b.characters] }
          : b
      )
    );
    setSaveState('saved');
    setLastSavedAt(nowIso);
  };

  const handleUpdateCharacter = async (character: Character) => {
    if (!activeProject) return;
    setSaveState('saving');
    const nowIso = new Date().toISOString();
    const updatedChar = { ...character, updatedAt: nowIso };

    if (currentUser) {
      await updateFirestoreCharacter(currentUser.uid, activeProject.id, updatedChar);
    }

    updateBundlesAndPersist((prev) =>
      prev.map((b) =>
        b.project.id === activeProject.id
          ? {
              ...b,
              characters: b.characters.map((c) =>
                c.id === updatedChar.id ? updatedChar : c
              ),
            }
          : b
      )
    );
    setSaveState('saved');
    setLastSavedAt(nowIso);
  };

  const handleDeleteCharacter = async (characterId: string) => {
    if (!activeProject) return;
    setSaveState('saving');
    if (currentUser) {
      await deleteFirestoreCharacter(currentUser.uid, activeProject.id, characterId);
    }

    void triggerRagApiInBackground('/api/rag/delete-entity', {
      projectId: activeProject.id,
      sourceEntityId: characterId,
      isEpisodeDelete: false,
    });

    updateBundlesAndPersist((prev) =>
      prev.map((b) =>
        b.project.id === activeProject.id
          ? {
              ...b,
              characters: b.characters.filter((c) => c.id !== characterId),
            }
          : b
      )
    );
    setSaveState('saved');
    setLastSavedAt(new Date().toISOString());
  };

  // ============================================================================
  // Worldbuilding CRUD Handlers
  // ============================================================================

  const handleCreateWorldbuilding = async (
    data: Omit<WorldbuildingItem, 'id' | 'ownerId' | 'projectId' | 'createdAt' | 'updatedAt'>
  ) => {
    if (!activeProject) return;
    setSaveState('saving');
    const nowIso = new Date().toISOString();
    const newItem: WorldbuildingItem = {
      ...data,
      id: generateEntityId('wb'),
      ownerId: currentUser?.uid || 'local_author',
      projectId: activeProject.id,
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    if (currentUser) {
      await createFirestoreWorldbuilding(currentUser.uid, activeProject.id, newItem);
    }

    updateBundlesAndPersist((prev) =>
      prev.map((b) =>
        b.project.id === activeProject.id
          ? { ...b, worldbuilding: [newItem, ...b.worldbuilding] }
          : b
      )
    );
    setSaveState('saved');
    setLastSavedAt(nowIso);
  };

  const handleUpdateWorldbuilding = async (item: WorldbuildingItem) => {
    if (!activeProject) return;
    setSaveState('saving');
    const nowIso = new Date().toISOString();
    const updatedItem = { ...item, updatedAt: nowIso };

    if (currentUser) {
      await updateFirestoreWorldbuilding(currentUser.uid, activeProject.id, updatedItem);
    }

    updateBundlesAndPersist((prev) =>
      prev.map((b) =>
        b.project.id === activeProject.id
          ? {
              ...b,
              worldbuilding: b.worldbuilding.map((w) =>
                w.id === updatedItem.id ? updatedItem : w
              ),
            }
          : b
      )
    );
    setSaveState('saved');
    setLastSavedAt(nowIso);
  };

  const handleDeleteWorldbuilding = async (itemId: string) => {
    if (!activeProject) return;
    setSaveState('saving');
    if (currentUser) {
      await deleteFirestoreWorldbuilding(currentUser.uid, activeProject.id, itemId);
    }

    void triggerRagApiInBackground('/api/rag/delete-entity', {
      projectId: activeProject.id,
      sourceEntityId: itemId,
      isEpisodeDelete: false,
    });

    updateBundlesAndPersist((prev) =>
      prev.map((b) =>
        b.project.id === activeProject.id
          ? {
              ...b,
              worldbuilding: b.worldbuilding.filter((w) => w.id !== itemId),
            }
          : b
      )
    );
    setSaveState('saved');
    setLastSavedAt(new Date().toISOString());
  };

  // ============================================================================
  // Phase 4.1: CharacterRelationship, TimelineEvent, Foreshadowing CRUD Handlers
  // ============================================================================

  const handleCreateRelationship = async (
    data: Omit<
      CharacterRelationship,
      'id' | 'ownerId' | 'projectId' | 'createdAt' | 'updatedAt'
    >
  ) => {
    if (!activeProject) return;
    setSaveState('saving');
    setErrorBanner(null);
    const nowIso = new Date().toISOString();
    const verifiedRevId = resolveVerifiedSourceRevisionId({
      candidateRevisionId: data.sourceRevisionId,
      projectRevisions: revisions,
      projectId: activeProject.id,
    });
    const newRel: CharacterRelationship = {
      ...data,
      id: generateEntityId('rel'),
      ownerId: currentUser?.uid || activeProject.ownerId || 'local_author',
      projectId: activeProject.id,
      canonStatus: 'DRAFT',
      createdBy: 'AUTHOR',
      sourceRevisionId: verifiedRevId,
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    try {
      if (currentUser) {
        await createFirestoreRelationship(currentUser.uid, activeProject.id, newRel);
      }
      updateBundlesAndPersist((prev) =>
        prev.map((b) =>
          b.project.id === activeProject.id
            ? { ...b, relationships: [newRel, ...(b.relationships || [])] }
            : b
        )
      );
      setSaveState('saved');
      setLastSavedAt(nowIso);
    } catch (err) {
      setSaveState('error');
      const msg =
        err instanceof Error ? err.message : '인물 관계 저장 중 오류가 발생했습니다.';
      setErrorBanner(msg);
      throw err;
    }
  };

  const handleUpdateRelationship = async (
    relationship: CharacterRelationship,
    currentCanonStatus: CanonStatus
  ) => {
    if (!activeProject) return;
    setSaveState('saving');
    setErrorBanner(null);
    const nowIso = new Date().toISOString();
    const storedOriginal = relationships.find((r) => r.id === relationship.id);
    const priorCanonStatus = storedOriginal?.canonStatus ?? currentCanonStatus;

    assertCanonProtection({
      actor: 'AUTHOR',
      operation: 'UPDATE',
      canonStatus: priorCanonStatus,
    });

    const verifiedRevId = resolveVerifiedSourceRevisionId({
      candidateRevisionId: relationship.sourceRevisionId,
      projectRevisions: revisions,
      projectId: activeProject.id,
      existingVerifiedRevisionId: storedOriginal?.sourceRevisionId,
    });

    const updatedRel: CharacterRelationship = {
      ...relationship,
      ownerId: currentUser?.uid || activeProject.ownerId || 'local_author',
      projectId: activeProject.id,
      sourceRevisionId: verifiedRevId,
      updatedAt: nowIso,
    };

    try {
      if (currentUser) {
        await updateFirestoreRelationship(
          currentUser.uid,
          activeProject.id,
          updatedRel,
          'AUTHOR',
          priorCanonStatus
        );
      }
      updateBundlesAndPersist((prev) =>
        prev.map((b) =>
          b.project.id === activeProject.id
            ? {
                ...b,
                relationships: (b.relationships || []).map((r) =>
                  r.id === updatedRel.id ? updatedRel : r
                ),
              }
            : b
        )
      );
      if (updatedRel.canonStatus === 'CANON' && !verifiedRevId) {
        setRagSyncSummary({
          status: 'SKIPPED_UNVERIFIED_SOURCE',
          message: '색인 미실행: 검증된 원고 리비전 출처 없음',
          updatedAt: nowIso,
        });
      }
      setSaveState('saved');
      setLastSavedAt(nowIso);
    } catch (err) {
      setSaveState('error');
      const msg =
        err instanceof Error ? err.message : '인물 관계 수정 중 오류가 발생했습니다.';
      setErrorBanner(msg);
      throw err;
    }
  };

  const handleDeleteRelationship = async (
    relationshipId: string,
    currentCanonStatus: CanonStatus
  ) => {
    if (!activeProject) return;
    setSaveState('saving');
    setErrorBanner(null);
    const storedOriginal = relationships.find((r) => r.id === relationshipId);
    const priorCanonStatus = storedOriginal?.canonStatus ?? currentCanonStatus;

    assertCanonProtection({
      actor: 'AUTHOR',
      operation: 'DELETE',
      canonStatus: priorCanonStatus,
    });

    try {
      if (currentUser) {
        await deleteFirestoreRelationship(
          currentUser.uid,
          activeProject.id,
          relationshipId,
          'AUTHOR',
          priorCanonStatus
        );
      }
      updateBundlesAndPersist((prev) =>
        prev.map((b) =>
          b.project.id === activeProject.id
            ? {
                ...b,
                relationships: (b.relationships || []).filter(
                  (r) => r.id !== relationshipId
                ),
              }
            : b
        )
      );
      setSaveState('saved');
      setLastSavedAt(new Date().toISOString());
    } catch (err) {
      setSaveState('error');
      const msg =
        err instanceof Error ? err.message : '인물 관계 삭제 중 오류가 발생했습니다.';
      setErrorBanner(msg);
      throw err;
    }
  };

  const handleCreateTimelineEvent = async (
    data: Omit<
      TimelineEvent,
      'id' | 'ownerId' | 'projectId' | 'createdAt' | 'updatedAt'
    >
  ) => {
    if (!activeProject) return;
    setSaveState('saving');
    setErrorBanner(null);
    const nowIso = new Date().toISOString();
    const verifiedRevId = resolveVerifiedSourceRevisionId({
      candidateRevisionId: data.sourceRevisionId,
      projectRevisions: revisions,
      projectId: activeProject.id,
    });
    const newEvt: TimelineEvent = {
      ...data,
      id: generateEntityId('evt'),
      ownerId: currentUser?.uid || activeProject.ownerId || 'local_author',
      projectId: activeProject.id,
      canonStatus: 'DRAFT',
      createdBy: 'AUTHOR',
      sourceRevisionId: verifiedRevId,
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    try {
      if (currentUser) {
        await createFirestoreTimelineEvent(currentUser.uid, activeProject.id, newEvt);
      }
      updateBundlesAndPersist((prev) =>
        prev.map((b) =>
          b.project.id === activeProject.id
            ? { ...b, timelineEvents: [newEvt, ...(b.timelineEvents || [])] }
            : b
        )
      );
      setSaveState('saved');
      setLastSavedAt(nowIso);
    } catch (err) {
      setSaveState('error');
      const msg =
        err instanceof Error ? err.message : '연표 사건 등록 중 오류가 발생했습니다.';
      setErrorBanner(msg);
      throw err;
    }
  };

  const handleUpdateTimelineEvent = async (
    event: TimelineEvent,
    currentCanonStatus: CanonStatus
  ) => {
    if (!activeProject) return;
    setSaveState('saving');
    setErrorBanner(null);
    const nowIso = new Date().toISOString();
    const storedOriginal = timelineEvents.find((e) => e.id === event.id);
    const priorCanonStatus = storedOriginal?.canonStatus ?? currentCanonStatus;

    assertCanonProtection({
      actor: 'AUTHOR',
      operation: 'UPDATE',
      canonStatus: priorCanonStatus,
    });

    const verifiedRevId = resolveVerifiedSourceRevisionId({
      candidateRevisionId: event.sourceRevisionId,
      projectRevisions: revisions,
      projectId: activeProject.id,
      existingVerifiedRevisionId: storedOriginal?.sourceRevisionId,
    });

    const updatedEvt: TimelineEvent = {
      ...event,
      ownerId: currentUser?.uid || activeProject.ownerId || 'local_author',
      projectId: activeProject.id,
      sourceRevisionId: verifiedRevId,
      updatedAt: nowIso,
    };

    try {
      if (currentUser) {
        await updateFirestoreTimelineEvent(
          currentUser.uid,
          activeProject.id,
          updatedEvt,
          'AUTHOR',
          priorCanonStatus
        );
      }
      updateBundlesAndPersist((prev) =>
        prev.map((b) =>
          b.project.id === activeProject.id
            ? {
                ...b,
                timelineEvents: (b.timelineEvents || []).map((e) =>
                  e.id === updatedEvt.id ? updatedEvt : e
                ),
              }
            : b
        )
      );
      if (updatedEvt.canonStatus === 'CANON') {
        const rawText = `${updatedEvt.title}\n작중 연대: ${updatedEvt.inUniverseDate}\n${updatedEvt.summary}`;
        const eligibility = evaluateRagAutoIndexEligibility({
          canonStatus: updatedEvt.canonStatus,
          sourceRevisionId: updatedEvt.sourceRevisionId,
          projectRevisions: revisions,
          projectId: activeProject.id,
          rawText,
        });

        if (eligibility.eligible) {
          void triggerRagApiInBackground('/api/rag/index-entity', {
            input: {
              projectId: activeProject.id,
              sourceEntityType: 'TIMELINE_EVENT',
              sourceEntityId: updatedEvt.id,
              sourceEpisodeId: updatedEvt.episodeId || undefined,
              sourceRevisionId: eligibility.verifiedRevisionId,
              canonStatus: 'CANON',
              title: `[연표 사건] ${updatedEvt.title}`,
              summary: updatedEvt.summary.slice(0, 380),
              rawText,
              relatedCharacterIds: updatedEvt.participantCharacterIds,
              relatedForeshadowingIds: updatedEvt.linkedForeshadowingIds,
              keywordTags: [updatedEvt.title, updatedEvt.inUniverseDate].filter(Boolean),
            },
          });
        } else if (eligibility.skipReason === 'UNVERIFIED_SOURCE_REVISION') {
          setRagSyncSummary({
            status: 'SKIPPED_UNVERIFIED_SOURCE',
            message: '색인 미실행: 검증된 원고 리비전 출처 없음',
            updatedAt: nowIso,
          });
        }
      }
      setSaveState('saved');
      setLastSavedAt(nowIso);
    } catch (err) {
      setSaveState('error');
      const msg =
        err instanceof Error ? err.message : '연표 사건 수정 중 오류가 발생했습니다.';
      setErrorBanner(msg);
      throw err;
    }
  };

  const handleDeleteTimelineEvent = async (
    eventId: string,
    currentCanonStatus: CanonStatus
  ) => {
    if (!activeProject) return;
    setSaveState('saving');
    setErrorBanner(null);
    const storedOriginal = timelineEvents.find((e) => e.id === eventId);
    const priorCanonStatus = storedOriginal?.canonStatus ?? currentCanonStatus;

    assertCanonProtection({
      actor: 'AUTHOR',
      operation: 'DELETE',
      canonStatus: priorCanonStatus,
    });

    try {
      if (currentUser) {
        await deleteFirestoreTimelineEvent(
          currentUser.uid,
          activeProject.id,
          eventId,
          'AUTHOR',
          priorCanonStatus
        );
      }
      void triggerRagApiInBackground('/api/rag/delete-entity', {
        projectId: activeProject.id,
        sourceEntityId: eventId,
        isEpisodeDelete: false,
      });
      updateBundlesAndPersist((prev) =>
        prev.map((b) =>
          b.project.id === activeProject.id
            ? {
                ...b,
                timelineEvents: (b.timelineEvents || []).filter(
                  (e) => e.id !== eventId
                ),
              }
            : b
        )
      );
      setSaveState('saved');
      setLastSavedAt(new Date().toISOString());
    } catch (err) {
      setSaveState('error');
      const msg =
        err instanceof Error ? err.message : '연표 사건 삭제 중 오류가 발생했습니다.';
      setErrorBanner(msg);
      throw err;
    }
  };

  const handleCreateForeshadowing = async (
    data: Omit<
      Foreshadowing,
      'id' | 'ownerId' | 'projectId' | 'createdAt' | 'updatedAt'
    >
  ) => {
    if (!activeProject) return;
    setSaveState('saving');
    setErrorBanner(null);
    const nowIso = new Date().toISOString();
    const verifiedRevId = resolveVerifiedSourceRevisionId({
      candidateRevisionId: data.sourceRevisionId,
      projectRevisions: revisions,
      projectId: activeProject.id,
    });
    const newFsh: Foreshadowing = {
      ...data,
      id: generateEntityId('fsh'),
      ownerId: currentUser?.uid || activeProject.ownerId || 'local_author',
      projectId: activeProject.id,
      canonStatus: 'DRAFT',
      createdBy: 'AUTHOR',
      sourceRevisionId: verifiedRevId,
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    try {
      if (currentUser) {
        await createFirestoreForeshadowing(currentUser.uid, activeProject.id, newFsh);
      }
      updateBundlesAndPersist((prev) =>
        prev.map((b) =>
          b.project.id === activeProject.id
            ? { ...b, foreshadowings: [newFsh, ...(b.foreshadowings || [])] }
            : b
        )
      );
      setSaveState('saved');
      setLastSavedAt(nowIso);
    } catch (err) {
      setSaveState('error');
      const msg =
        err instanceof Error ? err.message : '복선 등록 중 오류가 발생했습니다.';
      setErrorBanner(msg);
      throw err;
    }
  };

  const handleUpdateForeshadowing = async (
    foreshadowing: Foreshadowing,
    currentCanonStatus: CanonStatus
  ) => {
    if (!activeProject) return;
    setSaveState('saving');
    setErrorBanner(null);
    const nowIso = new Date().toISOString();
    const storedOriginal = foreshadowings.find((f) => f.id === foreshadowing.id);
    const priorCanonStatus = storedOriginal?.canonStatus ?? currentCanonStatus;

    assertCanonProtection({
      actor: 'AUTHOR',
      operation: 'UPDATE',
      canonStatus: priorCanonStatus,
    });

    const verifiedRevId = resolveVerifiedSourceRevisionId({
      candidateRevisionId: foreshadowing.sourceRevisionId,
      projectRevisions: revisions,
      projectId: activeProject.id,
      existingVerifiedRevisionId: storedOriginal?.sourceRevisionId,
    });

    const updatedFsh: Foreshadowing = {
      ...foreshadowing,
      ownerId: currentUser?.uid || activeProject.ownerId || 'local_author',
      projectId: activeProject.id,
      sourceRevisionId: verifiedRevId,
      updatedAt: nowIso,
    };

    try {
      if (currentUser) {
        await updateFirestoreForeshadowing(
          currentUser.uid,
          activeProject.id,
          updatedFsh,
          'AUTHOR',
          priorCanonStatus
        );
      }
      updateBundlesAndPersist((prev) =>
        prev.map((b) =>
          b.project.id === activeProject.id
            ? {
                ...b,
                foreshadowings: (b.foreshadowings || []).map((f) =>
                  f.id === updatedFsh.id ? updatedFsh : f
                ),
              }
            : b
        )
      );
      if (updatedFsh.canonStatus === 'CANON') {
        const rawText = `${updatedFsh.title}\n단계: ${updatedFsh.cluePhase}\n${updatedFsh.description}`;
        const eligibility = evaluateRagAutoIndexEligibility({
          canonStatus: updatedFsh.canonStatus,
          sourceRevisionId: updatedFsh.sourceRevisionId,
          projectRevisions: revisions,
          projectId: activeProject.id,
          rawText,
        });

        if (eligibility.eligible) {
          void triggerRagApiInBackground('/api/rag/index-entity', {
            input: {
              projectId: activeProject.id,
              sourceEntityType: 'FORESHADOWING',
              sourceEntityId: updatedFsh.id,
              sourceEpisodeId:
                updatedFsh.resolvedEpisodeId ||
                updatedFsh.plantedEpisodeId ||
                undefined,
              sourceRevisionId: eligibility.verifiedRevisionId,
              canonStatus: 'CANON',
              title: `[복선] ${updatedFsh.title}`,
              summary: updatedFsh.description.slice(0, 380),
              rawText,
              relatedCharacterIds: updatedFsh.relatedCharacterIds,
              relatedForeshadowingIds: [updatedFsh.id],
              keywordTags: [updatedFsh.title, updatedFsh.cluePhase].filter(Boolean),
            },
          });
        } else if (eligibility.skipReason === 'UNVERIFIED_SOURCE_REVISION') {
          setRagSyncSummary({
            status: 'SKIPPED_UNVERIFIED_SOURCE',
            message: '색인 미실행: 검증된 원고 리비전 출처 없음',
            updatedAt: nowIso,
          });
        }
      }
      setSaveState('saved');
      setLastSavedAt(nowIso);
    } catch (err) {
      setSaveState('error');
      const msg =
        err instanceof Error ? err.message : '복선 수정 중 오류가 발생했습니다.';
      setErrorBanner(msg);
      throw err;
    }
  };

  const handleDeleteForeshadowing = async (
    foreshadowingId: string,
    currentCanonStatus: CanonStatus
  ) => {
    if (!activeProject) return;
    setSaveState('saving');
    setErrorBanner(null);
    const storedOriginal = foreshadowings.find((f) => f.id === foreshadowingId);
    const priorCanonStatus = storedOriginal?.canonStatus ?? currentCanonStatus;

    assertCanonProtection({
      actor: 'AUTHOR',
      operation: 'DELETE',
      canonStatus: priorCanonStatus,
    });

    try {
      if (currentUser) {
        await deleteFirestoreForeshadowing(
          currentUser.uid,
          activeProject.id,
          foreshadowingId,
          'AUTHOR',
          priorCanonStatus
        );
      }
      void triggerRagApiInBackground('/api/rag/delete-entity', {
        projectId: activeProject.id,
        sourceEntityId: foreshadowingId,
        isEpisodeDelete: false,
      });
      updateBundlesAndPersist((prev) =>
        prev.map((b) =>
          b.project.id === activeProject.id
            ? {
                ...b,
                foreshadowings: (b.foreshadowings || []).filter(
                  (f) => f.id !== foreshadowingId
                ),
              }
            : b
        )
      );
      setSaveState('saved');
      setLastSavedAt(new Date().toISOString());
    } catch (err) {
      setSaveState('error');
      const msg =
        err instanceof Error ? err.message : '복선 삭제 중 오류가 발생했습니다.';
      setErrorBanner(msg);
      throw err;
    }
  };

  // ============================================================================
  // Import & Sync Handlers
  // ============================================================================

  const handleImportProjectBundle = async (importedBundle: ProjectBundle) => {
    setSaveState('saving');
    let finalBundle = importedBundle;

    if (currentUser) {
      finalBundle = await uploadProjectBundleToFirestore(currentUser.uid, importedBundle);
    }

    updateBundlesAndPersist((prev) => {
      const existsIdx = prev.findIndex((b) => b.project.id === finalBundle.project.id);
      if (existsIdx >= 0) {
        const copy = [...prev];
        copy[existsIdx] = finalBundle;
        return copy;
      }
      return [finalBundle, ...prev];
    });

    setActiveProjectId(finalBundle.project.id);
    setSelectedEpisodeId(finalBundle.episodes[0]?.id || null);
    setSaveState('saved');
    setLastSavedAt(new Date().toISOString());
  };

  const handleSyncCurrentToFirestore = async () => {
    if (!currentUser || !activeBundle) return;
    setSaveState('saving');
    await uploadProjectBundleToFirestore(currentUser.uid, activeBundle);
    setSaveState('saved');
    setLastSavedAt(new Date().toISOString());
  };

  // ============================================================================
  // Phase 2: PromptProfile, WritingPlan, and ChangeProposal Handlers
  // ============================================================================

  const handleCreatePromptProfile = async (profile: PromptProfile) => {
    if (!activeProject) return;
    setSaveState('saving');
    const nowIso = new Date().toISOString();
    const normalized: PromptProfile = {
      ...profile,
      ownerId: currentUser?.uid || activeProject.ownerId || 'local_author',
      projectId: activeProject.id,
      updatedAt: nowIso,
    };

    if (currentUser) {
      await createFirestorePromptProfile(currentUser.uid, activeProject.id, normalized);
    }

    updateBundlesAndPersist((prev) =>
      prev.map((b) => {
        if (b.project.id !== activeProject.id) return b;
        const currentList =
          b.writingPromptProfiles && b.writingPromptProfiles.length > 0
            ? b.writingPromptProfiles
            : createInitialPromptProfiles(
                b.project.ownerId,
                b.project.id,
                b.project.createdAt
              );
        return {
          ...b,
          writingPromptProfiles: [normalized, ...currentList],
        };
      })
    );
    setSaveState('saved');
    setLastSavedAt(nowIso);
  };

  const handleUpdatePromptProfile = async (
    profile: PromptProfile,
    options?: {
      expectedVersionId?: string;
      expectedVersionNumber?: number;
    }
  ): Promise<PromptProfileCasResult | void> => {
    if (!activeProject) return;
    setSaveState('saving');
    setErrorBanner(null);
    const nowIso = new Date().toISOString();
    const effectiveOwnerId =
      currentUser?.uid || activeProject.ownerId || 'local_author';
    const normalized: PromptProfile = {
      ...profile,
      ownerId: effectiveOwnerId,
      projectId: activeProject.id,
      updatedAt: nowIso,
    };

    const existingInState =
      promptProfiles.find((p) => p.id === normalized.id) || null;
    const expectedVersionId =
      options?.expectedVersionId ?? existingInState?.currentVersionId;
    const expectedVersionNumber =
      options?.expectedVersionNumber ?? existingInState?.currentVersionNumber;

    const casResult = currentUser
      ? await updateFirestorePromptProfileWithCas(
          currentUser.uid,
          activeProject.id,
          normalized,
          {
            expectedVersionId,
            expectedVersionNumber,
          }
        )
      : await updateLocalPromptProfileWithCas({
          uid: effectiveOwnerId,
          projectId: activeProject.id,
          nextProfile: normalized,
          existingProfiles: promptProfiles,
          expectedVersionId,
          expectedVersionNumber,
        });

    if (!casResult.committed) {
      setSaveState('error');
      const errMsg =
        casResult.errorMessage ||
        '프롬프트 프로필 버전 저장이 충돌 또는 검증 오류로 보류되었습니다.';
      setErrorBanner(errMsg);
      return casResult;
    }

    updateBundlesAndPersist((prev) =>
      prev.map((b) => {
        if (b.project.id !== activeProject.id) return b;
        const currentList =
          b.writingPromptProfiles && b.writingPromptProfiles.length > 0
            ? b.writingPromptProfiles
            : createInitialPromptProfiles(
                b.project.ownerId,
                b.project.id,
                b.project.createdAt
              );
        return {
          ...b,
          writingPromptProfiles: currentList.map((p) =>
            p.id === casResult.profile.id ? casResult.profile : p
          ),
        };
      })
    );
    setSaveState('saved');
    setLastSavedAt(nowIso);
    return casResult;
  };

  const handleReloadPromptProfile = async (
    profileId: string
  ): Promise<PromptProfile | null> => {
    if (!activeProject) return null;
    if (currentUser) {
      const remote = await fetchFirestorePromptProfileById(
        currentUser.uid,
        activeProject.id,
        profileId
      );
      if (remote) {
        updateBundlesAndPersist((prev) =>
          prev.map((b) => {
            if (b.project.id !== activeProject.id) return b;
            const currentList = b.writingPromptProfiles || [];
            const exists = currentList.some((p) => p.id === remote.id);
            return {
              ...b,
              writingPromptProfiles: exists
                ? currentList.map((p) => (p.id === remote.id ? remote : p))
                : [remote, ...currentList],
            };
          })
        );
        return remote;
      }
    }
    return promptProfiles.find((p) => p.id === profileId) || null;
  };

  const handleDeletePromptProfile = async (profileId: string) => {
    if (!activeProject) return;
    setSaveState('saving');
    if (currentUser) {
      await deleteFirestorePromptProfile(currentUser.uid, activeProject.id, profileId);
    }

    updateBundlesAndPersist((prev) =>
      prev.map((b) => {
        if (b.project.id !== activeProject.id) return b;
        const currentList = b.writingPromptProfiles || [];
        return {
          ...b,
          writingPromptProfiles: currentList.filter((p) => p.id !== profileId),
        };
      })
    );
    setSaveState('saved');
    setLastSavedAt(new Date().toISOString());
  };

  const handleApproveSaveStyleDNA = async (
    payload: StyleApprovalPayload
  ): Promise<StyleProfileApplicationResult> => {
    if (!activeProject) {
      throw new Error('활성화된 작품이 없습니다.');
    }
    setSaveState('saving');
    setErrorBanner(null);
    const nowIso = new Date().toISOString();
    const effectiveOwnerId =
      currentUser?.uid || activeProject.ownerId || 'local_author';

    const normalizedPayload: StyleApprovalPayload = {
      ...payload,
      ownerId: effectiveOwnerId,
      projectId: activeProject.id,
      allowAutoBranchOnConflict: false,
    };

    const result = currentUser
      ? await persistApprovedStyleDnaAtomicallyFirestore(
          currentUser.uid,
          activeProject.id,
          normalizedPayload,
          { nowIso }
        )
      : await persistApprovedStyleDnaAtomicallyLocal({
          uid: effectiveOwnerId,
          projectId: activeProject.id,
          payload: normalizedPayload,
          existingStyleProfiles: styleProfiles,
          existingPromptProfiles: promptProfiles,
          options: { nowIso },
        });

    // CRITICAL Stage 1.1 Invariant:
    // NEVER mutate committed state or report saved unless BOTH StyleProfile & PromptProfile
    // committed atomically (result.approved === true && result.persistenceStatus === 'COMMITTED').
    if (!result.approved || result.persistenceStatus !== 'COMMITTED') {
      setSaveState('error');
      const msg =
        result.errorMessage ||
        result.partialFailureWarning ||
        '문체 프로필 원자적 저장이 보류 또는 실패하여 기존 데이터를 보존했습니다.';
      setErrorBanner(msg);
      return result;
    }

    updateBundlesAndPersist((prev) =>
      prev.map((b) => {
        if (b.project.id !== activeProject.id) return b;
        const existingStyles = b.styleProfiles || [];
        const hasStyle = existingStyles.some(
          (s) => s.id === result.styleProfile.id
        );
        const nextStyleProfiles = hasStyle
          ? existingStyles.map((s) =>
              s.id === result.styleProfile.id ? result.styleProfile : s
            )
          : [result.styleProfile, ...existingStyles];

        const basePrompts =
          b.writingPromptProfiles && b.writingPromptProfiles.length > 0
            ? b.writingPromptProfiles
            : createInitialPromptProfiles(
                b.project.ownerId,
                b.project.id,
                b.project.createdAt
              );
        const hasPrompt = basePrompts.some(
          (p) => p.id === result.promptProfile.id
        );
        const nextPromptProfiles = hasPrompt
          ? basePrompts.map((p) =>
              p.id === result.promptProfile.id ? result.promptProfile : p
            )
          : [result.promptProfile, ...basePrompts];

        return {
          ...b,
          styleProfiles: nextStyleProfiles,
          writingPromptProfiles: nextPromptProfiles,
        };
      })
    );

    setSaveState('saved');
    setLastSavedAt(nowIso);
    return result;
  };

  const handleSaveWritingPlan = async (plan: WritingPlan) => {
    if (!activeProject) return;
    setSaveState('saving');
    const nowIso = new Date().toISOString();
    const normalized: WritingPlan = {
      ...plan,
      ownerId: currentUser?.uid || activeProject.ownerId || 'local_author',
      projectId: activeProject.id,
      updatedAt: nowIso,
    };

    const existsAlready = writingPlans.some((p) => p.id === normalized.id);
    if (currentUser) {
      if (existsAlready) {
        await updateFirestoreWritingPlan(currentUser.uid, activeProject.id, normalized);
      } else {
        await createFirestoreWritingPlan(currentUser.uid, activeProject.id, normalized);
      }
    }

    updateBundlesAndPersist((prev) =>
      prev.map((b) => {
        if (b.project.id !== activeProject.id) return b;
        const existingPlans = b.writingPlans || [];
        const hasId = existingPlans.some((p) => p.id === normalized.id);
        const nextPlans = hasId
          ? existingPlans.map((p) => (p.id === normalized.id ? normalized : p))
          : [normalized, ...existingPlans];
        return {
          ...b,
          writingPlans: nextPlans,
        };
      })
    );
    setSaveState('saved');
    setLastSavedAt(nowIso);
  };

  const handleSaveChangeProposals = async (
    proposals: ChangeProposal[],
    options?: PersistChangeProposalsOptions
  ): Promise<PersistChangeProposalsResult> => {
    if (!activeProject || proposals.length === 0) {
      return {
        attemptedCount: 0,
        createdCount: 0,
        skippedDuplicateCount: 0,
        failedCount: 0,
        failedProposals: [],
        itemResults: [],
      };
    }
    setSaveState('saving');
    const nowIso = new Date().toISOString();
    const ownerId = currentUser?.uid || activeProject.ownerId || 'local_author';
    const existingList = activeBundle?.changeProposals || [];
    const existingMap = new Map(existingList.map((p) => [p.id, p]));

    const normalizedProposals = proposals.map((prop) => {
      const explicitOwner = (prop.ownerId || '').trim();
      const preservedOwnerId =
        explicitOwner && explicitOwner !== 'local_author'
          ? explicitOwner
          : ownerId;
      const explicitProjectId = (prop.projectId || '').trim();
      const preservedProjectId = explicitProjectId || activeProject.id;
      return {
        ...prop,
        ownerId: preservedOwnerId,
        projectId: preservedProjectId,
        canonStatus: prop.canonStatus || ('PROPOSED' as const),
        updatedAt: nowIso,
      };
    });

    let persistResult: PersistChangeProposalsResult;

    if (currentUser) {
      persistResult = await persistFirestoreChangeProposalsIdempotently(
        currentUser.uid,
        activeProject.id,
        normalizedProposals,
        undefined,
        options
      );
    } else {
      const localRevisionMap = new Map<string, Revision>();
      for (const rev of activeBundle?.revisions || []) {
        localRevisionMap.set(rev.id, rev);
      }
      try {
        const persistedBundle = loadLocalBundles(ownerId).find(
          (b) => b.project.id === activeProject.id
        );
        for (const rev of persistedBundle?.revisions || []) {
          localRevisionMap.set(rev.id, rev);
        }
      } catch {
        // Fallback to in-memory activeBundle revisions if storage read fails
      }

      persistResult = await persistChangeProposalsIdempotentlyCore(
        normalizedProposals,
        {
          getExistingProposalStatus: async (proposalId) => {
            const found = existingMap.get(proposalId);
            if (!found) {
              return {
                exists: false,
                lookupStatus: 'DOCUMENT_NOT_FOUND',
              };
            }
            const decided =
              found.canonStatus !== 'PROPOSED' &&
              found.canonStatus !== 'DRAFT';
            return {
              exists: true,
              lookupStatus: decided
                ? 'DOCUMENT_EXISTS_DECIDED'
                : 'DOCUMENT_EXISTS_PROPOSED',
              canonStatus: found.canonStatus,
              existingProposal: found,
            };
          },
          verifySourceRevision: async (proposal, opts) => {
            const sourceRevId = (proposal.sourceRevisionId || '').trim();
            const expectedEp = (
              opts?.expectedEpisodeId ?? proposal.triggerEpisodeId
            ).trim();
            if (!sourceRevId || sourceRevId === 'UNSAVED_DRAFT') {
              return {
                valid: false,
                lookupStatus: 'SOURCE_REVISION_UNVERIFIED',
                errorCode: 'SOURCE_REVISION_UNVERIFIED',
                errorMessage: `[SOURCE_REVISION_UNVERIFIED] 유효한 sourceRevisionId가 없어 제안서(${proposal.id}) 저장을 거부했습니다.`,
              };
            }
            if (!expectedEp) {
              return {
                valid: false,
                lookupStatus: 'SOURCE_REVISION_UNVERIFIED',
                errorCode: 'SOURCE_REVISION_UNVERIFIED',
                errorMessage: `[SOURCE_REVISION_UNVERIFIED] 회차 정보(episodeId)가 누락되어 리비전(${sourceRevId}) 출처를 검증할 수 없습니다.`,
              };
            }
            if (sourceRevId === expectedEp) {
              return {
                valid: false,
                lookupStatus: 'SOURCE_REVISION_UNVERIFIED',
                errorCode: 'SOURCE_REVISION_UNVERIFIED',
                errorMessage: `[SOURCE_REVISION_UNVERIFIED] episodeId(${expectedEp})를 sourceRevisionId로 사용할 수 없습니다.`,
              };
            }
            if (
              opts?.expectedSourceRevisionId &&
              sourceRevId !== opts.expectedSourceRevisionId.trim()
            ) {
              return {
                valid: false,
                lookupStatus: 'SOURCE_REVISION_MISMATCH',
                errorCode: 'SOURCE_REVISION_MISMATCH',
                errorMessage: `[SOURCE_REVISION_MISMATCH] 제안서의 sourceRevisionId('${sourceRevId}')가 기대 리비전('${opts.expectedSourceRevisionId}')과 일치하지 않습니다.`,
              };
            }
            const foundRev = localRevisionMap.get(sourceRevId);
            const expectedHash = (
              opts?.expectedContentHashByRevisionId?.[sourceRevId] ||
              opts?.expectedSourceContentHash ||
              ''
            ).trim();
            return verifyPersistedRevisionSnapshot({
              exists: Boolean(foundRev),
              revisionData: foundRev ?? null,
              revisionDocId: sourceRevId,
              expectedOwnerId: ownerId,
              expectedProjectId: activeProject.id,
              expectedEpisodeId: expectedEp,
              expectedContentHash: expectedHash,
            });
          },
          createProposal: async (prop) => {
            const check = normalizeAndValidateChangeProposalPayload(
              ownerId,
              activeProject.id,
              prop
            );
            if (!check.ok) {
              throw new Error(
                (check as { ok: false; errorMessage: string }).errorMessage
              );
            }
          },
        },
        options
      );
    }

    const createdIds = new Set(
      persistResult.itemResults
        .filter((r) => r.status === 'CREATED')
        .map((r) => r.proposalId)
    );
    const createdProposals = normalizedProposals
      .filter((p) => createdIds.has(p.id))
      .map((p) => ({
        ...p,
        canonStatus: 'PROPOSED' as const,
      }));

    if (createdProposals.length > 0) {
      updateBundlesAndPersist((prev) =>
        prev.map((b) => {
          if (b.project.id !== activeProject.id) return b;
          const existing = b.changeProposals || [];
          const existingIds = new Set(existing.map((p) => p.id));
          const strictlyNew = createdProposals.filter(
            (p) => !existingIds.has(p.id)
          );
          return {
            ...b,
            changeProposals: [...strictlyNew, ...existing],
          };
        })
      );
    }

    if (persistResult.failedCount > 0) {
      const errSummary = formatProposalPersistenceErrorSummaryKo(
        persistResult.itemResults
      );
      if (errSummary) {
        setErrorBanner(errSummary);
      }
      setSaveState('error');
    } else {
      setSaveState('saved');
    }
    setLastSavedAt(nowIso);
    return persistResult;
  };

  const handleOpenProposalReview = useCallback((proposalId?: string) => {
    if (proposalId) {
      setSelectedProposalForReviewId(proposalId);
    }
    setActiveTab('proposal_review');
    setMobileNavOpen(false);
  }, []);

  const handleRefreshApprovalWorkspaceData = useCallback(async () => {
    if (!activeProject || !currentUser) return;
    const [foundation, phase2, audits] = await Promise.all([
      fetchFirestoreFoundationCollections(currentUser.uid, activeProject.id),
      fetchFirestorePhase2Collections(currentUser.uid, activeProject.id),
      fetchFirestoreApprovalAudits(currentUser.uid, activeProject.id),
    ]);
    const mergedProposalsMap = new Map<string, ChangeProposal>();
    for (const cp of foundation.changeProposals) {
      mergedProposalsMap.set(cp.id, cp);
    }
    for (const cp of phase2.changeProposals) {
      mergedProposalsMap.set(cp.id, cp);
    }
    updateBundlesAndPersist((prev) =>
      prev.map((b) =>
        b.project.id === activeProject.id
          ? {
              ...b,
              scenes: foundation.scenes,
              relationships: foundation.relationships,
              timelineEvents: foundation.timelineEvents,
              foreshadowings: foundation.foreshadowings,
              changeProposals: Array.from(mergedProposalsMap.values()),
              approvalAudits: audits,
            }
          : b
      )
    );
  }, [activeProject, currentUser, updateBundlesAndPersist]);

  const handleRetryRagSyncFromWorkspace = useCallback(
    async (proposalId: string): Promise<{
      ok: boolean;
      ragSyncStatus:
        | 'PENDING'
        | 'PROCESSING'
        | 'SYNCED'
        | 'FAILED'
        | 'SUPERSEDED'
        | 'NOT_REQUIRED';
      skippedReason?: string | null;
      retryAfterMs?: number | null;
      documentId?: string | null;
      message: string;
    }> => {
      if (!activeProject) {
        return {
          ok: false,
          ragSyncStatus: 'FAILED',
          message: '선택된 작품이 없습니다.',
        };
      }
      const token = await getIdToken();
      if (!currentUser || !token) {
        // Section 4: Never mark local ragSyncStatus as SYNCED without verified server indexing
        return {
          ok: false,
          ragSyncStatus: 'FAILED',
          skippedReason: 'CLOUD_AUTH_REQUIRED',
          message:
            '클라우드 인증(로그인)을 확인할 수 없어 서버 영구 RAG 색인을 실행하지 못했습니다. 로컬 미리보기에서는 RAG 동기화 완료(SYNCED)로 전환되지 않습니다.',
        };
      }

      try {
        const res = await fetch('/api/ai/change-proposals/sync-rag', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            projectId: activeProject.id,
            proposalId,
            forceRetry: true,
            manualRetry: true,
          }),
        });
        const data = await res.json().catch(() => ({}));
        await handleRefreshApprovalWorkspaceData().catch(() => undefined);

        const isVerifiedSynced =
          res.ok &&
          data?.ok === true &&
          data?.ragSyncStatus === 'SYNCED' &&
          Boolean(data?.documentId);

        if (isVerifiedSynced) {
          return {
            ok: true,
            ragSyncStatus: 'SYNCED',
            documentId: data.documentId,
            message: `RAG 장기 기억 영구 색인이 완료되었습니다 (문서 ID: ${data.documentId}).`,
          };
        }

        const skippedReason: string | null = data?.skippedReason || null;
        const retryAfterMs: number | null =
          typeof data?.retryAfterMs === 'number' ? data.retryAfterMs : null;
        const resolvedStatus:
          | 'PENDING'
          | 'PROCESSING'
          | 'SYNCED'
          | 'FAILED'
          | 'SUPERSEDED'
          | 'NOT_REQUIRED' =
          data?.ragSyncStatus === 'PROCESSING'
            ? 'PROCESSING'
            : data?.ragSyncStatus === 'PENDING'
              ? 'PENDING'
              : data?.ragSyncStatus === 'SUPERSEDED'
                ? 'SUPERSEDED'
                : data?.ragSyncStatus === 'NOT_REQUIRED'
                  ? 'NOT_REQUIRED'
                  : 'FAILED';

        let reasonMessage =
          data?.error || 'RAG 장기 기억 색인이 완료되지 않았습니다.';
        if (skippedReason === 'LEASE_ACTIVE') {
          reasonMessage =
            '다른 워커에서 현재 RAG 색인 작업(PROCESSING)을 수행 중입니다. 잠시 후 상태를 새로고침해 주세요.';
        } else if (skippedReason === 'BACKOFF_WAITING') {
          const waitSec = retryAfterMs
            ? Math.max(1, Math.ceil(retryAfterMs / 1000))
            : 5;
          reasonMessage = `재시도 대기 시간(Exponential Backoff)이 남아 있습니다. 약 ${waitSec}초 후에 다시 시도해 주세요.`;
        } else if (skippedReason === 'MAX_ATTEMPTS_EXCEEDED') {
          reasonMessage =
            '최대 재시도 횟수(maxAttempts)를 초과하여 자동/수동 재시도가 차단되었습니다.';
        } else if (skippedReason === 'SUPERSEDED_BY_NEWER_CANON') {
          reasonMessage =
            '더 최신 CANON 설정 버전이 이미 존재하여 구버전 색인 작업이 안전하게 건너뛰어졌습니다.';
        }

        return {
          ok: false,
          ragSyncStatus: resolvedStatus,
          skippedReason,
          retryAfterMs,
          documentId: null,
          message: reasonMessage,
        };
      } catch (err) {
        return {
          ok: false,
          ragSyncStatus: 'FAILED',
          message:
            err instanceof Error
              ? `RAG 동기화 요청 실패: ${err.message}`
              : 'RAG 동기화 통신 중 오류가 발생했습니다.',
        };
      }
    },
    [
      activeProject,
      currentUser,
      getIdToken,
      handleRefreshApprovalWorkspaceData,
    ]
  );

  const handleApproveProposalFromWorkspace = useCallback(
    async (params: {
      proposal: ChangeProposal;
      reviewNote?: string;
      expectedUpdatedAt?: string | null;
    }): Promise<ApprovalExecutionOutcome> => {
      if (!activeProject) {
        return {
          ok: false,
          canonCommitted: false,
          message: '선택된 작품이 없습니다.',
        };
      }

      const { proposal, reviewNote, expectedUpdatedAt } = params;
      const token = await getIdToken();

      // Section 3: Logged-in user with missing/expired token MUST fail-closed (never fallback to local)
      if (currentUser && !token) {
        return {
          ok: false,
          canonCommitted: false,
          errorCode: 'CLOUD_AUTH_REQUIRED',
          message:
            '클라우드 인증 토큰을 확인할 수 없어 CANON 승인을 진행하지 않았습니다. 다시 로그인하거나 인증을 갱신해 주세요.',
        };
      }

      if (!isSupportedApprovalEntityType(proposal.targetEntityType)) {
        await handleUpdateChangeProposalStatus(proposal, 'CANON');
        return {
          ok: true,
          canonCommitted: true,
          ragSyncStatus: 'NOT_REQUIRED',
          message: `'${proposal.title}' 제안서가 CANON으로 반영되었습니다.`,
        };
      }

      // Section 3: Unauthenticated local preview mode MUST NOT commit local CANON or fake audit for transactional entities
      if (!currentUser || !token) {
        return {
          ok: false,
          canonCommitted: false,
          errorCode: 'CLOUD_AUTH_REQUIRED',
          message:
            '관계·연표·복선 제안의 원자적 CANON 승인은 클라우드 인증(로그인) 상태에서만 실행할 수 있습니다. 로컬 미리보기에서는 변경 전후 Diff만 확인할 수 있습니다.',
        };
      }

      let approveData: Record<string, unknown> = {};
      try {
        const res = await fetch('/api/ai/change-proposals/approve', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            projectId: activeProject.id,
            proposalId: proposal.id,
            reviewNote,
            expectedUpdatedAt: expectedUpdatedAt ?? null,
          }),
        });
        approveData = (await res.json().catch(() => ({}))) as Record<
          string,
          unknown
        >;
        if (!res.ok || !approveData.ok) {
          const isAuthError = res.status === 401 || res.status === 403;
          return {
            ok: false,
            canonCommitted: false,
            errorCode: isAuthError
              ? 'CLOUD_AUTH_REQUIRED'
              : (approveData.errorCode as string) || 'APPROVAL_FAILED',
            message:
              (approveData.errorMessage as string) ||
              (approveData.error as string) ||
              '서버 원자적 CANON 승인 트랜잭션이 거부되었습니다.',
          };
        }
      } catch (err) {
        return {
          ok: false,
          canonCommitted: false,
          errorCode: 'CLOUD_AUTH_REQUIRED',
          message:
            err instanceof Error
              ? `서버 CANON 승인 통신 실패: ${err.message}`
              : '서버 CANON 승인 요청 중 네트워크 오류가 발생했습니다.',
        };
      }

      // Trigger post-commit RAG synchronization outside the approval transaction
      // Section 4 & 9: Only mark SYNCED if server persistent indexing returned ok + SYNCED + documentId
      let ragSyncStatus:
        | 'PENDING'
        | 'PROCESSING'
        | 'SYNCED'
        | 'FAILED'
        | 'SUPERSEDED'
        | 'NOT_REQUIRED' = 'PENDING';
      let ragSyncError: string | undefined;
      try {
        const ragRes = await fetch('/api/ai/change-proposals/sync-rag', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            projectId: activeProject.id,
            proposalId: proposal.id,
          }),
        });
        const ragData = await ragRes.json().catch(() => ({}));
        if (
          ragRes.ok &&
          ragData?.ok === true &&
          ragData?.ragSyncStatus === 'SYNCED' &&
          Boolean(ragData?.documentId)
        ) {
          ragSyncStatus = 'SYNCED';
        } else if (
          ragData?.ragSyncStatus === 'PROCESSING' ||
          ragData?.ragSyncStatus === 'PENDING' ||
          ragData?.ragSyncStatus === 'SUPERSEDED' ||
          ragData?.ragSyncStatus === 'NOT_REQUIRED'
        ) {
          ragSyncStatus = ragData.ragSyncStatus;
          if (ragData?.error) {
            ragSyncError = String(ragData.error);
          }
        } else {
          ragSyncStatus = 'FAILED';
          ragSyncError =
            typeof ragData?.error === 'string'
              ? ragData.error
              : 'RAG 장기 기억 색인이 완료되지 않았습니다.';
        }
      } catch (ragErr) {
        ragSyncStatus = 'FAILED';
        ragSyncError =
          ragErr instanceof Error
            ? ragErr.message
            : 'RAG 장기 기억 동기화 통신 실패';
      }

      // Post-approval state refresh (Section 13: separate CANON commit success from UI refresh failure)
      try {
        await handleRefreshApprovalWorkspaceData();
        setSaveState('saved');
        setLastSavedAt(new Date().toISOString());
        return {
          ok: true,
          canonCommitted: true,
          uiRefreshFailed: false,
          ragSyncStatus,
          ragSyncError,
          message:
            ragSyncStatus === 'SYNCED'
              ? `'${proposal.title}' 제안서가 서버 트랜잭션을 통해 CANON 설정 및 RAG 장기 기억에 반영되었습니다.`
              : `'${proposal.title}' 제안서가 서버 트랜잭션을 통해 CANON 설정으로 원자적 반영되었습니다 (RAG 상태: ${ragSyncStatus}).`,
        };
      } catch (refreshErr) {
        return {
          ok: true,
          canonCommitted: true,
          uiRefreshFailed: true,
          ragSyncStatus,
          ragSyncError,
          message: `서버에서 CANON 승인은 완료되었으나 화면 최신화에 실패했습니다 (${
            refreshErr instanceof Error ? refreshErr.message : '통신 오류'
          }). 상단 [최신 상태 동기화] 버튼을 눌러 다시 불러와 주세요.`,
        };
      }
    },
    [
      activeProject,
      currentUser,
      getIdToken,
      handleRefreshApprovalWorkspaceData,
    ]
  );

  const handleRejectProposalFromWorkspace = useCallback(
    async (params: {
      proposal: ChangeProposal;
      reviewNote?: string;
    }): Promise<ApprovalExecutionOutcome> => {
      if (!activeProject) {
        return {
          ok: false,
          canonCommitted: false,
          message: '선택된 작품이 없습니다.',
        };
      }

      const { proposal, reviewNote } = params;
      const token = await getIdToken();

      // Section 3: Logged-in user with missing/expired token MUST fail-closed (never fallback to local)
      if (currentUser && !token) {
        return {
          ok: false,
          canonCommitted: false,
          errorCode: 'CLOUD_AUTH_REQUIRED',
          message:
            '클라우드 인증 토큰을 확인할 수 없어 제안 거절을 진행하지 않았습니다. 다시 로그인하거나 인증을 갱신해 주세요.',
        };
      }

      if (!isSupportedApprovalEntityType(proposal.targetEntityType)) {
        await handleUpdateChangeProposalStatus(proposal, 'REJECTED');
        return {
          ok: true,
          canonCommitted: false,
          ragSyncStatus: 'NOT_REQUIRED',
          message: `'${proposal.title}' 제안서가 거절 처리되었습니다.`,
        };
      }

      // Section 3: Unauthenticated local preview mode MUST NOT execute local rejection for server-transactional entities
      if (!currentUser || !token) {
        return {
          ok: false,
          canonCommitted: false,
          errorCode: 'CLOUD_AUTH_REQUIRED',
          message:
            '관계·연표·복선 제안의 거절 및 감사 이력 기록은 클라우드 인증(로그인) 상태에서만 실행할 수 있습니다.',
        };
      }

      try {
        const res = await fetch('/api/ai/change-proposals/reject', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            projectId: activeProject.id,
            proposalId: proposal.id,
            reviewNote,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) {
          const isAuthError = res.status === 401 || res.status === 403;
          return {
            ok: false,
            canonCommitted: false,
            errorCode: isAuthError
              ? 'CLOUD_AUTH_REQUIRED'
              : data.errorCode || 'REJECTION_FAILED',
            message:
              data.errorMessage ||
              data.error ||
              '서버 제안서 거절 요청이 실패했습니다.',
          };
        }
      } catch (err) {
        return {
          ok: false,
          canonCommitted: false,
          errorCode: 'CLOUD_AUTH_REQUIRED',
          message:
            err instanceof Error
              ? `서버 제안서 거절 통신 실패: ${err.message}`
              : '서버 제안서 거절 요청 중 네트워크 오류가 발생했습니다.',
        };
      }

      try {
        await handleRefreshApprovalWorkspaceData();
        setSaveState('saved');
        setLastSavedAt(new Date().toISOString());
        return {
          ok: true,
          canonCommitted: false,
          uiRefreshFailed: false,
          ragSyncStatus: 'NOT_REQUIRED',
          message: `'${proposal.title}' 제안서가 거절(REJECTED) 처리되었으며, 실제 CANON 엔티티는 변경되지 않았습니다.`,
        };
      } catch (refreshErr) {
        return {
          ok: true,
          canonCommitted: false,
          uiRefreshFailed: true,
          ragSyncStatus: 'NOT_REQUIRED',
          message: `서버에서 거절 처리는 완료되었으나 화면 최신화에 실패했습니다 (${
            refreshErr instanceof Error ? refreshErr.message : '통신 오류'
          }).`,
        };
      }
    },
    [
      activeProject,
      currentUser,
      getIdToken,
      handleRefreshApprovalWorkspaceData,
    ]
  );

  const handleUpdateChangeProposalStatus = async (
    proposal: ChangeProposal,
    nextStatus: 'CANON' | 'REJECTED'
  ) => {
    if (!activeProject) return;

    // Phase 4.2.2 Stage 2: Route RELATIONSHIP / TIMELINE_EVENT / FORESHADOWING proposals
    // directly to the Author Approval Workspace so the author reviews the structured diff first.
    if (
      (nextStatus === 'CANON' || nextStatus === 'REJECTED') &&
      (proposal.targetEntityType === 'RELATIONSHIP' ||
        proposal.targetEntityType === 'TIMELINE_EVENT' ||
        proposal.targetEntityType === 'FORESHADOWING')
    ) {
      handleOpenProposalReview(proposal.id);
      return;
    }

    setSaveState('saving');
    const nowIso = new Date().toISOString();
    const updatedProposal: ChangeProposal = {
      ...proposal,
      canonStatus: nextStatus,
      reviewedAt: nowIso,
      updatedAt: nowIso,
    };

    if (currentUser) {
      await updateFirestoreChangeProposal(currentUser.uid, activeProject.id, updatedProposal);
    }

    // If approved to CANON by the author, apply the proposed change to Character or Worldbuilding
    if (nextStatus === 'CANON') {
      let parsedPayload: Record<string, unknown> = {};
      try {
        parsedPayload = JSON.parse(proposal.proposedPayloadJson || '{}');
      } catch {
        parsedPayload = {};
      }
      const proposedName = String(parsedPayload.name || proposal.title || '신규 확정 설정');

      if (proposal.targetEntityType === 'CHARACTER') {
        const existingChar = characters.find(
          (c) => c.id === proposal.targetEntityId || c.name === proposedName
        );
        if (existingChar) {
          await handleUpdateCharacter({
            ...existingChar,
            background: `${existingChar.background}\n[제${
              episodes.find((e) => e.id === proposal.triggerEpisodeId)?.episodeNumber || ''
            }화 갱신] ${proposal.afterSummary}`.trim(),
            status: 'confirmed',
          });
        } else {
          await handleCreateCharacter({
            name: proposedName,
            role: '조연 / 신규 등장인물',
            affiliation: '미정',
            appearance: '',
            personality: '',
            background: proposal.afterSummary,
            abilities: '',
            status: 'confirmed',
            linkedEpisodeIds: proposal.triggerEpisodeId ? [proposal.triggerEpisodeId] : [],
            linkedWorldbuildingIds: [],
          });
        }
      } else if (proposal.targetEntityType === 'WORLDBUILDING') {
        const existingWb = worldbuilding.find(
          (w) => w.id === proposal.targetEntityId || w.title === proposedName
        );
        if (existingWb) {
          await handleUpdateWorldbuilding({
            ...existingWb,
            content: `${existingWb.content}\n[확정 반영] ${proposal.afterSummary}`.trim(),
            status: 'confirmed',
          });
        } else {
          await handleCreateWorldbuilding({
            title: proposedName,
            category: '법칙/설정',
            summary: proposal.rationale || proposal.afterSummary.slice(0, 120),
            content: proposal.afterSummary,
            rules: proposal.afterSummary,
            status: 'confirmed',
            linkedCharacterIds: [],
            linkedEpisodeIds: proposal.triggerEpisodeId ? [proposal.triggerEpisodeId] : [],
          });
        }
      }
    }

    updateBundlesAndPersist((prev) =>
      prev.map((b) => {
        if (b.project.id !== activeProject.id) return b;
        return {
          ...b,
          changeProposals: (b.changeProposals || []).map((c) =>
            c.id === updatedProposal.id ? updatedProposal : c
          ),
        };
      })
    );
    setSaveState('saved');
    setLastSavedAt(nowIso);
  };

  const handleReceiveServerSavedExtractionProposals = (
    proposals: ChangeProposal[]
  ) => {
    if (!activeProject || proposals.length === 0) return;
    const nowIso = new Date().toISOString();
    const ownerId = currentUser?.uid || activeProject.ownerId || 'local_author';
    const normalizedProposals = proposals.map((prop) => ({
      ...prop,
      ownerId,
      projectId: activeProject.id,
      canonStatus: 'PROPOSED' as const,
      updatedAt: prop.updatedAt || nowIso,
    }));

    updateBundlesAndPersist((prev) =>
      prev.map((b) => {
        if (b.project.id !== activeProject.id) return b;
        const existing = b.changeProposals || [];
        const incomingIds = new Set(normalizedProposals.map((p) => p.id));
        const filteredExisting = existing.filter((p) => !incomingIds.has(p.id));
        return {
          ...b,
          changeProposals: [...normalizedProposals, ...filteredExisting],
        };
      })
    );
    setSaveState('saved');
    setLastSavedAt(nowIso);
  };

  const handleNavigate = (tab: NavTab, targetEpisodeId?: string) => {
    setVoiceRewriteSelection(null);
    if (targetEpisodeId) {
      setSelectedEpisodeId(targetEpisodeId);
    }
    setActiveTab(tab);
    setMobileNavOpen(false);
  };

  const handleSaveCharacterVoice = async (next: PromptProfile, base: PromptProfile | null, sources: VoiceSourceReference[] = []) => {
    const ownerId = currentUser?.uid || activeProject?.ownerId;
    if (!ownerId || next.ownerId !== ownerId || next.projectId !== activeProject?.id ||
        !characters.some((entry) => entry.id === next.targetCharacterId && entry.ownerId === ownerId && entry.projectId === next.projectId)) {
      throw new Error('현재 작품에서 화법을 저장할 인물을 확인할 수 없습니다.');
    }
    const applyProfile = (bundle: ProjectBundle, committed: PromptProfile) => {
      if (bundle.project.id !== committed.projectId || bundle.project.ownerId !== committed.ownerId) return bundle;
      const profiles = bundle.writingPromptProfiles?.length ? bundle.writingPromptProfiles : promptProfiles;
      const existing = profiles.find((profile) => profile.id === committed.id);
      if (existing && existing.currentVersionNumber > committed.currentVersionNumber) return bundle;
      return { ...bundle, writingPromptProfiles: existing ? profiles.map((profile) => profile.id === committed.id ? committed : profile) : [...profiles, committed] };
    };
    const saveLocalVoice = async () => {
      const snapshot = loadLocalBundles(ownerId);
      const bundle = snapshot.find((entry) => entry.project.id === next.projectId && entry.project.ownerId === ownerId);
      if (!bundle) throw new Error('로컬 저장소에서 현재 작품을 찾을 수 없습니다.');
      for (const source of sources) {
        if (!source.revisionId) continue;
        const revision = bundle.revisions.find((entry) => entry.id === source.revisionId && entry.episodeId === source.episodeId);
        const episode = bundle.episodes.find((entry) => entry.id === source.episodeId);
        if (!revision || !episode || (episode.latestRevisionId || undefined) !== (source.latestRevisionId || undefined) ||
            computeManuscriptContentHash(revision.content) !== source.contentHash) throw new Error('STALE_SOURCE: 출처를 다시 분석해 주세요.');
      }
      return saveCharacterVoicePromptCore({
        next, base, storageMode: 'LOCAL_STORE',
        remote: bundle.writingPromptProfiles?.find((profile) => profile.id === next.id) ?? null,
        write: async (profile) => saveLocalBundles(snapshot.map((entry) => applyProfile(entry, profile))),
      });
    };
    const committed = currentUser ? await saveFirestoreCharacterVoicePrompt(next, base, sources)
      : await (navigator.locks ? navigator.locks.request('novelforge-voice-persistence', saveLocalVoice) : saveLocalVoice());
    if (currentUser) updateBundlesAndPersist((previous) => previous.map((bundle) => applyProfile(bundle, committed)));
    else setBundles(loadLocalBundles(ownerId));
    return committed;
  };

  const pendingProposalCount = useMemo(
    () => changeProposals.filter((p) => p.canonStatus === 'PROPOSED').length,
    [changeProposals]
  );

  const navItems: {
    key: NavTab;
    label: string;
    count?: number;
    icon: React.FC<{ className?: string }>;
  }[] = [
    { key: 'dashboard', label: '대시보드', icon: LayoutDashboard },
    { key: 'manuscript', label: '원고 집필', count: episodes.length, icon: BookOpen },
    {
      key: 'ai_extraction',
      label: 'AI 원고 분석',
      icon: FileSearch,
    },
    {
      key: 'proposal_review',
      label: 'AI 제안 검토',
      count: pendingProposalCount,
      icon: ShieldCheck,
    },
    { key: 'memory_search', label: 'AI 기억 검색', icon: Database },
    { key: 'prompts', label: '프롬프트 관리', count: promptProfiles.length, icon: Sliders },
    { key: 'characters', label: '등장인물', count: characters.length, icon: Users },
    { key: 'relationships', label: '인물 관계도', count: relationships.length, icon: Network },
    { key: 'timeline', label: '작품 연표', count: timelineEvents.length, icon: CalendarClock },
    { key: 'foreshadowing', label: '복선 관리', count: foreshadowings.length, icon: Sparkles },
    { key: 'worldbuilding', label: '세계관', count: worldbuilding.length, icon: Globe },
    { key: 'settings', label: '설정', icon: Settings },
  ];

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex">
      {/* Left Fixed Sidebar (Desktop) */}
      <aside className="hidden lg:flex lg:w-64 lg:flex-col lg:fixed lg:inset-y-0 border-r border-slate-800 bg-slate-900/95 z-30">
        <div className="flex h-16 items-center gap-3 px-6 border-b border-slate-800">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-500 text-slate-950">
            <Feather className="h-4 w-4" />
          </div>
          <span className="font-display text-lg font-bold tracking-wider text-slate-100 whitespace-nowrap">
            NOVEL FORGE
          </span>
        </div>

        {/* Project Selector in Sidebar */}
        <div className="p-4 border-b border-slate-800">
          <label
            htmlFor="sidebar-project-select"
            className="block text-[11px] font-medium text-slate-400 mb-1.5"
          >
            현재 작업 작품 전환
          </label>
          <select
            id="sidebar-project-select"
            value={activeProject?.id || ''}
            onChange={(e) => {
              setActiveProjectId(e.target.value);
              setSelectedEpisodeId(null);
            }}
            className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs font-medium text-slate-100 focus:border-amber-500 focus:outline-none"
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
              </option>
            ))}
          </select>
        </div>

        {/* Primary Sidebar Navigation */}
        <nav aria-label="주 메뉴" className="flex-1 space-y-1 p-3">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeTab === item.key;
            return (
              <button
                key={item.key}
                type="button"
                onClick={() => handleNavigate(item.key)}
                className={`flex w-full items-center justify-between rounded-lg px-3.5 py-2.5 text-sm font-medium transition-colors whitespace-nowrap ${
                  isActive
                    ? 'bg-amber-500 text-slate-950 font-semibold'
                    : 'text-slate-300 hover:bg-slate-800/80 hover:text-slate-100'
                }`}
              >
                <span className="flex items-center gap-3">
                  <Icon className="h-4 w-4 shrink-0" />
                  <span>{item.label}</span>
                </span>
                {typeof item.count === 'number' && (
                  <span
                    className={`font-mono-tabular text-xs ${
                      isActive ? 'text-slate-900 font-bold' : 'text-slate-400'
                    }`}
                  >
                    {item.count}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        {/* Storage & Auth Mode Footer in Sidebar */}
        <div className="border-t border-slate-800 p-4 space-y-3 text-xs">
          <div className="flex items-center gap-2 text-slate-300">
            {currentUser ? (
              <>
                <Cloud className="h-4 w-4 text-emerald-400 shrink-0" />
                <div className="truncate">
                  <div className="font-semibold text-emerald-400">Firestore 클라우드 연동</div>
                  <div className="truncate text-[11px] text-slate-400">
                    {currentUser.email}
                  </div>
                </div>
              </>
            ) : (
              <>
                <HardDrive className="h-4 w-4 text-amber-400 shrink-0" />
                <div>
                  <div className="font-semibold text-amber-300">로컬 영구 저장소 모드</div>
                  <div className="text-[11px] text-slate-400">
                    새로고침 시 자동 복구 · 로그인 시 클라우드 동기화
                  </div>
                </div>
              </>
            )}
          </div>

          {authReady && (
            <div>
              {currentUser ? (
                <button
                  type="button"
                  onClick={handleGoogleSignOut}
                  className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs font-medium text-slate-200 hover:bg-slate-700 transition-colors"
                >
                  <LogOut className="h-3.5 w-3.5" />
                  <span>로그아웃</span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleGoogleSignIn}
                  className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-amber-500 px-3 py-2 text-xs font-semibold text-slate-950 hover:bg-amber-400 transition-colors"
                >
                  <LogIn className="h-3.5 w-3.5" />
                  <span>Google 계정으로 로그인</span>
                </button>
              )}
            </div>
          )}
        </div>
      </aside>

      {/* Mobile Navigation Drawer */}
      {mobileNavOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div
            className="fixed inset-0 bg-black/70"
            onClick={() => setMobileNavOpen(false)}
          />
          <aside className="relative w-64 max-w-xs flex-1 flex flex-col bg-slate-900 border-r border-slate-800 z-10">
            <div className="flex h-16 items-center justify-between px-5 border-b border-slate-800">
              <span className="font-display text-base font-bold text-slate-100">
                NOVEL FORGE
              </span>
              <button
                type="button"
                onClick={() => setMobileNavOpen(false)}
                aria-label="모바일 메뉴 닫기"
                className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <nav className="flex-1 space-y-1 p-3">
              {navItems.map((item) => {
                const Icon = item.icon;
                const isActive = activeTab === item.key;
                return (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => handleNavigate(item.key)}
                    className={`flex w-full items-center justify-between rounded-lg px-3.5 py-2.5 text-sm font-medium ${
                      isActive
                        ? 'bg-amber-500 text-slate-950 font-semibold'
                        : 'text-slate-300 hover:bg-slate-800'
                    }`}
                  >
                    <span className="flex items-center gap-3">
                      <Icon className="h-4 w-4" />
                      <span>{item.label}</span>
                    </span>
                    {typeof item.count === 'number' && (
                      <span className="font-mono-tabular text-xs">{item.count}</span>
                    )}
                  </button>
                );
              })}
            </nav>
          </aside>
        </div>
      )}

      {/* Main Content Area (Right of Fixed Sidebar) */}
      <div className="flex-1 flex flex-col lg:pl-64 min-w-0">
        {/* Top Bar Contract: Zone 1 (Current Project) — Zone 2 (Save Status) — Zone 3 (Primary Action) */}
        <header className="sticky top-0 z-20 flex h-16 items-center justify-between gap-4 border-b border-slate-800 bg-slate-950/90 px-6 backdrop-blur-md">
          {/* Zone 1: Mobile Menu Trigger + Current Project Title */}
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileNavOpen(true)}
              aria-label="메뉴 열기"
              className="rounded-lg border border-slate-800 p-2 text-slate-300 hover:bg-slate-900 lg:hidden"
            >
              <Menu className="h-4 w-4" />
            </button>
            <div className="truncate text-sm font-semibold text-slate-100">
              {activeProject ? activeProject.title : '작품을 선택하거나 생성해 주세요'}
            </div>
          </div>

          {/* Zone 2: Save Status Indicator */}
          <div
            data-testid="header-save-status"
            className="hidden sm:flex items-center gap-2 text-xs text-slate-300 whitespace-nowrap shrink-0"
          >
            {saveState === 'saving' && (
              <span className="inline-flex items-center gap-1.5 text-amber-400">
                <Clock className="h-3.5 w-3.5" />
                <span>저장 중...</span>
              </span>
            )}
            {saveState === 'saved' && (
              <span className="inline-flex items-center gap-1.5 text-emerald-400">
                <CheckCircle2 className="h-3.5 w-3.5" />
                <span>
                  저장 완료
                  {lastSavedAt
                    ? ` · ${new Date(lastSavedAt).toLocaleTimeString('ko-KR')}`
                    : ''}
                </span>
              </span>
            )}
            {saveState === 'recovered' && (
              <span className="inline-flex items-center gap-1.5 text-sky-400">
                <RotateCcw className="h-3.5 w-3.5" />
                <span>버전/복구본 복원 완료</span>
              </span>
            )}
            {saveState === 'error' && (
              <span className="inline-flex items-center gap-1.5 text-rose-400">
                <AlertCircle className="h-3.5 w-3.5" />
                <span>저장 실패 (비상 복구본 보존됨)</span>
              </span>
            )}
            {ragSyncSummary.status !== 'IDLE' && (
              <span
                data-testid="header-rag-status"
                className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] ${
                  ragSyncSummary.status === 'FAILED'
                    ? 'border-rose-500/40 bg-rose-500/10 text-rose-300'
                    : ragSyncSummary.status === 'SKIPPED_UNVERIFIED_SOURCE'
                    ? 'border-amber-500/40 bg-amber-500/10 text-amber-300'
                    : ragSyncSummary.status === 'INDEXED'
                    ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                    : 'border-slate-700 bg-slate-900 text-slate-400'
                }`}
              >
                {ragSyncSummary.message}
              </span>
            )}
          </div>

          {/* Zone 3: Single Primary Action */}
          <div className="flex items-center gap-3 shrink-0">
            {currentUser ? (
              <button
                type="button"
                onClick={() => handleNavigate('manuscript')}
                className="rounded-lg bg-amber-500 px-3.5 py-2 text-xs font-semibold text-slate-950 hover:bg-amber-400 transition-colors whitespace-nowrap shrink-0"
              >
                집필실 이동
              </button>
            ) : (
              <button
                type="button"
                onClick={handleGoogleSignIn}
                className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500 px-3.5 py-2 text-xs font-semibold text-slate-950 hover:bg-amber-400 transition-colors whitespace-nowrap shrink-0"
              >
                <LogIn className="h-3.5 w-3.5" />
                <span>Google 로그인</span>
              </button>
            )}
          </div>
        </header>

        {/* Main Workspace Container */}
        <main className="flex-1 p-6 max-w-[1440px] w-full mx-auto space-y-6">
          {errorBanner && (
            <div
              role="alert"
              className="flex items-center justify-between gap-3 rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-xs text-rose-200"
            >
              <div className="flex items-center gap-2">
                <AlertCircle className="h-4 w-4 text-rose-400 shrink-0" />
                <span>{errorBanner}</span>
              </div>
              <button
                type="button"
                onClick={() => setErrorBanner(null)}
                className="text-rose-300 hover:text-white whitespace-nowrap"
              >
                닫기
              </button>
            </div>
          )}

          {isLoadingCloud && (
            <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 text-xs text-amber-300">
              Firestore 클라우드 데이터베이스에서 작품과 원고를 동기화하는 중입니다...
            </div>
          )}

          {activeTab === 'dashboard' && (
            <DashboardView
              projects={projects}
              activeProject={activeProject}
              episodes={episodes}
              characters={characters}
              worldbuilding={worldbuilding}
              revisions={revisions}
              onSelectProject={(id) => {
                setActiveProjectId(id);
                setSelectedEpisodeId(null);
              }}
              onCreateProject={handleCreateProject}
              onUpdateProject={handleUpdateProject}
              onDeleteProject={handleDeleteProject}
              onNavigate={handleNavigate}
            />
          )}

          {activeTab === 'manuscript' && activeProject && (
            <ManuscriptView
              projectId={activeProject.id}
              project={activeProject}
              voiceRewriteSelection={voiceRewriteSelection?.projectId === activeProject.id ? voiceRewriteSelection : null}
              episodes={episodes}
              characters={characters}
              worldbuilding={worldbuilding}
              revisions={revisions}
              promptProfiles={promptProfiles}
              writingPlans={writingPlans}
              changeProposals={changeProposals}
              selectedEpisodeId={selectedEpisodeId}
              saveState={saveState}
              lastSavedAt={lastSavedAt}
              onSelectEpisode={(id) => { setVoiceRewriteSelection(null); setSelectedEpisodeId(id); }}
              onCreateEpisode={handleCreateEpisode}
              onSaveEpisode={handleSaveEpisode}
              onDeleteEpisode={handleDeleteEpisode}
              onDeleteRevision={handleDeleteRevision}
              onSaveWritingPlan={handleSaveWritingPlan}
              onSaveChangeProposals={handleSaveChangeProposals}
              onUpdateChangeProposalStatus={handleUpdateChangeProposalStatus}
              onUpdatePromptProfile={handleUpdatePromptProfile}
              onOpenPromptManager={() => handleNavigate('prompts')}
              onOpenProposalReview={handleOpenProposalReview}
              getIdToken={getIdToken}
              onSaveStateChange={(st, err) => {
                setSaveState(st);
                if (err) setErrorBanner(err);
              }}
            />
          )}

          {activeTab === 'ai_extraction' && activeProject && (
            <AiExtractionPanel
              project={activeProject}
              episodes={episodes}
              revisions={revisions}
              scenes={scenes}
              characters={characters}
              worldbuilding={worldbuilding}
              relationships={relationships}
              timelineEvents={timelineEvents}
              foreshadowings={foreshadowings}
              changeProposals={changeProposals}
              selectedEpisodeId={selectedEpisodeId}
              onSelectEpisodeId={(epId) => setSelectedEpisodeId(epId)}
              isCloudAuthenticated={Boolean(currentUser)}
              getIdToken={getIdToken}
              onProposalsSaved={handleReceiveServerSavedExtractionProposals}
              onNavigateTab={(tab) => handleNavigate(tab)}
              onOpenProposalReview={handleOpenProposalReview}
            />
          )}

          {activeTab === 'proposal_review' && activeProject && (
            <ChangeProposalReviewPanel
              project={activeProject}
              proposals={changeProposals}
              characters={characters}
              episodes={episodes}
              relationships={relationships}
              timelineEvents={timelineEvents}
              foreshadowings={foreshadowings}
              approvalAudits={approvalAudits}
              idToken={idTokenState}
              initialSelectedProposalId={selectedProposalForReviewId}
              onApproveProposal={handleApproveProposalFromWorkspace}
              onRejectProposal={handleRejectProposalFromWorkspace}
              onRetryRagSync={handleRetryRagSyncFromWorkspace}
              onRefreshWorkspaceData={handleRefreshApprovalWorkspaceData}
              onNavigateToEntity={(tab) => handleNavigate(tab)}
            />
          )}

          {activeTab === 'memory_search' && activeProject && (
            <MemorySearchView
              ownerId={currentUser?.uid || activeProject.ownerId || 'local_author'}
              idToken={idTokenState}
              activeProject={activeProject}
              episodes={episodes}
              characters={characters}
              worldbuilding={worldbuilding}
              timelineEvents={activeBundle?.timelineEvents || []}
              scenes={activeBundle?.scenes || []}
              foreshadowings={activeBundle?.foreshadowings || []}
              relationships={activeBundle?.relationships || []}
              onNavigateToSource={({ tab, episodeId }) => {
                handleNavigate(tab, episodeId);
              }}
            />
          )}

          {activeTab === 'prompts' && activeProject && (
            <PromptManagerView
              projectId={activeProject.id}
              projectTitle={activeProject.title}
              ownerId={currentUser?.uid || activeProject.ownerId || 'local_author'}
              promptProfiles={promptProfiles}
              characters={characters}
              episodes={episodes}
              revisions={revisions}
              styleProfiles={styleProfiles}
              getIdToken={getIdToken}
              onApproveSaveStyleDNA={handleApproveSaveStyleDNA}
              onCreatePromptProfile={handleCreatePromptProfile}
              onUpdatePromptProfile={handleUpdatePromptProfile}
              onReloadPromptProfile={handleReloadPromptProfile}
              onDeletePromptProfile={handleDeletePromptProfile}
            />
          )}

          {activeTab === 'characters' && activeProject && (
            <CharactersView
              key={activeProject.id}
              voiceWorkspace={{
                projectId: activeProject.id, ownerId: currentUser?.uid || activeProject.ownerId,
                revisions, relationships, profiles: promptProfiles, cloud: Boolean(currentUser), getIdToken,
                onSave: handleSaveCharacterVoice,
                onReload: (id) => currentUser ? handleReloadPromptProfile(id) : Promise.resolve(
                  loadLocalBundles(activeProject.ownerId).find((bundle) => bundle.project.id === activeProject.id)
                    ?.writingPromptProfiles?.find((profile) => profile.id === id) ?? null),
                onOpenRewrite: (selection) => { handleNavigate('manuscript', selection.episodeId); setVoiceRewriteSelection(selection); },
              }}
              characters={characters}
              episodes={episodes}
              worldbuilding={worldbuilding}
              onCreateCharacter={handleCreateCharacter}
              onUpdateCharacter={handleUpdateCharacter}
              onDeleteCharacter={handleDeleteCharacter}
            />
          )}

          {activeTab === 'relationships' && activeProject && (
            <RelationshipsView
              projectId={activeProject.id}
              characters={characters}
              relationships={relationships}
              episodes={episodes}
              timelineEvents={timelineEvents}
              revisions={revisions}
              onCreateRelationship={handleCreateRelationship}
              onUpdateRelationship={handleUpdateRelationship}
              onDeleteRelationship={handleDeleteRelationship}
              onNavigateToEpisode={(epId) => handleNavigate('manuscript', epId)}
              onNavigateToTimeline={() => handleNavigate('timeline')}
            />
          )}

          {activeTab === 'timeline' && activeProject && (
            <TimelineView
              projectId={activeProject.id}
              timelineEvents={timelineEvents}
              episodes={episodes}
              scenes={scenes}
              characters={characters}
              foreshadowings={foreshadowings}
              worldbuilding={worldbuilding}
              relationships={relationships}
              revisions={revisions}
              onCreateTimelineEvent={handleCreateTimelineEvent}
              onUpdateTimelineEvent={handleUpdateTimelineEvent}
              onDeleteTimelineEvent={handleDeleteTimelineEvent}
              onNavigateToEpisode={(epId) => handleNavigate('manuscript', epId)}
              onNavigateToForeshadowing={() => handleNavigate('foreshadowing')}
            />
          )}

          {activeTab === 'foreshadowing' && activeProject && (
            <ForeshadowingView
              project={activeProject}
              foreshadowings={foreshadowings}
              episodes={episodes}
              scenes={scenes}
              characters={characters}
              timelineEvents={timelineEvents}
              worldbuilding={worldbuilding}
              relationships={relationships}
              revisions={revisions}
              onCreateForeshadowing={handleCreateForeshadowing}
              onUpdateForeshadowing={handleUpdateForeshadowing}
              onDeleteForeshadowing={handleDeleteForeshadowing}
              onNavigateToEpisode={(epId) => handleNavigate('manuscript', epId)}
              onNavigateToTimeline={() => handleNavigate('timeline')}
              onNavigateToCharacters={() => handleNavigate('characters')}
            />
          )}

          {activeTab === 'worldbuilding' && activeProject && (
            <WorldbuildingView
              worldbuilding={worldbuilding}
              characters={characters}
              episodes={episodes}
              onCreateWorldbuilding={handleCreateWorldbuilding}
              onUpdateWorldbuilding={handleUpdateWorldbuilding}
              onDeleteWorldbuilding={handleDeleteWorldbuilding}
            />
          )}

          {activeTab === 'settings' && (
            <SettingsView
              activeProject={activeProject}
              characters={characters}
              worldbuilding={worldbuilding}
              episodes={episodes}
              revisions={revisions}
              isAuthenticated={Boolean(currentUser)}
              userEmail={currentUser?.email || null}
              userUid={currentUser?.uid || null}
              serverAuthStatus={serverAuthStatus}
              onRefreshServerAuth={() => verifyTokenWithServer(currentUser)}
              onImportProjectBundle={handleImportProjectBundle}
              onSyncCurrentToFirestore={handleSyncCurrentToFirestore}
              getIdToken={getIdToken}
            />
          )}
        </main>
      </div>
    </div>
  );
}
