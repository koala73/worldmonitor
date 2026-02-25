export type PropagandaRisk = 'low' | 'medium' | 'high';

export interface Feed {
  name: string;
  url: string | Record<string, string>;
  type?: string;
  region?: string;
  propagandaRisk?: PropagandaRisk;
  stateAffiliated?: string;  // e.g., "Russia", "China", "Iran"
  lang?: string;             // ISO 2-letter code for filtering
}

export type { ThreatClassification, ThreatLevel, EventCategory } from '@/services/threat-classifier';

export interface NewsItem {
  source: string;
  title: string;
  link: string;
  pubDate: Date;
  isAlert: boolean;
  monitorColor?: string;
  tier?: number;
  threat?: import('@/services/threat-classifier').ThreatClassification;
  lat?: number;
  lon?: number;
  locationName?: string;
  lang?: string;
  // Happy variant: positive content category
  happyCategory?: import('@/services/positive-classifier').HappyContentCategory;
  // Image URL extracted from RSS media/enclosure tags
  imageUrl?: string;
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
  threat?: import('@/services/threat-classifier').ThreatClassification;
  lat?: number;
  lon?: number;
  lang?: string;
}

export type AssetType = 'pipeline' | 'cable' | 'datacenter' | 'base' | 'nuclear';

export interface RelatedAsset {
  id: string;
  name: string;
  type: AssetType;
  distanceKm: number;
}

export interface RelatedAssetContext {
  origin: { label: string; lat: number; lon: number };
  types: AssetType[];
  assets: RelatedAsset[];
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
  sparkline?: number[];
}

export interface CryptoData {
  name: string;
  symbol: string;
  price: number;
  change: number;
  sparkline?: number[];
}

export type EscalationTrend = 'escalating' | 'stable' | 'de-escalating';

export interface DynamicEscalationScore {
  hotspotId: string;
  staticBaseline: number;
  dynamicScore: number;
  combinedScore: number;
  trend: EscalationTrend;
  components: {
    newsActivity: number;
    ciiContribution: number;
    geoConvergence: number;
    militaryActivity: number;
  };
  history: Array<{ timestamp: number; score: number }>;
  lastUpdated: Date;
}

export interface HistoricalContext {
  lastMajorEvent?: string;
  lastMajorEventDate?: string;
  precedentCount?: number;
  precedentDescription?: string;
  cyclicalRisk?: string;
}

export interface Hotspot {
  id: string;
  name: string;
  lat: number;
  lon: number;
  keywords: string[];
  subtext?: string;
  location?: string;  // Human-readable location (e.g., "Sahel Region, West Africa")
  agencies?: string[];
  level?: 'low' | 'elevated' | 'high';
  description?: string;
  status?: string;
  // Escalation indicators (Quick Win #2)
  escalationScore?: 1 | 2 | 3 | 4 | 5;
  escalationTrend?: EscalationTrend;
  escalationIndicators?: string[];
  // Historical context (Quick Win #4)
  history?: HistoricalContext;
  whyItMatters?: string;
}

export interface StrategicWaterway {
  id: string;
  name: string;
  lat: number;
  lon: number;
  description?: string;
}

export type AisDisruptionType = 'gap_spike' | 'chokepoint_congestion';

export interface AisDisruptionEvent {
  id: string;
  name: string;
  type: AisDisruptionType;
  lat: number;
  lon: number;
  severity: 'low' | 'elevated' | 'high';
  changePct: number;
  windowHours: number;
  darkShips?: number;
  vesselCount?: number;
  region?: string;
  description: string;
}

export interface AisDensityZone {
  id: string;
  name: string;
  lat: number;
  lon: number;
  intensity: number;
  deltaPct: number;
  shipsPerDay?: number;
  note?: string;
}

export interface APTGroup {
  id: string;
  name: string;
  aka: string;
  sponsor: string;
  lat: number;
  lon: number;
}

