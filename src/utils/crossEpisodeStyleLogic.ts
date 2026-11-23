import type { ContinuityFinding, ContinuitySample, StyleContinuityFindingStatus, StyleContinuityReport } from '../types/styleContinuity';

export function compareEpisodeStyles(samples: ContinuitySample[]): StyleContinuityReport {
  const findings: ContinuityFinding[] = [];
  for (let after = 1; after < samples.length; after++) {
    const before = after - 1;
    const a = samples[before];
    const b = samples[after];
    const sceneChange = a.sceneKind !== 'UNKNOWN' && b.sceneKind !== 'UNKNOWN' && a.sceneKind !== b.sceneKind;
    const sameEpisode = a.source.episodeId === b.source.episodeId;
    const enough = a.style.sentenceCount >= 5 && b.style.sentenceCount >= 5 &&
      !a.style.hasCriticalInsufficientSample && !b.style.hasCriticalInsufficientSample;
    const add = (dimension: ContinuityFinding['dimension'], status: StyleContinuityFindingStatus, description: string, strong = false) =>
      findings.push({ id: `${before}:${after}:${dimension}`, dimension, status, description, confidence: strong ? 'MEDIUM' : 'LOW', before, after });
    const compare = (dimension: ContinuityFinding['dimension'], label: string, changed: boolean, comparable = enough) =>
      add(dimension, !comparable ? 'INSUFFICIENT_EVIDENCE' : !changed ? 'CONSISTENT' : sceneChange ? 'INTENTIONAL_VARIATION' : 'POTENTIAL_DRIFT',
        `${label}${sameEpisode ? ' · 같은 회차의 두 Revision' : ''}${changed && sceneChange ? ' · 지정된 장면 유형 차이' : ''}`,
        comparable && a.sceneKind !== 'UNKNOWN' && b.sceneKind !== 'UNKNOWN');
    const diff = (x: number, y: number, threshold: number) => Math.abs(x - y) >= threshold;
    compare('SENTENCE', '문장 평균 길이와 단문 비율', diff(a.style.avgSentenceLengthChars, b.style.avgSentenceLengthChars, 12) && diff(a.style.shortSentenceRatio, b.style.shortSentenceRatio, 0.25));
    compare('PARAGRAPH', '문단당 문장 수와 단문단 비율', diff(a.style.avgSentencesPerParagraph, b.style.avgSentencesPerParagraph, 1) && diff(a.style.singleSentenceParagraphRatio, b.style.singleSentenceParagraphRatio, 0.25), enough && Math.min(a.style.paragraphCount, b.style.paragraphCount) >= 3);
    const sameCast = JSON.stringify([...a.characterIds].sort()) === JSON.stringify([...b.characterIds].sort()) && a.characterIds.length > 0;
    compare('DIALOGUE', '동일 등장인물 구성에서의 대사 비중', diff(a.style.dialogueRatioPercent, b.style.dialogueRatioPercent, 24), enough && sameCast && a.style.dialogueCount >= 3 && b.style.dialogueCount >= 3);
    const aPov = a.style.observedPerspectiveHints;
    const bPov = b.style.observedPerspectiveHints;
    const povEnough = enough && aPov.suggestedObservedTendency !== 'MIXED_OR_UNCERTAIN' && bPov.suggestedObservedTendency !== 'MIXED_OR_UNCERTAIN';
    const povChanged = aPov.suggestedObservedTendency !== bPov.suggestedObservedTendency;
    compare('POV', '관찰된 시점 단서. 설정된 동적 시점을 변경하지 않습니다.', povChanged, povEnough);
    compare('DISTANCE', '서술 거리의 간접 단서: 서술부 시점 단서 분포', povChanged, povEnough);
    compare('PSYCHOLOGY', '내면 접근의 간접 단서: 문장당 1인칭 서술 단서', diff(aPov.firstPersonCueCount / Math.max(1, a.style.sentenceCount), bPov.firstPersonCueCount / Math.max(1, b.style.sentenceCount), 0.4), povEnough && !povChanged);
    compare('TRANSITION', '열 문장당 전환 표현 빈도', diff(a.style.transitionCueDensityPerTenSentences, b.style.transitionCueDensityPerTenSentences, 3), enough && Math.min(a.style.sentenceCount, b.style.sentenceCount) >= 10);
    const voiceEnough = a.voice.count >= 3 && b.voice.count >= 3 &&
      (a.voice.polite + a.voice.informal >= 2) && (b.voice.polite + b.voice.informal >= 2);
    const dominantEnding = (sample: ContinuitySample) =>
      Object.entries(sample.voice.endings).sort((left, right) => right[1] - left[1])[0];
    const aEnding = dominantEnding(a);
    const bEnding = dominantEnding(b);
    const shiftedEnding = aEnding && bEnding && aEnding[0] !== bEnding[0] &&
      aEnding[1] / a.voice.count >= 0.6 && bEnding[1] / b.voice.count >= 0.6;
    const changedVoice = diff(a.voice.polite / Math.max(1, a.voice.count), b.voice.polite / Math.max(1, b.voice.count), 0.5) || shiftedEnding;
    const variation = changedVoice && ((!sameEpisode && b.canonRelationshipChange) || sceneChange);
    add('VOICE', !voiceEnough ? 'INSUFFICIENT_EVIDENCE' : !changedVoice ? 'CONSISTENT' : variation ? 'INTENTIONAL_VARIATION' : 'POTENTIAL_DRIFT',
      variation ? '화법 변화에 해당 회차의 확정 관계 또는 지정된 장면 차이 근거가 있습니다. 작가 확인이 필요합니다.'
        : `확인된 화자의 존비칭 및 주요 종결 표현 비교${aEnding && bEnding ? `: ${aEnding[0]} → ${bEnding[0]}` : ''}`,
      voiceEnough && Math.min(a.voice.count, b.voice.count) >= 5);
  }
  return { samples, findings };
}
