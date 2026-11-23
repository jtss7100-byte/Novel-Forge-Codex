import type { PromptProfile, WritingContextBundle, WritingResult } from '../types/aiEngine';
import type { BlindAbPairItem } from '../types/literaryRewriting';
import type { EvaluationArm, EvaluationBlindPair, EvaluationCase, EvaluationManifest, EvaluationProfileTrace, EvaluationRating, EvaluationScenarioId } from '../types/novelWritingEvaluation';
import { EVALUATION_DIMENSIONS, EVALUATION_INTEGRITY_CODES } from '../types/novelWritingEvaluation';
import { assembleNovelWriterPromptInOrder, sanitizeEmbeddedDataAgainstCommandInjection } from './aiEngineLogic';
import { extractStylePromptMetadata } from './authorStyleLogic';
import { collectVoiceEvidence, extractVoiceExcerpts, readApprovedVoiceSources } from './characterVoiceLogic';
import { randomizeBlindSides, resolveBlindChoiceToPreference, summarizeBlindAbRatings } from './literaryEvaluationHarness';
import { computeManuscriptContentHash } from './manuscriptIntegrity';
import { EVALUATION_DATASET_VERSION, toActivePrompt, type EvaluationFixture } from './novelWritingEvaluationBenchmark';
import type { EvaluationIntegrityCode } from '../types/novelWritingEvaluation';

export function evaluationFingerprint(value: unknown): string {
  return computeManuscriptContentHash(JSON.stringify(value, (_key, item: unknown) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return item;
    return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  }));
}

function profileTrace(profile: PromptProfile, context: WritingContextBundle): EvaluationProfileTrace {
  const version = profile.versions.find((item) => item.versionId === profile.currentVersionId);
  const isApproved = profile.promptType === 'PROJECT_STYLE_PROFILE'
    ? Boolean(extractStylePromptMetadata(profile.content).approvedAt && extractStylePromptMetadata(profile.content).sourceHash)
    : readApprovedVoiceSources(profile.content).length > 0;
  if (!profile.isActive || profile.ownerId !== context.ownerId || profile.projectId !== context.projectId ||
      !version || version.versionNumber !== profile.currentVersionNumber || version.content !== profile.content || !isApproved) {
    throw new Error('INVALID_APPROVED_PROFILE_VERSION');
  }
  return {
    profileId: profile.id, versionId: version.versionId, contentHash: computeManuscriptContentHash(version.content),
    projectId: profile.projectId, targetCharacterId: profile.targetCharacterId, active: true, approval: 'APPROVED_SYNTHETIC_FIXTURE',
  };
}

export function prepareEvaluationArm(fixture: EvaluationFixture, arm: EvaluationArm) {
  const { plan } = fixture;
  const scenePlan = plan.scenes[0];
  const source = fixture.context;
  const styleProfiles = arm === 'STYLE_ONLY' || arm === 'STYLE_AND_VOICE' ? [fixture.style] : [];
  const voiceProfiles = arm === 'VOICE_ONLY' || arm === 'STYLE_AND_VOICE'
    ? fixture.voice.filter((profile) => profile.targetCharacterId && scenePlan.characterIds.includes(profile.targetCharacterId) &&
      source.sceneCharacterIds?.includes(profile.targetCharacterId) && profile.isActive &&
      profile.projectId === source.projectId && profile.ownerId === source.ownerId)
    : [];
  const style = styleProfiles.map((profile) => profileTrace(profile, source));
  const voice = voiceProfiles.map((profile) => profileTrace(profile, source));
  const context = {
    ...source, activePrompts: [...source.activePrompts, ...[...styleProfiles, ...voiceProfiles].map(toActivePrompt)],
  };
  const assembled = assembleNovelWriterPromptInOrder({
    context, scenePlan, totalScenesInPlan: plan.scenes.length, episodeGoal: plan.episodeGoal,
    previousSceneEndingExcerpt: context.previousEpisodeTailExcerpt || '회차 첫 장면 시작',
    retainDefaultStyleGuidance: true,
  });
  if (!assembled.resolvedPerspective.perspective) throw new Error('INVALID_EVALUATION_POV');
  // Remove only the exact added records. All other text, including generic fallback guidance, remains comparable.
  let controlledPrompt = assembled.orderedPrompt;
  for (const profile of styleProfiles) {
    controlledPrompt = removeExactAddition(controlledPrompt,
      `### ${profile.title} (${profile.currentVersionId})\n${sanitizeEmbeddedDataAgainstCommandInjection(profile.content)}\n`);
  }
  for (const profile of voiceProfiles) {
    controlledPrompt = removeExactAddition(controlledPrompt,
      `\n\n### ${profile.title} (${profile.currentVersionId}) · 발화 인물 ID: ${profile.targetCharacterId}\n${profile.content}`);
  }
  return { context, style, voice, controlledPrompt, prompt: assembled.orderedPrompt, perspective: assembled.resolvedPerspective.perspective };
}

