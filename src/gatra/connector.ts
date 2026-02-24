/**
 * GATRA SOC Connector — unified integration layer
 *
 * Exposes GATRA's 5-agent pipeline data via the same panel system
 * World Monitor uses.  Current implementation uses mock data from
 * `@/services/gatra`; the mock calls will be replaced by real GATRA
 * API feeds via Pub/Sub once the production connector is ready.
 *
 * Data exposed:
 *   ADA  alerts     — anomaly detections with MITRE ATT&CK mapping
 *   TAA  analyses   — threat investigation with actor/campaign/kill-chain
 *   CRA  actions    — automated containment responses with status
 *   Agent health    — ADA/TAA/CRA/CLA/RVA heartbeat & state
 *   Correlations    — links between World Monitor events and GATRA alerts
 */

import {
  fetchGatraAlerts,
  fetchGatraAgentStatus,
  fetchGatraIncidentSummary,
  fetchGatraCRAActions,
  fetchGatraTAAAnalyses,
  fetchGatraCorrelations,
} from '@/services/gatra';

import type {
  GatraAlert,
  GatraAgentStatus,
  GatraIncidentSummary,
  GatraCRAAction,
  GatraTAAAnalysis,
  GatraCorrelation,
  GatraConnectorSnapshot,
} from '@/types';

// ── Connector state ─────────────────────────────────────────────────

let _snapshot: GatraConnectorSnapshot | null = null;
let _refreshing = false;
const _listeners: Set<(snap: GatraConnectorSnapshot) => void> = new Set();

// ── Public API ──────────────────────────────────────────────────────

/**
 * Fetch all GATRA data sources in parallel and cache the result.
 * Returns a unified snapshot that panels, layers, and other consumers
 * can read without issuing their own requests.
 */
export async function refreshGatraData(): Promise<GatraConnectorSnapshot> {
  if (_refreshing && _snapshot) return _snapshot;
  _refreshing = true;

  try {
    const [alerts, agents, summary, craActions] = await Promise.all([
      fetchGatraAlerts(),
      fetchGatraAgentStatus(),
      fetchGatraIncidentSummary(),
      fetchGatraCRAActions(),
    ]);

    // TAA and correlations depend on alerts
    const [taaAnalyses, correlations] = await Promise.all([
      fetchGatraTAAAnalyses(alerts),
      fetchGatraCorrelations(alerts),
    ]);

    _snapshot = {
      alerts,
      agents,
      summary,
      craActions,
      taaAnalyses,
      correlations,
      lastRefresh: new Date(),
    };

    // Notify subscribers
    for (const fn of _listeners) {
      try { fn(_snapshot); } catch (e) { console.error('[GatraConnector] listener error:', e); }
    }

    return _snapshot;
  } catch (err) {
    console.error('[GatraConnector] refresh failed:', err);
    if (_snapshot) return _snapshot;
    throw err;
  } finally {
    _refreshing = false;
  }
}

/** Return the last cached snapshot (may be null before first refresh). */
export function getGatraSnapshot(): GatraConnectorSnapshot | null {
  return _snapshot;
}

/** Subscribe to snapshot updates. Returns an unsubscribe function. */
export function onGatraUpdate(fn: (snap: GatraConnectorSnapshot) => void): () => void {
  _listeners.add(fn);
  return () => { _listeners.delete(fn); };
}

// ── Convenience accessors ───────────────────────────────────────────

export function getAlerts(): GatraAlert[] {
  return _snapshot?.alerts ?? [];
}

export function getAgentStatus(): GatraAgentStatus[] {
  return _snapshot?.agents ?? [];
}

export function getIncidentSummary(): GatraIncidentSummary | null {
  return _snapshot?.summary ?? null;
}

export function getCRAActions(): GatraCRAAction[] {
  return _snapshot?.craActions ?? [];
}

export function getTAAAnalyses(): GatraTAAAnalysis[] {
  return _snapshot?.taaAnalyses ?? [];
}

export function getCorrelations(): GatraCorrelation[] {
  return _snapshot?.correlations ?? [];
}
