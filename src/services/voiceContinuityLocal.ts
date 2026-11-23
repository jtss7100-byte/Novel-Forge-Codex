import type { ContinuityDecisionDimension, VoiceContinuityDecisionRecord, VoiceContinuityIdentity, VoiceDecisionAudit, VoiceDecisionCommand, VoiceDecisionScope } from '../types/voiceContinuityDecision';
import { normalizeDecisionCommand, prepareVoiceDecisionWrite, replayVoiceDecision, sameVoiceScope, VOICE_DECISION_DIMENSIONS } from '../utils/voiceContinuityDecisionLogic';

type KeyValueStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;
type LocalSnapshot = { records: VoiceContinuityDecisionRecord[]; audits: VoiceDecisionAudit[] };

const scopeKey = (scope: VoiceDecisionScope) => `${scope.ownerId}:${scope.projectId}:${scope.characterId}`;
const decisionStoreKey = (scope: VoiceDecisionScope) => `nf_voice_decisions_v1:${scopeKey(scope)}`;
const pendingKey = (scope: VoiceDecisionScope, id: string, cloud: boolean) => `nf_voice_pending_v1:${cloud ? 'cloud' : 'local'}:${scopeKey(scope)}:${id}`;

function readLocalSnapshot(storage: KeyValueStorage, scope: VoiceDecisionScope): LocalSnapshot {
  const value = storage.getItem(decisionStoreKey(scope));
  if (value === null) return { records: [], audits: [] };
  const read = JSON.parse(value) as LocalSnapshot;
  if (!Array.isArray(read.records) || !Array.isArray(read.audits) ||
      !read.records.every((entry) => entry && sameVoiceScope(entry, scope)) ||
      !read.audits.every((entry) => entry && sameVoiceScope(entry, scope) && sameVoiceScope(entry.record, scope))) {
    throw new Error('로컬 판단 기록을 읽지 못했습니다.');
  }
  return read;
}

export function listLocalVoiceDecisions(storage: KeyValueStorage, scope: VoiceDecisionScope): VoiceContinuityDecisionRecord[] {
  return readLocalSnapshot(storage, scope).records;
}

export function listLocalVoiceAudits(storage: KeyValueStorage, scope: VoiceDecisionScope, decisionId: string): VoiceDecisionAudit[] {
  return readLocalSnapshot(storage, scope).audits.filter((entry) => entry.decisionId === decisionId);
}

export function commitLocalVoiceDecision(storage: KeyValueStorage, identity: VoiceContinuityIdentity, input: VoiceDecisionCommand) {
  const command = normalizeDecisionCommand(input);
  const snapshot = readLocalSnapshot(storage, identity);
  const replay = replayVoiceDecision(identity, command, snapshot.audits.find((audit) => audit.id === command.operationId) ?? null);
  if (replay) return replay;
  const current = snapshot.records.find((record) => record.id === identity.id) ?? null;
  const { result, audit } = prepareVoiceDecisionWrite(identity, command, current, new Date().toISOString());
  storage.setItem(decisionStoreKey(identity), JSON.stringify({
    records: [...snapshot.records.filter((record) => record.id !== identity.id), result.record],
    audits: [...snapshot.audits, audit],
  }));
  return result;
}

export function readVoiceDecisionDraft(storage: KeyValueStorage, scope: VoiceDecisionScope, id: string, cloud: boolean) {
  const saved = storage.getItem(pendingKey(scope, id, cloud));
  if (!saved) return undefined;
  try {
    const input = normalizeDecisionCommand(JSON.parse(saved) as VoiceDecisionCommand);
    return input.decisionId === id ? input : undefined;
  } catch { return undefined; }
}

export function writeVoiceDecisionDraft(storage: KeyValueStorage, scope: VoiceDecisionScope, command: VoiceDecisionCommand, cloud: boolean) {
  storage.setItem(pendingKey(scope, command.decisionId, cloud), JSON.stringify(command));
}

export function clearVoiceDecisionDraft(storage: KeyValueStorage, scope: VoiceDecisionScope, command: VoiceDecisionCommand, cloud: boolean) {
  if (readVoiceDecisionDraft(storage, scope, command.decisionId, cloud)?.operationId === command.operationId) {
    storage.removeItem(pendingKey(scope, command.decisionId, cloud));
  }
}

export interface LegacyVoiceDecision {
  key: string;
  ownerId: string;
  projectId: string;
  characterId: string;
  beforeRevisionId: string;
  beforeContentHash: string;
  afterRevisionId: string;
  afterContentHash: string;
  dimension: ContinuityDecisionDimension;
  value: 'intent' | 'review';
}

const hash = /^sha256_[a-f0-9]{64}$/;
const id = /^[a-zA-Z0-9_-]{1,128}$/;
export function listLegacyVoiceDecisions(storage: KeyValueStorage, scope: VoiceDecisionScope, showLocalWorkspace: boolean) {
  const legacy: LegacyVoiceDecision[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (!key?.startsWith('nf_voice:')) continue;
    const [, ownerId, projectId, characterId, beforeRevisionId, beforeContentHash, afterRevisionId, afterContentHash, dimension, leftover] = key.split(':');
    if ((ownerId !== scope.ownerId && !(showLocalWorkspace && ownerId === 'local_author')) ||
        projectId !== scope.projectId || characterId !== scope.characterId || leftover !== undefined ||
        !id.test(beforeRevisionId) || !id.test(afterRevisionId) || !hash.test(beforeContentHash) || !hash.test(afterContentHash)) continue;
    const knownDimension = VOICE_DECISION_DIMENSIONS.find((item) => item === dimension);
    const value = storage.getItem(key);
    if (knownDimension && (value === 'intent' || value === 'review')) {
      legacy.push({ key, ownerId, projectId, characterId, beforeRevisionId, beforeContentHash,
        afterRevisionId, afterContentHash, dimension: knownDimension, value });
    }
  }
  return legacy;
}

export function legacyMatchesSources(legacy: LegacyVoiceDecision, identity: VoiceContinuityIdentity): boolean {
  return legacy.projectId === identity.projectId && legacy.characterId === identity.characterId &&
    legacy.beforeRevisionId === identity.beforeRevisionId && legacy.afterRevisionId === identity.afterRevisionId &&
    legacy.beforeContentHash === identity.beforeContentHash && legacy.afterContentHash === identity.afterContentHash &&
    legacy.dimension === identity.dimension;
}
