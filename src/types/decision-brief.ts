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
  /**
   * World mine/refinery output for the selected commodity. Null when the
   * registry row has no `mineralProductionId` (nothing to ask for) and when the
   * request failed — the trade evidence stands on its own either way, so the
   * brief reports the gap instead of failing the capture.
   */
  production: import('@/generated/client/worldmonitor/supply_chain/v1/service_client').GetMineralProductionResponse | null;
}

export interface CommodityBriefSnapshot {
  kind: 'commodity';
  basket: string;
  coverage: string[];
  selection: CommodityBriefSelection;
  capturedAt: string;
  commodity: string;
  hs4: string;
  capture: CommodityBriefCapture;
  evidence: DecisionBriefSnapshot['evidence'];
  candidates: {
    origin: string;
    partnerCode: number;
    partnerScope: string;
    shareReference: string;
    sharePct: number | null;
    routeIds: string[];
    transitChokepoints: string[];
    affectedChokepoints: string[];
    routeState: 'exposed' | 'not_on_modeled_route' | 'unknown';
    reason: string;
    constraints: string;
    // Every field below is null or false when the evidence is absent, never
    // undefined: the preview, the HTML export and the e2e round-trip all compare
    // `JSON.parse(JSON.stringify(snapshot))` against the snapshot object, and
    // JSON drops undefined properties.
    netWeightKg: number | null;
    netWeightEstimated: boolean;
    quantity: number | null;
    /** Provider abbreviation for `quantity` (e.g. `m³`), rendered as published. */
    quantityUnit: string | null;
    transitHub: boolean;
    /**
     * `rank` is among the `reporterCount` reporters that filed `year`;
     * `unrankedReporterCount` filed only earlier years and is left out, so
     * the rank is not a rank among every world exporter. Counts are null on a
     * snapshot written before they were recorded.
     */
    scale: { worldExportsUsd: number; worldExportsKg: number | null; rank: number; year: number; reporterCount: number | null; unrankedReporterCount: number | null } | null;
    /** `sharePct` is percent of named producers (0-100), not the 0-1 trade share. */
    production: { sharePct: number | null; stage: 'mine' | 'refinery'; source: string; restricted: boolean } | null;
  }[];
  context: string;
  caveats: string[];
  ordering: string;
  action: DecisionBriefSnapshot['action'];
}
