/**
 * Core warfare simulation engine.
 *
 * Implements:
 *   - Combat resolution using Lanchester's Square Law
 *   - Missile trajectory & interception probability modeling
 *   - Supply line logistics & resource depletion
 *   - Territorial control dynamics
 *   - Casualty projection models
 *   - Military capability assessment
 *
 * All state is in-memory per simulation. Each simulation is independent.
 */

import type {
  MilitaryUnit,
  GeoCoordinates,
  CombatEngagement,
  CasualtyEstimate,
  MissileSystem,
  MissileLaunch,
  TrajectoryPoint,
  InterceptionAttempt,
  SupplyLine,
  ResourcePool,
  ControlledTerritory,
  FrontlinePosition,
  GameSimulation,
  GameTurn,
  ForceComposition,
  UnitTypeBreakdown,
  MilitaryCapabilityAssessment,
  CasualtyProjection,
  ConflictOutcomeScenario,
  TurnMissileEvent,
  TurnSupplyEvent,
  TurnTerritoryEvent,
  UnitType,
  UnitState,
  TerrainType,
  CombatOutcome,
  MissileStatus,
  SimulationStatus,
} from '../../../../src/generated/server/worldmonitor/warfare/v1/service_server';

// ──────────────────────────────── Geo utilities ────────────────────────────────

const DEG_TO_RAD = Math.PI / 180;
const EARTH_RADIUS_KM = 6371;

