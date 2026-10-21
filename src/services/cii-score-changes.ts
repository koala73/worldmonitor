import type { CountryScore } from './country-instability';

export interface DetectedCiiScoreChange {
  score: CountryScore;
  previousScore: number;
}

export function detectCiiScoreChanges(
  scores: CountryScore[],
  previousScores: ReadonlyMap<string, number>,
  inLearningMode: boolean,
): { changes: DetectedCiiScoreChange[]; nextScores: Map<string, number> } {
  const changes: DetectedCiiScoreChange[] = [];
  const nextScores = new Map(previousScores);

  for (const score of scores) {
    const previousScore = previousScores.get(score.code);
    if (previousScore !== undefined && !inLearningMode && Math.abs(score.score - previousScore) >= 10) {
      changes.push({ score, previousScore });
    }
    nextScores.set(score.code, score.score);
  }

  return { changes, nextScores };
}
