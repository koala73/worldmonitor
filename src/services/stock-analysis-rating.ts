export function getStockAnalysisRatingScore(
  snapshot: { signalScore: number; compositeScore?: number },
): number {
  return typeof snapshot.compositeScore === 'number' && Number.isFinite(snapshot.compositeScore)
    ? snapshot.compositeScore
    : snapshot.signalScore;
}

export function getStockAnalysisRatingSignal(
  snapshot: { signal: string; ratingSignal?: string },
): string {
  return snapshot.ratingSignal || snapshot.signal;
}

export function getStockAnalysisRatingSummary(
  snapshot: { summary: string; ratingSummary?: string },
): string {
  return snapshot.ratingSummary || snapshot.summary;
}

export function getStockAnalysisRatingAction(
  snapshot: { action: string; ratingAction?: string },
): string {
  return snapshot.ratingAction || snapshot.action;
}

export function getStockAnalysisRatingConfidence(
  snapshot: { confidence: string; ratingConfidence?: string },
): string {
  return snapshot.ratingConfidence || snapshot.confidence;
}

export function getStockAnalysisRatingWhyNow(
  snapshot: { whyNow: string; ratingWhyNow?: string },
): string {
  return snapshot.ratingWhyNow || snapshot.whyNow;
}

export function getStockAnalysisRatingBullishFactors(
  snapshot: { bullishFactors: string[]; ratingBullishFactors?: string[] },
): string[] {
  return Array.isArray(snapshot.ratingBullishFactors)
    ? snapshot.ratingBullishFactors
    : snapshot.bullishFactors;
}

export function getStockAnalysisRatingRiskFactors(
  snapshot: { riskFactors: string[]; ratingRiskFactors?: string[] },
): string[] {
  return Array.isArray(snapshot.ratingRiskFactors)
    ? snapshot.ratingRiskFactors
    : snapshot.riskFactors;
}
