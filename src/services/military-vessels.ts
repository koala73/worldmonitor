import type { MilitaryVessel, MilitaryVesselCluster, MilitaryVesselType, MilitaryOperator } from '@/types';
import { createCircuitBreaker } from '@/utils';
import {
  KNOWN_NAVAL_VESSELS,
  MILITARY_VESSEL_PATTERNS,
  getNearbyHotspot,
  MILITARY_HOTSPOTS,
} from '@/config/military';
import {
  registerAisCallback,
  unregisterAisCallback,
  isAisConfigured,
  initAisStream,
  type AisPositionData,
} from './maritime';
import { fetchUSNIFleetReport, mergeUSNIWithAIS } from './usni-fleet';

// Cache for API responses
let vesselCache: { data: MilitaryVessel[]; timestamp: number } | null = null;

// In-memory vessel tracking
const trackedVessels = new Map<string, MilitaryVessel>();
const vesselHistory = new Map<string, { positions: [number, number][]; lastUpdate: number }>();
const HISTORY_MAX_POINTS = 30;
const HISTORY_CLEANUP_INTERVAL = 10 * 60 * 1000; // 10 minutes
const VESSEL_STALE_TIME = 60 * 60 * 1000; // 1 hour - consider vessel stale

// Tracking state
let isTracking = false;
let messageCount = 0;

// Circuit breaker
const breaker = createCircuitBreaker<{ vessels: MilitaryVessel[]; clusters: MilitaryVesselCluster[] }>({
  name: 'Military Vessel Tracking',
  maxFailures: 3,
  cooldownMs: 5 * 60 * 1000,
  cacheTtlMs: 5 * 60 * 1000,
});

// Strategic chokepoints for naval monitoring
const NAVAL_CHOKEPOINTS = [
  { name: 'Strait of Hormuz', lat: 26.5, lon: 56.5, radius: 2 },
  { name: 'Suez Canal', lat: 30.0, lon: 32.5, radius: 1 },
  { name: 'Strait of Malacca', lat: 2.5, lon: 101.5, radius: 2 },
  { name: 'Bab el-Mandeb', lat: 12.5, lon: 43.5, radius: 1.5 },
  { name: 'Panama Canal', lat: 9.0, lon: -79.5, radius: 1 },
  { name: 'Taiwan Strait', lat: 24.5, lon: 119.5, radius: 2 },
  { name: 'South China Sea', lat: 15.0, lon: 115.0, radius: 5 },
  { name: 'Black Sea', lat: 43.5, lon: 34.0, radius: 3 },
  { name: 'Baltic Sea', lat: 58.0, lon: 20.0, radius: 4 },
  { name: 'Sea of Japan', lat: 40.0, lon: 135.0, radius: 4 },
  { name: 'Persian Gulf', lat: 26.5, lon: 52.0, radius: 4 },
  { name: 'Eastern Mediterranean', lat: 34.5, lon: 33.0, radius: 3 },
];

// Naval base locations for proximity detection
const NAVAL_BASES = [
  { name: 'Norfolk Naval Station', lat: 36.95, lon: -76.30, country: 'USA' },
  { name: 'San Diego Naval Base', lat: 32.68, lon: -117.15, country: 'USA' },
  { name: 'Pearl Harbor', lat: 21.35, lon: -157.95, country: 'USA' },
  { name: 'Yokosuka Naval Base', lat: 35.29, lon: 139.67, country: 'Japan' },
  { name: 'Qingdao Naval Base', lat: 36.07, lon: 120.38, country: 'China' },
  { name: 'Sevastopol', lat: 44.62, lon: 33.53, country: 'Russia' },
  { name: 'Portsmouth Naval Base', lat: 50.80, lon: -1.10, country: 'UK' },
  { name: 'Toulon Naval Base', lat: 43.12, lon: 5.93, country: 'France' },
  { name: 'Tartus Naval Base', lat: 34.89, lon: 35.87, country: 'Syria' },
  { name: 'Zhanjiang Naval Base', lat: 21.20, lon: 110.40, country: 'China' },
  { name: 'Vladivostok', lat: 43.12, lon: 131.90, country: 'Russia' },
  { name: 'Diego Garcia', lat: -7.32, lon: 72.42, country: 'UK/USA' },
];