/** Haversine distance between two coordinates in km. */
export function haversineDistance(a: GeoCoordinates, b: GeoCoordinates): number {
  const dLat = (b.latitude - a.latitude) * DEG_TO_RAD;
  const dLon = (b.longitude - a.longitude) * DEG_TO_RAD;
  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const h = sinLat * sinLat +
    Math.cos(a.latitude * DEG_TO_RAD) * Math.cos(b.latitude * DEG_TO_RAD) * sinLon * sinLon;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

/** Interpolate between two coordinates by fraction t ∈ [0,1]. */
function interpolateCoord(a: GeoCoordinates, b: GeoCoordinates, t: number): GeoCoordinates {
  return {
    latitude: a.latitude + (b.latitude - a.latitude) * t,
    longitude: a.longitude + (b.longitude - a.longitude) * t,
  };
}

/** Generate a unique ID. */
function uid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

// ──────────────────────────────── Terrain modifiers ────────────────────────────────

const TERRAIN_DEFENSE_MODIFIER: Record<string, number> = {
  TERRAIN_TYPE_OPEN: 1.0,
  TERRAIN_TYPE_URBAN: 1.6,
  TERRAIN_TYPE_FOREST: 1.3,
  TERRAIN_TYPE_MOUNTAIN: 1.8,
  TERRAIN_TYPE_DESERT: 1.0,
  TERRAIN_TYPE_RIVER_CROSSING: 1.5,
  TERRAIN_TYPE_COASTAL: 1.2,
  TERRAIN_TYPE_ARCTIC: 1.4,
  TERRAIN_TYPE_UNSPECIFIED: 1.0,
};

const TERRAIN_MOVEMENT_MODIFIER: Record<string, number> = {
  TERRAIN_TYPE_OPEN: 1.0,
  TERRAIN_TYPE_URBAN: 0.6,
  TERRAIN_TYPE_FOREST: 0.7,
  TERRAIN_TYPE_MOUNTAIN: 0.4,
  TERRAIN_TYPE_DESERT: 0.8,
  TERRAIN_TYPE_RIVER_CROSSING: 0.3,
  TERRAIN_TYPE_COASTAL: 0.9,
  TERRAIN_TYPE_ARCTIC: 0.5,
  TERRAIN_TYPE_UNSPECIFIED: 1.0,
};

// ──────────────────────────────── Unit combat power ────────────────────────────────

/** Calculate effective combat power for a unit (Lanchester-compatible scalar). */
function unitCombatPower(unit: MilitaryUnit): number {
  const readinessMultiplier = unit.readiness / 100;
  const moraleMultiplier = 0.5 + (unit.morale / 200); // range: 0.5–1.0
  const supplyMultiplier = 0.3 + (unit.supplyLevel / 143); // range: 0.3–1.0
  return unit.firepower * readinessMultiplier * moraleMultiplier * supplyMultiplier;
}

// ──────────────────────────────── Simulation State ────────────────────────────────

export interface SimulationState {
  simulation: GameSimulation;
  units: Map<string, MilitaryUnit>;
  missileSystems: Map<string, MissileSystem>;
  activeLaunches: Map<string, MissileLaunch>;
  supplyLines: Map<string, SupplyLine>;
  resources: Map<string, ResourcePool>;
  territories: Map<string, ControlledTerritory>;
  frontlines: Map<string, FrontlinePosition>;
  engagementLog: CombatEngagement[];
  cumulativeCasualties: Map<string, CasualtyEstimate>;
  turnHistory: GameTurn[];
}

/** In-memory store of all active simulations. */
const simulations = new Map<string, SimulationState>();

// ──────────────────────────────── Simulation management ────────────────────────────────

export function createSimulation(
  name: string,
  conflictBasis: string,
  factions: string[],
  theater: string,
  maxTurns: number,
): GameSimulation {
  const now = Date.now();
  const sim: GameSimulation = {
    simulationId: uid(),
    name,
    conflictBasis,
    factions,
    status: 'SIMULATION_STATUS_SETUP',
    currentTurn: 0,
    maxTurns: maxTurns || 365,
    theater,
    createdAt: now,
    updatedAt: now,
  };

  const state: SimulationState = {
    simulation: sim,
    units: new Map(),
    missileSystems: new Map(),
    activeLaunches: new Map(),
    supplyLines: new Map(),
    resources: new Map(),
    territories: new Map(),
    frontlines: new Map(),
    engagementLog: [],
    cumulativeCasualties: new Map(),
    turnHistory: [],
  };

  // Initialize empty cumulative casualties per faction
  for (const faction of factions) {
    state.cumulativeCasualties.set(faction, {
      faction,
      militaryKilled: 0,
      militaryWounded: 0,
      militaryMissing: 0,
      civilianCasualties: 0,
      equipmentDestroyed: 0,
      confidence: 80,
      methodology: 'simulation',
    });
  }

  // Initialize default resource pools per faction
  for (const faction of factions) {
    state.resources.set(faction, {
      faction,
      ammunitionTons: 50000,
      fuelTons: 80000,
      foodDays: 90,
      manpowerReserves: 50000,
      equipmentReserves: 500,
      ammoConsumptionRate: 200,
      fuelConsumptionRate: 300,
      daysUntilCritical: 180,
      logisticsHealth: 85,
    });
  }

  // Seed default units for each faction based on theater
  seedDefaultUnits(state, factions, theater);

  // Seed default missile systems
  seedDefaultMissileSystems(state, factions);

  // Seed default supply lines
  seedDefaultSupplyLines(state, factions, theater);

  // Seed default territories
  seedDefaultTerritories(state, factions, theater);

  sim.status = 'SIMULATION_STATUS_RUNNING';
  simulations.set(sim.simulationId, state);
  return sim;
}

export function getSimulation(simulationId: string): SimulationState | undefined {
  return simulations.get(simulationId);
}

// ──────────────────────────────── Default seeding ────────────────────────────────

function seedDefaultUnits(state: SimulationState, factions: string[], theater: string): void {
  // Theater-based starting positions
  const theaterPositions: Record<string, GeoCoordinates[]> = {
    'european': [
      { latitude: 50.45, longitude: 30.52 },  // Kyiv
      { latitude: 51.67, longitude: 39.21 },  // Voronezh
    ],
    'middle-east': [
      { latitude: 32.08, longitude: 34.78 },  // Tel Aviv
      { latitude: 35.69, longitude: 51.39 },  // Tehran
    ],
    'indo-pacific': [
      { latitude: 25.03, longitude: 121.57 }, // Taipei
      { latitude: 24.48, longitude: 118.09 }, // Xiamen
    ],
    'default': [
      { latitude: 48.86, longitude: 2.35 },
      { latitude: 52.52, longitude: 13.41 },
    ],
  };

  const positions = theaterPositions[theater] || theaterPositions['default'];

  const unitTemplates: Array<{ type: UnitType; name: string; personnel: number; equipment: number; firepower: number; armor: number; speed: number }> = [
    { type: 'UNIT_TYPE_INFANTRY', name: 'Infantry Brigade', personnel: 3500, equipment: 120, firepower: 45, armor: 20, speed: 30 },
    { type: 'UNIT_TYPE_ARMOR', name: 'Armored Division', personnel: 4500, equipment: 250, firepower: 85, armor: 80, speed: 40 },
    { type: 'UNIT_TYPE_ARTILLERY', name: 'Artillery Regiment', personnel: 1200, equipment: 72, firepower: 70, armor: 15, speed: 20 },
    { type: 'UNIT_TYPE_AIR_DEFENSE', name: 'Air Defense Battery', personnel: 800, equipment: 24, firepower: 55, armor: 25, speed: 25 },
    { type: 'UNIT_TYPE_FIGHTER_AIRCRAFT', name: 'Fighter Squadron', personnel: 350, equipment: 24, firepower: 90, armor: 10, speed: 500 },
    { type: 'UNIT_TYPE_SPECIAL_FORCES', name: 'Special Operations Group', personnel: 400, equipment: 30, firepower: 60, armor: 10, speed: 50 },
    { type: 'UNIT_TYPE_LOGISTICS', name: 'Logistics Battalion', personnel: 900, equipment: 80, firepower: 10, armor: 5, speed: 35 },
    { type: 'UNIT_TYPE_RECONNAISSANCE', name: 'Recon Company', personnel: 250, equipment: 40, firepower: 30, armor: 15, speed: 60 },
  ];

  factions.forEach((faction, fIdx) => {
    const basePos = positions[fIdx] || positions[0];
    unitTemplates.forEach((tmpl, uIdx) => {
      // Offset each unit slightly from the base position
      const offset = (uIdx - unitTemplates.length / 2) * 0.15;
      const unit: MilitaryUnit = {
        unitId: uid(),
        name: `${faction} ${tmpl.name}`,
        unitType: tmpl.type,
        faction,
        location: {
          latitude: basePos.latitude + offset,
          longitude: basePos.longitude + (offset * 0.5),
        },
        personnel: tmpl.personnel,
        equipmentCount: tmpl.equipment,
        readiness: 80 + Math.floor(Math.random() * 20),
        morale: 70 + Math.floor(Math.random() * 30),
        supplyLevel: 75 + Math.floor(Math.random() * 25),
        firepower: tmpl.firepower,
        armorRating: tmpl.armor,
        speedKmDay: tmpl.speed,
        state: 'UNIT_STATE_ACTIVE',
        updatedAt: Date.now(),
        parentUnitId: '',
      };
      state.units.set(unit.unitId, unit);
    });
  });
}

function seedDefaultMissileSystems(state: SimulationState, factions: string[]): void {
  const missileTemplates: Array<{
    designation: string;
    missileType: MissileLaunch['missileType'];
    range: number;
    capacity: number;
  }> = [
    { designation: 'Iskander-M', missileType: 'MISSILE_TYPE_BALLISTIC_SHORT', range: 500, capacity: 4 },
    { designation: 'Kalibr', missileType: 'MISSILE_TYPE_CRUISE', range: 1500, capacity: 8 },
    { designation: 'S-300', missileType: 'MISSILE_TYPE_ANTI_AIRCRAFT', range: 200, capacity: 48 },
    { designation: 'Patriot PAC-3', missileType: 'MISSILE_TYPE_ANTI_AIRCRAFT', range: 160, capacity: 16 },
    { designation: 'HIMARS', missileType: 'MISSILE_TYPE_BALLISTIC_SHORT', range: 300, capacity: 6 },
  ];

  factions.forEach((faction) => {
    // Give each faction 3 missile systems
    const selected = missileTemplates.slice(0, 3);
    for (const tmpl of selected) {
      // Find the first unit of this faction to co-locate
      const factionUnits = [...state.units.values()].filter(u => u.faction === faction);
      const baseUnit = factionUnits[Math.floor(Math.random() * factionUnits.length)];
      const sys: MissileSystem = {
        systemId: uid(),
        designation: `${faction} ${tmpl.designation}`,
        missileType: tmpl.missileType as MissileSystem['missileType'],
        operatorCountry: faction,
        faction,
        location: baseUnit?.location ? {
          latitude: baseUnit.location.latitude + (Math.random() - 0.5) * 0.3,
          longitude: baseUnit.location.longitude + (Math.random() - 0.5) * 0.3,
        } : { latitude: 0, longitude: 0 },
        rangeKm: tmpl.range,
        ammoRemaining: tmpl.capacity,
        ammoCapacity: tmpl.capacity,
        operational: true,
        lastLaunchAt: 0,
      };
      state.missileSystems.set(sys.systemId, sys);
    }
  });
}

function seedDefaultSupplyLines(state: SimulationState, factions: string[], theater: string): void {
  for (const faction of factions) {
    const factionUnits = [...state.units.values()].filter(u => u.faction === faction);
    if (factionUnits.length < 2) continue;

    // Create supply lines connecting the logistics unit to combat units
    const logUnit = factionUnits.find(u => u.unitType === 'UNIT_TYPE_LOGISTICS');
    if (!logUnit?.location) continue;

    const combatUnits = factionUnits.filter(u =>
      u.unitType !== 'UNIT_TYPE_LOGISTICS' && u.location
    ).slice(0, 3);

    for (const combatUnit of combatUnits) {
      if (!combatUnit.location) continue;
      const line: SupplyLine = {
        lineId: uid(),
        faction,
        origin: { ...logUnit.location },
        destination: { ...combatUnit.location },
        waypoints: [],
        supplyType: 'SUPPLY_TYPE_AMMUNITION',
        throughputTonsPerDay: 50 + Math.random() * 100,
        vulnerability: 20 + Math.floor(Math.random() * 40),
        status: 'SUPPLY_LINE_STATUS_OPERATIONAL',
        lengthKm: haversineDistance(logUnit.location, combatUnit.location),
        interdictionCount: 0,
        lastDisruptedAt: 0,
      };
      state.supplyLines.set(line.lineId, line);
    }
  }
}

function seedDefaultTerritories(state: SimulationState, factions: string[], theater: string): void {
  // Create a simple territory for each faction based on unit positions
  for (const faction of factions) {
    const factionUnits = [...state.units.values()].filter(u => u.faction === faction && u.location);
    if (factionUnits.length === 0) continue;

    // Calculate bounding box of faction units with buffer
    let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
    for (const u of factionUnits) {
      if (!u.location) continue;
      minLat = Math.min(minLat, u.location.latitude);
      maxLat = Math.max(maxLat, u.location.latitude);
      minLon = Math.min(minLon, u.location.longitude);
      maxLon = Math.max(maxLon, u.location.longitude);
    }

    const buffer = 0.5;
    const territory: ControlledTerritory = {
      territoryId: uid(),
      faction,
      polygon: [
        { latitude: minLat - buffer, longitude: minLon - buffer },
        { latitude: minLat - buffer, longitude: maxLon + buffer },
        { latitude: maxLat + buffer, longitude: maxLon + buffer },
        { latitude: maxLat + buffer, longitude: minLon - buffer },
      ],
      centroid: {
        latitude: (minLat + maxLat) / 2,
        longitude: (minLon + maxLon) / 2,
      },
      population: 500000 + Math.floor(Math.random() * 2000000),
      contested: false,
      strategicValue: 50 + Math.floor(Math.random() * 50),
      trend: 'TERRITORY_TREND_STABLE',
      garrisonCount: factionUnits.length,
      areaSqKm: (maxLat - minLat + buffer * 2) * 111 * (maxLon - minLon + buffer * 2) * 85,
      recentBattles: 0,
    };
    state.territories.set(territory.territoryId, territory);
  }
}

// ──────────────────────────────── Combat resolution ────────────────────────────────

/**
 * Resolve combat between attacker and defender units using Lanchester's Square Law.
 *
 * The square law models attrition where each combatant can engage any opponent:
 *   dA/dt = -β × D
 *   dD/dt = -α × A
 * where α and β are combat effectiveness coefficients.
 *
 * We discretize into a single engagement and compute casualties proportional
 * to the opposing force's effective combat power.
 */
export function resolveCombat(
  state: SimulationState,
  attackerIds: string[],
  defenderIds: string[],
  terrain: TerrainType,
  surpriseFactor: number,
): CombatEngagement {
  const attackers = attackerIds.map(id => state.units.get(id)).filter(Boolean) as MilitaryUnit[];
  const defenders = defenderIds.map(id => state.units.get(id)).filter(Boolean) as MilitaryUnit[];

  // Calculate aggregate combat power
  let attackerPower = attackers.reduce((sum, u) => sum + unitCombatPower(u), 0);
  let defenderPower = defenders.reduce((sum, u) => sum + unitCombatPower(u), 0);

  // Apply terrain defense modifier
  const terrainMod = TERRAIN_DEFENSE_MODIFIER[terrain] || 1.0;
  defenderPower *= terrainMod;

  // Apply surprise factor
  attackerPower *= (surpriseFactor || 1.0);

  // Lanchester combat ratio
  const powerRatio = attackerPower / (defenderPower || 1);
  const totalPower = attackerPower + defenderPower;

  // Duration scales with balanced forces (longer for equal forces)
  const durationHours = 4 + 20 * Math.min(powerRatio, 1 / (powerRatio || 1));

  // Casualty rates using Lanchester attrition
  // Attacker losses are proportional to defender power, and vice versa
  const attritionRate = 0.02 + Math.random() * 0.03; // 2-5% per engagement
  const attackerPersonnel = attackers.reduce((s, u) => s + u.personnel, 0);
  const defenderPersonnel = defenders.reduce((s, u) => s + u.personnel, 0);

  const attackerCasualties = Math.round(attackerPersonnel * attritionRate * (defenderPower / totalPower));
  const defenderCasualties = Math.round(defenderPersonnel * attritionRate * (attackerPower / totalPower));
  const attackerEquipLost = Math.round(attackers.reduce((s, u) => s + u.equipmentCount, 0) * attritionRate * (defenderPower / totalPower));
  const defenderEquipLost = Math.round(defenders.reduce((s, u) => s + u.equipmentCount, 0) * attritionRate * (attackerPower / totalPower));

  // Determine outcome
  let outcome: CombatOutcome;
  if (powerRatio > 1.5) outcome = 'COMBAT_OUTCOME_ATTACKER_VICTORY';
  else if (powerRatio < 0.67) outcome = 'COMBAT_OUTCOME_DEFENDER_VICTORY';
  else if (Math.random() < 0.3) outcome = 'COMBAT_OUTCOME_MUTUAL_WITHDRAWAL';
  else outcome = 'COMBAT_OUTCOME_STALEMATE';

  // Calculate civilian casualties (higher in urban terrain)
  const civilianBase = terrain === 'TERRAIN_TYPE_URBAN' ? 0.1 : 0.02;
  const civilianCasualties = Math.round((attackerCasualties + defenderCasualties) * civilianBase);

  // Infrastructure damage
  const infraDamage = Math.round(
    (terrain === 'TERRAIN_TYPE_URBAN' ? 40 : 10) * (attackerPower + defenderPower) / 200
  );

  // Engagement location is average of defender positions
  const engagementLocation: GeoCoordinates = {
    latitude: defenders.reduce((s, u) => s + (u.location?.latitude || 0), 0) / defenders.length,
    longitude: defenders.reduce((s, u) => s + (u.location?.longitude || 0), 0) / defenders.length,
  };

  const engagement: CombatEngagement = {
    engagementId: uid(),
    turnNumber: state.simulation.currentTurn,
    location: engagementLocation,
    attackerFaction: attackers[0]?.faction || '',
    defenderFaction: defenders[0]?.faction || '',
    attackerUnitIds: attackerIds,
    defenderUnitIds: defenderIds,
    durationHours,
    terrain,
    attackerPower,
    defenderPower,
    terrainModifier: terrainMod,
    weatherModifier: 1.0,
    surpriseFactor: surpriseFactor || 1.0,
    outcome,
    attackerCasualties,
    defenderCasualties,
    attackerEquipmentLost: attackerEquipLost,
    defenderEquipmentLost: defenderEquipLost,
    civilianCasualties,
    infrastructureDamage: Math.min(infraDamage, 100),
    resolvedAt: Date.now(),
  };

  // Apply casualties to units
  applyUnitCasualties(attackers, attackerCasualties, attackerEquipLost, outcome === 'COMBAT_OUTCOME_DEFENDER_VICTORY');
  applyUnitCasualties(defenders, defenderCasualties, defenderEquipLost, outcome === 'COMBAT_OUTCOME_ATTACKER_VICTORY');

  // Update cumulative casualties
  updateCumulativeCasualties(state, engagement);

  state.engagementLog.push(engagement);
  return engagement;
}

function applyUnitCasualties(
  units: MilitaryUnit[],
  totalCasualties: number,
  equipLost: number,
  isDefeated: boolean,
): void {
  // Distribute casualties proportionally across units
  const totalPersonnel = units.reduce((s, u) => s + u.personnel, 0);
  for (const unit of units) {
    const share = unit.personnel / (totalPersonnel || 1);
    unit.personnel = Math.max(0, unit.personnel - Math.round(totalCasualties * share));
    unit.equipmentCount = Math.max(0, unit.equipmentCount - Math.round(equipLost * share));
    unit.readiness = Math.max(10, unit.readiness - Math.round(10 + Math.random() * 15));
    unit.morale = Math.max(5, unit.morale - Math.round(5 + Math.random() * (isDefeated ? 20 : 10)));
    unit.supplyLevel = Math.max(0, unit.supplyLevel - Math.round(5 + Math.random() * 10));
    unit.updatedAt = Date.now();

    // Update unit state
    if (unit.personnel <= 0) {
      unit.state = 'UNIT_STATE_DESTROYED';
    } else if (isDefeated) {
      unit.state = 'UNIT_STATE_RETREATING';
    } else if (unit.readiness < 30) {
      unit.state = 'UNIT_STATE_DAMAGED';
    } else {
      unit.state = 'UNIT_STATE_ENGAGED';
    }
  }
}

function updateCumulativeCasualties(state: SimulationState, engagement: CombatEngagement): void {
  const atk = state.cumulativeCasualties.get(engagement.attackerFaction);
  if (atk) {
    atk.militaryKilled += Math.round(engagement.attackerCasualties * 0.3);
    atk.militaryWounded += Math.round(engagement.attackerCasualties * 0.6);
    atk.militaryMissing += Math.round(engagement.attackerCasualties * 0.1);
    atk.equipmentDestroyed += engagement.attackerEquipmentLost;
  }

  const def = state.cumulativeCasualties.get(engagement.defenderFaction);
  if (def) {
    def.militaryKilled += Math.round(engagement.defenderCasualties * 0.3);
    def.militaryWounded += Math.round(engagement.defenderCasualties * 0.6);
    def.militaryMissing += Math.round(engagement.defenderCasualties * 0.1);
    def.equipmentDestroyed += engagement.defenderEquipmentLost;
    def.civilianCasualties += engagement.civilianCasualties;
  }
}

// ──────────────────────────────── Missile system ────────────────────────────────

/** Simulate a missile launch with trajectory generation. */
export function launchMissile(
  state: SimulationState,
  systemId: string,
  targetLat: number,
  targetLon: number,
): MissileLaunch | null {
  const system = state.missileSystems.get(systemId);
  if (!system || !system.operational || system.ammoRemaining <= 0 || !system.location) return null;

  const target: GeoCoordinates = { latitude: targetLat, longitude: targetLon };
  const distance = haversineDistance(system.location, target);

  // Check range
  if (distance > system.rangeKm * 1.1) return null;

  // Decrement ammo
  system.ammoRemaining--;
  system.lastLaunchAt = Date.now();

  // Generate trajectory points
  const trajectory = generateTrajectory(system.location, target, system.missileType, distance);

  // Calculate time of flight based on missile type
  const speedMs = getMissileSpeed(system.missileType);
  const timeOfFlight = (distance * 1000) / speedMs;

  const launch: MissileLaunch = {
    launchId: uid(),
    systemId,
    missileName: system.designation,
    missileType: system.missileType,
    launcherFaction: system.faction,
    launchLocation: { ...system.location },
    targetLocation: target,
    trajectory,
    status: 'MISSILE_STATUS_IN_FLIGHT',
    timeOfFlightSeconds: timeOfFlight,
    payloadKg: getMissilePayload(system.missileType),
    apogeeMeters: getApogee(system.missileType, distance),
    cepMeters: getCEP(system.missileType),
    launchedAt: Date.now(),
    resolvedAt: 0,
  };

  state.activeLaunches.set(launch.launchId, launch);
  return launch;
}

function generateTrajectory(
  from: GeoCoordinates,
  to: GeoCoordinates,
  missileType: string,
  distance: number,
): TrajectoryPoint[] {
  const points: TrajectoryPoint[] = [];
  const steps = 20;
  const apogee = getApogee(missileType, distance);
  const speedMs = getMissileSpeed(missileType);
  const totalTime = (distance * 1000) / speedMs;

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const pos = interpolateCoord(from, to, t);
    // Parabolic altitude profile for ballistic missiles
    const altFactor = missileType.includes('BALLISTIC') ? 4 * t * (1 - t) : 0.3;
    points.push({
      location: pos,
      altitudeMeters: apogee * altFactor,
      speedMs: speedMs * (0.8 + 0.4 * Math.sin(Math.PI * t)),
      timeOffsetSeconds: totalTime * t,
    });
  }

  return points;
}

