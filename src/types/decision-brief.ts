import type { ComputeEnergyShockScenarioResponse } from '@/generated/client/worldmonitor/intelligence/v1/service_client';

export interface DecisionBriefSelection {
  countryCode: string;
  countryName: string;
  chokepointId: string;
  fuelMode: 'gas' | 'oil';
  baselinePct: number;
  comparisonPct: number;
}

export interface DecisionBriefCapture {
  retrievedAt: string;
  response: ComputeEnergyShockScenarioResponse;
}

export interface DecisionBriefSnapshot {
  operationalWorksheet?: import('./operational-balance').OperationalSnapshot | null;
  selection: DecisionBriefSelection;
  capturedAt: string;
  captures: [DecisionBriefCapture, DecisionBriefCapture];
  evidence: { id: string; label: string; value: number | null; unit: string; source: string; sourceUrl: string; observedAt: string | null }[];
  results: { reference: string; severity: number; loss: number | null; unit: string; demandPct: number | null; observedAt: string | null }[];
  comparison: { delta: number | null; reason: string };
  assumptions: string[];
  impact: string;
  action: { text: string; references: string[]; constraint: string; trigger: string };
  unknowns: string[];
}

export interface CommodityBriefSelection {
  countryCode: string;
  countryName: string;
  commodityId: string;
  chokepointId: string;
}

export interface CommodityBriefCapture {
  retrievedAt: string;
  products: import('@/generated/client/worldmonitor/supply_chain/v1/service_client').GetCountryProductsResponse;
  vulnerabilities: import('@/generated/client/worldmonitor/supply_chain/v1/service_client').GetCountryVulnerabilitiesResponse;
}

export interface CommodityBriefSnapshot {
  kind: 'commodity';
  selection: CommodityBriefSelection;
  capturedAt: string;
  commodity: string;
  hs4: string;
  capture: CommodityBriefCapture;
  evidence: DecisionBriefSnapshot['evidence'];
  candidates: {
    origin: string;
    shareReference: string;
    sharePct: number | null;
    routeIds: string[];
    transitChokepoints: string[];
    affectedChokepoints: string[];
    routeState: 'exposed' | 'not_on_modeled_route' | 'unknown';
    reason: string;
    constraints: string;
  }[];
  context: string;
  caveats: string[];
  ordering: string;
  action: DecisionBriefSnapshot['action'];
}
