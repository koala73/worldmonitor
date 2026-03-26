/**
 * Ireland Submarine Cables Data
 *
 * Data for submarine cables connecting Ireland to the world.
 * Ireland is a key hub for transatlantic connectivity.
 *
 * Data source: TeleGeography Submarine Cable Map
 * https://www.submarinecablemap.com/country/ireland
 */

/**
 * Cable destination type for color coding on the map:
 * - transatlantic: Orange #F97316 (Ireland ↔ US)
 * - uk: Blue #3B82F6 (Ireland ↔ UK)
 * - europe: Green #10B981 (Ireland ↔ Europe)
 * - planned: Purple #8B5CF6 (Planned / Under Construction)
 */
export type CableDestination = 'transatlantic' | 'uk' | 'europe' | 'planned';

export type CableStatus = 'active' | 'under-construction' | 'planned';

/**
 * Landing point interface for cable landing stations
 */
export interface LandingPoint {
  city: string;
  country: string;
  lat: number;
  lng: number;
}

/**
 * Submarine cable interface
 */
export interface SubmarineCable {
  id: string;
  name: string;
  route: string;
  destination: CableDestination;
  /** Path coordinates for drawing the cable line [lng, lat][] */
  path: [number, number][];
  landingPoints: LandingPoint[];
  length?: string;
  capacity?: string;
  latency?: string;
  operator: string;
  rfs: number | string; // Ready for Service year
  status: CableStatus;
  website?: string;
  description?: string;
}

/**
 * Cable segment interface for GreatCircleLayer (FR #176)
 * Each segment represents one arc between two points
 */
export interface CableSegment {
  cableId: string;
  source: [number, number]; // [lng, lat]
  target: [number, number]; // [lng, lat]
  destination: CableDestination;
  status: CableStatus;
  cable: SubmarineCable; // Reference to original cable for popup
}

/**
 * Landing station interface for cable landing points in Ireland
 */
export interface LandingStation {
  id: string;
  city: string;
  lat: number;
  lng: number;
  cableIds: string[]; // References to connected cables
  description?: string;
}

/**
 * Color mapping for cable destinations (used in DeckGLMap.ts)
 */
export const CABLE_COLORS: Record<CableDestination, [number, number, number]> = {
  transatlantic: [249, 115, 22],  // Orange #F97316
  uk: [59, 130, 246],             // Blue #3B82F6
  europe: [16, 185, 129],         // Green #10B981
  planned: [139, 92, 246],        // Purple #8B5CF6
};

/**
 * Destination labels for Legend and Popup display
 */
export const CABLE_DESTINATION_LABELS: Record<CableDestination, string> = {
  transatlantic: 'Transatlantic (Ireland ↔ US)',
  uk: 'Ireland ↔ UK',
  europe: 'Ireland ↔ Europe',
  planned: 'Planned / Under Construction',
};

/**
 * Submarine cables connecting Ireland (~12 cables)
 */
