import test from 'node:test';
import assert from 'node:assert/strict';
import { Timestamp, type Firestore } from 'firebase-admin/firestore';
import {
  executeServerManuscriptExtraction,
  normalizeChangeProposalFromFirestore,
  saveVerifiedExtractionProposalsOnServer,
  serializeChangeProposalForFirestoreWrite,
} from '../server/manuscriptExtractionEngine';
import { registerIsolatedMockFirestoreForTest } from '../server/authMiddleware';
import type { ChangeProposal } from '../types/novel';

/**
 * In-memory mock Firestore supporting doc(), collection(), runTransaction(), and batch()
 * registered via registerIsolatedMockFirestoreForTest for strict TEST_ISOLATED verification.
 */
function createInMemoryIsolatedMockFirestore(runId: string): {
  db: Firestore;
  store: Map<string, Record<string, unknown>>;
} {
  const store = new Map<string, Record<string, unknown>>();

  const makeDocRef = (docPath: string) => ({
    id: docPath.split('/').pop() || '',
    path: docPath,
    get: async () => {
      const data = store.get(docPath);
      return {
        id: docPath.split('/').pop() || '',
        exists: data !== undefined,
        data: () => (data ? { ...data } : undefined),
      };
    },
    set: async (data: Record<string, unknown>, opts?: { merge?: boolean }) => {
      if (opts?.merge && store.has(docPath)) {
        store.set(docPath, { ...store.get(docPath)!, ...data });
      } else {
        store.set(docPath, { ...data });
      }
    },
  });

  const makeCollectionRef = (colPath: string) => ({
    path: colPath,
    get: async () => {
      const prefix = `${colPath}/`;
      const docs: Array<{
        id: string;
        exists: boolean;
        data: () => Record<string, unknown>;
      }> = [];
      for (const [k, v] of store.entries()) {
        if (k.startsWith(prefix) && !k.slice(prefix.length).includes('/')) {
          docs.push({
            id: k.slice(prefix.length),
            exists: true,
            data: () => ({ ...v }),
          });
        }
      }
      return { docs, empty: docs.length === 0, size: docs.length };
    },
  });

  const mockDb = {
    doc: (p: string) => makeDocRef(p),
    collection: (p: string) => makeCollectionRef(p),
    runTransaction: async <T>(
      updateFn: (tx: {
        get: (ref: ReturnType<typeof makeDocRef>) => ReturnType<
          ReturnType<typeof makeDocRef>['get']
        >;
        set: (
          ref: ReturnType<typeof makeDocRef>,
          data: Record<string, unknown>,
          opts?: { merge?: boolean }
        ) => void;
      }) => Promise<T>
    ): Promise<T> => {
      const stagedWrites: Array<{
        ref: ReturnType<typeof makeDocRef>;
        data: Record<string, unknown>;
        opts?: { merge?: boolean };
      }> = [];
      const tx = {
        get: async (ref: ReturnType<typeof makeDocRef>) => ref.get(),
        set: (
          ref: ReturnType<typeof makeDocRef>,
          data: Record<string, unknown>,
          opts?: { merge?: boolean }
        ) => {
          stagedWrites.push({ ref, data, opts });
        },
      };
      const result = await updateFn(tx);
      for (const w of stagedWrites) {
        await w.ref.set(w.data, w.opts);
      }
      return result;
    },
    batch: () => {
      const ops: Array<() => Promise<void>> = [];
      return {
        set: (
          ref: ReturnType<typeof makeDocRef>,
          data: Record<string, unknown>,
          opts?: { merge?: boolean }
        ) => {
          ops.push(() => ref.set(data, opts));
        },
        commit: async () => {
          for (const op of ops) await op();
        },
      };
    },
  } as unknown as Firestore;

  registerIsolatedMockFirestoreForTest(mockDb, {
    runId,
    projectId: 'nf-isolated-test-proj',
    databaseId: 'nf-isolated-test-db',
  });

  return { db: mockDb, store };
}