function getMissileSpeed(type: string): number {
  if (type.includes('HYPERSONIC')) return 3400;
  if (type.includes('BALLISTIC_INTERCONTINENTAL')) return 7000;
  if (type.includes('BALLISTIC')) return 2100;
  if (type.includes('CRUISE')) return 250;
  return 900;
}

function getMissilePayload(type: string): number {
  if (type.includes('INTERCONTINENTAL')) return 1000;
  if (type.includes('BALLISTIC')) return 480;
  if (type.includes('CRUISE')) return 450;
  if (type.includes('HYPERSONIC')) return 300;
  return 150;
}

function getApogee(type: string, distanceKm: number): number {
  if (type.includes('INTERCONTINENTAL')) return 1200000;
  if (type.includes('BALLISTIC_MEDIUM')) return 300000;
  if (type.includes('BALLISTIC_SHORT')) return Math.min(100000, distanceKm * 200);
  if (type.includes('CRUISE')) return 100;
  if (type.includes('HYPERSONIC')) return 80000;
  return 15000;
}

function getCEP(type: string): number {
  if (type.includes('CRUISE')) return 3;
  if (type.includes('HYPERSONIC')) return 10;
  if (type.includes('BALLISTIC_SHORT')) return 30;
  if (type.includes('BALLISTIC_MEDIUM')) return 50;
  if (type.includes('INTERCONTINENTAL')) return 200;
  return 100;
}