export const IRELAND_SUBMARINE_CABLES: SubmarineCable[] = [
  // ========================================
  // 🟧 Transatlantic Cables (Orange)
  // ========================================
  {
    id: 'hibernia-express',
    name: 'Hibernia Express',
    route: 'New York → Halifax → Dublin → London',
    destination: 'transatlantic',
    path: [
      [-74.006, 40.7128],   // New York
      [-63.5752, 44.6488],  // Halifax
      [-6.2603, 53.3498],   // Dublin
      [-0.1278, 51.5074],   // London
    ],
    landingPoints: [
      { city: 'New York', country: 'USA', lat: 40.7128, lng: -74.006 },
      { city: 'Halifax', country: 'Canada', lat: 44.6488, lng: -63.5752 },
      { city: 'Dublin', country: 'Ireland', lat: 53.3498, lng: -6.2603 },
      { city: 'London', country: 'UK', lat: 51.5074, lng: -0.1278 },
    ],
    length: '~15,000 km',
    capacity: '10.5 Tbps',
    latency: '58.95ms (NY-London)',
    operator: 'GTT (Hibernia Networks)',
    rfs: 2015,
    status: 'active',
    website: 'https://www.gtt.net/',
    description: 'First sub-60ms transatlantic cable, lowest latency route.',
  },
  {
    id: 'aec-1',
    name: 'AEC-1 (America Europe Connect)',
    route: 'Virginia → Dublin → Cornwall',
    destination: 'transatlantic',
    path: [
      [-76.0589, 36.8508],  // Virginia Beach
      [-6.2603, 53.3498],   // Dublin
      [-5.0527, 50.2660],   // Bude, Cornwall
    ],
    landingPoints: [
      { city: 'Virginia Beach', country: 'USA', lat: 36.8508, lng: -76.0589 },
      { city: 'Dublin', country: 'Ireland', lat: 53.3498, lng: -6.2603 },
      { city: 'Bude', country: 'UK', lat: 50.2660, lng: -5.0527 },
    ],
    length: '~14,000 km',
    capacity: '40+ Tbps',
    operator: 'Aqua Comms',
    rfs: 2016,
    status: 'active',
    website: 'https://www.aquacomms.com/',
    description: 'High-capacity transatlantic cable with Dublin landing.',
  },

  // ========================================
  // 🟦 Ireland ↔ UK Cables (Blue)
  // ========================================
  {
    id: 'celtixconnect-1',
    name: 'CeltixConnect-1 (CC-1)',
    route: 'Dublin ↔ Holyhead',
    destination: 'uk',
    path: [
      [-6.2603, 53.3498],   // Dublin
      [-4.6330, 53.3094],   // Holyhead
    ],
    landingPoints: [
      { city: 'Dublin', country: 'Ireland', lat: 53.3498, lng: -6.2603 },
      { city: 'Holyhead', country: 'UK', lat: 53.3094, lng: -4.6330 },
    ],
    length: '~120 km',
    capacity: '160 Tbps',
    operator: 'CeltixConnect',
    rfs: 2020,
    status: 'active',
    website: 'https://www.celtixconnect.com/',
    description: 'High-capacity Ireland-UK cable via Irish Sea.',
  },
  {
    id: 'emerald-bridge',
    name: 'Emerald Bridge Fibres',
    route: 'Dublin ↔ Wales',
    destination: 'uk',
    path: [
      [-6.2603, 53.3498],   // Dublin
      [-3.9436, 51.6214],   // Swansea
    ],
    landingPoints: [
      { city: 'Dublin', country: 'Ireland', lat: 53.3498, lng: -6.2603 },
      { city: 'Swansea', country: 'UK', lat: 51.6214, lng: -3.9436 },
    ],
    length: '~300 km',
    operator: 'euNetworks',
    rfs: 2017,
    status: 'active',
    website: 'https://eunetworks.com/',
    description: 'Direct Ireland-Wales fiber connection.',
  },
  {
    id: 'esat-2',
    name: 'ESAT-2',
    route: 'Dublin ↔ Southport',
    destination: 'uk',
    path: [
      [-6.2603, 53.3498],   // Dublin
      [-3.0075, 53.6478],   // Southport
    ],
    landingPoints: [
      { city: 'Dublin', country: 'Ireland', lat: 53.3498, lng: -6.2603 },
      { city: 'Southport', country: 'UK', lat: 53.6478, lng: -3.0075 },
    ],
    length: '~200 km',
    operator: 'BT',
    rfs: 1997,
    status: 'active',
    description: 'Legacy Ireland-UK cable, one of the earliest.',
  },
  {
    id: 'exa-north',
    name: 'EXA North',
    route: 'Dublin ↔ Portpatrick',
    destination: 'uk',
    path: [
      [-6.2603, 53.3498],   // Dublin
      [-5.1191, 54.8420],   // Portpatrick
    ],
    landingPoints: [
      { city: 'Dublin', country: 'Ireland', lat: 53.3498, lng: -6.2603 },
      { city: 'Portpatrick', country: 'UK', lat: 54.8420, lng: -5.1191 },
    ],
    length: '~150 km',
    operator: 'GTT',
    rfs: 2013,
    status: 'active',
    description: 'Northern route to Scotland.',
  },
  {
    id: 'exa-south',
    name: 'EXA South',
    route: 'Dublin ↔ Wales',
    destination: 'uk',
    path: [
      [-6.2603, 53.3498],   // Dublin
      [-4.2578, 53.2274],   // Anglesey
    ],
    landingPoints: [
      { city: 'Dublin', country: 'Ireland', lat: 53.3498, lng: -6.2603 },
      { city: 'Anglesey', country: 'UK', lat: 53.2274, lng: -4.2578 },
    ],
    length: '~120 km',
    operator: 'GTT',
    rfs: 2013,
    status: 'active',
    description: 'Southern route to Wales.',
  },

  // ========================================
  // 🟩 Ireland ↔ Europe Cables (Green)
  // ========================================
  {
    id: 'havhingsten',
    name: 'Havhingsten',
    route: 'Denmark ↔ Dublin ↔ UK',
    destination: 'europe',
    path: [
      [9.9937, 57.0488],    // Hirtshals, Denmark
      [-6.2603, 53.3498],   // Dublin
      [-2.9916, 53.4084],   // Liverpool
    ],
    landingPoints: [
      { city: 'Hirtshals', country: 'Denmark', lat: 57.0488, lng: 9.9937 },
      { city: 'Dublin', country: 'Ireland', lat: 53.3498, lng: -6.2603 },
      { city: 'Liverpool', country: 'UK', lat: 53.4084, lng: -2.9916 },
    ],
    length: '~1,450 km',
    capacity: '48 Tbps',
    operator: 'Aqua Comms',
    rfs: 2018,
    status: 'active',
    website: 'https://www.aquacomms.com/',
    description: 'First direct cable connecting Ireland to Scandinavia.',
  },
  {
    id: 'exa-express',
    name: 'EXA Express',
    route: 'Ireland ↔ Faroe Islands',
    destination: 'europe',
    path: [
      [-9.0568, 53.2707],   // Galway
      [-6.7709, 62.0079],   // Tórshavn, Faroe
    ],
    landingPoints: [
      { city: 'Galway', country: 'Ireland', lat: 53.2707, lng: -9.0568 },
      { city: 'Tórshavn', country: 'Faroe Islands', lat: 62.0079, lng: -6.7709 },
    ],
    length: '~1,500 km',
    operator: 'Farice',
    rfs: 2024,
    status: 'active',
    description: 'Connects Ireland to North Atlantic islands.',
  },

  // ========================================
  // 🟣 Planned / Under Construction (Purple)
  // ========================================
  {
    id: 'iris',
    name: 'IRIS',
    route: 'Galway ↔ Reykjavik',
    destination: 'planned',
    path: [
      [-9.0568, 53.2707],   // Galway
      [-21.9426, 64.1466],  // Reykjavik
    ],
    landingPoints: [
      { city: 'Galway', country: 'Ireland', lat: 53.2707, lng: -9.0568 },
      { city: 'Reykjavik', country: 'Iceland', lat: 64.1466, lng: -21.9426 },
    ],
    length: '~1,200 km',
    operator: 'TBD',
    rfs: 'TBD',
    status: 'planned',
    description: 'Planned Ireland-Iceland cable for data center connectivity.',
  },
  {
    id: 'fastnet',
    name: 'Fastnet',
    route: 'Cork ↔ UK',
    destination: 'planned',
    path: [
      [-8.4756, 51.8985],   // Cork
      [-5.0527, 50.2660],   // Bude, Cornwall
    ],
    landingPoints: [
      { city: 'Cork', country: 'Ireland', lat: 51.8985, lng: -8.4756 },
      { city: 'Bude', country: 'UK', lat: 50.2660, lng: -5.0527 },
    ],
    length: '~300 km',
    operator: 'TBD',
    rfs: 2028,
    status: 'under-construction',
    description: 'New southern route from Cork to UK.',
  },
  {
    id: 'beaufort',
    name: 'Beaufort',
    route: 'Ireland ↔ UK',
    destination: 'planned',
    path: [
      [-6.2603, 53.3498],   // Dublin
      [-3.0075, 53.6478],   // Northwest UK
    ],
    landingPoints: [
      { city: 'Dublin', country: 'Ireland', lat: 53.3498, lng: -6.2603 },
      { city: 'Northwest UK', country: 'UK', lat: 53.6478, lng: -3.0075 },
    ],
    length: '~300 km',
    operator: 'TBD',
    rfs: 2027,
    status: 'under-construction',
    description: 'Additional capacity for Ireland-UK connectivity.',
  },
];

/**
 * Cable landing stations in Ireland
 */
export const IRELAND_LANDING_STATIONS: LandingStation[] = [
  {
    id: 'dublin-landing',
    city: 'Dublin',
    lat: 53.3498,
    lng: -6.2603,
    cableIds: [
      'hibernia-express',
      'aec-1',
      'celtixconnect-1',
      'emerald-bridge',
      'esat-2',
      'exa-north',
      'exa-south',
      'havhingsten',
      'beaufort',
    ],
    description: "Ireland's primary international connectivity hub with 9 submarine cables.",
  },
  {
    id: 'galway-landing',
    city: 'Galway',
    lat: 53.2707,
    lng: -9.0568,
    cableIds: ['exa-express', 'iris'],
    description: 'Western gateway to North Atlantic, connecting to Faroe Islands and Iceland.',
  },
  {
    id: 'cork-landing',
    city: 'Cork',
    lat: 51.8985,
    lng: -8.4756,
    cableIds: ['fastnet'],
    description: 'Southern landing station with planned UK connectivity.',
  },
];
