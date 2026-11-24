import test from 'node:test';
import assert from 'node:assert/strict';
import type { MemoryKnowledgeAnnotation, MemoryKnowledgeSource } from '../types/memoryKnowledge';
import { annotationEligibility, compareKnowledgePosition, hasKnowledgeScopeConflict, proposeMemoryKnowledge } from './memoryKnowledgeLogic';
import { memoryAnnotationId, memoryKnowledgeSource, memoryKnowledgeWriteSchema } from '../server/memoryKnowledgeStore';
import { selectSceneMemory, sceneMemoryBudget, verifySceneMemoryProvenance } from './sceneMemoryLogic';
import { benchmarkMemory, memoryBenchRequirements } from './sceneMemoryBenchmark';
import { buildEvaluationFixture } from './novelWritingEvaluationBenchmark';
import { assembleNovelWriterPromptInOrder } from './aiEngineLogic';
import { runLegacyKnowledgeBenchmark } from './memoryKnowledgeBenchmark';

const requirements = { ...memoryBenchRequirements, episodeId: 'same', episodeNumber: 300, sceneNumber: 3 };
const source: MemoryKnowledgeSource = {
  sourceEntityType: 'SCENE', sourceEntityId: 'learn', sourceRevisionId: 'rev10', sourceContentHash: 'a'.repeat(64),
  sourceStartOffset: 4, sourceEndOffset: 18,
};
const slot = memoryAnnotationId(source);
const clock = '2026-01-01T00:00:00.000Z';
const approval: MemoryKnowledgeAnnotation = {
  id: slot, ownerId: 'author', projectId: requirements.projectId, source, scope: 'CHARACTERS', classification: 'PAST_EVENT',
  verificationStatus: 'AUTHOR_CONFIRMED', version: 1, operationId: 'operation', createdAt: clock, updatedAt: clock, approvedBy: 'author',
  acquisition: [{ ...source, factId: slot, characterId: 'seorin', episodeId: 'same', sceneId: 'learn', method: 'DOCUMENT',
    position: { episodeId: 'same', episodeNumber: 300, sceneId: 'learn', sceneNumber: 2, eventId: 'event', order: 20 },
    proofHash: 'b'.repeat(64), verificationStatus: 'AUTHOR_CONFIRMED', approvedAt: clock, approvedBy: 'author' }],
};
const legacy = benchmarkMemory('learn', 300, '서린은 「은빛 문 뒤에 증표가 있다」라는 기록을 읽었다.', { episodeId: 'same', sceneNumber: 2, knowledge: undefined });

test('MK2 and MK3: CANON prose and participant IDs never imply public or character knowledge', () => {
  assert.deepEqual(proposeMemoryKnowledge(true), { candidateScope: 'UNKNOWN', candidateReason: 'SOURCE_EXCERPT' });
  assert.deepEqual(selectSceneMemory(requirements, [legacy], sceneMemoryBudget()).selected, []);
});

test('MK4: a quotation candidate comes from the verified exact excerpt', () => {
  assert.equal(proposeMemoryKnowledge(true, undefined, legacy.hit.chunk.content).candidateReason, 'DIRECT_QUOTE_REVIEW');
  assert.equal(proposeMemoryKnowledge(false, undefined, legacy.hit.chunk.content).candidateReason, 'UNVERIFIED');
  assert.equal(proposeMemoryKnowledge(true, { scope: 'AUTHOR_ONLY' }).candidateScope, 'AUTHOR_ONLY');
});

test('MK5: a candidate or rejected approval cannot grant access, including omniscient narration', () => {
  const source = { ...legacy.source, durableKnowledge: { ...approval, verificationStatus: 'REJECTED' as const } };
  assert.equal(selectSceneMemory({ ...requirements, perspective: 'OMNISCIENT', pointOfViewCharacterId: undefined },
    [{ hit: legacy.hit, source }], sceneMemoryBudget()).selected.length, 0);
});

test('MK13 and MK15: identity survives chunk ID changes and exact evidence still binds to its hash', () => {
  const original = memoryKnowledgeSource(legacy.hit.chunk, legacy.hit.document, legacy.source);
  assert.ok(original);
  const chunk = { ...legacy.hit.chunk, id: 'new_generation_chunk', indexGeneration: 2 };
  const moved = memoryKnowledgeSource(chunk, legacy.hit.document, legacy.source);
  assert.deepEqual(moved, original);
  const modified = { ...legacy.hit.chunk, content: '위조', contentHash: 'wrong' };
  assert.equal(memoryKnowledgeSource(modified, legacy.hit.document, legacy.source), undefined);
  assert.equal(verifySceneMemoryProvenance({ ownerId: 'synthetic-author', projectId: requirements.projectId,
    chunk: modified, document: legacy.hit.document, source: legacy.source, generation: 'ACTIVE' }), 'SOURCE_UNVERIFIED');
});

test('MK14: retired and deleted generations cannot become verified knowledge', () => {
  const params = { ownerId: legacy.source.ownerId, projectId: legacy.source.projectId, ...legacy.hit, source: legacy.source };
  assert.equal(verifySceneMemoryProvenance({ ...params, generation: 'RETIRED' }), 'RETIRED_GENERATION');
  assert.equal(verifySceneMemoryProvenance({ ...params, generation: 'DELETED' }), 'DELETED_SOURCE');
});

