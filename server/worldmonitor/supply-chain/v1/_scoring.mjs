export const SEVERITY_SCORE = {
  'AIS_DISRUPTION_SEVERITY_LOW': 1,
  'AIS_DISRUPTION_SEVERITY_ELEVATED': 2,
  'AIS_DISRUPTION_SEVERITY_HIGH': 3,
};

/**
 * Geopolitical threat levels — based on Lloyd's Joint War Committee
 * Listed Areas and real-world maritime security conditions.
 *
 *   war_zone (70) — Active naval conflict, blockade, or strait closure
 *   critical (40) — Active attacks on commercial shipping
 *   high     (30) — Military seizure risk, armed escort zones
 *   elevated (15) — Military tensions, disputed waters
 *   normal    (0) — No significant military threat
 */
export const THREAT_LEVEL = {
  war_zone: 70,
  critical: 40,
  high:     30,
  elevated: 15,
  normal:    0,
};

/**
 * Compute the navigational-warning component (0-15).
 * Each warning contributes 5 points, capped at 15.
 */
export function warningComponent(warningCount) {
  return Math.min(15, warningCount * 5);
}

/**
 * Compute the AIS-disruption component (0-15).
 *   severity 3 (high)     → 15
 *   severity 2 (elevated)  → 10
 *   severity 1 (low)       → 5
 *   severity 0 (none)      → 0
 */
export function aisComponent(maxCongestionSeverity) {
  return Math.min(15, maxCongestionSeverity * 5);
}

/**
 * Composite disruption score.
 *
 *   score = threatLevel (0-70)
 *         + warningComponent (0-15)
 *         + aisComponent (0-15)
 *
 * Capped at 100.
 */
export function computeDisruptionScore(threatLevel, warningCount, maxCongestionSeverity) {
  return Math.min(100, threatLevel + warningComponent(warningCount) + aisComponent(maxCongestionSeverity));
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

export function detectTrafficAnomaly(history, threatLevel) {
  if (!history || history.length < 37) return { dropPct: 0, signal: false };
  const sorted = [...history].sort((a, b) => b.date.localeCompare(a.date));
  let recent7 = 0;
  let baseline30 = 0;
  for (let i = 0; i < 7 && i < sorted.length; i++) recent7 += sorted[i].total;
  for (let i = 7; i < 37 && i < sorted.length; i++) baseline30 += sorted[i].total;
  const baselineAvg7 = (baseline30 / Math.min(30, sorted.length - 7)) * 7;
  if (baselineAvg7 < 14) return { dropPct: 0, signal: false };
  const dropPct = Math.round(((baselineAvg7 - recent7) / baselineAvg7) * 100);
  const isHighThreat = threatLevel === 'war_zone' || threatLevel === 'critical';
  return { dropPct, signal: dropPct >= 50 && isHighThreat };
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
