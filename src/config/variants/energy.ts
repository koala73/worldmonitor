// Energy variant - energy.worldmonitor.app
// NOTE: This file is a structured canonical description for reference. The runtime
// wiring lives in src/config/panels.ts (ENERGY_PANELS, ENERGY_MAP_LAYERS,
// ENERGY_MOBILE_MAP_LAYERS) — modify both if the variant shape changes. Parallel
// to commodity.ts / finance.ts / tech.ts / happy.ts / full.ts orphans.
// See docs/internal/global-energy-flow-parity-and-surpass.md for the full plan.
import type { PanelConfig, MapLayers } from '@/types';
import type { VariantConfig } from './base';

// Re-export base config
export * from './base';

// ─────────────────────────────────────────────────────────────────────────────
// PANEL CONFIGURATION — Energy-focused panels
// IDs match existing panel registrations; new panels (PipelineStatusPanel,
// StorageFacilityMapPanel, FuelShortagePanel) land on this variant in Week 2–3.
// ─────────────────────────────────────────────────────────────────────────────
export const DEFAULT_PANELS: Record<string, PanelConfig> = {
  // Core
  map: { name: 'Energy & Infrastructure Map', enabled: true, priority: 1 },
  'live-news': { name: 'Energy Headlines', enabled: true, priority: 1 },
  // Energy complex — existing panels we reuse in Week 1
  'energy-complex': { name: 'Oil & Gas Complex', enabled: true, priority: 1 },
  'oil-inventories': { name: 'Oil & Gas Inventories', enabled: true, priority: 1 },
  'fuel-prices': { name: 'Retail Fuel Prices', enabled: true, priority: 1 },
  hormuz: { name: 'Strait of Hormuz Tracker', enabled: true, priority: 1 },
  'energy-crisis': { name: 'Energy Crisis Policy Tracker', enabled: true, priority: 1 },
  'renewable-energy': { name: 'Renewable Energy', enabled: true, priority: 2 },
  // Markets relevant to energy
  commodities: { name: 'Energy Commodities (WTI, Brent, NatGas)', enabled: true, priority: 1 },
  'macro-signals': { name: 'Market Radar', enabled: true, priority: 2 },
  // Supply-chain & sanctions context
  'supply-chain': { name: 'Chokepoints & Routes', enabled: true, priority: 1 },
  'sanctions-pressure': { name: 'Sanctions Pressure', enabled: true, priority: 2 },
  // Gulf / OPEC context
  'gulf-economies': { name: 'Gulf & OPEC Economies', enabled: true, priority: 2 },
  // Climate — demand driver for heating/cooling
  climate: { name: 'Climate & Weather Impact', enabled: true, priority: 2 },
  // Tracking
  monitors: { name: 'My Monitors', enabled: true, priority: 3 },
};

// ─────────────────────────────────────────────────────────────────────────────
// MAP LAYERS — Energy-focused
// Only energy-relevant layers enabled; all others explicitly false.
// ─────────────────────────────────────────────────────────────────────────────
export const DEFAULT_MAP_LAYERS: MapLayers = {
  // ── Core energy map layers (ENABLED) ──────────────────────────────────────
  pipelines: true,          // Oil & gas pipelines (first-class object from Week 2)
  waterways: true,          // Strategic shipping chokepoints (Hormuz, Suez, etc.)
  tradeRoutes: true,        // Tanker trade routes
  ais: true,                // Tanker positions at chokepoints
  commodityPorts: true,     // LNG / crude import & export ports
  minerals: true,           // Critical minerals (battery / energy transition overlap)
  miningSites: false,
  processingPlants: false,
  commodityHubs: true,      // Energy exchanges (ICE, NYMEX, TTF, JKM hubs)
  sanctions: true,          // Sanctions directly impact energy trade
  economic: false,
  fires: true,              // Fires near energy infrastructure / forestry
  climate: true,            // Weather / heating & cooling demand
  outages: true,            // Power outages — energy system status
  natural: true,            // Earthquakes — infrastructure risk
  weather: true,            // Weather impacting operations

  // ── Non-energy layers (DISABLED) ──────────────────────────────────────────
  gpsJamming: false,
  satellites: false,
  iranAttacks: false,
  conflicts: false,
  bases: false,
  hotspots: false,
  nuclear: false,
  irradiators: false,
  military: false,
  spaceports: false,
  ucdpEvents: false,
  displacement: false,
  protests: false,
  flights: false,
  cables: false,
  datacenters: false,
  // Tech variant layers
  startupHubs: false,
  cloudRegions: false,
  accelerators: false,
  techHQs: false,
  techEvents: false,
  // Finance variant layers
  stockExchanges: false,
  financialCenters: false,
  centralBanks: false,
  gulfInvestments: false,
  // Happy variant layers
  positiveEvents: false,
  kindness: false,
  happiness: false,
  speciesRecovery: false,
  renewableInstallations: false,
  // Overlay
  dayNight: false,
  cyberThreats: false,
  ciiChoropleth: false,
  resilienceScore: false,
  webcams: false,
  diseaseOutbreaks: false,
};

// ─────────────────────────────────────────────────────────────────────────────
// MOBILE MAP LAYERS — Minimal set for energy mobile view
// ─────────────────────────────────────────────────────────────────────────────
export const MOBILE_DEFAULT_MAP_LAYERS: MapLayers = {
  // Core energy layers (limited for mobile perf)
  pipelines: true,
  waterways: true,
  tradeRoutes: false,
  ais: false,
  commodityPorts: true,
  minerals: false,
  miningSites: false,
  processingPlants: false,
  commodityHubs: false,
  sanctions: false,
  economic: false,
  fires: false,
  climate: false,
  outages: false,
  natural: true,
  weather: false,

  // All others disabled on mobile
  gpsJamming: false,
  satellites: false,
  iranAttacks: false,
  conflicts: false,
  bases: false,
  hotspots: false,
  nuclear: false,
  irradiators: false,
  military: false,
  spaceports: false,
  ucdpEvents: false,
  displacement: false,
  protests: false,
  flights: false,
  cables: false,
  datacenters: false,
  startupHubs: false,
  cloudRegions: false,
  accelerators: false,
  techHQs: false,
  techEvents: false,
  stockExchanges: false,
  financialCenters: false,
  centralBanks: false,
  gulfInvestments: false,
  positiveEvents: false,
  kindness: false,
  happiness: false,
  speciesRecovery: false,
  renewableInstallations: false,
  dayNight: false,
  cyberThreats: false,
  ciiChoropleth: false,
  resilienceScore: false,
  webcams: false,
  diseaseOutbreaks: false,
};

export const VARIANT_CONFIG: VariantConfig = {
  name: 'energy',
  description: 'Global energy intelligence — pipelines, storage, chokepoints, shortages, disruption timeline',
  panels: DEFAULT_PANELS,
  mapLayers: DEFAULT_MAP_LAYERS,
  mobileMapLayers: MOBILE_DEFAULT_MAP_LAYERS,
};
