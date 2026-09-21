/**
 * React-safe mission catalog (mirrors vanilla MISSION_PRESETS fields used here).
 */
import {
  MISSION_PRESET_IDS,
  parseMissionPresetId,
  type MissionPresetId,
} from '@wm-shared/mission-domain';
import type { MapView, TimeRange } from './url-state';

export type { MissionPresetId };

export const MISSION_STORAGE_KEY = 'worldmonitor-mission-preset-v1';

export interface ReactMission {
  id: MissionPresetId;
  label: string;
  shortLabel: string;
  description: string;
  view: MapView;
  zoom?: number;
  timeRange: TimeRange;
  panels: string[];
  layers: string[];
}

export const PANEL_LABELS: Record<string, string> = {
  'live-news': 'Live News',
  insights: 'AI Insights',
  'strategic-posture': 'Strategic Posture',
  cii: 'CII',
  'strategic-risk': 'Strategic Risk',
  'gdelt-intel': 'GDELT Intel',
  cascade: 'Cascade',
  'military-correlation': 'Military Correlation',
  'escalation-correlation': 'Escalation',
  'ucdp-events': 'UCDP Events',
  'security-advisories': 'Advisories',
  'airline-intel': 'Airline Intel',
  'supply-chain': 'Supply Chain',
  'chokepoint-strip': 'Chokepoints',
  'hormuz-tracker': 'Hormuz Tracker',
  commodities: 'Commodities',
  'energy-complex': 'Energy Complex',
  markets: 'Markets',
  'consumer-prices': 'Consumer Prices',
  'oil-inventories': 'Oil Inventories',
  'energy-crisis': 'Energy Crisis',
  'pipeline-status': 'Pipeline Status',
  'storage-facility-map': 'Storage Map',
  'fuel-shortages': 'Fuel Shortages',
  'energy-disruptions': 'Energy Disruptions',
  'energy-risk-overview': 'Energy Risk',
  intel: 'Intel',
  politics: 'Politics',
  middleeast: 'Middle East',
  europe: 'Europe',
  africa: 'Africa',
  latam: 'LatAm',
  asia: 'Asia',
  us: 'US',
  'social-velocity': 'Social Velocity',
  'live-webcams': 'Webcams',
  heatmap: 'Heatmap',
  'market-breadth': 'Market Breadth',
  'earnings-calendar': 'Earnings',
  'macro-signals': 'Macro Signals',
  'fear-greed': 'Fear & Greed',
  economic: 'Economic',
  'liquidity-shifts': 'Liquidity',
  'positioning-247': 'Positioning',
  'gold-intelligence': 'Gold',
  'etf-flows': 'ETF Flows',
  stablecoins: 'Stablecoins',
  crypto: 'Crypto',
  finance: 'Finance',
  'economic-calendar': 'Econ Calendar',
  ai: 'AI',
  tech: 'Tech',
  startups: 'Startups',
  security: 'Security',
  policy: 'Policy',
  hardware: 'Hardware',
  cloud: 'Cloud',
  github: 'GitHub',
  'tech-readiness': 'Tech Readiness',
  funding: 'Funding',
  unicorns: 'Unicorns',
  accelerators: 'Accelerators',
  events: 'Events',
  'internet-disruptions': 'Internet',
  'service-status': 'Service Status',
  monitors: 'Monitors',
  'positive-feed': 'Positive Feed',
  progress: 'Progress',
  counters: 'Counters',
  spotlight: 'Spotlight',
  breakthroughs: 'Breakthroughs',
  digest: 'Digest',
  species: 'Species',
  renewable: 'Renewable',
  'nq-pulse': 'NQ Pulse',
  'nq-catalysts': 'NQ Catalysts',
  'nq-news': 'NQ News',
  fsi: 'FSI',
  'yield-curve': 'Yield Curve',
  'sanctions-pressure': 'Sanctions',
  displacement: 'Displacement',
  'population-exposure': 'Population',
};