export type CyberThreatType = 'c2_server' | 'malware_host' | 'phishing' | 'malicious_url';
export type CyberThreatSource = 'feodo' | 'urlhaus' | 'c2intel' | 'otx' | 'abuseipdb';
export type CyberThreatSeverity = 'low' | 'medium' | 'high' | 'critical';
export type CyberThreatIndicatorType = 'ip' | 'domain' | 'url';

export interface CyberThreat {
  id: string;
  type: CyberThreatType;
  source: CyberThreatSource;
  indicator: string;
  indicatorType: CyberThreatIndicatorType;
  lat: number;
  lon: number;
  country?: string;
  severity: CyberThreatSeverity;
  malwareFamily?: string;
  tags: string[];
  firstSeen?: string;
  lastSeen?: string;
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

// UCDP Georeferenced Events
export type UcdpEventType = 'state-based' | 'non-state' | 'one-sided';

export interface UcdpGeoEvent {
  id: string;
  date_start: string;
  date_end: string;
  latitude: number;
  longitude: number;
  country: string;
  side_a: string;
  side_b: string;
  deaths_best: number;
  deaths_low: number;
  deaths_high: number;
  type_of_violence: UcdpEventType;
  source_original: string;
}

// WorldPop Population Exposure
export interface CountryPopulation {
  code: string;
  name: string;
  population: number;
  densityPerKm2: number;
}

export interface PopulationExposure {
  eventId: string;
  eventName: string;
  eventType: string;
  lat: number;
  lon: number;
  exposedPopulation: number;
  exposureRadiusKm: number;
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

export interface CableLandingPoint {
  country: string;       // ISO code
  countryName: string;
  city?: string;
  lat: number;
  lon: number;
}

export interface CountryCapacity {
  country: string;       // ISO code
  capacityShare: number; // 0-1, what % of country's int'l capacity
  isRedundant: boolean;  // Has alternative routes
}

export interface UnderseaCable {
  id: string;
  name: string;
  points: [number, number][];
  major?: boolean;
  // Enhanced fields for cascade analysis
  landingPoints?: CableLandingPoint[];
  countriesServed?: CountryCapacity[];
  capacityTbps?: number;
  rfsYear?: number;      // Ready for service year
  owners?: string[];
}

export type CableAdvisorySeverity = 'fault' | 'degraded';

export interface CableAdvisory {
  id: string;
  cableId: string;
  title: string;
  severity: CableAdvisorySeverity;
  description: string;
  reported: Date;
  lat: number;
  lon: number;
  impact: string;
  repairEta?: string;
}

export type RepairShipStatus = 'enroute' | 'on-station';

export interface RepairShip {
  id: string;
  name: string;
  cableId: string;
  status: RepairShipStatus;
  lat: number;
  lon: number;
  eta: string;
  operator?: string;
  note?: string;
}

// Cable health types (computed from NGA maritime warning signals)
export type CableHealthStatus = 'ok' | 'degraded' | 'fault' | 'unknown';

export interface CableHealthEvidence {
  source: string;
  summary: string;
  ts: string;
}

export interface CableHealthRecord {
  status: CableHealthStatus;
  score: number;
  confidence: number;
  lastUpdated: string;
  evidence: CableHealthEvidence[];
}

export interface CableHealthResponse {
  generatedAt: string;
  cables: Record<string, CableHealthRecord>;
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

export interface PipelineTerminal {
  country: string;       // ISO code
  name?: string;         // Terminal/field name
  portId?: string;       // Link to port if applicable
  lat?: number;
  lon?: number;
}

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
  // Enhanced fields for cascade analysis
  origin?: PipelineTerminal;
  destination?: PipelineTerminal;
  transitCountries?: string[];   // ISO codes
  capacityMbpd?: number;         // Million barrels per day (oil)
  capacityBcmY?: number;         // Billion cubic meters/year (gas)
  alternatives?: string[];       // Pipeline IDs that could substitute
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
  ais: boolean;
  nuclear: boolean;
  irradiators: boolean;
  sanctions: boolean;
  weather: boolean;
  economic: boolean;
  waterways: boolean;
  outages: boolean;
  cyberThreats: boolean;
  datacenters: boolean;
  protests: boolean;
  flights: boolean;
  military: boolean;
  natural: boolean;
  spaceports: boolean;
  minerals: boolean;
  fires: boolean;
  // Data source layers
  ucdpEvents: boolean;
  displacement: boolean;
  climate: boolean;
  // Tech variant layers
  startupHubs: boolean;
  cloudRegions: boolean;
  accelerators: boolean;
  techHQs: boolean;
  techEvents: boolean;
  // Finance variant layers
  stockExchanges: boolean;
  financialCenters: boolean;
  centralBanks: boolean;
  commodityHubs: boolean;
  // Gulf FDI layers
  gulfInvestments: boolean;
  // Happy variant layers
  positiveEvents: boolean;
  kindness: boolean;
  happiness: boolean;
  speciesRecovery: boolean;
  renewableInstallations: boolean;
  // Trade route layers
  tradeRoutes: boolean;
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

export interface Spaceport {
  id: string;
  name: string;
  lat: number;
  lon: number;
  country: string;
  operator: string;
  status: 'active' | 'construction' | 'inactive';
  launches: 'High' | 'Medium' | 'Low';
}

export interface CriticalMineralProject {
  id: string;
  name: string;
  lat: number;
  lon: number;
  mineral: string;
  country: string;
  operator: string;
  status: 'producing' | 'development' | 'exploration';
  significance: string;
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

// Social Unrest / Protest Types
export type ProtestSeverity = 'low' | 'medium' | 'high';
export type ProtestSource = 'acled' | 'gdelt' | 'rss';
export type ProtestEventType = 'protest' | 'riot' | 'strike' | 'demonstration' | 'civil_unrest';

export interface SocialUnrestEvent {
  id: string;
  title: string;
  summary?: string;
  eventType: ProtestEventType;
  city?: string;
  country: string;
  region?: string;
  lat: number;
  lon: number;
  time: Date;
  severity: ProtestSeverity;
  fatalities?: number;
  sources: string[];
  sourceType: ProtestSource;
  tags?: string[];
  actors?: string[];
  relatedHotspots?: string[];
  confidence: 'high' | 'medium' | 'low';
  validated: boolean;
  imageUrl?: string;
  sentiment?: 'angry' | 'peaceful' | 'mixed';
}

export interface ProtestCluster {
  id: string;
  country: string;
  region?: string;
  eventCount: number;
  events: SocialUnrestEvent[];
  severity: ProtestSeverity;
  startDate: Date;
  endDate: Date;
  primaryCause?: string;
}

export interface MonitoredAirport {
  iata: string;
  icao: string;
  name: string;
  city: string;
  country: string;
  lat: number;
  lon: number;
  region: 'americas' | 'europe' | 'apac' | 'mena' | 'africa';
}

// Military Flight Tracking Types
export type MilitaryAircraftType =
  | 'fighter'           // F-15, F-16, F-22, F-35, Su-27, etc.
  | 'bomber'            // B-52, B-1, B-2, Tu-95, etc.
  | 'transport'         // C-130, C-17, Il-76, A400M, etc.
  | 'tanker'            // KC-135, KC-10, KC-46, etc.
  | 'awacs'             // E-3, E-7, A-50, etc.
  | 'reconnaissance'    // RC-135, U-2, EP-3, etc.
  | 'helicopter'        // UH-60, CH-47, Mi-8, etc.
  | 'drone'             // RQ-4, MQ-9, etc.
  | 'patrol'            // P-8, P-3, etc.
  | 'special_ops'       // MC-130, CV-22, etc.
  | 'vip'               // Government/executive transport
  | 'unknown';

export type MilitaryOperator =
  | 'usaf'              // US Air Force
  | 'usn'               // US Navy
  | 'usmc'              // US Marine Corps
  | 'usa'               // US Army
  | 'raf'               // Royal Air Force (UK)
  | 'rn'                // Royal Navy (UK)
  | 'faf'               // French Air Force
  | 'gaf'               // German Air Force
  | 'plaaf'             // PLA Air Force (China)
  | 'plan'              // PLA Navy (China)
  | 'vks'               // Russian Aerospace Forces
  | 'iaf'               // Israeli Air Force
  | 'nato'              // NATO joint operations
  | 'other';

export interface MilitaryFlight {
  id: string;
  callsign: string;
  hexCode: string;             // ICAO 24-bit address
  registration?: string;
  aircraftType: MilitaryAircraftType;
  aircraftModel?: string;      // E.g., "F-35A", "C-17A"
  operator: MilitaryOperator;
  operatorCountry: string;
  lat: number;
  lon: number;
  altitude: number;            // feet
  heading: number;             // degrees
  speed: number;               // knots
  verticalRate?: number;       // feet/min
  onGround: boolean;
  squawk?: string;             // Transponder code
  origin?: string;             // ICAO airport code
  destination?: string;        // ICAO airport code
  lastSeen: Date;
  firstSeen?: Date;
  track?: [number, number][];  // Historical positions for trail
  confidence: 'high' | 'medium' | 'low';
  isInteresting?: boolean;     // Flagged for unusual activity
  note?: string;
  // Wingbits enrichment data
  enriched?: {
    manufacturer?: string;
    owner?: string;
    operatorName?: string;
    typeCode?: string;
    builtYear?: string;
    confirmedMilitary?: boolean;
    militaryBranch?: string;
  };
}

export interface MilitaryFlightCluster {
  id: string;
  name: string;
  lat: number;
  lon: number;
  flightCount: number;
  flights: MilitaryFlight[];
  dominantOperator?: MilitaryOperator;
  activityType?: 'exercise' | 'patrol' | 'transport' | 'unknown';
}

// Military/Special Vessel Tracking Types
export type MilitaryVesselType =
  | 'carrier'           // Aircraft carrier
  | 'destroyer'         // Destroyer/Cruiser
  | 'frigate'           // Frigate/Corvette
  | 'submarine'         // Submarine (when surfaced/detected)
  | 'amphibious'        // LHD, LPD, LST
  | 'patrol'            // Coast guard, patrol boats
  | 'auxiliary'         // Supply ships, tankers
  | 'research'          // Intelligence gathering, research vessels
  | 'icebreaker'        // Military icebreakers
  | 'special'           // Special mission vessels
  | 'unknown';

export interface MilitaryVessel {
  id: string;
  mmsi: string;
  name: string;
  vesselType: MilitaryVesselType;
  aisShipType?: string;        // Human-readable AIS ship type (Cargo, Tanker, etc.)
  hullNumber?: string;         // E.g., "DDG-51", "CVN-78"
  operator: MilitaryOperator | 'other';
  operatorCountry: string;
  lat: number;
  lon: number;
  heading: number;
  speed: number;               // knots
  course?: number;
  destination?: string;
  lastAisUpdate: Date;
  aisGapMinutes?: number;      // Time since last AIS signal
  isDark?: boolean;            // AIS disabled/suspicious
  nearChokepoint?: string;     // If near strategic waterway
  nearBase?: string;           // If near known naval base
  track?: [number, number][];  // Historical positions
  confidence: 'high' | 'medium' | 'low';
  isInteresting?: boolean;
  note?: string;
  usniRegion?: string;
  usniDeploymentStatus?: USNIDeploymentStatus;
  usniStrikeGroup?: string;
  usniActivityDescription?: string;
  usniArticleUrl?: string;
  usniArticleDate?: string;
  usniSource?: boolean;
}

export type USNIDeploymentStatus = 'deployed' | 'underway' | 'in-port' | 'unknown';

export interface USNIVesselEntry {
  name: string;
  hullNumber: string;
  vesselType: MilitaryVesselType;
  region: string;
  regionLat: number;
  regionLon: number;
  deploymentStatus: USNIDeploymentStatus;
  homePort?: string;
  strikeGroup?: string;
  activityDescription?: string;
  usniArticleUrl: string;
  usniArticleDate: string;
}

export interface USNIStrikeGroup {
  name: string;
  carrier?: string;
  airWing?: string;
  destroyerSquadron?: string;
  escorts: string[];
}

export interface USNIFleetReport {
  articleUrl: string;
  articleDate: string;
  articleTitle: string;
  battleForceSummary?: {
    totalShips: number;
    deployed: number;
    underway: number;
  };
  vessels: USNIVesselEntry[];
  strikeGroups: USNIStrikeGroup[];
  regions: string[];
  parsingWarnings: string[];
  timestamp: string;
}

export interface MilitaryVesselCluster {
  id: string;
  name: string;
  lat: number;
  lon: number;
  vesselCount: number;
  vessels: MilitaryVessel[];
  region?: string;
  activityType?: 'exercise' | 'deployment' | 'transit' | 'unknown';
}

// Combined military activity summary
export interface MilitaryActivitySummary {
  flights: MilitaryFlight[];
  vessels: MilitaryVessel[];
  flightClusters: MilitaryFlightCluster[];
  vesselClusters: MilitaryVesselCluster[];
  activeOperations: number;
  lastUpdate: Date;
}

// PizzINT - Pentagon Pizza Index Types
export type PizzIntDefconLevel = 1 | 2 | 3 | 4 | 5;
export type PizzIntDataFreshness = 'fresh' | 'stale';

export interface PizzIntLocation {
  place_id: string;
  name: string;
  address: string;
  current_popularity: number;
  percentage_of_usual: number | null;
  is_spike: boolean;
  spike_magnitude: number | null;
  data_source: string;
  recorded_at: string;
  data_freshness: PizzIntDataFreshness;
  is_closed_now: boolean;
  lat?: number;
  lng?: number;
  distance_miles?: number;
}

export interface PizzIntStatus {
  defconLevel: PizzIntDefconLevel;
  defconLabel: string;
  aggregateActivity: number;
  activeSpikes: number;
  locationsMonitored: number;
  locationsOpen: number;
  lastUpdate: Date;
  dataFreshness: PizzIntDataFreshness;
  locations: PizzIntLocation[];
}

// GDELT Country Tension Pairs
export interface GdeltTensionPair {
  id: string;
  countries: [string, string];
  label: string;
  score: number;
  trend: 'rising' | 'stable' | 'falling';
  changePercent: number;
  region: string;
}

// NASA EONET Natural Events
export type NaturalEventCategory =
  | 'severeStorms'
  | 'wildfires'
  | 'volcanoes'
  | 'earthquakes'
  | 'floods'
  | 'landslides'
  | 'drought'
  | 'dustHaze'
  | 'snow'
  | 'tempExtremes'
  | 'seaLakeIce'
  | 'waterColor'
  | 'manmade';

export interface NaturalEvent {
  id: string;
  title: string;
  description?: string;
  category: NaturalEventCategory;
  categoryTitle: string;
  lat: number;
  lon: number;
  date: Date;
  magnitude?: number;
  magnitudeUnit?: string;
  sourceUrl?: string;
  sourceName?: string;
  closed: boolean;
}

// Infrastructure Cascade Types
export type InfrastructureNodeType = 'cable' | 'pipeline' | 'port' | 'chokepoint' | 'country' | 'route';

export interface InfrastructureNode {
  id: string;
  type: InfrastructureNodeType;
  name: string;
  coordinates?: [number, number];
  metadata?: Record<string, unknown>;
}

export type DependencyType =
  | 'serves'              // Infrastructure serves country
  | 'terminates_at'       // Pipeline terminates at port
  | 'transits_through'    // Route transits chokepoint
  | 'lands_at'            // Cable lands at country
  | 'depends_on'          // Port depends on pipeline
  | 'shares_risk'         // Assets share vulnerability
  | 'alternative_to'      // Provides redundancy
  | 'trade_route'         // Port enables trade route
  | 'controls_access'     // Chokepoint controls access
  | 'trade_dependency';   // Country depends on trade route

export interface DependencyEdge {
  from: string;           // Node ID
  to: string;             // Node ID
  type: DependencyType;
  strength: number;       // 0-1 criticality
  redundancy?: number;    // 0-1 how replaceable
  metadata?: {
    capacityShare?: number;
    alternativeRoutes?: number;
    estimatedImpact?: string;
    portType?: string;
    relationship?: string;
  };
}

export type CascadeImpactLevel = 'critical' | 'high' | 'medium' | 'low';

export interface CascadeAffectedNode {
  node: InfrastructureNode;
  impactLevel: CascadeImpactLevel;
  pathLength: number;
  dependencyChain: string[];
  redundancyAvailable: boolean;
  estimatedRecovery?: string;
}

export interface CascadeCountryImpact {
  country: string;
  countryName: string;
  impactLevel: CascadeImpactLevel;
  affectedCapacity: number;
  criticalSectors?: string[];
}

export interface CascadeResult {
  source: InfrastructureNode;
  affectedNodes: CascadeAffectedNode[];
  countriesAffected: CascadeCountryImpact[];
  economicImpact?: {
    dailyTradeLoss?: number;
    affectedThroughput?: number;
  };
  redundancies?: {
    id: string;
    name: string;
    capacityShare: number;
  }[];
}

// Re-export port types
export type { Port, PortType } from '@/config/ports';

// AI Regulation Types
export type RegulationType = 'comprehensive' | 'sectoral' | 'voluntary' | 'proposed';
export type ComplianceStatus = 'active' | 'proposed' | 'draft' | 'superseded';
export type RegulationStance = 'strict' | 'moderate' | 'permissive' | 'undefined';

export interface AIRegulation {
  id: string;
  name: string;
  shortName: string;
  country: string;
  region?: string;
  type: RegulationType;
  status: ComplianceStatus;
  announcedDate: string;
  effectiveDate?: string;
  complianceDeadline?: string;
  scope: string[];
  keyProvisions: string[];
  penalties?: string;
  link?: string;
  description?: string;
}

export interface RegulatoryAction {
  id: string;
  date: string;
  country: string;
  title: string;
  type: 'law-passed' | 'executive-order' | 'guideline' | 'enforcement' | 'consultation';
  regulationId?: string;
  description: string;
  impact: 'high' | 'medium' | 'low';
  source?: string;
}

export interface CountryRegulationProfile {
  country: string;
  countryCode: string;
  stance: RegulationStance;
  activeRegulations: string[];
  proposedRegulations: string[];
  lastUpdated: string;
  summary: string;
}

// Tech Company & AI Lab Types
export interface TechCompany {
  id: string;
  name: string;
  lat: number;
  lon: number;
  country: string;
  city?: string;
  sector?: string;
  officeType?: 'headquarters' | 'regional' | 'engineering' | 'research' | 'campus' | 'major office';
  employees?: number;
  foundedYear?: number;
  keyProducts?: string[];
  valuation?: number;
  stockSymbol?: string;
  description?: string;
}

export interface AIResearchLab {
  id: string;
  name: string;
  lat: number;
  lon: number;
  country: string;
  city?: string;
  type: 'corporate' | 'academic' | 'government' | 'nonprofit' | 'industry' | 'research institute';
  parent?: string;
  focusAreas?: string[];
  description?: string;
  foundedYear?: number;
  notableWork?: string[];
  publications?: number;
  faculty?: number;
}

export interface StartupEcosystem {
  id: string;
  name: string;
  lat: number;
  lon: number;
  country: string;
  city: string;
  ecosystemTier?: 'tier1' | 'tier2' | 'tier3' | 'emerging';
  totalFunding2024?: number;
  activeStartups?: number;
  unicorns?: number;
  topSectors?: string[];
  majorVCs?: string[];
  notableStartups?: string[];
  avgSeedRound?: number;
  avgSeriesA?: number;
  description?: string;
}

// ============================================================================
// FOCAL POINT DETECTION (Intelligence Synthesis)
// ============================================================================

export type FocalPointUrgency = 'watch' | 'elevated' | 'critical';

export interface HeadlineWithUrl {
  title: string;
  url: string;
}

export interface EntityMention {
  entityId: string;
  entityType: 'country' | 'company' | 'index' | 'commodity' | 'crypto' | 'sector';
  displayName: string;
  mentionCount: number;
  avgConfidence: number;
  clusterIds: string[];
  topHeadlines: HeadlineWithUrl[];
}

export interface FocalPoint {
  id: string;
  entityId: string;
  entityType: 'country' | 'company' | 'index' | 'commodity' | 'crypto' | 'sector';
  displayName: string;

