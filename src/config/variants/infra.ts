/**
 * INFRA VARIANT — Gulf FDI & Critical Infrastructure Tracker
 *
 * Tracks Saudi Arabia and UAE foreign direct investment in global
 * critical infrastructure: ports, pipelines, energy, data centers,
 * airports, railways, telecoms, and mining.
 *
 * Usage: VITE_VARIANT=infra
 */
import type { PanelConfig, MapLayers } from '@/types';

// Re-export base config
export * from './base';

// Infra-specific data
export { GULF_INVESTMENTS } from '../gulf-fdi';

// Infra variant panels
export const INFRA_PANELS: Record<string, PanelConfig> = {
  map:                  { name: 'Gulf FDI World Map',           enabled: true,  priority: 1 },
  'fdi-investments':    { name: 'Investment Database',           enabled: true,  priority: 1 },
  'fdi-announcements':  { name: 'New Announcements',             enabled: true,  priority: 1 },
  'live-news':          { name: 'Live FDI News',                 enabled: true,  priority: 1 },
  fdiNews:              { name: 'Gulf Business News',            enabled: true,  priority: 1 },
  entityNews:           { name: 'Entity News',                   enabled: true,  priority: 1 },
  infraMedia:           { name: 'Infrastructure Media',          enabled: true,  priority: 1 },
  announcements:        { name: 'New Project Announcements',     enabled: true,  priority: 1 },
  regional:             { name: 'Regional Coverage',             enabled: true,  priority: 2 },
  markets:              { name: 'Markets',                       enabled: true,  priority: 2 },
  energy:               { name: 'Energy & Resources',            enabled: true,  priority: 2 },
  insights:             { name: 'AI Insights',                   enabled: true,  priority: 2 },
  monitors:             { name: 'My Monitors',                   enabled: true,  priority: 2 },
};

// Infra variant map layers — focus on infrastructure context layers
export const INFRA_MAP_LAYERS: MapLayers = {
  conflicts:        false,
  bases:            false,
  cables:           false,
  pipelines:        true,    // Show pipelines for energy/supply context
  hotspots:         false,
  ais:              true,    // Show strategic ports
  nuclear:          false,
  irradiators:      false,
  sanctions:        false,
  weather:          false,
  economic:         true,    // Economic hub context
  waterways:        true,    // Strategic waterway context (Suez, Strait of Hormuz, etc.)
  outages:          false,
  datacenters:      false,
  protests:         false,
  flights:          false,
  military:         false,
  natural:          false,
  spaceports:       false,
  minerals:         true,    // Critical minerals context
  fires:            false,
  startupHubs:      false,
  cloudRegions:     false,
  accelerators:     false,
  techHQs:          false,
  techEvents:       false,
  gulfInvestments:  true,    // Gulf FDI investments — primary layer
};

export const INFRA_MOBILE_MAP_LAYERS: MapLayers = {
  conflicts:        false,
  bases:            false,
  cables:           false,
  pipelines:        false,
  hotspots:         false,
  ais:              false,
  nuclear:          false,
  irradiators:      false,
  sanctions:        false,
  weather:          false,
  economic:         false,
  waterways:        true,
  outages:          false,
  datacenters:      false,
  protests:         false,
  flights:          false,
  military:         false,
  natural:          false,
  spaceports:       false,
  minerals:         false,
  fires:            false,
  startupHubs:      false,
  cloudRegions:     false,
  accelerators:     false,
  techHQs:          false,
  techEvents:       false,
  gulfInvestments:  true,
};