function seedAuthoritativeFirestoreProject(
  store: Map<string, Record<string, unknown>>,
  params: {
    ownerId: string;
    projectId: string;
    episodeId: string;
    revisionId: string;
    manuscriptContent: string;
  }
) {
  const { ownerId, projectId, episodeId, revisionId, manuscriptContent } = params;
  const basePath = `users/${ownerId}/projects/${projectId}`;
  const nowIso = '2026-03-30T09:00:00.000Z';

  store.set(basePath, {
    id: projectId,
    ownerId,
    title: '테스트 장편 소설',
    genre: '판타지',
    synopsis: '시놉시스',
    status: 'confirmed',
    createdAt: Timestamp.fromDate(new Date(nowIso)),
    updatedAt: Timestamp.fromDate(new Date(nowIso)),
  });

  store.set(`${basePath}/episodes/${episodeId}`, {
    id: episodeId,
    ownerId,
    projectId,
    episodeNumber: 1,
    title: '제1화 서막',
    content: manuscriptContent,
    synopsis: '',
    authorNote: '',
    charCountWithSpaces: manuscriptContent.length,
    charCountWithoutSpaces: manuscriptContent.replace(/\s+/g, '').length,
    status: 'draft',
    linkedCharacterIds: ['char_cassian', 'char_elena'],
    linkedWorldbuildingIds: [],
    latestRevisionId: revisionId,
    createdAt: Timestamp.fromDate(new Date(nowIso)),
    updatedAt: Timestamp.fromDate(new Date(nowIso)),
  });

  store.set(`${basePath}/revisions/${revisionId}`, {
    id: revisionId,
    ownerId,
    projectId,
    episodeId,
    episodeTitle: '제1화 서막',
    content: manuscriptContent,
    charCountWithSpaces: manuscriptContent.length,
    label: '리비전 1',
    createdAt: Timestamp.fromDate(new Date(nowIso)),
  });

  store.set(`${basePath}/characters/char_cassian`, {
    id: 'char_cassian',
    ownerId,
    projectId,
    name: '카시안',
    role: '주인공',
    affiliation: '기사단',
    appearance: '',
    personality: '',
    background: '',
    abilities: '',
    status: 'confirmed',
    canonStatus: 'CANON',
    linkedEpisodeIds: [episodeId],
    linkedWorldbuildingIds: [],
    createdAt: Timestamp.fromDate(new Date(nowIso)),
    updatedAt: Timestamp.fromDate(new Date(nowIso)),
  });

  store.set(`${basePath}/characters/char_elena`, {
    id: 'char_elena',
    ownerId,
    projectId,
    name: '엘레나',
    role: '주연',
    affiliation: '마탑',
    appearance: '',
    personality: '',
    background: '',
    abilities: '',
    status: 'confirmed',
    canonStatus: 'CANON',
    linkedEpisodeIds: [episodeId],
    linkedWorldbuildingIds: [],
    createdAt: Timestamp.fromDate(new Date(nowIso)),
    updatedAt: Timestamp.fromDate(new Date(nowIso)),
  });
}

