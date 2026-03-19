/**
 * Warfare service handler — implements the generated WarfareServiceHandler
 * interface with 16 RPCs covering:
 *   - Simulation lifecycle (create, get state, advance turn)
 *   - Unit operations (list, move, combat)
 *   - Missile tracking (systems, launches, interceptions)
 *   - Logistics (supply status, supply lines)
 *   - Territorial control (territories, frontlines)
 *   - Analysis (capabilities, casualty projections, outcome scenarios)
 *
 * All simulation state is managed by the simulation engine (in-memory).
 * Each simulation is independent and self-contained.
 */

import type { WarfareServiceHandler } from '../../../../src/generated/server/worldmonitor/warfare/v1/service_server';

import {
  createSimulation as engineCreateSimulation,
  getSimulation,
  advanceTurn as engineAdvanceTurn,
  resolveCombat,
  moveUnit as engineMoveUnit,
  launchMissile,
  attemptInterception,
  getForceComposition,
  assessCapabilities as engineAssessCapabilities,
  projectCasualties as engineProjectCasualties,
  analyzeOutcomes as engineAnalyzeOutcomes,
} from './simulation-engine';

export const warfareHandler: WarfareServiceHandler = {
  async createSimulation(_ctx, req) {
    const simulation = engineCreateSimulation(
      req.name,
      req.conflictBasis,
      req.factions,
      req.theater,
      req.maxTurns,
    );
    return { simulation };
  },

  async getGameState(_ctx, req) {
    const state = getSimulation(req.simulationId);
    if (!state) {
      return { units: [], casualties: [], totalEngagements: 0 };
    }
    return {
      simulation: state.simulation,
      units: [...state.units.values()],
      casualties: [...state.cumulativeCasualties.values()],
      totalEngagements: state.engagementLog.length,
    };
  },

  async advanceTurn(_ctx, req) {
    const state = getSimulation(req.simulationId);
    if (!state || state.simulation.status !== 'SIMULATION_STATUS_RUNNING') {
      return {};
    }
    const turn = engineAdvanceTurn(state);
    return { turn };
  },

  async listUnits(_ctx, req) {
    const state = getSimulation(req.simulationId);
    if (!state) return { units: [], compositions: [] };

    let units = [...state.units.values()];
    if (req.faction) {
      units = units.filter(u => u.faction === req.faction);
    }

    const factions = req.faction
      ? [req.faction]
      : [...new Set(units.map(u => u.faction))];

    const compositions = factions.map(f => getForceComposition(state, f));

    return { units, compositions };
  },

  async moveUnit(_ctx, req) {
    const state = getSimulation(req.simulationId);
    if (!state) return { estimatedArrivalTurns: 0 };

    const result = engineMoveUnit(state, req.unitId, req.destinationLat, req.destinationLon);
    if (!result) return { estimatedArrivalTurns: 0 };

    return {
      unit: result.unit,
      estimatedArrivalTurns: result.estimatedTurns,
    };
  },

  async simulateCombat(_ctx, req) {
    const state = getSimulation(req.simulationId);
    if (!state) return { updatedUnits: [] };

    const engagement = resolveCombat(
      state,
      req.attackerUnitIds,
      req.defenderUnitIds,
      req.terrain,
      req.surpriseFactor,
    );

    // Gather updated units
    const allIds = [...req.attackerUnitIds, ...req.defenderUnitIds];
    const updatedUnits = allIds
      .map(id => state.units.get(id))
      .filter(Boolean) as typeof engagement extends never ? never : import('../../../../src/generated/server/worldmonitor/warfare/v1/service_server').MilitaryUnit[];

    return { engagement, updatedUnits };
  },

  async listMissileSystems(_ctx, req) {
    const state = getSimulation(req.simulationId);
    if (!state) return { systems: [] };

    let systems = [...state.missileSystems.values()];
    if (req.faction) {
      systems = systems.filter(s => s.faction === req.faction);
    }
    return { systems };
  },

  async trackMissileLaunch(_ctx, req) {
    const state = getSimulation(req.simulationId);
    if (!state) return {};

    const launch = launchMissile(state, req.systemId, req.targetLat, req.targetLon);
    return launch ? { launch } : {};
  },

  async simulateInterception(_ctx, req) {
    const state = getSimulation(req.simulationId);
    if (!state) return {};

    const attempt = attemptInterception(state, req.launchId, req.interceptorSystemId);
    if (!attempt) return {};

    const updatedLaunch = state.activeLaunches.get(req.launchId);
    return { attempt, updatedLaunch };
  },

  async getSupplyStatus(_ctx, req) {
    const state = getSimulation(req.simulationId);
    if (!state) return { supplyLines: [] };

    const resources = state.resources.get(req.faction);
    const supplyLines = [...state.supplyLines.values()].filter(l => l.faction === req.faction);
    return { resources, supplyLines };
  },

  async listSupplyLines(_ctx, req) {
    const state = getSimulation(req.simulationId);
    if (!state) return { lines: [] };

    let lines = [...state.supplyLines.values()];
    if (req.faction) {
      lines = lines.filter(l => l.faction === req.faction);
    }
    return { lines };
  },

  async getTerritorialControl(_ctx, req) {
    const state = getSimulation(req.simulationId);
    if (!state) return { territories: [], totalContested: 0 };

    const territories = [...state.territories.values()];
    const totalContested = territories.filter(t => t.contested).length;
    return { territories, totalContested };
  },

  async getFrontlinePositions(_ctx, req) {
    const state = getSimulation(req.simulationId);
    if (!state) return { positions: [] };

    return { positions: [...state.frontlines.values()] };
  },

  async assessCapabilities(_ctx, req) {
    const state = getSimulation(req.simulationId);
    if (!state) return {};

    const assessment = engineAssessCapabilities(state, req.faction);
    return { assessment };
  },

  async projectCasualties(_ctx, req) {
    const state = getSimulation(req.simulationId);
    if (!state) return {};

    const projection = engineProjectCasualties(state, req.faction, req.horizonDays);
    return { projection };
  },

  async analyzeOutcomes(_ctx, req) {
    const state = getSimulation(req.simulationId);
    if (!state) return { scenarios: [], analysisSummary: '' };

    const result = engineAnalyzeOutcomes(state);
    return {
      scenarios: result.scenarios,
      analysisSummary: result.summary,
    };
  },
};
