import type { CountryBriefSignals } from '@/types';
import type { CountryScore } from '@/services/country-instability';
import type { PredictionMarket } from '@/services/prediction';
import type { NewsItem } from '@/types';
import type { GetCountryChokepointIndexResponse, SectorExposureSummary, CountryProductsResponse } from '@/services/supply-chain';

export interface CountryIntelData {
  brief: string;
  country: string;
  code: string;
  cached?: boolean;
  generatedAt?: string;
  error?: string;
  skipped?: boolean;
  reason?: string;
  fallback?: boolean;
}

export interface StockIndexData {
  available: boolean;
  code: string;
  symbol: string;
  indexName: string;
  price: string;
  weekChangePercent: string;
  currency: string;
  cached?: boolean;
}

type ThreatLevel = 'critical' | 'high' | 'medium' | 'low' | 'info';
type TrendDirection = 'up' | 'down' | 'flat';

export interface CountryDeepDiveSignalItem {
  type: 'MILITARY' | 'PROTEST' | 'CYBER' | 'DISASTER' | 'OUTAGE' | 'OTHER';
  severity: ThreatLevel;
  description: string;
  timestamp: Date;
}

export interface CountryDeepDiveSignalDetails {
  critical: number;
  high: number;
  medium: number;
  low: number;
  recentHigh: CountryDeepDiveSignalItem[];
}

export interface CountryDeepDiveBaseSummary {
  id: string;
  name: string;
  distanceKm: number;
  country?: string;
}

export interface CountryDeepDiveMilitarySummary {
  ownFlights: number;
  foreignFlights: number;
  nearbyVessels: number;
  nearestBases: CountryDeepDiveBaseSummary[];
  foreignPresence: boolean;
}

export interface CountryDeepDiveEconomicIndicator {
  label: string;
  value: string;
  trend: TrendDirection;
  source?: string;
}

export interface CountryFactsData {
  headOfState: string;
  headOfStateTitle: string;
  wikipediaSummary: string;
  wikipediaThumbnailUrl: string;
  population: number;
  capital: string;
  languages: string[];
  currencies: string[];
  areaSqKm: number;
  countryName: string;
}

export interface CountryEnergyProfileData {
  mixAvailable: boolean;
  mixYear: number;
  coalShare: number;
  gasShare: number;
  oilShare: number;
  nuclearShare: number;
  renewShare: number;
  windShare: number;
  solarShare: number;
  hydroShare: number;
  importShare: number;
  gasStorageAvailable: boolean;
  gasStorageFillPct: number;
  gasStorageChange1d: number;
  gasStorageTrend: string;
  gasStorageDate: string;
  electricityAvailable: boolean;
  electricityPriceMwh: number;
  electricitySource: string;
  electricityDate: string;
  jodiOilAvailable: boolean;
  jodiOilDataMonth: string;
  gasolineDemandKbd: number;
  gasolineImportsKbd: number;
  dieselDemandKbd: number;
  dieselImportsKbd: number;
  jetDemandKbd: number;
  jetImportsKbd: number;
  lpgDemandKbd: number;
  lpgImportsKbd: number;
  crudeImportsKbd: number;
  jodiGasAvailable: boolean;
  jodiGasDataMonth: string;
  gasTotalDemandTj: number;
  gasLngImportsTj: number;
  gasPipeImportsTj: number;
  gasLngShare: number;
  ieaStocksAvailable: boolean;
  ieaStocksDataMonth: string;
  ieaDaysOfCover: number;
  ieaNetExporter: boolean;
  ieaBelowObligation: boolean;
  emberFossilShare: number;
  emberRenewShare: number;
  emberNuclearShare: number;
  emberCoalShare: number;
  emberGasShare: number;
  emberDemandTwh: number;
  emberDataMonth: string;
  emberAvailable: boolean;
  sprRegime: string;
  sprCapacityMb: number;
  sprOperator: string;
  sprIeaMember: boolean;
  sprStockholdingModel: string;
  sprNote: string;
  sprSource: string;
  sprAsOf: string;
  sprAvailable: boolean;
}

export interface CountryPortActivityData {
  available: boolean;
  ports: {
    portId: string;
    portName: string;
    lat: number;
    lon: number;
    tankerCalls30d: number;
    trendDeltaPct: number;
    importTankerDwt: number;
    exportTankerDwt: number;
    anomalySignal: boolean;
  }[];
  fetchedAt: string;
}

export interface CountryBriefPanel {
  show(country: string, code: string, score: CountryScore | null, signals: CountryBriefSignals): void;
  hide(): void;
  showLoading(): void;
  getCode(): string | null;
  getName(): string | null;
  isVisible(): boolean;
  getTimelineMount(): HTMLElement | null;
  readonly signal: AbortSignal;
  onClose(cb: () => void): void;
  setShareStoryHandler(handler: (code: string, name: string) => void): void;
  setExportImageHandler(handler: (code: string, name: string) => void): void;
  updateBrief(data: CountryIntelData): void;
  updateNews(headlines: NewsItem[]): void;
  updateMarkets(markets: PredictionMarket[]): void;
  updateStock(data: StockIndexData): void;
  updateInfrastructure(code: string): void;
  showGeoError?(onRetry: () => void): void;
  updateScore?(score: CountryScore | null, signals: CountryBriefSignals): void;
  updateSignalDetails?(details: CountryDeepDiveSignalDetails): void;
  updateMilitaryActivity?(summary: CountryDeepDiveMilitarySummary): void;
  updateEconomicIndicators?(indicators: CountryDeepDiveEconomicIndicator[]): void;
  updateCountryFacts?(data: CountryFactsData): void;
  updateEnergyProfile?(data: CountryEnergyProfileData): void;
  updateMaritimeActivity?(data: CountryPortActivityData): void;
  updateTradeExposure?(data: GetCountryChokepointIndexResponse | null, sectors?: SectorExposureSummary[]): void;
  maximize?(): void;
  minimize?(): void;
  getIsMaximized?(): boolean;
  onStateChange?(cb: (state: { visible: boolean; maximized: boolean }) => void): void;
  updateNationalDebt?(entry: { debtToGdp: number; debtUsd: number; annualGrowth: number; source: string } | null): void;
  updateSanctionsPressure?(data: { entryCount: number; sanctionsActive?: boolean } | null): void;
  updateComtradeFlows?(flows: Array<{ partnerName: string; cmdDesc: string; tradeValueUsd: number; yoyChange: number }> | null): void;
  updateTariffTrends?(data: { currentRate: number; trend: string; datapoints: Array<{ year: number; tariffRate: number }> } | null): void;
  updateChokepointExposure?(data: { vulnerabilityIndex: number; exposures: Array<{ chokepointName: string; exposureScore: number }> } | null): void;
  updateCostShock?(data: { supplyDeficitPct: number; coverageDays: number; warRiskTier: string } | null): void;
  updateProductImports?(data: CountryProductsResponse | null): void;
}
