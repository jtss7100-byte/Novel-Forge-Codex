import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  ENTITY_CONSTRAINTS,
  isValidEntityId,
  validateCharacterInput,
  validateEpisodeInput,
  validateProjectInput,
  validateWorldbuildingInput,
} from './novelLogic';
import { FOUNDATION_CONSTRAINTS } from './foundationLogic';

const rulesContent = fs
  .readFileSync(path.resolve(process.cwd(), 'firestore.rules'), 'utf8')
  .replace(/\r\n/g, '\n');
const blueprintContent = JSON.parse(
  fs.readFileSync(path.resolve(process.cwd(), 'firebase-blueprint.json'), 'utf8')
);

test('firestore.rules contains all Phase 1 (5) and Phase 1.5 (8) collections and global default-deny', () => {
  assert.ok(rulesContent.includes("rules_version = '2';"));
  assert.ok(rulesContent.includes('match /{document=**} {\n      allow read, write: if false;\n    }'));
  // Phase 1 collections
  assert.ok(rulesContent.includes('match /users/{uid}/projects/{projectId}'));
  assert.ok(rulesContent.includes('match /characters/{characterId}'));
  assert.ok(rulesContent.includes('match /worldbuilding/{itemId}'));
  assert.ok(rulesContent.includes('match /episodes/{episodeId}'));
  assert.ok(rulesContent.includes('match /revisions/{revisionId}'));
  // Phase 1.5 collections
  assert.ok(rulesContent.includes('match /scenes/{sceneId}'));
  assert.ok(rulesContent.includes('match /foreshadowings/{foreshadowingId}'));
  assert.ok(rulesContent.includes('match /relationships/{relationshipId}'));
  assert.ok(rulesContent.includes('match /timelineEvents/{eventId}'));
  assert.ok(rulesContent.includes('match /memoryDocuments/{documentId}'));
  assert.ok(rulesContent.includes('match /memoryChunks/{chunkId}'));
  assert.ok(rulesContent.includes('match /styleProfiles/{profileId}'));
  assert.ok(rulesContent.includes('match /changeProposals/{proposalId}'));
  // Phase 2 collections
  assert.ok(rulesContent.includes('match /writingPromptProfiles/{profileId}'));
  assert.ok(rulesContent.includes('match /writingPlans/{planId}'));
  assert.ok(blueprintContent.entities.WritingPromptProfile);
  assert.ok(blueprintContent.entities.WritingPlan);
  // Phase 4.2.2 Stage 2B / 2.5C server-only audit, task, and staging collections
  assert.ok(rulesContent.includes('match /changeProposalApprovalAudits/{auditId}'));
  assert.ok(rulesContent.includes('match /ragSyncTasks/{taskId}'));
  assert.ok(rulesContent.includes('match /ragGenerationStaging/{stagingId}'));
  assert.ok(blueprintContent.entities.ChangeProposalApprovalAudit);
  assert.ok(blueprintContent.entities.RagSyncTask);
  assert.ok(blueprintContent.entities.RagGenerationStagingReceipt);
});

test('Dirty Dozen security invariants and blueprint synchronicity hold across Phase 1 and Phase 1.5', () => {
  // 1. Unverified email blocked on writes
  assert.ok(rulesContent.includes('request.auth.token.email_verified == true'));
  // 2. Owner check on every collection
  assert.ok(rulesContent.includes('request.auth.uid == uid'));
  // 3. Master gate relational check on subcollections
  assert.ok(rulesContent.includes('isParentProjectOwner(uid, projectId)'));
  // 4. Shadow field protection via hasOnly
  assert.ok(rulesContent.includes('affectedKeys().hasOnly'));
  // 5. ID poisoning regex guard
  assert.equal(isValidEntityId('bad/id$!'), false);
  assert.equal(isValidEntityId('a'.repeat(129)), false);
  // 6. Revisions and MemoryChunks are immutable (allow update: if false)
  assert.ok(rulesContent.includes('allow update: if false;'));
  // 7. Blueprint maxLengths match ENTITY_CONSTRAINTS and FOUNDATION_CONSTRAINTS
  assert.equal(
    blueprintContent.entities.Project.properties.title.maxLength,
    ENTITY_CONSTRAINTS.PROJECT.TITLE_MAX
  );
  assert.equal(
    blueprintContent.entities.Episode.properties.title.maxLength,
    ENTITY_CONSTRAINTS.EPISODE.TITLE_MAX
  );
  assert.equal(
    blueprintContent.entities.Foreshadowing.properties.title.maxLength,
    FOUNDATION_CONSTRAINTS.FORESHADOWING.TITLE_MAX
  );
  assert.equal(
    blueprintContent.entities.ChangeProposal.properties.proposedPayloadJson.maxLength,
    FOUNDATION_CONSTRAINTS.CHANGE_PROPOSAL.PAYLOAD_JSON_MAX
  );
  // 8-12. Validators reject oversized or invalid status payloads
  assert.equal(
    validateProjectInput({
      title: '가'.repeat(121),
      genre: '판타지',
      synopsis: '',
      status: 'draft',
    }).valid,
    false
  );
  assert.equal(
    validateEpisodeInput({
      episodeNumber: 1,
      title: '가'.repeat(151),
      content: '',
      synopsis: '',
      authorNote: '',
      status: 'draft',
    }).valid,
    false
  );
  assert.equal(
    validateCharacterInput({
      name: '카엘',
      role: '주인공',
      affiliation: '',
      appearance: '가'.repeat(2001),
      personality: '',
      background: '',
      abilities: '',
      status: 'draft',
    }).valid,
    false
  );
  assert.equal(
    validateWorldbuildingInput({
      title: '세계관',
      category: '마법',
      summary: '가'.repeat(501),
      content: '',
      rules: '',
      status: 'confirmed',
    }).valid,
    false
  );
});