// ──────────────────────────────── Interception ────────────────────────────────

/** Simulate an air defense interception attempt. */
export function attemptInterception(
  state: SimulationState,
  launchId: string,
  interceptorSystemId: string,
): InterceptionAttempt | null {
  const launch = state.activeLaunches.get(launchId);
  const interceptor = state.missileSystems.get(interceptorSystemId);

  if (!launch || !interceptor || !interceptor.operational || interceptor.ammoRemaining <= 0) {
    return null;
  }
  if (!interceptor.location || !launch.targetLocation) return null;

  // Interception probability based on missile type vs interceptor type
  const baseProbability = getInterceptionProbability(launch.missileType, interceptor.missileType);

  // Distance penalty — interceptor must be within range
  const distanceToTarget = haversineDistance(interceptor.location, launch.targetLocation);
  if (distanceToTarget > interceptor.rangeKm) return null;

  const distanceFactor = 1 - (distanceToTarget / interceptor.rangeKm) * 0.3;
  const probability = baseProbability * distanceFactor;

  // Roll for success
  const success = Math.random() < probability;

  // Consume interceptor rounds
  const interceptorsUsed = success ? 1 : Math.min(2, interceptor.ammoRemaining);
  interceptor.ammoRemaining -= interceptorsUsed;

  const attempt: InterceptionAttempt = {
    interceptionId: uid(),
    launchId,
    interceptorType: mapInterceptorDesignation(interceptor.designation),
    interceptorSystemId,
    defenderFaction: interceptor.faction,
    engagementLocation: launch.targetLocation ? interpolateCoord(
      launch.launchLocation || { latitude: 0, longitude: 0 },
      launch.targetLocation,
      0.7 + Math.random() * 0.2,
    ) : { latitude: 0, longitude: 0 },
    engagementDistanceKm: distanceToTarget,
    success,
    durationSeconds: 5 + Math.random() * 25,
    interceptorsUsed,
    attemptedAt: Date.now(),
  };

  if (success) {
    launch.status = 'MISSILE_STATUS_INTERCEPTED';
    launch.impactLocation = attempt.engagementLocation;
  } else {
    // Missile continues to target
    launch.status = 'MISSILE_STATUS_IMPACTED';
    launch.impactLocation = launch.targetLocation ? {
      latitude: launch.targetLocation.latitude + (Math.random() - 0.5) * (launch.cepMeters / 111000),
      longitude: launch.targetLocation.longitude + (Math.random() - 0.5) * (launch.cepMeters / 111000),
    } : undefined;
  }
  launch.resolvedAt = Date.now();

  return attempt;
}