/**
 * MMSI number analysis for military/government vessels
 * MMSI format: MIDXXXXXX where MID = Maritime Identification Digits
 * Ship type is indicated by AIS message, but MMSI can hint at special vessels
 */
function analyzeMmsi(mmsi: string): { isPotentialMilitary: boolean; country?: string } {
  if (!mmsi || mmsi.length < 9) return { isPotentialMilitary: false };

  const mid = mmsi.substring(0, 3);

  // MIDs for countries with significant navies
  const militaryMids: Record<string, string> = {
    '201': 'Albania', '202': 'Andorra', '203': 'Austria',
    '211': 'Germany', '212': 'Cyprus', '213': 'Georgia',
    '214': 'Moldova', '215': 'Malta', '216': 'Armenia',
    '218': 'Germany', '219': 'Denmark', '220': 'Denmark',
    '224': 'Spain', '225': 'Spain', '226': 'France',
    '227': 'France', '228': 'France', '229': 'Malta',
    '230': 'Finland', '231': 'Faroe', '232': 'UK',
    '233': 'UK', '234': 'UK', '235': 'UK',
    '236': 'Gibraltar', '237': 'Greece', '238': 'Croatia',
    '239': 'Greece', '240': 'Greece', '241': 'Greece',
    '242': 'Morocco', '243': 'Hungary', '244': 'Netherlands',
    '245': 'Netherlands', '246': 'Netherlands', '247': 'Italy',
    '248': 'Malta', '249': 'Malta', '250': 'Ireland',
    '255': 'Portugal', '256': 'Malta', '257': 'Norway',
    '258': 'Norway', '259': 'Norway', '261': 'Poland',
    '263': 'Portugal', '264': 'Romania', '265': 'Sweden',
    '266': 'Sweden', '267': 'Slovakia', '268': 'San Marino',
    '269': 'Switzerland', '270': 'Czechia', '271': 'Turkey',
    '272': 'Ukraine', '273': 'Russia', '274': 'North Macedonia',
    '275': 'Latvia', '276': 'Estonia', '277': 'Lithuania',
    '278': 'Slovenia', '279': 'Serbia',
    '301': 'Anguilla', '303': 'Alaska',
    '304': 'Antigua', '305': 'Antigua', '306': 'Sint Maarten',
    '307': 'Aruba', '308': 'Bahamas', '309': 'Bahamas',
    '310': 'Bermuda', '311': 'Bahamas', '312': 'Belize',
    '314': 'Barbados', '316': 'Canada',
    '319': 'Cayman', '321': 'Costa Rica', '323': 'Cuba',
    '325': 'Dominica', '327': 'Dominican Rep', '329': 'Guadeloupe',
    '330': 'Grenada', '331': 'Greenland', '332': 'Guatemala',
    '334': 'Honduras', '336': 'Haiti', '338': 'USA',
    '339': 'Jamaica', '341': 'St Kitts', '343': 'St Lucia',
    '345': 'Mexico', '347': 'Martinique', '348': 'Montserrat',
    '350': 'Nicaragua', '351': 'Panama', '352': 'Panama',
    '353': 'Panama', '354': 'Panama', '355': 'Panama',
    '356': 'Panama', '357': 'Panama', '358': 'Puerto Rico',
    '359': 'El Salvador', '361': 'St Pierre', '362': 'Trinidad',
    '364': 'Turks Caicos', '366': 'USA', '367': 'USA',
    '368': 'USA', '369': 'USA', '370': 'Panama',
    '371': 'Panama', '372': 'Panama', '373': 'Panama',
    '374': 'Panama', '375': 'St Vincent', '376': 'St Vincent',
    '377': 'St Vincent', '378': 'BVI', '379': 'USVI',
    '401': 'Afghanistan', '403': 'Saudi Arabia', '405': 'Bangladesh',
    '408': 'Bahrain', '410': 'Bhutan', '412': 'China',
    '413': 'China', '414': 'China', '416': 'Taiwan',
    '417': 'Sri Lanka', '419': 'India', '422': 'Iran',
    '423': 'Azerbaijan', '425': 'Iraq', '428': 'Israel',
    '431': 'Japan', '432': 'Japan', '434': 'Turkmenistan',
    '436': 'Kazakhstan', '437': 'Uzbekistan', '438': 'Jordan',
    '440': 'South Korea', '441': 'South Korea', '443': 'Palestine',
    '445': 'North Korea', '447': 'Kuwait', '450': 'Lebanon',
    '451': 'Kyrgyzstan', '453': 'Macau', '455': 'Maldives',
    '457': 'Mongolia', '459': 'Nepal', '461': 'Oman',
    '463': 'Pakistan', '466': 'Qatar', '468': 'Syria',
    '470': 'UAE', '472': 'Tajikistan', '473': 'Yemen',
    '475': 'Yemen', '477': 'Hong Kong',
    '501': 'France Adelie', '503': 'Australia',
    '506': 'Myanmar', '508': 'Brunei', '510': 'Micronesia',
    '511': 'Palau', '512': 'New Zealand', '514': 'Cambodia',
    '515': 'Cambodia', '516': 'Christmas Is', '518': 'Cook Is',
    '520': 'Fiji', '523': 'Cocos', '525': 'Indonesia',
    '529': 'Kiribati', '531': 'Laos', '533': 'Malaysia',
    '536': 'N Mariana', '538': 'Marshall Is', '540': 'New Caledonia',
    '542': 'Niue', '544': 'Nauru', '546': 'French Polynesia',
    '548': 'Philippines', '553': 'Papua NG', '555': 'Pitcairn',
    '557': 'Solomon Is', '559': 'Am Samoa', '561': 'Samoa',
    '563': 'Singapore', '564': 'Singapore', '565': 'Singapore',
    '566': 'Singapore', '567': 'Thailand', '570': 'Tonga',
    '572': 'Tuvalu', '574': 'Vietnam', '576': 'Vanuatu',
    '577': 'Vanuatu', '578': 'Wallis',
  };

  const country = militaryMids[mid];

  // Check for military vessel patterns
  for (const pattern of MILITARY_VESSEL_PATTERNS) {
    if (pattern.mmsiPrefix && mmsi.startsWith(pattern.mmsiPrefix)) {
      return { isPotentialMilitary: true, country: pattern.country };
    }
  }

  // Check last digits - some patterns indicate warships
  // Government vessels often have specific MMSI patterns
  const suffix = mmsi.substring(3);
  if (suffix.startsWith('00') || suffix.startsWith('99')) {
    return { isPotentialMilitary: true, country };
  }

  return { isPotentialMilitary: false, country };
}