export const REACT_MISSIONS: readonly ReactMission[] = [
  {
    id: 'crisis-desk',
    label: 'Crisis Desk',
    shortLabel: 'Crisis',
    description: 'Conflict, posture, instability, and live intelligence.',
    view: 'mena',
    zoom: 3.6,
    timeRange: '24h',
    panels: [
      'map',
      'live-news',
      'insights',
      'strategic-posture',
      'cii',
      'strategic-risk',
      'gdelt-intel',
    ],
    layers: [
      'conflicts',
      'hotspots',
      'military',
      'bases',
      'iranAttacks',
      'ucdpEvents',
      'protests',
      'sanctions',
      'outages',
      'weather',
      'natural',
      'ciiChoropleth',
    ],
  },
  {
    id: 'supply-chain-risk',
    label: 'Supply-Chain Risk',
    shortLabel: 'Supply',
    description: 'Routes, chokepoints, country risk, and commodities.',
    view: 'global',
    zoom: 2.3,
    timeRange: '7d',
    panels: [
      'map',
      'supply-chain',
      'chokepoint-strip',
      'hormuz-tracker',
      'cascade',
      'strategic-risk',
      'cii',
    ],
    layers: [
      'tradeRoutes',
      'waterways',
      'ais',
      'cables',
      'pipelines',
      'commodityHubs',
      'commodityPorts',
      'minerals',
      'economic',
      'sanctions',
      'weather',
      'natural',
      'resilienceScore',
    ],
  },
  {
    id: 'energy-security',
    label: 'Energy Security',
    shortLabel: 'Energy',
    description: 'Pipelines, storage, tankers, outages, and disruption logs.',
    view: 'mena',
    zoom: 3.2,
    timeRange: '7d',
    panels: [
      'map',
      'energy-complex',
      'oil-inventories',
      'energy-crisis',
      'pipeline-status',
      'storage-facility-map',
      'fuel-shortages',
    ],
    layers: [
      'pipelines',
      'storageFacilities',
      'fuelShortages',
      'liveTankers',
      'ais',
      'tradeRoutes',
      'waterways',
      'commodityPorts',
      'commodityHubs',
      'sanctions',
      'fires',
      'weather',
      'outages',
      'natural',
    ],
  },
  {
    id: 'osint-newsroom',
    label: 'News Seeker',
    shortLabel: 'News',
    description: 'Breaking news, source context, webcams, advisories, and social signal.',
    view: 'global',
    zoom: 2.1,
    timeRange: '24h',
    panels: [
      'map',
      'live-news',
      'gdelt-intel',
      'intel',
      'politics',
      'social-velocity',
      'live-webcams',
    ],
    layers: [
      'hotspots',
      'conflicts',
      'protests',
      'ucdpEvents',
      'displacement',
      'outages',
      'cyberThreats',
      'webcams',
      'weather',
      'natural',
      'fires',
    ],
  },
  {
    id: 'macro-market-watch',
    label: 'Stock Geek',
    shortLabel: 'Stocks',
    description: 'Stocks, market breadth, earnings, macro signals, and event context.',
    view: 'america',
    zoom: 3,
    timeRange: '7d',
    panels: [
      'map',
      'markets',
      'heatmap',
      'market-breadth',
      'earnings-calendar',
      'macro-signals',
      'fear-greed',
    ],
    layers: [
      'stockExchanges',
      'financialCenters',
      'centralBanks',
      'commodityHubs',
      'gulfInvestments',
      'economic',
      'tradeRoutes',
      'pipelines',
      'waterways',
      'sanctions',
      'outages',
      'weather',
      'natural',
    ],
  },
  {
    id: 'tech-ai-watch',
    label: 'Tech / AI Watcher',
    shortLabel: 'Tech',
    description: 'AI labs, startups, chips, cloud, cyber, and regulation signals.',
    view: 'global',
    zoom: 2.4,
    timeRange: '7d',
    panels: ['map', 'live-news', 'insights', 'ai', 'tech', 'startups', 'security'],
    layers: [
      'datacenters',
      'startupHubs',
      'techHQs',
      'hotspots',
      'cloudRegions',
      'cables',
      'outages',
      'cyberThreats',
      'natural',
    ],
  },
  {
    id: 'good-news-explorer',
    label: 'Good News Explorer',
    shortLabel: 'Good',
    description: 'Progress, breakthroughs, conservation wins, and clean-energy momentum.',
    view: 'global',
    zoom: 2.2,
    timeRange: '7d',
    panels: ['map', 'positive-feed', 'progress', 'counters', 'spotlight', 'breakthroughs', 'digest'],
    layers: [
      'positiveEvents',
      'kindness',
      'happiness',
      'speciesRecovery',
      'renewableInstallations',
    ],
  },
  {
    id: 'nq-day-trader',
    label: 'NQ Day Trader',
    shortLabel: 'NQ',
    description: 'E-mini Nasdaq-100 context, catalysts, and curated NQ news.',
    view: 'america',
    zoom: 3.4,
    timeRange: '24h',
    panels: ['map', 'nq-pulse', 'nq-catalysts', 'nq-news', 'live-news', 'heatmap', 'economic'],
    layers: ['stockExchanges', 'financialCenters', 'centralBanks', 'economic', 'outages'],
  },
  {
    id: 'country-watcher',
    label: 'Country Watcher',
    shortLabel: 'Watch',
    description: 'Instability, sanctions, displacement, and risk for followed countries.',
    view: 'global',
    zoom: 2.2,
    timeRange: '48h',
    panels: [
      'map',
      'live-news',
      'cii',
      'strategic-risk',
      'sanctions-pressure',
      'security-advisories',
      'gdelt-intel',
    ],
    layers: [
      'conflicts',
      'hotspots',
      'protests',
      'sanctions',
      'ucdpEvents',
      'ciiChoropleth',
      'outages',
      'natural',
    ],
  },
];

export function getMission(id: string | null | undefined): ReactMission | null {
  const parsed = parseMissionPresetId(id);
  if (!parsed) return null;
  return REACT_MISSIONS.find((m) => m.id === parsed) ?? null;
}

export function loadStoredMission(): ReactMission | null {
  try {
    return getMission(localStorage.getItem(MISSION_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function saveMission(id: MissionPresetId | null): void {
  try {
    if (id) localStorage.setItem(MISSION_STORAGE_KEY, id);
    else localStorage.removeItem(MISSION_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/** First 6 non-map panels for the feed bento. */
export function missionFeedSlots(mission: ReactMission | null): string[] {
  if (!mission) {
    return ['live-news', 'insights', 'strategic-risk', 'cii', 'gdelt-intel', 'cascade'];
  }
  return mission.panels.filter((p) => p !== 'map').slice(0, 6);
}

export function panelLabel(key: string): string {
  return PANEL_LABELS[key] ?? key.replace(/-/g, ' ');
}

export { MISSION_PRESET_IDS };