function getInterceptionProbability(missileType: string, interceptorType: string): number {
  // Base probabilities for different missile/interceptor pairings
  if (missileType.includes('HYPERSONIC')) return 0.15;
  if (missileType.includes('BALLISTIC_INTERCONTINENTAL')) return 0.30;
  if (missileType.includes('BALLISTIC')) {
    if (interceptorType.includes('ANTI_AIRCRAFT')) return 0.70;
    return 0.50;
  }
  if (missileType.includes('CRUISE')) {
    if (interceptorType.includes('ANTI_AIRCRAFT')) return 0.85;
    return 0.60;
  }
  return 0.50;
}

function mapInterceptorDesignation(designation: string): InterceptionAttempt['interceptorType'] {
  const lower = designation.toLowerCase();
  if (lower.includes('patriot')) return 'INTERCEPTOR_TYPE_PATRIOT';
  if (lower.includes('thaad')) return 'INTERCEPTOR_TYPE_THAAD';
  if (lower.includes('iron dome')) return 'INTERCEPTOR_TYPE_IRON_DOME';
  if (lower.includes('s-300')) return 'INTERCEPTOR_TYPE_S300';
  if (lower.includes('s-400')) return 'INTERCEPTOR_TYPE_S400';
  if (lower.includes('arrow')) return 'INTERCEPTOR_TYPE_ARROW';
  if (lower.includes('nasams')) return 'INTERCEPTOR_TYPE_NASAMS';
  if (lower.includes('iris')) return 'INTERCEPTOR_TYPE_IRIS_T';
  return 'INTERCEPTOR_TYPE_OTHER';
}

// ──────────────────────────────── Movement ────────────────────────────────

/** Issue a movement order for a unit. Returns estimated turns to arrive. */
export function moveUnit(
  state: SimulationState,
  unitId: string,
  destLat: number,
  destLon: number,
): { unit: MilitaryUnit; estimatedTurns: number } | null {
  const unit = state.units.get(unitId);
  if (!unit || !unit.location || unit.state === 'UNIT_STATE_DESTROYED') return null;

  const dest: GeoCoordinates = { latitude: destLat, longitude: destLon };
  const distance = haversineDistance(unit.location, dest);
  const estimatedTurns = Math.ceil(distance / unit.speedKmDay);

  unit.destination = dest;
  unit.state = 'UNIT_STATE_MOVING';
  unit.updatedAt = Date.now();

  return { unit, estimatedTurns };
}

// ──────────────────────────────── Turn advancement ────────────────────────────────

/** Advance the simulation by one turn (1 simulated day). */
export function advanceTurn(state: SimulationState): GameTurn {
  state.simulation.currentTurn++;
  state.simulation.updatedAt = Date.now();

  const turnEngagements: CombatEngagement[] = [];
  const missileEvents: TurnMissileEvent[] = [];
  const supplyEvents: TurnSupplyEvent[] = [];
  const territoryEvents: TurnTerritoryEvent[] = [];

  // 1. Process unit movement
  processMovement(state);

  // 2. Detect and resolve proximity-based combats
  const proximityEngagements = detectProximityCombat(state);
  turnEngagements.push(...proximityEngagements);

  // 3. Process supply consumption
  const sEvents = processSupplyConsumption(state);
  supplyEvents.push(...sEvents);

  // 4. Process active missiles
  const mEvents = processActiveMissiles(state);
  missileEvents.push(...mEvents);

  // 5. Update territorial control
  const tEvents = updateTerritorialControl(state);
  territoryEvents.push(...tEvents);

  // 6. Apply morale and readiness recovery for non-engaged units
  processRecovery(state);

  // 7. Check for simulation conclusion
  checkSimulationEnd(state);

  // Build turn summary
  const summaryParts: string[] = [];
  if (turnEngagements.length > 0) {
    summaryParts.push(`${turnEngagements.length} combat engagement(s) resolved`);
  }
  if (missileEvents.length > 0) {
    summaryParts.push(`${missileEvents.length} missile event(s)`);
  }
  if (supplyEvents.length > 0) {
    summaryParts.push(`${supplyEvents.length} supply event(s)`);
  }
  if (territoryEvents.length > 0) {
    summaryParts.push(`${territoryEvents.length} territory change(s)`);
  }

  const turn: GameTurn = {
    turnNumber: state.simulation.currentTurn,
    simulationId: state.simulation.simulationId,
    engagements: turnEngagements,
    missileEvents,
    cumulativeCasualties: [...state.cumulativeCasualties.values()],
    supplyEvents,
    territoryEvents,
    summary: summaryParts.length > 0
      ? `Turn ${state.simulation.currentTurn}: ${summaryParts.join('; ')}.`
      : `Turn ${state.simulation.currentTurn}: No significant events.`,
    resolvedAt: Date.now(),
  };

  state.turnHistory.push(turn);
  return turn;
}