/**
 * Match vessel name against known military vessels
 */
function matchKnownVessel(name: string): typeof KNOWN_NAVAL_VESSELS[number] | undefined {
  if (!name) return undefined;

  const normalized = name.toUpperCase().trim();

  for (const vessel of KNOWN_NAVAL_VESSELS) {
    if (normalized.includes(vessel.name.toUpperCase()) ||
        (vessel.hullNumber && normalized.includes(vessel.hullNumber))) {
      return vessel;
    }
  }

  // Check for common naval prefixes
  const navalPrefixes = ['USS', 'HMS', 'HMCS', 'HMAS', 'INS', 'JS', 'ROKS', 'TCG'];
  for (const prefix of navalPrefixes) {
    if (normalized.startsWith(prefix + ' ')) {
      // Known pattern but not in our database
      return undefined;
    }
  }

  return undefined;
}

/**
 * Map AIS ship type code to human-readable name
 */
function getAisShipTypeName(shipType: number | undefined): string | undefined {
  if (shipType === undefined || shipType === null) return undefined;

  const aisTypeMap: Record<number, string> = {
    0: 'Not Available',
    20: 'Wing in Ground',
    21: 'Wing in Ground (Hazardous A)',
    22: 'Wing in Ground (Hazardous B)',
    23: 'Wing in Ground (Hazardous C)',
    24: 'Wing in Ground (Hazardous D)',
    30: 'Fishing',
    31: 'Towing',
    32: 'Towing (Large)',
    33: 'Dredging/Underwater Ops',
    34: 'Diving Ops',
    35: 'Military Ops',
    36: 'Sailing',
    37: 'Pleasure Craft',
    40: 'High Speed Craft',
    41: 'High Speed Craft (Hazardous A)',
    42: 'High Speed Craft (Hazardous B)',
    43: 'High Speed Craft (Hazardous C)',
    44: 'High Speed Craft (Hazardous D)',
    50: 'Pilot Vessel',
    51: 'Search & Rescue',
    52: 'Tug',
    53: 'Port Tender',
    54: 'Anti-Pollution',
    55: 'Law Enforcement',
    56: 'Local Vessel',
    57: 'Local Vessel',
    58: 'Medical Transport',
    59: 'Special Craft',
    60: 'Passenger',
    61: 'Passenger (Hazardous A)',
    62: 'Passenger (Hazardous B)',
    63: 'Passenger (Hazardous C)',
    64: 'Passenger (Hazardous D)',
    69: 'Passenger',
    70: 'Cargo',
    71: 'Cargo (Hazardous A)',
    72: 'Cargo (Hazardous B)',
    73: 'Cargo (Hazardous C)',
    74: 'Cargo (Hazardous D)',
    79: 'Cargo',
    80: 'Tanker',
    81: 'Tanker (Hazardous A)',
    82: 'Tanker (Hazardous B)',
    83: 'Tanker (Hazardous C)',
    84: 'Tanker (Hazardous D)',
    89: 'Tanker',
    90: 'Other',
    91: 'Other (Hazardous A)',
    92: 'Other (Hazardous B)',
    93: 'Other (Hazardous C)',
    94: 'Other (Hazardous D)',
    99: 'Other',
  };

  // Direct match
  if (aisTypeMap[shipType]) return aisTypeMap[shipType];

  // Range-based fallbacks
  if (shipType >= 20 && shipType <= 29) return 'Wing in Ground';
  if (shipType >= 40 && shipType <= 49) return 'High Speed Craft';
  if (shipType >= 60 && shipType <= 69) return 'Passenger';
  if (shipType >= 70 && shipType <= 79) return 'Cargo';
  if (shipType >= 80 && shipType <= 89) return 'Tanker';
  if (shipType >= 90 && shipType <= 99) return 'Other';

  return undefined;
}

