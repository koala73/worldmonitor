export const SEVERITY_SCORE = {
  'AIS_DISRUPTION_SEVERITY_LOW': 1,
  'AIS_DISRUPTION_SEVERITY_ELEVATED': 2,
  'AIS_DISRUPTION_SEVERITY_HIGH': 3,
};

export function computeDisruptionScore(warningCount, congestionSeverity) {
  return Math.min(100, warningCount * 15 + congestionSeverity * 30);
}

export function scoreToStatus(score) {
  if (score < 20) return 'green';
  if (score < 50) return 'yellow';
  return 'red';
}

export function computeHHI(shares) {
  if (!shares || shares.length === 0) return 0;
  return shares.reduce((sum, s) => sum + s * s, 0);
}

export function riskRating(hhi) {
  if (hhi >= 5000) return 'critical';
  if (hhi >= 2500) return 'high';
  if (hhi >= 1500) return 'moderate';
  return 'low';
}

export function detectSpike(history) {
  if (!history || history.length < 3) return false;
  const values = history.map(h => typeof h === 'number' ? h : h.value).filter(v => Number.isFinite(v));
  if (values.length < 3) return false;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  const stdDev = Math.sqrt(variance);
  if (stdDev === 0) return false;
  const latest = values[values.length - 1];
  return latest > mean + 2 * stdDev;
}