function processMovement(state: SimulationState): void {
  for (const unit of state.units.values()) {
    if (unit.state !== 'UNIT_STATE_MOVING' || !unit.location || !unit.destination) continue;

    const remaining = haversineDistance(unit.location, unit.destination);
    if (remaining <= unit.speedKmDay) {
      // Arrived
      unit.location = { ...unit.destination };
      unit.destination = undefined;
      unit.state = 'UNIT_STATE_ACTIVE';
    } else {
      // Move towards destination
      const fraction = unit.speedKmDay / remaining;
      unit.location = interpolateCoord(unit.location, unit.destination, fraction);
    }
    unit.updatedAt = Date.now();
  }
}

function detectProximityCombat(state: SimulationState): CombatEngagement[] {
  const engagements: CombatEngagement[] = [];
  const ENGAGEMENT_RANGE_KM = 50;
  const engaged = new Set<string>();

  const activeUnits = [...state.units.values()].filter(
    u => u.state !== 'UNIT_STATE_DESTROYED' && u.state !== 'UNIT_STATE_RESERVE' && u.location
  );

  // Check each pair of units from different factions
  for (let i = 0; i < activeUnits.length; i++) {
    if (engaged.has(activeUnits[i].unitId)) continue;
    for (let j = i + 1; j < activeUnits.length; j++) {
      if (engaged.has(activeUnits[j].unitId)) continue;
      const a = activeUnits[i];
      const b = activeUnits[j];
      if (a.faction === b.faction) continue;
      if (!a.location || !b.location) continue;

      const dist = haversineDistance(a.location, b.location);
      if (dist > ENGAGEMENT_RANGE_KM) continue;

      // 30% chance of engagement per turn when in proximity
      if (Math.random() > 0.3) continue;

      // Determine attacker (the one moving towards the other, or random)
      const aIsAttacker = a.state === 'UNIT_STATE_MOVING' || Math.random() > 0.5;

      const eng = resolveCombat(
        state,
        aIsAttacker ? [a.unitId] : [b.unitId],
        aIsAttacker ? [b.unitId] : [a.unitId],
        'TERRAIN_TYPE_OPEN',
        1.0,
      );
      engagements.push(eng);
      engaged.add(a.unitId);
      engaged.add(b.unitId);
    }
  }

  return engagements;
}

function processSupplyConsumption(state: SimulationState): TurnSupplyEvent[] {
  const events: TurnSupplyEvent[] = [];

  for (const [faction, pool] of state.resources) {
    // Daily consumption
    pool.ammunitionTons = Math.max(0, pool.ammunitionTons - pool.ammoConsumptionRate);
    pool.fuelTons = Math.max(0, pool.fuelTons - pool.fuelConsumptionRate);
    pool.foodDays = Math.max(0, pool.foodDays - 1);

    // Recalculate days until critical
    const ammoDays = pool.ammoConsumptionRate > 0 ? pool.ammunitionTons / pool.ammoConsumptionRate : 999;
    const fuelDays = pool.fuelConsumptionRate > 0 ? pool.fuelTons / pool.fuelConsumptionRate : 999;
    pool.daysUntilCritical = Math.min(ammoDays, fuelDays, pool.foodDays);

    // Update logistics health
    pool.logisticsHealth = Math.round(Math.min(100,
      (pool.ammunitionTons > 0 ? 33 : 0) +
      (pool.fuelTons > 0 ? 33 : 0) +
      (pool.foodDays > 0 ? 34 : 0)
    ));

    // Check for critical supply situations
    if (pool.daysUntilCritical < 7) {
      events.push({
        faction,
        supplyLineId: '',
        eventType: 'depleted',
        description: `${faction} supplies critically low — ${Math.round(pool.daysUntilCritical)} days remaining`,
      });

      // Reduce morale of all units for this faction
      for (const unit of state.units.values()) {
        if (unit.faction === faction && unit.state !== 'UNIT_STATE_DESTROYED') {
          unit.morale = Math.max(5, unit.morale - 5);
          unit.supplyLevel = Math.max(0, unit.supplyLevel - 10);
        }
      }
    }

    // Random supply line disruption (5% chance per line per turn)
    for (const line of state.supplyLines.values()) {
      if (line.faction !== faction || line.status === 'SUPPLY_LINE_STATUS_SEVERED') continue;
      if (Math.random() < 0.05) {
        line.status = 'SUPPLY_LINE_STATUS_DISRUPTED';
        line.interdictionCount++;
        line.lastDisruptedAt = Date.now();
        events.push({
          faction,
          supplyLineId: line.lineId,
          eventType: 'disrupted',
          description: `Supply line disrupted by enemy action`,
        });
      } else if (line.status === 'SUPPLY_LINE_STATUS_DISRUPTED' && Math.random() < 0.3) {
        // 30% chance to restore disrupted lines
        line.status = 'SUPPLY_LINE_STATUS_OPERATIONAL';
        events.push({
          faction,
          supplyLineId: line.lineId,
          eventType: 'restored',
          description: `Supply line restored to operational status`,
        });
      }
    }
  }

  return events;
}

function processActiveMissiles(state: SimulationState): TurnMissileEvent[] {
  const events: TurnMissileEvent[] = [];

  for (const [launchId, launch] of state.activeLaunches) {
    if (launch.status !== 'MISSILE_STATUS_IN_FLIGHT') continue;

    // Auto-resolve in-flight missiles (impact after 1 turn for simplicity)
    launch.status = 'MISSILE_STATUS_IMPACTED';
    launch.impactLocation = launch.targetLocation ? {
      latitude: launch.targetLocation.latitude + (Math.random() - 0.5) * (launch.cepMeters / 111000),
      longitude: launch.targetLocation.longitude + (Math.random() - 0.5) * (launch.cepMeters / 111000),
    } : undefined;
    launch.resolvedAt = Date.now();

    events.push({
      launchId,
      launcherFaction: launch.launcherFaction,
      missileName: launch.missileName,
      targetDescription: launch.targetLocation
        ? `${launch.targetLocation.latitude.toFixed(2)}N, ${launch.targetLocation.longitude.toFixed(2)}E`
        : 'unknown',
      status: launch.status,
      intercepted: false,
      interceptorType: '',
    });
  }

  return events;
}