/**
 * Determine vessel type from AIS ship type code
 */
function getVesselTypeFromAis(shipType: number): MilitaryVesselType | undefined {
  // AIS ship type codes
  // 35 = Military ops
  // 50-59 = Special craft
  // 55 = Law enforcement

  if (shipType === 35) return 'destroyer'; // Generic military
  if (shipType === 55) return 'patrol'; // Law enforcement/coast guard
  if (shipType >= 50 && shipType <= 59) return 'special';

  return undefined;
}

/**
 * Check if vessel is near a naval base
 */
function getNearbyBase(lat: number, lon: number): string | undefined {
  for (const base of NAVAL_BASES) {
    const distance = Math.sqrt(Math.pow(lat - base.lat, 2) + Math.pow(lon - base.lon, 2));
    if (distance <= 0.5) { // Within ~50km
      return base.name;
    }
  }
  return undefined;
}

/**
 * Check if vessel is near a chokepoint
 */
function getNearbyChokepoint(lat: number, lon: number): string | undefined {
  for (const chokepoint of NAVAL_CHOKEPOINTS) {
    const distance = Math.sqrt(Math.pow(lat - chokepoint.lat, 2) + Math.pow(lon - chokepoint.lon, 2));
    if (distance <= chokepoint.radius) {
      return chokepoint.name;
    }
  }
  return undefined;
}

