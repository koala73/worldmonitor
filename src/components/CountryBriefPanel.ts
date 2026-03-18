import type { CountryBriefSignals } from '@/types';
import type { CountryScore } from '@/services/country-instability';
import type { PredictionMarket } from '@/services/prediction';
import type { NewsItem } from '@/types';

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
  maximize?(): void;
  minimize?(): void;
  getIsMaximized?(): boolean;
  onStateChange?(cb: (state: { visible: boolean; maximized: boolean }) => void): void;
}