function updateTerritorialControl(state: SimulationState): TurnTerritoryEvent[] {
  const events: TurnTerritoryEvent[] = [];

  for (const territory of state.territories.values()) {
    if (!territory.centroid) continue;

    // Count unit strength per faction within territory
    const factionStrength: Record<string, number> = {};
    for (const unit of state.units.values()) {
      if (!unit.location || unit.state === 'UNIT_STATE_DESTROYED') continue;
      // Check if unit is roughly within territory bounds
      if (territory.centroid) {
        const dist = haversineDistance(unit.location, territory.centroid);
        if (dist > Math.sqrt(territory.areaSqKm) * 0.7) continue;
      }
      factionStrength[unit.faction] = (factionStrength[unit.faction] || 0) + unitCombatPower(unit);
    }

    const factions = Object.entries(factionStrength).sort((a, b) => b[1] - a[1]);

    if (factions.length === 0) continue;

    const [strongestFaction, strongestPower] = factions[0];
    const secondPower = factions.length > 1 ? factions[1][1] : 0;

    // Territory is contested if opposing forces are within 2:1 ratio
    const wasContested = territory.contested;
    territory.contested = secondPower > 0 && strongestPower / secondPower < 2;

    // Control shifts if dominant faction differs and not contested
    if (strongestFaction !== territory.faction && !territory.contested) {
      const prev = territory.faction;
      territory.faction = strongestFaction;
      territory.trend = 'TERRITORY_TREND_EXPANDING';
      events.push({
        territoryId: territory.territoryId,
        previousFaction: prev,
        newFaction: strongestFaction,
        eventType: 'captured',
        description: `${strongestFaction} captured territory from ${prev}`,
      });
    } else if (territory.contested && !wasContested) {
      territory.trend = 'TERRITORY_TREND_CONTESTED';
      events.push({
        territoryId: territory.territoryId,
        previousFaction: territory.faction,
        newFaction: territory.faction,
        eventType: 'contested',
        description: `Territory is now contested between ${factions.map(f => f[0]).join(' and ')}`,
      });
    }

    territory.recentBattles = state.engagementLog.filter(e =>
      e.turnNumber === state.simulation.currentTurn &&
      territory.centroid &&
      e.location &&
      haversineDistance(e.location, territory.centroid) < Math.sqrt(territory.areaSqKm)
    ).length;
  }

  return events;
}

function processRecovery(state: SimulationState): void {
  for (const unit of state.units.values()) {
    if (unit.state === 'UNIT_STATE_DESTROYED') continue;

    // Units not in combat recover slowly
    if (unit.state === 'UNIT_STATE_ACTIVE' || unit.state === 'UNIT_STATE_FORTIFIED') {
      unit.readiness = Math.min(100, unit.readiness + 2);
      unit.morale = Math.min(100, unit.morale + 1);
      unit.supplyLevel = Math.min(100, unit.supplyLevel + 3);
    }

    // Retreating units lose morale but recover readiness once stopped
    if (unit.state === 'UNIT_STATE_RETREATING') {
      unit.morale = Math.max(5, unit.morale - 2);
      if (!unit.destination) {
        unit.state = 'UNIT_STATE_ACTIVE';
      }
    }
  }
}

function checkSimulationEnd(state: SimulationState): void {
  if (state.simulation.currentTurn >= state.simulation.maxTurns) {
    state.simulation.status = 'SIMULATION_STATUS_CONCLUDED';
    return;
  }

  // Check if any faction has been eliminated
  for (const faction of state.simulation.factions) {
    const activeUnits = [...state.units.values()].filter(
      u => u.faction === faction && u.state !== 'UNIT_STATE_DESTROYED'
    );
    if (activeUnits.length === 0) {
      state.simulation.status = 'SIMULATION_STATUS_CONCLUDED';
      return;
    }
  }
}

// ──────────────────────────────── Analysis ────────────────────────────────

/** Calculate force composition for a faction. */
export function getForceComposition(state: SimulationState, faction: string): ForceComposition {
  const factionUnits = [...state.units.values()].filter(
    u => u.faction === faction && u.state !== 'UNIT_STATE_DESTROYED'
  );

  const breakdownMap = new Map<string, { count: number; personnel: number }>();
  for (const u of factionUnits) {
    const entry = breakdownMap.get(u.unitType) || { count: 0, personnel: 0 };
    entry.count++;
    entry.personnel += u.personnel;
    breakdownMap.set(u.unitType, entry);
  }

  const breakdown: UnitTypeBreakdown[] = [...breakdownMap.entries()].map(([type, data]) => ({
    unitType: type as UnitType,
    count: data.count,
    personnel: data.personnel,
  }));

  const totalPersonnel = factionUnits.reduce((s, u) => s + u.personnel, 0);
  const totalEquipment = factionUnits.reduce((s, u) => s + u.equipmentCount, 0);
  const avgReadiness = factionUnits.reduce((s, u) => s + u.readiness, 0) / (factionUnits.length || 1);
  const avgMorale = factionUnits.reduce((s, u) => s + u.morale, 0) / (factionUnits.length || 1);

  return {
    faction,
    totalUnits: factionUnits.length,
    totalPersonnel,
    totalEquipment,
    forceStrengthIndex: Math.round((avgReadiness + avgMorale) / 2),
    breakdown,
  };
}

/** Assess military capabilities for a faction. */
export function assessCapabilities(state: SimulationState, faction: string): MilitaryCapabilityAssessment {
  const comp = getForceComposition(state, faction);
  const resources = state.resources.get(faction);
  const factionUnits = [...state.units.values()].filter(
    u => u.faction === faction && u.state !== 'UNIT_STATE_DESTROYED'
  );

  const avgMorale = factionUnits.reduce((s, u) => s + u.morale, 0) / (factionUnits.length || 1);
  const totalFirepower = factionUnits.reduce((s, u) => s + u.firepower, 0);
  const airUnits = factionUnits.filter(u =>
    u.unitType === 'UNIT_TYPE_FIGHTER_AIRCRAFT' || u.unitType === 'UNIT_TYPE_BOMBER_AIRCRAFT'
  );
  const navalUnits = factionUnits.filter(u =>
    u.unitType === 'UNIT_TYPE_NAVAL_SURFACE' || u.unitType === 'UNIT_TYPE_SUBMARINE'
  );

  // Determine trend based on casualty rate
  const casualties = state.cumulativeCasualties.get(faction);
  const totalLosses = casualties ? casualties.militaryKilled + casualties.militaryWounded : 0;
  const lossRate = state.simulation.currentTurn > 0
    ? totalLosses / state.simulation.currentTurn
    : 0;

  let trend: MilitaryCapabilityAssessment['trend'] = 'CAPABILITY_TREND_STABLE';
  if (lossRate > 500) trend = 'CAPABILITY_TREND_COLLAPSING';
  else if (lossRate > 200) trend = 'CAPABILITY_TREND_DEGRADING';
  else if (lossRate < 50 && comp.forceStrengthIndex > 70) trend = 'CAPABILITY_TREND_IMPROVING';

  return {
    faction,
    assessedAt: Date.now(),
    unitCount: comp.totalUnits,
    personnelStrength: comp.totalPersonnel,
    equipmentCount: comp.totalEquipment,
    combatPowerIndex: Math.min(100, totalFirepower / (factionUnits.length || 1)),
    logisticsRating: resources?.logisticsHealth || 50,
    leadershipRating: 60 + Math.floor(Math.random() * 20),
    techAdvantage: 50 + Math.floor(Math.random() * 30),
    morale: Math.round(avgMorale),
    airSuperiority: Math.min(100, airUnits.length * 15),
    navalDominance: Math.min(100, navalUnits.length * 20),
    trend,
    confidence: 70 + Math.floor(Math.random() * 20),
  };
}