/**
 * Process incoming AIS position report for military vessel detection
 * Called via callback from shared AIS stream
 */
function processAisPosition(data: AisPositionData): void {
  const mmsi = data.mmsi;
  const name = data.name || '';
  const lat = data.lat;
  const lon = data.lon;
  const now = Date.now();

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

  // Check if this is a military/government vessel
  const mmsiAnalysis = analyzeMmsi(mmsi);
  const knownVessel = matchKnownVessel(name);
  const aisType = data.shipType ? getVesselTypeFromAis(data.shipType) : undefined;

  // Determine if we should track this vessel
  const isMilitary = knownVessel || mmsiAnalysis.isPotentialMilitary || aisType;

  if (!isMilitary) return;

  messageCount++;

  // Check proximity to strategic locations
  const nearChokepoint = getNearbyChokepoint(lat, lon);
  const nearBase = getNearbyBase(lat, lon);
  const nearHotspot = getNearbyHotspot(lat, lon);

  // Update vessel history for trails
  let history = vesselHistory.get(mmsi);
  if (!history) {
    history = { positions: [], lastUpdate: now };
    vesselHistory.set(mmsi, history);
  }
  history.positions.push([lat, lon]);
  if (history.positions.length > HISTORY_MAX_POINTS) {
    history.positions.shift();
  }
  history.lastUpdate = now;

  // Determine operator
  let operator: MilitaryOperator | 'other' = 'other';
  let operatorCountry = mmsiAnalysis.country || 'Unknown';

  if (knownVessel) {
    operator = knownVessel.operator;
    operatorCountry = knownVessel.country;
  }

  // Check for AIS gap (dark ship detection)
  const existingVessel = trackedVessels.get(mmsi);
  let aisGapMinutes: number | undefined;
  let isDark = false;

  if (existingVessel) {
    const timeSinceLastUpdate = now - existingVessel.lastAisUpdate.getTime();
    aisGapMinutes = Math.round(timeSinceLastUpdate / (60 * 1000));
    isDark = aisGapMinutes > 60; // 1 hour gap
  }

  // Create/update vessel record
  const vessel: MilitaryVessel = {
    id: `ais-${mmsi}`,
    mmsi,
    name: name || (knownVessel?.name || `Vessel ${mmsi}`),
    vesselType: knownVessel?.vesselType || aisType || 'unknown',
    aisShipType: getAisShipTypeName(data.shipType),
    hullNumber: knownVessel?.hullNumber,
    operator,
    operatorCountry,
    lat,
    lon,
    heading: data.heading || data.course || 0,
    speed: data.speed || 0,
    course: data.course,
    lastAisUpdate: new Date(now),
    aisGapMinutes,
    isDark,
    nearChokepoint,
    nearBase,
    track: history.positions.length > 1 ? [...history.positions] : undefined,
    confidence: knownVessel ? 'high' : mmsiAnalysis.isPotentialMilitary ? 'medium' : 'low',
    isInteresting: Boolean(nearHotspot?.priority === 'high' || isDark || nearChokepoint),
    note: isDark ? 'Returned after AIS silence' : (nearChokepoint ? `Near ${nearChokepoint}` : undefined),
  };

  const previousSize = trackedVessels.size;
  trackedVessels.set(mmsi, vessel);

  // Clear stale caches when first vessels arrive or when we hit significant milestones
  // This ensures cached empty results don't block fresh data
  if (previousSize === 0 || (trackedVessels.size === 10 && previousSize < 10)) {
    vesselCache = null;
    breaker.clearCache();
    console.log(`[Military Vessels] Cleared caches - first vessels arriving (count: ${trackedVessels.size})`);
  }

  if (messageCount % 50 === 0) {
    console.log(`[Military Vessels] Tracking ${trackedVessels.size} military/gov vessels`);
  }
}