test('Phase 4.2.1 Persistence 1: Firestore ChangeProposal writes native Timestamp and normalizes back to ISO string while preserving immutable fields', () => {
  const sampleProposal: ChangeProposal = {
    id: 'prop_sample_001',
    ownerId: 'owner_1',
    projectId: 'proj_1',
    targetEntityType: 'RELATIONSHIP',
    targetEntityId: 'rel_1',
    proposedAction: 'CREATE',
    title: '카시안과 엘레나의 혈맹',
    rationale: '함께 싸우며 혈맹을 맺음',
    beforeSummary: '기존 설정 없음',
    afterSummary: '혈맹 관계 (+85)',
    proposedPayloadJson: '{"schemaVersion":"PHASE_4_2_1_V1"}',
    canonStatus: 'PROPOSED',
    triggerEpisodeId: 'ep_1',
    triggerSceneId: '',
    sourceRevisionId: 'rev_1',
    createdBy: 'AI_ENGINE',
    reviewedAt: '',
    createdAt: '2026-03-01T12:00:00.000Z',
    updatedAt: '2026-03-01T12:00:00.000Z',
  };

  const firestoreDoc = serializeChangeProposalForFirestoreWrite({
    proposal: sampleProposal,
    ownerId: 'owner_1',
    projectId: 'proj_1',
  });

  // Verify createdAt and updatedAt are native Admin SDK Timestamp instances
  assert.equal(firestoreDoc.createdAt instanceof Timestamp, true);
  assert.equal(firestoreDoc.updatedAt instanceof Timestamp, true);
  assert.equal(
    firestoreDoc.createdAt.toDate().toISOString(),
    '2026-03-01T12:00:00.000Z'
  );

  // Verify exact 19 keys required by firestore.rules isValidChangeProposal
  const expectedKeys = [
    'id',
    'ownerId',
    'projectId',
    'targetEntityType',
    'targetEntityId',
    'proposedAction',
    'title',
    'rationale',
    'beforeSummary',
    'afterSummary',
    'proposedPayloadJson',
    'canonStatus',
    'triggerEpisodeId',
    'triggerSceneId',
    'sourceRevisionId',
    'createdBy',
    'reviewedAt',
    'createdAt',
    'updatedAt',
  ].sort();
  assert.deepEqual(Object.keys(firestoreDoc).sort(), expectedKeys);

  // Verify update preserves original createdAt and immutable fields
  const laterTs = Timestamp.fromDate(new Date('2026-03-05T18:30:00.000Z'));
  const updatedFirestoreDoc = serializeChangeProposalForFirestoreWrite({
    proposal: {
      ...sampleProposal,
      id: 'attempted_id_tamper',
      ownerId: 'attempted_owner_tamper',
      createdAt: '2026-03-05T18:30:00.000Z',
      title: '수정된 제목',
    },
    ownerId: 'owner_1',
    projectId: 'proj_1',
    existingDoc: firestoreDoc,
    nowTimestamp: laterTs,
  });

  assert.equal(updatedFirestoreDoc.id, 'prop_sample_001');
  assert.equal(updatedFirestoreDoc.ownerId, 'owner_1');
  assert.equal(
    updatedFirestoreDoc.createdAt.toDate().toISOString(),
    '2026-03-01T12:00:00.000Z'
  );
  assert.equal(
    updatedFirestoreDoc.updatedAt.toDate().toISOString(),
    '2026-03-05T18:30:00.000Z'
  );

  // Verify read normalization converts Timestamp back to ISO strings
  const normalized = normalizeChangeProposalFromFirestore(
    updatedFirestoreDoc as unknown as Record<string, unknown>
  );
  assert.equal(typeof normalized.createdAt, 'string');
  assert.equal(typeof normalized.updatedAt, 'string');
  assert.equal(normalized.createdAt, '2026-03-01T12:00:00.000Z');
  assert.equal(normalized.updatedAt, '2026-03-05T18:30:00.000Z');
});