  // News dimension
  newsMentions: number;
  newsVelocity: number;
  topHeadlines: HeadlineWithUrl[];

  // Signal dimension
  signalTypes: string[];
  signalCount: number;
  highSeverityCount: number;
  signalDescriptions: string[];

  // Scoring
  focalScore: number;
  urgency: FocalPointUrgency;

  // For AI context
  narrative: string;
  correlationEvidence: string[];
}

export interface FocalPointSummary {
  timestamp: Date;
  focalPoints: FocalPoint[];
  aiContext: string;
  topCountries: FocalPoint[];
  topCompanies: FocalPoint[];
}

// ============================================
// GULF FDI TYPES
// ============================================

export type GulfInvestorCountry = 'SA' | 'UAE';

export type GulfInvestmentSector =
  | 'ports'
  | 'pipelines'
  | 'energy'
  | 'datacenters'
  | 'airports'
  | 'railways'
  | 'telecoms'
  | 'water'
  | 'logistics'
  | 'mining'
  | 'real-estate'
  | 'manufacturing';

export type GulfInvestmentStatus =
  | 'operational'
  | 'under-construction'
  | 'announced'
  | 'rumoured'
  | 'cancelled'
  | 'divested';

export type GulfInvestingEntity =
  | 'DP World'
  | 'AD Ports'
  | 'Mubadala'
  | 'ADIA'
  | 'ADNOC'
  | 'Masdar'
  | 'PIF'
  | 'Saudi Aramco'
  | 'ACWA Power'
  | 'STC'
  | 'Mawani'
  | 'NEOM'
  | 'Emirates Global Aluminium'
  | 'Other';

export interface GulfInvestment {
  id: string;
  investingEntity: GulfInvestingEntity;
  investingCountry: GulfInvestorCountry;
  targetCountry: string;
  targetCountryIso: string;
  sector: GulfInvestmentSector;
  assetType: string;
  assetName: string;
  lat: number;
  lon: number;
  investmentUSD?: number;
  stakePercent?: number;
  status: GulfInvestmentStatus;
  yearAnnounced?: number;
  yearOperational?: number;
  description: string;
  sourceUrl?: string;
  tags?: string[];
}

export interface MapProtestCluster {
  id: string;
  lat: number;
  lon: number;
  count: number;
  items: SocialUnrestEvent[];
  country: string;
  maxSeverity: 'low' | 'medium' | 'high';
  hasRiot: boolean;
  latestRiotEventTimeMs?: number;
  totalFatalities: number;
  riotCount?: number;
  highSeverityCount?: number;
  verifiedCount?: number;
  sampled?: boolean;
}

export interface MapTechHQCluster {
  id: string;
  lat: number;
  lon: number;
  count: number;
  items: import('@/config/tech-geo').TechHQ[];
  city: string;
  country: string;
  primaryType: 'faang' | 'unicorn' | 'public';
  faangCount?: number;
  unicornCount?: number;
  publicCount?: number;
  sampled?: boolean;
}

export interface MapTechEventCluster {
  id: string;
  lat: number;
  lon: number;
  count: number;
  items: Array<{ id: string; title: string; location: string; lat: number; lng: number; country: string; startDate: string; endDate: string; url: string | null; daysUntil: number }>;
  location: string;
  country: string;
  soonestDaysUntil: number;
  soonCount?: number;
  sampled?: boolean;
}

export interface MapDatacenterCluster {
  id: string;
  lat: number;
  lon: number;
  count: number;
  items: AIDataCenter[];
  region: string;
  country: string;
  totalChips: number;
  totalPowerMW: number;
  majorityExisting: boolean;
  existingCount?: number;
  plannedCount?: number;
  sampled?: boolean;
}
