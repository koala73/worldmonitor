export interface CiiScoreBand {
  readonly min: number;
  readonly label: string;
}

export const CII_SCORE_BANDS: ReadonlyArray<CiiScoreBand>;
export function instabilityBand(score: unknown): string | null;