test('MK16 and MK17: both the fact and the acquisition must precede the target in the same episode', () => {
  const withApproval = { hit: legacy.hit, source: { ...legacy.source, durableKnowledge: approval } };
  assert.equal(selectSceneMemory(requirements, [withApproval], sceneMemoryBudget()).selected[0]?.selection.annotationVersion, 1);
  assert.equal(selectSceneMemory({ ...requirements, sceneNumber: 1 }, [withApproval], sceneMemoryBudget()).rejected[0]?.reason, 'FUTURE_INFORMATION');
  assert.equal(annotationEligibility(approval, { ...requirements, sceneNumber: 2 }), 'FUTURE_INFORMATION');
  assert.equal(compareKnowledgePosition(approval.acquisition[0].position, { ...requirements, sceneNumber: undefined }), 'UNKNOWN');
});

test('MK18: flashbacks require verified in-world acquisition order', () => {
  assert.equal(annotationEligibility(approval, { ...requirements, narrativeCutoff: { eventId: 'flashback', order: 10 } }), 'FUTURE_INFORMATION');
  const { order: _order, ...position } = approval.acquisition[0].position;
  assert.equal(annotationEligibility({ ...approval, acquisition: [{ ...approval.acquisition[0], position }] },
    { ...requirements, narrativeCutoff: { eventId: 'flashback', order: 30 } }), 'TEMPORAL_EVIDENCE_MISSING');
});

test('MK19 and MK20: POV swaps, inference, and author-only information cannot grant access', () => {
  assert.equal(annotationEligibility(approval, { ...requirements, pointOfViewCharacterId: 'other' }), 'POV_KNOWLEDGE_RESTRICTED');
  assert.equal(annotationEligibility({ ...approval, acquisition: [{ ...approval.acquisition[0], method: 'INFERRED' }] }, requirements), 'POV_KNOWLEDGE_RESTRICTED');
  assert.equal(annotationEligibility({ ...approval, scope: 'AUTHOR_ONLY' }, requirements), 'POV_KNOWLEDGE_RESTRICTED');
  assert.equal(hasKnowledgeScopeConflict({ scope: 'AUTHOR_ONLY' }, 'PUBLIC', []), true);
  assert.equal(hasKnowledgeScopeConflict({ scope: 'CHARACTERS', characterIds: ['seorin', 'other'] }, 'CHARACTERS', ['other', 'seorin']), false);
});

test('MK21: bulk approval accepts only explicit selections and unique operation and source scopes', () => {
  const command = { chunkId: 'chunk', source, operationId: 'op', expectedVersion: 0, scope: 'PUBLIC', classification: 'PAST_EVENT', acquisition: [] };
  const request = { confirmed: true, projectId: requirements.projectId, commands: [command] };
  assert.equal(memoryKnowledgeWriteSchema.safeParse(request).success, true);
  assert.equal(memoryKnowledgeWriteSchema.safeParse({ ...request, confirmed: false }).success, false);
  assert.equal(memoryKnowledgeWriteSchema.safeParse({ ...request, commands: [command, { ...command, operationId: 'changed' }] }).success, false);
  assert.equal(memoryKnowledgeWriteSchema.safeParse({ ...request, commands: Array(17).fill(command) }).success, false);
});

test('MK24: the synthetic A/B writer snapshot retains its existing proof format', () => {
  const fixture = buildEvaluationFixture('NW8', 'test-writer');
  const rendered = assembleNovelWriterPromptInOrder({ context: fixture.context, scenePlan: fixture.plan.scenes[0], totalScenesInPlan: 1 });
  assert.ok(rendered.orderedPrompt.includes(fixture.source.chunk.content));
  assert.ok(rendered.orderedPrompt.includes(fixture.source.chunk.sourceRevisionId));
  assert.doesNotMatch(rendered.orderedPrompt, /기억 승인/);
});

test('MK25: an unknown acquisition, unverified source, or unresolved annotation conflict fails closed', () => {
  assert.equal(annotationEligibility({ ...approval, acquisition: [{ ...approval.acquisition[0], method: 'UNKNOWN' }] }, requirements), 'POV_KNOWLEDGE_RESTRICTED');
  const legacyScope = { scope: 'CHARACTERS' as const, characterIds: ['seorin'], effectiveEventId: 'record-begins' };
  assert.equal(selectSceneMemory(requirements, [{ ...legacy, source: { ...legacy.source, knowledge: legacyScope, legacyKnowledge: legacyScope } }],
    sceneMemoryBudget()).rejected[0]?.reason, 'TEMPORAL_EVIDENCE_MISSING');
  assert.equal(verifySceneMemoryProvenance({ ownerId: legacy.source.ownerId, projectId: legacy.source.projectId,
    chunk: legacy.hit.chunk, document: legacy.hit.document, generation: 'ACTIVE' }), 'SOURCE_UNVERIFIED');
  assert.equal(selectSceneMemory(requirements, [{ ...legacy, source: { ...legacy.source, knowledgeRejection: 'KNOWLEDGE_SCOPE_CONFLICT' } }],
    sceneMemoryBudget()).rejected[0]?.reason, 'KNOWLEDGE_SCOPE_CONFLICT');
});

test('Legacy memory benchmark compares identical synthetic candidates before and after approval', () => {
  const { before, after } = runLegacyKnowledgeBenchmark();
  assert.equal(before.totalMemories, after.totalMemories);
  assert.equal(before.eligibleMemories, 0);
  assert.equal(after.eligibleMemories, 2);
  assert.equal(after.recallAtK, 1);
  assert.equal(after.precisionAtK, 1);
  assert.equal(after.futureLeaks + after.povLeaks + after.crossProjectLeaks, 0);
  console.info('Legacy knowledge benchmark', JSON.stringify({ before, after }));
});
