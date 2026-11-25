import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import * as repository from '../services/novelRepository';
import type {
  AtomicEpisodeCasTxAdapter, AtomicProposalPersistenceOutcome, AtomicStylePersistenceOptions,
  EpisodeRevisionCasConflictCode, EpisodeRevisionCommitInput, EpisodeRevisionCommitResult,
  IdempotentProposalPersistenceAdapter, LocalStorageLike, NormalizedProposalValidationResult,
  SourceRevisionVerificationOutcome,
} from '../services/novelRepository';
import { firestoreProjectPath } from '../services/repository/core/projectPath';
import { commitEpisodeRevisionSafelyFirestore } from '../services/repository/episode/episodeRepository';
import { executeAtomicEpisodeCasCommitCore } from '../services/repository/episode/episodeCas';
import { loadLocalBundles } from '../services/repository/local/localProjectStore';
import { parseAndValidateProjectBundle, serializeProjectBundle } from './novelLogic';
import { createInitialSeedBundle } from './seedData';

const root = fileURLToPath(new URL('../../', import.meta.url));

// Runtime names recorded from 9b36d0a before moving the declarations.
const baselineExports = [
  'EpisodeRevisionCasConflictError',
  'LOCAL_BUNDLES_KEY',
  'areProposalsSemanticallyEquivalent',
  'buildCanonicalChangeProposalWriteDataFromNormalized',
  'canonicalizeProposedPayloadJson',
  'classifyFirestorePersistenceError',
  'classifyStylePersistenceError',
  'clearEmergencyDraft',
  'commitEpisodeRevisionSafelyFirestore',
  'commitEpisodeRevisionSafelyLocal',
  'createFirestoreChangeProposal',
  'createFirestoreCharacter',
  'createFirestoreEpisode',
  'createFirestoreForeshadowing',
  'createFirestoreMemoryChunk',
  'createFirestoreMemoryDocument',
  'createFirestoreProject',
  'createFirestorePromptProfile',
  'createFirestoreRelationship',
  'createFirestoreRevision',
  'createFirestoreScene',
  'createFirestoreStyleProfile',
  'createFirestoreTimelineEvent',
  'createFirestoreWorldbuilding',
  'createFirestoreWritingPlan',
  'deleteFirestoreCharacter',
  'deleteFirestoreEpisode',
  'deleteFirestoreForeshadowing',
  'deleteFirestoreProjectCascade',
  'deleteFirestorePromptProfile',
  'deleteFirestoreRelationship',
  'deleteFirestoreRevision',
  'deleteFirestoreScene',
  'deleteFirestoreTimelineEvent',
  'deleteFirestoreWorldbuilding',
  'executeAtomicEpisodeCasCommitCore',
  'fetchFirestoreApprovalAudits',
  'fetchFirestoreFoundationCollections',
  'fetchFirestorePhase2Collections',
  'fetchFirestoreProjectDetails',
  'fetchFirestoreProjects',
  'fetchFirestorePromptProfileById',
  'formatProposalPersistenceErrorSummaryKo',
  'getEmergencyDraft',
  'listAllEmergencyDrafts',
  'loadLocalBundles',
  'normalizeAndValidateChangeProposalPayload',
  'parsePromptProfileFromFirestoreData',
  'parseStyleProfileFromFirestoreData',
  'persistApprovedStyleDnaAtomicallyCore',
  'persistApprovedStyleDnaAtomicallyFirestore',
  'persistApprovedStyleDnaAtomicallyLocal',
  'persistChangeProposalsIdempotentlyCore',
  'persistFirestoreChangeProposalsIdempotently',
  'persistSingleFirestoreProposalAtomically',
  'saveCharacterVoicePromptCore',
  'saveEmergencyDraft',
  'saveFirestoreCharacterVoicePrompt',
  'saveLocalBundles',
  'updateFirestoreChangeProposal',
  'updateFirestoreCharacter',
  'updateFirestoreEpisode',
  'updateFirestoreForeshadowing',
  'updateFirestoreProject',
  'updateFirestorePromptProfile',
  'updateFirestorePromptProfileWithCas',
  'updateFirestoreRelationship',
  'updateFirestoreScene',
  'updateFirestoreStyleProfile',
  'updateFirestoreTimelineEvent',
  'updateFirestoreWorldbuilding',
  'updateFirestoreWritingPlan',
  'updateLocalPromptProfileWithCas',
  'updatePromptProfileWithCasCore',
  'uploadProjectBundleToFirestore',
  'validatePromptProfileForFirestoreSchema',
  'validateProposalBeforeFirestoreWrite',
  'validateStyleProfileForFirestoreSchema',
  'verifyPersistedRevisionSnapshot',
] satisfies Array<keyof typeof repository>;

type PublicRepositoryTypes = [
  AtomicEpisodeCasTxAdapter, AtomicProposalPersistenceOutcome, AtomicStylePersistenceOptions,
  EpisodeRevisionCasConflictCode, EpisodeRevisionCommitInput, EpisodeRevisionCommitResult,
  IdempotentProposalPersistenceAdapter, LocalStorageLike, NormalizedProposalValidationResult,
  SourceRevisionVerificationOutcome,
];

test('AR1: the original repository import exposes every baseline value and type', () => {
  assert.deepEqual(Object.keys(repository).sort(), [...baselineExports].sort());
  const typeCount: PublicRepositoryTypes['length'] = 10;
  assert.equal(typeCount, 10);
});