/** Project casualties forward by horizon_days. */
export function projectCasualties(
  state: SimulationState,
  faction: string,
  horizonDays: number,
): CasualtyProjection {
  const casualties = state.cumulativeCasualties.get(faction);
  const currentTurn = state.simulation.currentTurn || 1;

  const dailyKillRate = (casualties?.militaryKilled || 0) / currentTurn;
  const dailyWoundRate = (casualties?.militaryWounded || 0) / currentTurn;
  const dailyCivilianRate = (casualties?.civilianCasualties || 0) / currentTurn;
  const dailyEquipRate = (casualties?.equipmentDestroyed || 0) / currentTurn;

  const projectedKilled = Math.round(dailyKillRate * horizonDays);
  const projectedWounded = Math.round(dailyWoundRate * horizonDays);
  const projectedCivilian = Math.round(dailyCivilianRate * horizonDays);
  const projectedEquipment = Math.round(dailyEquipRate * horizonDays);

  // Confidence decreases with longer projection horizons
  const confidence = Math.max(20, 90 - Math.floor(horizonDays / 10));

  // Variance range based on confidence
  const varianceFactor = (100 - confidence) / 100;
  const totalProjected = projectedKilled + projectedWounded;
  const lowEstimate = Math.round(totalProjected * (1 - varianceFactor));
  const highEstimate = Math.round(totalProjected * (1 + varianceFactor));

  const drivingFactors: string[] = [];
  if (dailyKillRate > 100) drivingFactors.push('High intensity ground combat');
  if (dailyCivilianRate > 50) drivingFactors.push('Urban warfare causing civilian casualties');
  const resources = state.resources.get(faction);
  if (resources && resources.daysUntilCritical < 30) drivingFactors.push('Supply shortage increasing losses');
  if (drivingFactors.length === 0) drivingFactors.push('Sustained operational tempo');

  return {
    faction,
    horizonDays,
    projectedKilled,
    projectedWounded,
    projectedCivilian,
    lowEstimate,
    highEstimate,
    projectedEquipmentLost: projectedEquipment,
    drivingFactors,
    confidence,
  };
}

/** Analyze possible conflict outcome scenarios. */
export function analyzeOutcomes(state: SimulationState): {
  scenarios: ConflictOutcomeScenario[];
  summary: string;
} {
  const factions = state.simulation.factions;
  if (factions.length < 2) return { scenarios: [], summary: 'Insufficient factions for analysis.' };

  const assessments = factions.map(f => ({
    faction: f,
    assessment: assessCapabilities(state, f),
  }));

  // Sort by combat power
  assessments.sort((a, b) => b.assessment.combatPowerIndex - a.assessment.combatPowerIndex);

  const [stronger, weaker] = assessments;
  const powerGap = stronger.assessment.combatPowerIndex - weaker.assessment.combatPowerIndex;

  const scenarios: ConflictOutcomeScenario[] = [];

  // Scenario 1: Stronger faction victory
  const strongVictoryProb = Math.min(60, 30 + powerGap);
  scenarios.push({
    scenarioId: uid(),
    label: `${stronger.faction} Military Victory`,
    description: `${stronger.faction} achieves decisive military advantage through superior combat power and logistics.`,
    probabilityPercent: strongVictoryProb,
    durationDays: Math.round(90 + Math.random() * 180),
    expectedMilitaryCasualties: Math.round(10000 + Math.random() * 50000),
    expectedCivilianCasualties: Math.round(5000 + Math.random() * 20000),
    territorialOutcome: `${stronger.faction} gains significant territory`,
    requiredConditions: ['Sustained logistics', 'Air superiority maintained', 'No external intervention'],
    resolutionMechanism: 'military victory',
  });

  // Scenario 2: Prolonged stalemate
  const stalemateProb = Math.max(15, 40 - powerGap);
  scenarios.push({
    scenarioId: uid(),
    label: 'Prolonged Stalemate',
    description: 'Neither side achieves decisive advantage; conflict devolves into attritional warfare.',
    probabilityPercent: stalemateProb,
    durationDays: Math.round(365 + Math.random() * 365),
    expectedMilitaryCasualties: Math.round(50000 + Math.random() * 100000),
    expectedCivilianCasualties: Math.round(20000 + Math.random() * 50000),
    territorialOutcome: 'Minor frontline shifts, largely frozen conflict',
    requiredConditions: ['Both sides maintain supply lines', 'No escalation to WMD', 'Continued external support'],
    resolutionMechanism: 'negotiated ceasefire',
  });

  // Scenario 3: Negotiated settlement
  scenarios.push({
    scenarioId: uid(),
    label: 'Negotiated Settlement',
    description: 'International pressure and war fatigue lead to diplomatic resolution.',
    probabilityPercent: Math.max(10, 100 - strongVictoryProb - stalemateProb - 10),
    durationDays: Math.round(60 + Math.random() * 120),
    expectedMilitaryCasualties: Math.round(5000 + Math.random() * 20000),
    expectedCivilianCasualties: Math.round(2000 + Math.random() * 10000),
    territorialOutcome: 'Partial territorial concessions by weaker party',
    requiredConditions: ['International mediation', 'War fatigue on both sides', 'Credible security guarantees'],
    resolutionMechanism: 'diplomatic agreement',
  });

  // Scenario 4: Escalation
  scenarios.push({
    scenarioId: uid(),
    label: 'Dangerous Escalation',
    description: 'Conflict escalates beyond initial scope with potential for WMD use or wider regional war.',
    probabilityPercent: Math.min(15, 10 + Math.floor(powerGap / 5)),
    durationDays: Math.round(30 + Math.random() * 90),
    expectedMilitaryCasualties: Math.round(100000 + Math.random() * 500000),
    expectedCivilianCasualties: Math.round(50000 + Math.random() * 200000),
    territorialOutcome: 'Unpredictable — potential for complete restructuring',
    requiredConditions: ['Red lines crossed', 'Alliance activation', 'Command and control failures'],
    resolutionMechanism: 'ceasefire after escalation',
  });

  const summary = `Analysis of ${state.simulation.name}: ${stronger.faction} holds a ${powerGap > 20 ? 'significant' : 'modest'} combat power advantage. ` +
    `After ${state.simulation.currentTurn} days of conflict, the most likely outcome is ` +
    `${scenarios[0].label} (${scenarios[0].probabilityPercent}% probability).`;

  return { scenarios, summary };
}