test('Phase 4.2.1 Persistence 2: Analysis/Save separation saves ONLY selectedCandidateIds without re-calling Gemini and enforces atomic duplicate prevention', async () => {
  const { db, store } = createInMemoryIsolatedMockFirestore('run_persist_sep_1');
  const manuscript = [
    '카시안은 엘레나에게 무릎을 꿇고 기사의 맹세를 바쳤다.',
    '그날 밤 성채 지하에서 붉은 마석의 균열이 처음으로 시작되었다.',
  ].join('\n');

  seedAuthoritativeFirestoreProject(store, {
    ownerId: 'owner_auth_1',
    projectId: 'proj_1',
    episodeId: 'ep_1',
    revisionId: 'rev_1',
    manuscriptContent: manuscript,
  });

  let geminiCallCount = 0;
  const mockExtractorFn = async () => {
    geminiCallCount++;
    return {
      modelId: 'gemini-2.5-flash-test',
      rawResponse: {
        analysis_summary: '기사의 맹세 및 마석 균열 복선 추출',
        candidates: [
          {
            targetEntityType: 'RELATIONSHIP',
            proposedAction: 'CREATE',
            existingTargetEntityId: null,
            title: '카시안과 엘레나의 기사 서약',
            rationale: '무릎을 꿇고 기사의 맹세를 바침',
            beforeSummary: '없음',
            afterSummary: '주군과 수호기사 (+90)',
            excerpt: '카시안은 엘레나에게 무릎을 꿇고 기사의 맹세를 바쳤다.',
            precedingContext: null,
            followingContext: null,
            sceneId: null,
            confidence: 0.95,
            dialogueClaimOnly: false,
            temporalContextType: 'PRESENT_EVENT',
            uncertaintyFlags: [],
            relationshipPayload: {
              sourceCharacterId: 'char_cassian',
              sourceCharacterName: '카시안',
              targetCharacterId: 'char_elena',
              targetCharacterName: '엘레나',
              relationType: '주군과 수호기사',
              affinityScore: 90,
              isDirectional: true,
              description: '충성 서약',
            },
            timelineEventPayload: null,
            foreshadowingPayload: null,
          },
          {
            targetEntityType: 'FORESHADOWING',
            proposedAction: 'CREATE',
            existingTargetEntityId: null,
            title: '붉은 마석의 균열',
            rationale: '성채 지하 마석 균열 발생',
            beforeSummary: '없음',
            afterSummary: 'PLANTED 복선 신규 등록',
            excerpt: '그날 밤 성채 지하에서 붉은 마석의 균열이 처음으로 시작되었다.',
            precedingContext: null,
            followingContext: null,
            sceneId: null,
            confidence: 0.88,
            dialogueClaimOnly: false,
            temporalContextType: 'PRESENT_EVENT',
            uncertaintyFlags: [],
            relationshipPayload: null,
            timelineEventPayload: null,
            foreshadowingPayload: {
              title: '붉은 마석의 균열',
              description: '성채 지하 마석의 균열',
              cluePhase: 'PLANTED',
              relatedCharacterIds: ['char_cassian'],
              relatedCharacterNames: ['카시안'],
              relatedEventIds: [],
              payoffNote: '성채 붕괴의 전조',
            },
          },
          {
            targetEntityType: 'TIMELINE_EVENT',
            proposedAction: 'CREATE',
            existingTargetEntityId: null,
            title: '원문에 없는 환각 사건',
            rationale: '원문에 없는 요약 문장',
            beforeSummary: '없음',
            afterSummary: '환각 사건',
            excerpt: '이 문장은 원고 본문에 전혀 존재하지 않는 문장입니다.',
            precedingContext: null,
            followingContext: null,
            sceneId: null,
            confidence: 0.5,
            dialogueClaimOnly: false,
            temporalContextType: 'PRESENT_EVENT',
            uncertaintyFlags: [],
            relationshipPayload: null,
            timelineEventPayload: {
              title: '환각 사건',
              summary: '환각',
              inUniverseDate: '미상',
              chronologicalOrder: 30,
              involvedCharacterIds: [],
              involvedCharacterNames: [],
              locationWorldItemId: null,
              locationName: null,
            },
            foreshadowingPayload: null,
          },
        ],
      },
    };
  };

  // Step 1: Run analysis (persistProposals = false)
  const analysisRes = await executeServerManuscriptExtraction(
    {
      projectId: 'proj_1',
      episodeId: 'ep_1',
      revisionId: 'rev_1',
      persistProposals: false,
    },
    {
      db,
      verifiedOwnerId: 'owner_auth_1',
      mockExtractorFn,
    }
  );

  assert.equal(geminiCallCount, 1);
  assert.equal(analysisRes.savedProposals.length, 0);
  assert.equal(analysisRes.candidates.length, 3);
  assert.equal(analysisRes.audit.verifiedCount, 2);
  assert.equal(analysisRes.audit.unverifiedCount, 1);
  assert.ok(analysisRes.analysisRunId);
  assert.ok(analysisRes.analysisToken);

  // Verify 0 proposals in Firestore after analysis
  const proposalsColAfterAnalysis = await db
    .collection('users/owner_auth_1/projects/proj_1/changeProposals')
    .get();
  assert.equal(proposalsColAfterAnalysis.size, 0);

  // Step 2: Empty selectedCandidateIds MUST fail with 0 saved
  await assert.rejects(
    async () => {
      await saveVerifiedExtractionProposalsOnServer(
        {
          projectId: 'proj_1',
          episodeId: 'ep_1',
          revisionId: 'rev_1',
          analysisRunId: analysisRes.analysisRunId,
          analysisToken: analysisRes.analysisToken,
          selectedCandidateIds: [],
        },
        { db, verifiedOwnerId: 'owner_auth_1' }
      );
    },
    /EMPTY_SELECTION_FORBIDDEN/
  );

  // Step 3: Selecting an UNVERIFIED candidate MUST fail with 0 saved
  const unverifiedCand = analysisRes.candidates[2];
  assert.equal(unverifiedCand.verification.status, 'UNVERIFIED_EXCERPT');
  await assert.rejects(
    async () => {
      await saveVerifiedExtractionProposalsOnServer(
        {
          projectId: 'proj_1',
          episodeId: 'ep_1',
          revisionId: 'rev_1',
          analysisRunId: analysisRes.analysisRunId,
          analysisToken: analysisRes.analysisToken,
          selectedCandidateIds: [unverifiedCand.candidateId],
        },
        { db, verifiedOwnerId: 'owner_auth_1' }
      );
    },
    /UNVERIFIED_CANDIDATE_SAVE_FORBIDDEN/
  );

  // Step 4: Save ONLY the 1st verified candidate (without calling Gemini again!)
  const firstVerified = analysisRes.candidates[0];
  const saveRes1 = await saveVerifiedExtractionProposalsOnServer(
    {
      projectId: 'proj_1',
      episodeId: 'ep_1',
      revisionId: 'rev_1',
      analysisRunId: analysisRes.analysisRunId,
      analysisToken: analysisRes.analysisToken,
      selectedCandidateIds: [firstVerified.candidateId],
    },
    { db, verifiedOwnerId: 'owner_auth_1' }
  );

  assert.equal(geminiCallCount, 1); // Gemini was NOT called again!
  assert.equal(saveRes1.selectedCount, 1);
  assert.equal(saveRes1.createdCount, 1);
  assert.equal(saveRes1.skippedDuplicateCount, 0);
  assert.equal(saveRes1.savedProposals.length, 1);
  assert.equal(saveRes1.savedProposals[0].canonStatus, 'PROPOSED');

  // Verify raw Firestore document has native Timestamp for createdAt & updatedAt
  const savedPropId = saveRes1.savedProposals[0].id;
  const rawStoredDoc = store.get(
    `users/owner_auth_1/projects/proj_1/changeProposals/${savedPropId}`
  );
  assert.ok(rawStoredDoc);
  assert.equal(rawStoredDoc.createdAt instanceof Timestamp, true);
  assert.equal(rawStoredDoc.updatedAt instanceof Timestamp, true);

  // Step 5: Repeated save of the same candidate is atomically skipped (no duplicate created)
  const saveRes2 = await saveVerifiedExtractionProposalsOnServer(
    {
      projectId: 'proj_1',
      episodeId: 'ep_1',
      revisionId: 'rev_1',
      analysisRunId: analysisRes.analysisRunId,
      analysisToken: analysisRes.analysisToken,
      selectedCandidateIds: [firstVerified.candidateId],
    },
    { db, verifiedOwnerId: 'owner_auth_1' }
  );

  assert.equal(saveRes2.createdCount, 0);
  assert.equal(saveRes2.skippedDuplicateCount, 1);
  assert.equal(saveRes2.itemResults[0].disposition, 'SKIPPED_EXISTING_PROPOSED');

  const proposalsColAfterDup = await db
    .collection('users/owner_auth_1/projects/proj_1/changeProposals')
    .get();
  assert.equal(proposalsColAfterDup.size, 1);
});