test('AR2: storage paths preserve the existing owner and project hierarchy', () => {
  assert.equal(firestoreProjectPath('writer_A', 'project_18'), 'users/writer_A/projects/project_18');
});

test('AR3: backup codec output and deserialization match the frozen baseline', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-01-01T00:00:00.000Z') });
  const original = createInitialSeedBundle('repository_owner');
  const json = serializeProjectBundle(
    original.project, original.characters, original.worldbuilding, original.episodes, original.revisions,
  );
  const parsed = parseAndValidateProjectBundle(json, 'repository_reader');
  const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
  assert.equal(sha256(json), '33c1647d822576329e0c18aba4d2df7b6f955e63d34514a71ffaee3d8921c8a5');
  assert.equal(sha256(JSON.stringify(parsed)), '928c1cfb30229fbb80a027fb9cf20ade8381827d5e51c8fbf4fa69c4f1bacf72');
  assert.ok(parsed.valid);
  assert.equal(parsed.bundle.project.ownerId, 'repository_reader');
  assert.equal(parsed.bundle.episodes.length, original.episodes.length);
  assert.equal(parsed.bundle.revisions.length, original.revisions.length);
  assert.deepEqual(parsed.bundle.episodes.map(({ content }) => content), original.episodes.map(({ content }) => content));
});

test('AR18: the legacy cache retains its original bytes and isolates readers by owner', (t) => {
  const { LOCAL_BUNDLES_KEY, getEmergencyDraft, saveEmergencyDraft, saveLocalBundles } = repository;
  const first = createInitialSeedBundle('storage_a');
  const second = createInitialSeedBundle('storage_b');
  const legacy = JSON.stringify([first, second]);
  const entries = new Map<string, string>([[LOCAL_BUNDLES_KEY, legacy]]);
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => { entries.set(key, value); },
  } });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  });

  assert.deepEqual(loadLocalBundles('storage_a', false).map((item) => item.project.ownerId), ['storage_a']);
  assert.deepEqual(loadLocalBundles('storage_b', false).map((item) => item.project.ownerId), ['storage_b']);
  assert.deepEqual(loadLocalBundles('storage_other', false), []);
  saveLocalBundles([first]);
  assert.equal(entries.get(LOCAL_BUNDLES_KEY), legacy);

  const episode = first.episodes[0];
  const emergency = { projectId: first.project.id, episodeId: episode.id, title: episode.title,
    content: '기존 복구 사본', synopsis: '', authorNote: '', status: 'draft', reason: 'save_error',
    savedAt: '2026-01-01T00:00:00.000Z' } as const;
  saveEmergencyDraft(emergency);
  assert.deepEqual(getEmergencyDraft(first.project.id, episode.id), emergency);
  assert.equal(entries.get(LOCAL_BUNDLES_KEY), legacy);
  assert.equal(loadLocalBundles('storage_b', false)[0].project.ownerId, 'storage_b');
});

test('AR23: repository runtime dependencies are acyclic and point away from the facade', async () => {
  const bundle = await build({
    absWorkingDir: root,
    entryPoints: ['src/services/novelRepository.ts', 'src/utils/novelLogic.ts', 'src/components/ManuscriptView.tsx'],
    bundle: true, packages: 'external', platform: 'browser', format: 'esm', outdir: 'unused', write: false, metafile: true,
  });
  assert.ok(bundle.metafile);
  const inputs = bundle.metafile.inputs;
  const facade = 'src/services/novelRepository.ts';
  const repositoryPrefix = 'src/services/repository/';
  const inRepository = (file: string) => file === facade || file.startsWith(repositoryPrefix) ||
    file === 'src/utils/novelLogic.ts' || file === 'src/utils/novelValidation.ts';
  const dependencies = (file: string) => inputs[file].imports.filter((edge) => !edge.external).map(({ path }) => path);
  const visiting: string[] = [];
  const visited = new Set<string>();

  function visit(file: string) {
    const index = visiting.indexOf(file);
    if (index >= 0) {
      const cycle = [...visiting.slice(index), file];
      assert.ok(!cycle.some(inRepository), `Repository runtime cycle: ${cycle.join(' -> ')}`);
      return;
    }
    if (visited.has(file) || !inputs[file]) return;
    visiting.push(file);
    for (const child of dependencies(file)) visit(child);
    visiting.pop();
    visited.add(file);
  }

  assert.ok(Object.keys(inputs).some((file) => file.startsWith(repositoryPrefix)));
  for (const file of Object.keys(inputs)) {
    if (file.startsWith(repositoryPrefix)) assert.ok(!dependencies(file).includes(facade), file);
    visit(file);
  }
  for (const source of ['src/firebase.ts', 'src/services/episodeDraftStore.ts', 'src/utils/episodeSaveScheduler.ts']) {
    assert.deepEqual(Object.keys(inputs).filter((file) => file.endsWith('/' + source.split('/').pop())), [source]);
  }
});

test('AR24: facade exports keep the same implementation identities as internal modules', () => {
  assert.equal(repository.commitEpisodeRevisionSafelyFirestore, commitEpisodeRevisionSafelyFirestore);
  assert.equal(repository.executeAtomicEpisodeCasCommitCore, executeAtomicEpisodeCasCommitCore);
  assert.equal(repository.loadLocalBundles, loadLocalBundles);
});
