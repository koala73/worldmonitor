export interface Feed {
  name: string;
  url: string;
  type?: string;
  region?: string;
}

export interface NewsItem {
  source: string;
  title: string;
  link: string;
  pubDate: Date;
  isAlert: boolean;
  monitorColor?: string;
  tier?: number;
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
}

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
}

export interface CryptoData {
  name: string;
  symbol: string;
  price: number;
  change: number;
}

export interface Hotspot {
  id: string;
  name: string;
  lat: number;
  lon: number;
  keywords: string[];
  subtext?: string;
  agencies?: string[];
  level?: 'low' | 'elevated' | 'high';
  description?: string;
  status?: string;
}

export interface StrategicWaterway {
  id: string;
  name: string;
  lat: number;
  lon: number;
  description?: string;
}

export interface APTGroup {
  id: string;
  name: string;
  aka: string;
  sponsor: string;
  lat: number;
  lon: number;
}

export interface ConflictZone {
  id: string;
  name: string;
  coords: [number, number][];
  center: [number, number];
  intensity?: 'high' | 'medium' | 'low';
  parties?: string[];
  casualties?: string;
  displaced?: string;
  keywords?: string[];
  startDate?: string;
  location?: string;
  description?: string;
  keyDevelopments?: string[];
}

// Military base operator types
export type MilitaryBaseType =
  | 'us-nato'      // United States and NATO allies
  | 'china'        // People's Republic of China
  | 'russia'       // Russian Federation
  | 'uk'           // United Kingdom (non-US NATO)
  | 'france'       // France (non-US NATO)
  | 'india'        // India
  | 'italy'        // Italy
  | 'uae'          // United Arab Emirates
  | 'turkey'       // Turkey
  | 'japan'        // Japan Self-Defense Forces
  | 'other';       // Other nations

export interface MilitaryBase {
  id: string;
  name: string;
  lat: number;
  lon: number;
  type: MilitaryBaseType;
  description?: string;
  country?: string;           // Host country
  arm?: string;               // Armed forces branch (Navy, Air Force, Army, etc.)
  status?: 'active' | 'planned' | 'controversial' | 'closed';
  source?: string;            // Reference URL
}

export interface UnderseaCable {
  id: string;
  name: string;
  points: [number, number][];
  major?: boolean;
}

export interface ShippingChokepoint {
  id: string;
  name: string;
  lat: number;
  lon: number;
  desc: string;
}

export interface CyberRegion {
  id: string;
  group: string;
  aka: string;
  sponsor: string;
}

// Nuclear facility types
export type NuclearFacilityType =
  | 'plant'        // Power reactors
  | 'enrichment'   // Uranium enrichment
  | 'reprocessing' // Plutonium reprocessing
  | 'weapons'      // Weapons design/assembly
  | 'ssbn'         // Submarine base (nuclear deterrent)
  | 'test-site'    // Nuclear test site
  | 'icbm'         // ICBM silo fields
  | 'research';    // Research reactors

export interface NuclearFacility {
  id: string;
  name: string;
  lat: number;
  lon: number;
  type: NuclearFacilityType;
  status: 'active' | 'contested' | 'inactive' | 'decommissioned' | 'construction';
  operator?: string;  // Operating country
}

export interface GammaIrradiator {
  id: string;
  city: string;
  country: string;
  lat: number;
  lon: number;
  organization?: string;
}

export type PipelineType = 'oil' | 'gas' | 'products';
export type PipelineStatus = 'operating' | 'construction';

export interface Pipeline {
  id: string;
  name: string;
  type: PipelineType;
  status: PipelineStatus;
  points: [number, number][];  // [lon, lat] pairs
  capacity?: string;           // e.g., "1.2 million bpd"
  length?: string;             // e.g., "1,768 km"
  operator?: string;
  countries?: string[];
}

export interface Earthquake {
  id: string;
  place: string;
  magnitude: number;
  lat: number;
  lon: number;
  depth: number;
  time: Date;
  url: string;
}

export interface Monitor {
  id: string;
  keywords: string[];
  color: string;
  name?: string;
  lat?: number;
  lon?: number;
}

export interface PanelConfig {
  name: string;
  enabled: boolean;
  priority?: number;
}

export interface MapLayers {
  conflicts: boolean;
  bases: boolean;
  cables: boolean;
  pipelines: boolean;
  hotspots: boolean;
  grid: boolean;
  nuclear: boolean;
  irradiators: boolean;
  sanctions: boolean;
  earthquakes: boolean;
  weather: boolean;
  economic: boolean;
  countries: boolean;
  waterways: boolean;
  outages: boolean;
  datacenters: boolean;
}

export interface AIDataCenter {
  id: string;
  name: string;
  owner: string;
  country: string;
  lat: number;
  lon: number;
  status: 'existing' | 'planned' | 'decommissioned';
  chipType: string;
  chipCount: number;
  powerMW?: number;
  h100Equivalent?: number;
  sector?: string;
  note?: string;
}

export interface InternetOutage {
  id: string;
  title: string;
  link: string;
  description: string;
  pubDate: Date;
  country: string;
  region?: string;
  lat: number;
  lon: number;
  severity: 'partial' | 'major' | 'total';
  categories: string[];
  cause?: string;
  outageType?: string;
  endDate?: Date;
}

export type PowerGridSeverity = 'watch' | 'warning' | 'critical';
export type PowerGridSignal = 'stress' | 'outage';

export interface PowerGridAlert {
  id: string;
  title: string;
  description: string;
  region: string;
  lat: number;
  lon: number;
  severity: PowerGridSeverity;
  signalType: PowerGridSignal;
  reserveMargin?: number;
  frequencyHz?: number;
  customersAffected?: number;
  outageCount?: number;
  impactRadiusKm?: number;
  time: Date;
  source: string;
  sourceUrl?: string;
}

export type EconomicCenterType = 'exchange' | 'central-bank' | 'financial-hub';

export interface EconomicCenter {
  id: string;
  name: string;
  type: EconomicCenterType;
  lat: number;
  lon: number;
  country: string;
  marketHours?: { open: string; close: string; timezone: string };
  description?: string;
}

export interface PredictionMarket {
  title: string;
  yesPrice: number;
  volume?: number;
}

export interface AppState {
  currentView: 'global' | 'us';
  mapZoom: number;
  mapPan: { x: number; y: number };
  mapLayers: MapLayers;
  panels: Record<string, PanelConfig>;
  monitors: Monitor[];
  allNews: NewsItem[];
  isLoading: boolean;
}

export type FeedCategory = 'politics' | 'tech' | 'finance' | 'gov' | 'intel';