/**
 * Clean up stale vessels and old history
 */
function cleanup(): void {
  const now = Date.now();
  const staleCutoff = now - VESSEL_STALE_TIME;

  // Remove stale vessels
  for (const [mmsi, vessel] of trackedVessels) {
    if (vessel.lastAisUpdate.getTime() < staleCutoff) {
      trackedVessels.delete(mmsi);
      vesselHistory.delete(mmsi);
    }
  }

  // Clean up orphaned history entries
  for (const [mmsi, history] of vesselHistory) {
    if (history.lastUpdate < staleCutoff) {
      vesselHistory.delete(mmsi);
    }
  }
}

/**
 * Cluster nearby vessels
 */
function clusterVessels(vessels: MilitaryVessel[]): MilitaryVesselCluster[] {
  const clusters: MilitaryVesselCluster[] = [];
  const processed = new Set<string>();

  for (const hotspot of MILITARY_HOTSPOTS) {
    const nearbyVessels = vessels.filter((v) => {
      if (processed.has(v.id)) return false;
      const distance = Math.sqrt(Math.pow(v.lat - hotspot.lat, 2) + Math.pow(v.lon - hotspot.lon, 2));
      return distance <= hotspot.radius;
    });

    if (nearbyVessels.length >= 2) {
      nearbyVessels.forEach((v) => processed.add(v.id));

      const avgLat = nearbyVessels.reduce((sum, v) => sum + v.lat, 0) / nearbyVessels.length;
      const avgLon = nearbyVessels.reduce((sum, v) => sum + v.lon, 0) / nearbyVessels.length;

      // Determine activity type
      const hasCarrier = nearbyVessels.some((v) => v.vesselType === 'carrier');
      const hasCombatants = nearbyVessels.some((v) =>
        v.vesselType === 'destroyer' || v.vesselType === 'frigate'
      );

      let activityType: 'exercise' | 'deployment' | 'transit' | 'unknown' = 'unknown';
      if (hasCarrier || nearbyVessels.length >= 5) activityType = 'deployment';
      else if (hasCombatants) activityType = 'exercise';
      else activityType = 'transit';

      clusters.push({
        id: `vessel-cluster-${hotspot.name.toLowerCase().replace(/\s+/g, '-')}`,
        name: `${hotspot.name} Naval Activity`,
        lat: avgLat,
        lon: avgLon,
        vesselCount: nearbyVessels.length,
        vessels: nearbyVessels,
        region: hotspot.name,
        activityType,
      });
    }
  }

  return clusters;
}

// Initialize cleanup interval
if (typeof window !== 'undefined') {
  setInterval(cleanup, HISTORY_CLEANUP_INTERVAL);
}

/**
 * Initialize military vessel tracking
 * Uses shared AIS stream via callback system
 */
export function initMilitaryVesselStream(): void {
  if (isTracking) return;

  console.log('[Military Vessels] Initializing tracking via shared AIS stream...');

  // Invalidate ALL caches when stream starts - fresh data should be read
  vesselCache = null;
  breaker.clearCache();  // Clear circuit breaker's 5-minute cache too!

  // Register callback with shared AIS stream
  registerAisCallback(processAisPosition);
  isTracking = true;

  // Ensure AIS stream is running
  if (isAisConfigured()) {
    initAisStream();
  }
}

/**
 * Disconnect from vessel stream
 */
