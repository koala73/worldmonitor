// OpenSens DAMD variant — decentralized off-grid AI micro data center platform
import type { PanelConfig, MapLayers } from '@/types';
import type { VariantConfig } from './base';

export * from './base';

// OpenSens-specific panels
export const DEFAULT_PANELS: Record<string, PanelConfig> = {
  map:                  { name: 'World Map',              enabled: true,  priority: 1 },
  'energy-potential':   { name: 'Energy Potential',       enabled: true,  priority: 1 },
  'autonomy-simulator': { name: 'Autonomy Simulator',     enabled: true,  priority: 1 },
  'connectivity':       { name: 'Connectivity Planner',   enabled: true,  priority: 1 },
  'node-placement':     { name: 'Node Placement',         enabled: true,  priority: 1 },
  'roi-dashboard':      { name: 'ROI Dashboard',          enabled: true,  priority: 1 },
  'assumptions':        { name: 'Assumptions & Sources',  enabled: true,  priority: 2 },
  'live-news':          { name: 'Energy & Grid News',     enabled: true,  priority: 2 },
  monitors:             { name: 'My Monitors',            enabled: true,  priority: 2 },
};

export const DEFAULT_MAP_LAYERS: MapLayers = {
  // Global layers — off by default in OpenSens
  conflicts: false, bases: false, cables: false, pipelines: false,
  hotspots: false, ais: false, nuclear: false, irradiators: false,
  sanctions: false, weather: true, economic: false, waterways: false,
  outages: true, cyberThreats: false, datacenters: true, protests: false,
  flights: false, military: false, natural: true, spaceports: false,
  minerals: false, fires: false, ucdpEvents: false, displacement: false,
  climate: true, startupHubs: false, cloudRegions: false, accelerators: false,
  techHQs: false, techEvents: false, stockExchanges: false,
  financialCenters: false, centralBanks: false, commodityHubs: false,
  gulfInvestments: false, positiveEvents: false, kindness: false,
  happiness: false, speciesRecovery: false, renewableInstallations: true,
  tradeRoutes: false,
  // OpenSens-specific layers
  pvPotential: true, windViability: true, aqiHeatmap: true,
  candidateNodes: true, starlinkHubs: true, fiberRoutes: false,
};

export const MOBILE_DEFAULT_MAP_LAYERS: MapLayers = {
  ...DEFAULT_MAP_LAYERS,
  pvPotential: true, windViability: false, aqiHeatmap: false,
  candidateNodes: true, starlinkHubs: true, fiberRoutes: false,
  renewableInstallations: false, weather: false, climate: false,
};

export const VARIANT_CONFIG: VariantConfig = {
  name: 'opensens',
  description: 'OpenSens DAMD — decentralized off-grid AI micro data center siting platform',
  panels: DEFAULT_PANELS,
  mapLayers: DEFAULT_MAP_LAYERS,
  mobileMapLayers: MOBILE_DEFAULT_MAP_LAYERS,
};
