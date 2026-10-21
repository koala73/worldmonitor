/**
 * Temporal-anomaly severity thresholds — single source of truth shared by the
 * server baseline pipeline (server/worldmonitor/infrastructure/v1/_shared.ts)
 * and the client mapper (src/services/temporal-baseline.ts), so the two sides
 * cannot drift on what "high" or "critical" means for a z-score.
 *
 * Dependency-free: importable from Vite client code, Vercel Edge bundles,
 * server handlers, and tsx tests alike.
 */

export const Z_THRESHOLD_LOW = 1.5;
export const Z_THRESHOLD_MEDIUM = 2.0;
export const Z_THRESHOLD_HIGH = 3.0;

export type BaselineSeverity = 'normal' | 'medium' | 'high' | 'critical';

export function getBaselineSeverity(zScore: number): BaselineSeverity {
  if (zScore >= Z_THRESHOLD_HIGH) return 'critical';
  if (zScore >= Z_THRESHOLD_MEDIUM) return 'high';
  if (zScore >= Z_THRESHOLD_LOW) return 'medium';
  return 'normal';
}

/**
 * Client anomaly severity: identical thresholds, but server-emitted anomalies
 * are already above the reporting floor, so anything below "high" collapses
 * to "medium" (there is no "normal" band on rendered anomalies).
 */
export function getAnomalySeverity(zScore: number): 'medium' | 'high' | 'critical' {
  if (zScore >= Z_THRESHOLD_HIGH) return 'critical';
  if (zScore >= Z_THRESHOLD_MEDIUM) return 'high';
  return 'medium';
}