export function disconnectMilitaryVesselStream(): void {
  if (!isTracking) return;

  unregisterAisCallback(processAisPosition);
  isTracking = false;
}

/**
 * Get current tracking status
 */
export function getMilitaryVesselStatus(): { connected: boolean; vessels: number; messages: number } {
  return {
    connected: isTracking,
    vessels: trackedVessels.size,
    messages: messageCount,
  };
}

// Cache TTL
const CACHE_TTL = 30 * 1000; // 30 seconds

/**
 * Main function to get military vessels
 */
export async function fetchMilitaryVessels(): Promise<{
  vessels: MilitaryVessel[];
  clusters: MilitaryVesselCluster[];
}> {
  // Debug: check state before calling breaker
  console.log(`[Military Vessels] fetchMilitaryVessels called - isTracking: ${isTracking}, isAisConfigured: ${isAisConfigured()}, trackedVessels.size: ${trackedVessels.size}`);

  return breaker.execute(async () => {
    let vessels: MilitaryVessel[] = [];

    // Check cache first, but still run USNI merge so output is consistent.
    if (vesselCache && Date.now() - vesselCache.timestamp < CACHE_TTL) {
      vessels = vesselCache.data;
      console.log(`[Military Vessels] Returning cached base vessels: ${vessels.length}`);
    } else {
      // Initialize stream if not running
      if (!isTracking && isAisConfigured()) {
        console.log('[Military Vessels] Initializing stream from fetchMilitaryVessels...');
        initMilitaryVesselStream();
      }

      // Clean up old data
      cleanup();

      // Convert tracked vessels to array
      vessels = Array.from(trackedVessels.values());
      console.log(`[Military Vessels] After cleanup, returning ${vessels.length} vessels (trackedVessels.size: ${trackedVessels.size})`);

      // Only cache non-empty results - empty results due to timing shouldn't block future calls
      if (vessels.length > 0) {
        vesselCache = { data: vessels, timestamp: Date.now() };
      }
    }

    // Generate AIS-only clusters
    const aisClusters = clusterVessels(vessels);

    // Merge with USNI Fleet Tracker data (non-blocking)
    try {
      const usniReport = await fetchUSNIFleetReport();
      if (usniReport && usniReport.vessels.length > 0) {
        const merged = mergeUSNIWithAIS(vessels, usniReport, aisClusters);
        console.log(`[Military Vessels] USNI merge: ${vessels.length} AIS + ${usniReport.vessels.length} USNI → ${merged.vessels.length} total`);
        return merged;
      }
    } catch (e) {
      console.warn('[Military Vessels] USNI merge failed, using AIS only:', (e as Error).message);
    }

    return { vessels, clusters: aisClusters };
  }, { vessels: [], clusters: [] });
}

/**
 * Get status string for circuit breaker
 */
export function getMilitaryVesselsStatus(): string {
  return breaker.getStatus();
}

/**
 * Get vessel by MMSI
 */
export function getVesselByMmsi(mmsi: string): MilitaryVessel | undefined {
  return trackedVessels.get(mmsi);
}

/**
 * Get vessels near a specific location
 */
export function getVesselsNearLocation(lat: number, lon: number, radiusDeg: number = 2): MilitaryVessel[] {
  const result: MilitaryVessel[] = [];
  for (const vessel of trackedVessels.values()) {
    const distance = Math.sqrt(Math.pow(vessel.lat - lat, 2) + Math.pow(vessel.lon - lon, 2));
    if (distance <= radiusDeg) {
      result.push(vessel);
    }
  }
  return result;
}

/**
 * Get dark (AIS-disabled) vessels
 */
export function getDarkVessels(): MilitaryVessel[] {
  return Array.from(trackedVessels.values()).filter((v) => v.isDark);
}

/**
 * Check if AIS stream is configured
 */
export function isMilitaryVesselTrackingConfigured(): boolean {
  return isAisConfigured();
}
