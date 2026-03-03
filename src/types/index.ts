/**
 * SalesIntel Type Definitions
 */

// ============================================
// Feed & News Types (retained from World Monitor)
// ============================================

export type PropagandaRisk = 'low' | 'medium' | 'high';

export interface Feed {
  name: string;
  url: string | Record<string, string>;
  type?: string;
  region?: string;
  propagandaRisk?: PropagandaRisk;
  stateAffiliated?: string;
  lang?: string;
}

// Intent classification (was threat classification)
export type { IntentClassification as ThreatClassification, IntentLevel as ThreatLevel, SignalCategory as EventCategory } from '@/services/threat-classifier';

export interface NewsItem {
  source: string;
  title: string;
  link: string;
  pubDate: Date;
  isAlert: boolean;
  monitorColor?: string;
  tier?: number;
  threat?: import('@/services/threat-classifier').IntentClassification;
  lat?: number;
  lon?: number;
  locationName?: string;
  lang?: string;
  imageUrl?: string;
  // SalesIntel additions
  company?: string;
  signalType?: string;
}

export type VelocityLevel = 'normal' | 'elevated' | 'spike';
export type SentimentType = 'negative' | 'neutral' | 'positive';
export type DeviationLevel = 'normal' | 'elevated' | 'spike' | 'quiet';

export interface VelocityMetrics {
  sourcesPerHour: number;
  level: VelocityLevel;
  trend: 'rising' | 'stable' | 'falling';
  sentiment: SentimentType;
  sentimentScore: number;
}

export interface ClusteredEvent {
  id: string;
  primaryTitle: string;
  primarySource: string;
  primaryLink: string;
  sourceCount: number;
  topSources: Array<{ name: string; tier: number; url: string }>;
  allItems: NewsItem[];
  firstSeen: Date;
  lastUpdated: Date;
  isAlert: boolean;
  monitorColor?: string;
  velocity?: VelocityMetrics;
  threat?: import('@/services/threat-classifier').IntentClassification;
  lat?: number;
  lon?: number;
  lang?: string;
  // SalesIntel additions
  company?: string;
  signalType?: string;
}

// ============================================
// Market Types (retained)
// ============================================

export interface Sector {
  symbol: string;
  name: string;
}

export interface Commodity {
  symbol: string;
  name: string;
  display: string;
}

export interface MarketSymbol {
  symbol: string;
  name: string;
  display: string;
}

export interface MarketData {
  symbol: string;
  name: string;
  display: string;
  price: number | null;
  change: number | null;
  sparkline?: number[];
}

export interface CryptoData {
  name: string;
  symbol: string;
  price: number;
  change: number;
  sparkline?: number[];
}

// ============================================
// Panel & Config Types (retained)
// ============================================

export interface PanelConfig {
  name: string;
  enabled: boolean;
  priority: number;
}

export interface Monitor {
  id: string;
  name: string;
  keywords: string[];
  color: string;
}

// Map layers type — minimal for SalesIntel (no geospatial map)
export type MapLayers = Record<string, boolean>;

// ============================================
// Entity Types (retained for NER)
// ============================================

export interface EntityMention {
  entityId: string;
  name: string;
  type: string;
  count: number;
  contexts: string[];
}

export interface FocalPoint {
  entityId: string;
  name: string;
  type: string;
  newsCount: number;
  signalCount: number;
  totalReach: number;
  signalTypes: string[];
  topHeadlines: Array<{ title: string; source: string; url: string }>;
  narrative: string;
}

export interface FocalPointSummary {
  focalPoints: FocalPoint[];
  topNarrative: string;
  generatedAt: Date;
}

// ============================================
// SalesIntel-Specific Types
// ============================================

export interface TargetCompany {
  name: string;
  domain?: string;
  industry: string;
  tier: 1 | 2 | 3;
  lastSignalType: string;
  lastSignalTime: Date;
  signalHealth: number;
  signalCount: number;
}

export interface SignalAlert {
  id: string;
  company: string;
  companyDomain?: string;
  signalType: string;
  title: string;
  summary: string;
  source: string;
  sourceTier: number;
  timestamp: Date;
  tags: string[];
  strength: 'critical' | 'high' | 'medium' | 'low';
  dismissed: boolean;
}

// Legacy compat — these types were used across the codebase
// Provide empty/minimal versions so remaining code compiles

export interface InternetOutage {
  id: string;
  country: string;
  severity: string;
}

export interface MilitaryFlight {
  id: string;
  callsign: string;
}

export interface MilitaryVessel {
  id: string;
  name: string;
}

export interface SocialUnrestEvent {
  id: string;
  country: string;
  type: string;
}

export interface AisDisruptionEvent {
  id: string;
  name: string;
  type: string;
}

export interface CyberThreat {
  id: string;
  type: string;
  indicator: string;
}

export interface DeductContextDetail {
  query?: string;
  geoContext: string;
  autoSubmit?: boolean;
}
