/**
 * Client-side service for the Warfare Simulation API.
 *
 * Provides typed RPC wrappers for all warfare endpoints plus
 * local state caching for responsive UI updates.
 */

const BASE = '/api/warfare/v1';

async function rpc<T>(path: string, method: 'GET' | 'POST', params?: Record<string, string | number> | object): Promise<T> {
  let url = `${BASE}${path}`;
  const init: RequestInit = { method, headers: { 'Content-Type': 'application/json' } };

  if (method === 'GET' && params) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== '' && v !== 0) qs.set(k, String(v));
    }
    const qsStr = qs.toString();
    if (qsStr) url += `?${qsStr}`;
  } else if (method === 'POST' && params) {
    init.body = JSON.stringify(params);
  }

  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`Warfare API error: ${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

// ──────────────────────────────── Simulation lifecycle ────────────────────────────────

export interface CreateSimulationParams {
  name: string;
  conflictBasis: string;
  factions: string[];
  theater: string;
  maxTurns: number;
}

export function createSimulation(params: CreateSimulationParams) {
  return rpc('/create-simulation', 'POST', params);
}

export function getGameState(simulationId: string) {
  return rpc('/get-game-state', 'GET', { simulation_id: simulationId });
}

export function advanceTurn(simulationId: string) {
  return rpc('/advance-turn', 'POST', { simulationId });
}

// ──────────────────────────────── Units ────────────────────────────────

export function listUnits(simulationId: string, faction?: string) {
  return rpc('/list-units', 'GET', { simulation_id: simulationId, faction: faction || '' });
}

export function moveUnit(simulationId: string, unitId: string, destLat: number, destLon: number) {
  return rpc('/move-unit', 'POST', { simulationId, unitId, destinationLat: destLat, destinationLon: destLon });
}

export function simulateCombat(
  simulationId: string,
  attackerUnitIds: string[],
  defenderUnitIds: string[],
  terrain: string,
  surpriseFactor: number,
) {
  return rpc('/simulate-combat', 'POST', { simulationId, attackerUnitIds, defenderUnitIds, terrain, surpriseFactor });
}

// ──────────────────────────────── Missiles ────────────────────────────────

export function listMissileSystems(simulationId: string, faction?: string) {
  return rpc('/list-missile-systems', 'GET', { simulation_id: simulationId, faction: faction || '' });
}

export function trackMissileLaunch(simulationId: string, systemId: string, targetLat: number, targetLon: number) {
  return rpc('/track-missile-launch', 'POST', { simulationId, systemId, targetLat, targetLon });
}

export function simulateInterception(simulationId: string, launchId: string, interceptorSystemId: string) {
  return rpc('/simulate-interception', 'POST', { simulationId, launchId, interceptorSystemId });
}

// ──────────────────────────────── Supply ────────────────────────────────

export function getSupplyStatus(simulationId: string, faction: string) {
  return rpc('/get-supply-status', 'GET', { simulation_id: simulationId, faction });
}

export function listSupplyLines(simulationId: string, faction?: string) {
  return rpc('/list-supply-lines', 'GET', { simulation_id: simulationId, faction: faction || '' });
}

// ──────────────────────────────── Territory ────────────────────────────────

export function getTerritorialControl(simulationId: string) {
  return rpc('/get-territorial-control', 'GET', { simulation_id: simulationId });
}

export function getFrontlinePositions(simulationId: string) {
  return rpc('/get-frontline-positions', 'GET', { simulation_id: simulationId });
}

// ──────────────────────────────── Analysis ────────────────────────────────

export function assessCapabilities(simulationId: string, faction: string) {
  return rpc('/assess-capabilities', 'POST', { simulationId, faction });
}

export function projectCasualties(simulationId: string, faction: string, horizonDays: number) {
  return rpc('/project-casualties', 'POST', { simulationId, faction, horizonDays });
}

export function analyzeOutcomes(simulationId: string) {
  return rpc('/analyze-outcomes', 'POST', { simulationId });
}

// ──────────────────────────────── Event dispatcher ────────────────────────────────

/** Emit a warfare state change event for UI components to react to. */
export function emitWarfareUpdate(detail: { type: string; simulationId: string; data?: unknown }): void {
  document.dispatchEvent(new CustomEvent('wm:warfare-updated', { detail }));
}