function removeExactAddition(whole: string, addition: string) {
  if (!whole.includes(addition) || whole.indexOf(addition) !== whole.lastIndexOf(addition)) throw new Error('PROFILE_PROMPT_TRACE_MISMATCH');
  return whole.replace(addition, '');
}

export function assertControlledPrompts(baseline: string, treatment: string, baselineSystem: string, treatmentSystem: string) {
  if (baseline !== treatment || baselineSystem !== treatmentSystem) throw new Error('CONTROLLED_PROMPT_MISMATCH');
}

export function buildEvaluationManifest(fixture: EvaluationFixture, controlledPrompt: string, modelId: string,
  perspective: EvaluationManifest['perspective'], system: string, modelConfig: unknown, qualityCriteria: unknown): EvaluationManifest {
  const { context, plan } = fixture;
  return {
    modelId, datasetVersion: EVALUATION_DATASET_VERSION, writingPlanFingerprint: evaluationFingerprint(plan),
    canonFingerprint: evaluationFingerprint([context.canonCharacters, context.canonWorldbuilding, context.approvedExceptions]),
    ragFingerprint: evaluationFingerprint(context.retrievedMemoryChunks),
    controlsFingerprint: evaluationFingerprint([system, controlledPrompt, modelConfig]),
    qualityCriteriaFingerprint: evaluationFingerprint(qualityCriteria),
    perspective, characters: [...(context.sceneCharacterIds ?? [])], targetLength: plan.scenes[0].targetCharCount,
  };
}