test('Phase 4.2.1 Persistence 3: Existing REJECTED and CANON proposals are protected from overwrite and Revision change since analysis is blocked', async () => {
  const { db, store } = createInMemoryIsolatedMockFirestore('run_persist_sep_2');
  const manuscript =
    '카시안은 엘레나에게 무릎을 꿇고 기사의 맹세를 바쳤다.';

  seedAuthoritativeFirestoreProject(store, {
    ownerId: 'owner_auth_1',
    projectId: 'proj_1',
    episodeId: 'ep_1',
    revisionId: 'rev_1',
    manuscriptContent: manuscript,
  });

  const analysisRes = await executeServerManuscriptExtraction(
    {
      projectId: 'proj_1',
      episodeId: 'ep_1',
      revisionId: 'rev_1',
      persistProposals: false,
    },
    {
      db,
      verifiedOwnerId: 'owner_auth_1',
      mockExtractorFn: async () => ({
        rawResponse: {
          analysis_summary: '기사의 맹세',
          candidates: [
            {
              targetEntityType: 'RELATIONSHIP',
              proposedAction: 'CREATE',
              existingTargetEntityId: null,
              title: '카시안과 엘레나의 기사 서약',
              rationale: '기사의 맹세',
              beforeSummary: '없음',
              afterSummary: '주군과 수호기사',
              excerpt: '카시안은 엘레나에게 무릎을 꿇고 기사의 맹세를 바쳤다.',
              precedingContext: null,
              followingContext: null,
              sceneId: null,
              confidence: 0.92,
              dialogueClaimOnly: false,
              temporalContextType: 'PRESENT_EVENT',
              uncertaintyFlags: [],
              relationshipPayload: {
                sourceCharacterId: 'char_cassian',
                sourceCharacterName: '카시안',
                targetCharacterId: 'char_elena',
                targetCharacterName: '엘레나',
                relationType: '주군과 수호기사',
                affinityScore: 90,
                isDirectional: true,
                description: '충성 서약',
              },
              timelineEventPayload: null,
              foreshadowingPayload: null,
            },
          ],
        },
      }),
    }
  );

  const cand = analysisRes.candidates[0];
  const deterministicId = cand.proposalDraft!.id;

  // Pre-populate Firestore with an author-REJECTED proposal at that deterministic ID
  const originalRejectedCreatedAt = Timestamp.fromDate(
    new Date('2026-02-01T00:00:00.000Z')
  );
  store.set(
    `users/owner_auth_1/projects/proj_1/changeProposals/${deterministicId}`,
    {
      ...cand.proposalDraft,
      canonStatus: 'REJECTED',
      reviewedAt: '2026-02-02T00:00:00.000Z',
      createdAt: originalRejectedCreatedAt,
      updatedAt: originalRejectedCreatedAt,
    }
  );

  // Attempting to save when REJECTED proposal exists skips overwrite and preserves REJECTED status & createdAt
  const saveRejectedRes = await saveVerifiedExtractionProposalsOnServer(
    {
      projectId: 'proj_1',
      episodeId: 'ep_1',
      revisionId: 'rev_1',
      analysisRunId: analysisRes.analysisRunId,
      analysisToken: analysisRes.analysisToken,
      selectedCandidateIds: [cand.candidateId],
    },
    { db, verifiedOwnerId: 'owner_auth_1' }
  );

  assert.equal(saveRejectedRes.createdCount, 0);
  assert.equal(saveRejectedRes.skippedDuplicateCount, 1);
  assert.equal(
    saveRejectedRes.itemResults[0].disposition,
    'SKIPPED_EXISTING_REJECTED'
  );

  const storedAfterAttempt = store.get(
    `users/owner_auth_1/projects/proj_1/changeProposals/${deterministicId}`
  );
  assert.equal(storedAfterAttempt?.canonStatus, 'REJECTED');
  assert.equal(storedAfterAttempt?.createdAt, originalRejectedCreatedAt);

  // Modify Revision.content in Firestore after analysis -> save must reject with REVISION_CHANGED_SINCE_ANALYSIS
  store.set('users/owner_auth_1/projects/proj_1/revisions/rev_1', {
    ...store.get('users/owner_auth_1/projects/proj_1/revisions/rev_1')!,
    content: '완전히 수정된 새로운 리비전 원고 본문입니다.',
  });

  await assert.rejects(
    async () => {
      await saveVerifiedExtractionProposalsOnServer(
        {
          projectId: 'proj_1',
          episodeId: 'ep_1',
          revisionId: 'rev_1',
          analysisRunId: analysisRes.analysisRunId,
          analysisToken: analysisRes.analysisToken,
          selectedCandidateIds: [cand.candidateId],
        },
        { db, verifiedOwnerId: 'owner_auth_1' }
      );
    },
    /REVISION_CHANGED_SINCE_ANALYSIS/
  );
});