export function checkEvaluationIntegrity(fixture: EvaluationFixture, result: WritingResult): EvaluationIntegrityCode[] {
  const violations = new Set<EvaluationIntegrityCode>();
  if (result.status === 'COMPLETED' &&
      evaluationFingerprint(result.referencedMemoryChunks) !== evaluationFingerprint(fixture.context.retrievedMemoryChunks)) violations.add('RAG_PROVENANCE_FAILURE');
  if (result.executionState === 'BLOCKED_CONFLICT' || result.issues.some((issue) => issue.schemaSeverity === 'CRITICAL_BLOCK')) violations.add('CANON_VIOLATION');
  const text = result.manuscript;
  if (!text) return [...violations];
  if (!fixture.scene.witness.test(text)) violations.add('MISSING_REQUIRED_EVENT');
  if (/순간이동|공간 이동 마법으로|되살아났|부활했|상태창이 (떠|열)/.test(text)) violations.add('FORBIDDEN_DEVELOPMENT');
  if (/왼팔.{0,12}(멀쩡|부상이 없)|경보종.{0,12}(금이 없|새것)/.test(text)) violations.add('CANON_VIOLATION');
  if (/\[시점\s*:|카엘은 알지 못했지만|세라피나의 속마음은/.test(text) ||
      (fixture.scenarioId === 'NW11' && /서신에는 외벽 암호가 적혀 있었다/.test(text))) violations.add('POV_VIOLATION');
  if (/카엘은 경비대장이었|세라피나는 수습 기사였/.test(text)) violations.add('CHARACTER_IDENTITY_DRIFT');
  if (result.appResult?.proposals.some((proposal) => proposal.resolution_type === 'PERMANENT_LORE_UPDATE' || proposal.resolution_type === 'CANON_PROMOTION')) violations.add('UNAPPROVED_NEW_FACT');
  const excerpts = extractVoiceExcerpts(text, fixture.context.canonCharacters);
  const voiceLeakage = excerpts.some((excerpt) => excerpt.characterId && !fixture.context.sceneCharacterIds?.includes(excerpt.characterId)) ||
    ['kael', 'sera'].some((id) => collectVoiceEvidence(excerpts, id).some((excerpt) => /쇠종의 그림자/.test(excerpt.text))) ||
    collectVoiceEvidence(excerpts, 'sera').some((excerpt) => /대장님[,.!\s]/.test(excerpt.text));
  if (voiceLeakage) violations.add('CHARACTER_VOICE_LEAKAGE');
  return [...violations];
}

export function isCompleteEvaluationResult(result: Pick<WritingResult, 'status' | 'executionState' | 'sceneOutputs' | 'manuscript'>) {
  return result.status === 'COMPLETED' && result.executionState === 'DRAFT_READY' &&
    result.sceneOutputs?.length === 1 && result.manuscript.trim().length >= 50;
}

export function makeEvaluationBlindPair(inputs: {
  seed: string; caseId: string; scenarioId: EvaluationScenarioId; title: string; goal: string; baseline: string; treatment: string; index: number;
}) {
  const { flip } = randomizeBlindSides(inputs.seed, inputs.caseId, inputs.index);
  const id = evaluationFingerprint([inputs.seed, inputs.caseId, inputs.index]).slice('sha256_'.length, 'sha256_'.length + 24);
  const pair: EvaluationBlindPair = {
    pairId: `blind_${id}`, scenarioId: inputs.scenarioId, title: inputs.title, goal: inputs.goal,
    optionA: flip ? inputs.treatment : inputs.baseline, optionB: flip ? inputs.baseline : inputs.treatment,
  };
  const assignment: BlindAbPairItem['hiddenSideAssignment'] = flip ? 'A_REWRITE_B_ORIGINAL' : 'A_ORIGINAL_B_REWRITE';
  return { pair, assignment, caseId: inputs.caseId };
}

export type HiddenEvaluationPair = ReturnType<typeof makeEvaluationBlindPair>;

export function summarizeWritingEvaluation(cases: EvaluationCase[], pairs: HiddenEvaluationPair[], ratings: EvaluationRating[]) {
  const comparable = cases.filter((entry) => entry.comparable);
  const byPair = new Map(ratings.map((rating) => [rating.pairId, rating]));
  const human = summarizeBlindAbRatings(pairs.map(({ pair, assignment }) => {
    const choice = byPair.get(pair.pairId)?.choice;
    return { preference: resolveBlindChoiceToPreference({ choice: choice && choice !== 'DEFER' ? choice : 'NOT_RATED', hiddenSideAssignment: assignment }) };
  }));
  const deltas = EVALUATION_DIMENSIONS.map((dimension) => {
    const values = comparable.flatMap(({ baseline, treatment }) => {
      const a = baseline.scores[dimension], b = treatment.scores[dimension];
      return a == null || b == null ? [] : [b - a];
    }).sort((a, b) => a - b);
    const midpoint = Math.floor(values.length / 2);
    const mean = values.length ? values.reduce((sum, score) => sum + score, 0) / values.length : null;
    const median = values.length ? (values[midpoint] + values[Math.floor((values.length - 1) / 2)]) / 2 : null;
    const standardDeviation = mean !== null && values.length > 1
      ? Math.sqrt(values.reduce((sum, score) => sum + (score - mean) ** 2, 0) / (values.length - 1)) : null;
    return { dimension, mean, median, standardDeviation, samples: values.length };
  });
  const counts = (arm: 'baseline' | 'treatment') => Object.fromEntries(EVALUATION_INTEGRITY_CODES.map((code) =>
    [code, cases.filter((entry) => entry[arm].issues.includes(code)).length]));
  return {
    total: cases.length, comparable: comparable.length, excluded: cases.length - comparable.length,
    human: { ...human, status: human.ratedCount ? 'RATED' as const : 'NOT_RATED' as const },
    deltas, integrity: { baseline: counts('baseline'), treatment: counts('treatment') },
  };
}

export type EvaluationSummary = ReturnType<typeof summarizeWritingEvaluation>;
