import type { MilitaryAircraftType, MilitaryOperator, MilitaryVesselType } from '@/types';

/**
 * Military callsign prefixes and patterns for aircraft identification
 * These are used to filter ADS-B data for military aircraft
 */
export interface CallsignPattern {
  pattern: string;           // Regex pattern or prefix
  operator: MilitaryOperator;
  aircraftType?: MilitaryAircraftType;
  description?: string;
}

// US Military callsign patterns
export const US_MILITARY_CALLSIGNS: CallsignPattern[] = [
  // USAF
  { pattern: '^RCH', operator: 'usaf', aircraftType: 'transport', description: 'REACH - AMC transport' },
  { pattern: '^REACH', operator: 'usaf', aircraftType: 'transport', description: 'REACH - AMC transport' },
  { pattern: '^DUKE', operator: 'usaf', aircraftType: 'transport', description: 'DUKE - VIP transport' },
  { pattern: '^SAM', operator: 'usaf', aircraftType: 'vip', description: 'Special Air Mission' },
  { pattern: '^AF[12]', operator: 'usaf', aircraftType: 'vip', description: 'Air Force One/Two' },
  { pattern: '^EXEC', operator: 'usaf', aircraftType: 'vip', description: 'Executive transport' },
  { pattern: '^GOLD', operator: 'usaf', aircraftType: 'special_ops', description: 'Special operations' },
  { pattern: '^KING', operator: 'usaf', aircraftType: 'tanker', description: 'KC-135/KC-46 tanker' },
  { pattern: '^SHELL', operator: 'usaf', aircraftType: 'tanker', description: 'Tanker operations' },
  { pattern: '^TEAL', operator: 'usaf', aircraftType: 'tanker', description: 'Tanker operations' },
  { pattern: '^BOLT', operator: 'usaf', aircraftType: 'fighter', description: 'Fighter ops' },
  { pattern: '^VIPER', operator: 'usaf', aircraftType: 'fighter', description: 'F-16 operations' },
  { pattern: '^RAPTOR', operator: 'usaf', aircraftType: 'fighter', description: 'F-22 operations' },
  { pattern: '^BONE', operator: 'usaf', aircraftType: 'bomber', description: 'B-1B operations' },
  { pattern: '^DEATH', operator: 'usaf', aircraftType: 'bomber', description: 'B-2 operations' },
  { pattern: '^DOOM', operator: 'usaf', aircraftType: 'bomber', description: 'B-52 operations' },
  { pattern: '^SNTRY', operator: 'usaf', aircraftType: 'awacs', description: 'E-3 AWACS' },
  { pattern: '^DRAGN', operator: 'usaf', aircraftType: 'reconnaissance', description: 'U-2 operations' },
  { pattern: '^COBRA', operator: 'usaf', aircraftType: 'reconnaissance', description: 'RC-135 SIGINT' },
  { pattern: '^RIVET', operator: 'usaf', aircraftType: 'reconnaissance', description: 'RC-135 variants' },
  { pattern: '^OLIVE', operator: 'usaf', aircraftType: 'reconnaissance', description: 'RC-135 operations' },
  { pattern: '^JAKE', operator: 'usaf', aircraftType: 'reconnaissance', description: 'E-8 JSTARS' },
  { pattern: '^NCHO', operator: 'usaf', aircraftType: 'special_ops', description: 'MC-130 Specops' },
  { pattern: '^SHADOW', operator: 'usaf', aircraftType: 'special_ops', description: 'Special operations' },
  { pattern: '^EVAC', operator: 'usaf', aircraftType: 'transport', description: 'Aeromedical evacuation' },
  { pattern: '^MOOSE', operator: 'usaf', aircraftType: 'transport', description: 'C-17 operations' },
  { pattern: '^HERKY', operator: 'usaf', aircraftType: 'transport', description: 'C-130 operations' },

  // US Navy
  { pattern: '^NAVY', operator: 'usn', description: 'US Navy aircraft' },
  { pattern: '^CNV', operator: 'usn', aircraftType: 'transport', description: 'Navy transport' },
  { pattern: '^VRC', operator: 'usn', aircraftType: 'transport', description: 'Carrier onboard delivery' },
  { pattern: '^TRIDENT', operator: 'usn', aircraftType: 'patrol', description: 'P-8 maritime patrol' },
  { pattern: '^RED', operator: 'usn', aircraftType: 'patrol', description: 'P-8/P-3 operations' },
  { pattern: '^BRONCO', operator: 'usn', aircraftType: 'fighter', description: 'F/A-18 operations' },

  // US Marine Corps
  { pattern: '^MARINE', operator: 'usmc', description: 'USMC aircraft' },
  { pattern: '^HMX', operator: 'usmc', aircraftType: 'vip', description: 'Marine One squadron' },
  { pattern: '^NIGHT', operator: 'usmc', aircraftType: 'vip', description: 'Nighthawk VIP transport' },

  // US Army
  { pattern: '^ARMY', operator: 'usa', description: 'US Army aircraft' },
  { pattern: '^PAT', operator: 'usa', aircraftType: 'transport', description: 'Priority air transport' },
  { pattern: '^DUSTOFF', operator: 'usa', aircraftType: 'helicopter', description: 'Medevac helicopters' },

  // US Coast Guard
  { pattern: '^COAST GUARD', operator: 'other', aircraftType: 'patrol', description: 'USCG aircraft' },
  { pattern: '^CG[0-9]', operator: 'other', aircraftType: 'patrol', description: 'USCG aircraft' },

  // Global Hawk / Drones
  { pattern: '^FORTE', operator: 'usaf', aircraftType: 'drone', description: 'RQ-4 Global Hawk' },
  { pattern: '^HAWK', operator: 'usaf', aircraftType: 'drone', description: 'Global Hawk drone' },
  { pattern: '^REAPER', operator: 'usaf', aircraftType: 'drone', description: 'MQ-9 Reaper' },
];

// NATO/Allied callsign patterns
export const NATO_ALLIED_CALLSIGNS: CallsignPattern[] = [
  // Royal Air Force (UK)
  { pattern: '^RRR', operator: 'raf', description: 'RAF aircraft' },
  { pattern: '^ASCOT', operator: 'raf', aircraftType: 'transport', description: 'RAF transport' },
  { pattern: '^RAFAIR', operator: 'raf', aircraftType: 'transport', description: 'RAF transport' },
  { pattern: '^TARTAN', operator: 'raf', aircraftType: 'tanker', description: 'RAF tanker' },
  { pattern: '^NATO', operator: 'nato', aircraftType: 'awacs', description: 'NATO AWACS' },

  // Royal Navy (UK)
  { pattern: '^RN', operator: 'rn', description: 'Royal Navy aircraft' },
  { pattern: '^NAVY', operator: 'rn', description: 'RN aircraft' },

  // French Air Force
  { pattern: '^FAF', operator: 'faf', description: 'French Air Force' },
  { pattern: '^CTM', operator: 'faf', aircraftType: 'transport', description: 'French AF transport' },
  { pattern: '^FRENCH', operator: 'faf', description: 'French military' },

  // German Air Force
  { pattern: '^GAF', operator: 'gaf', description: 'German Air Force' },
  { pattern: '^GERMAN', operator: 'gaf', description: 'German military' },

  // Israeli Air Force
  { pattern: '^IAF', operator: 'iaf', description: 'Israeli Air Force' },
  { pattern: '^ELAL', operator: 'iaf', description: 'IAF transport (covers)' },

  // Turkey
  { pattern: '^THK', operator: 'other', description: 'Turkish Air Force' },
  { pattern: '^TUR', operator: 'other', description: 'Turkish military' },

  // Saudi Arabia
  { pattern: '^SVA', operator: 'other', description: 'Saudi Air Force' },
  { pattern: '^RSAF', operator: 'other', description: 'Royal Saudi Air Force' },

  // UAE
  { pattern: '^UAF', operator: 'other', description: 'UAE Air Force' },

  // India
  { pattern: '^AIR INDIA ONE', operator: 'other', aircraftType: 'vip', description: 'Indian Air Force One' },
  { pattern: '^IAM', operator: 'other', description: 'Indian Air Force' },

  // Japan ASDF
  { pattern: '^JPN', operator: 'other', description: 'Japan Self-Defense Force' },
  { pattern: '^JASDF', operator: 'other', description: 'Japan Air Self-Defense Force' },

  // South Korea
  { pattern: '^ROKAF', operator: 'other', description: 'Republic of Korea Air Force' },
  { pattern: '^KAF', operator: 'other', description: 'Korean Air Force' },

  // Australia
  { pattern: '^RAAF', operator: 'other', description: 'Royal Australian Air Force' },
  { pattern: '^AUSSIE', operator: 'other', description: 'Australian military' },

  // Canada
  { pattern: '^CANFORCE', operator: 'other', aircraftType: 'transport', description: 'Canadian Armed Forces' },
  { pattern: '^CFC', operator: 'other', description: 'Canadian Forces' },

  // Italy
  { pattern: '^IAM', operator: 'other', description: 'Italian Air Force' },
  { pattern: '^ITALY', operator: 'other', description: 'Italian military' },

  // Spain
  { pattern: '^AME', operator: 'other', description: 'Spanish Air Force' },

  // Poland
  { pattern: '^PLF', operator: 'other', description: 'Polish Air Force' },

  // Greece
  { pattern: '^HAF', operator: 'other', description: 'Hellenic Air Force' },

  // Egypt
  { pattern: '^EGY', operator: 'other', description: 'Egyptian Air Force' },

  // Pakistan
  { pattern: '^PAF', operator: 'other', description: 'Pakistan Air Force' },
];

// Russian/Chinese callsign patterns (less common due to transponder usage)
export const ADVERSARY_CALLSIGNS: CallsignPattern[] = [
  // Russian Aerospace Forces
  { pattern: '^RF', operator: 'vks', description: 'Russian Federation aircraft' },
  { pattern: '^RFF', operator: 'vks', description: 'Russian AF' },
  { pattern: '^RUSSIAN', operator: 'vks', description: 'Russian military' },

  // Chinese PLA
  { pattern: '^CCA', operator: 'plaaf', description: 'PLA Air Force' },
  { pattern: '^CHH', operator: 'plan', description: 'PLA Navy Air' },
  { pattern: '^CHINA', operator: 'plaaf', description: 'Chinese military' },
];

// All military callsign patterns combined
export const ALL_MILITARY_CALLSIGNS: CallsignPattern[] = [
  ...US_MILITARY_CALLSIGNS,
  ...NATO_ALLIED_CALLSIGNS,
  ...ADVERSARY_CALLSIGNS,
];

/**
 * Military aircraft type codes (ICAO aircraft type designators)
 * Used to identify military aircraft by their type code
 */
export const MILITARY_AIRCRAFT_TYPES: Record<string, { type: MilitaryAircraftType; name: string }> = {
  // Fighters
  'F15': { type: 'fighter', name: 'F-15 Eagle' },
  'F16': { type: 'fighter', name: 'F-16 Fighting Falcon' },
  'F18': { type: 'fighter', name: 'F/A-18 Hornet' },
  'FA18': { type: 'fighter', name: 'F/A-18 Hornet' },
  'F22': { type: 'fighter', name: 'F-22 Raptor' },
  'F35': { type: 'fighter', name: 'F-35 Lightning II' },
  'F117': { type: 'fighter', name: 'F-117 Nighthawk' },
  'SU27': { type: 'fighter', name: 'Su-27 Flanker' },
  'SU30': { type: 'fighter', name: 'Su-30 Flanker' },
  'SU35': { type: 'fighter', name: 'Su-35 Flanker-E' },
  'MIG29': { type: 'fighter', name: 'MiG-29 Fulcrum' },
  'MIG31': { type: 'fighter', name: 'MiG-31 Foxhound' },
  'EUFI': { type: 'fighter', name: 'Eurofighter Typhoon' },
  'EF2K': { type: 'fighter', name: 'Eurofighter Typhoon' },
  'RFAL': { type: 'fighter', name: 'Dassault Rafale' },
  'J10': { type: 'fighter', name: 'J-10 Vigorous Dragon' },
  'J11': { type: 'fighter', name: 'J-11 Flanker' },
  'J20': { type: 'fighter', name: 'J-20 Mighty Dragon' },

  // Bombers
  'B52': { type: 'bomber', name: 'B-52 Stratofortress' },
  'B1': { type: 'bomber', name: 'B-1B Lancer' },
  'B1B': { type: 'bomber', name: 'B-1B Lancer' },
  'B2': { type: 'bomber', name: 'B-2 Spirit' },
  'TU95': { type: 'bomber', name: 'Tu-95 Bear' },
  'TU160': { type: 'bomber', name: 'Tu-160 Blackjack' },
  'TU22': { type: 'bomber', name: 'Tu-22M Backfire' },
  'H6': { type: 'bomber', name: 'H-6 Badger' },

  // Transports
  'C130': { type: 'transport', name: 'C-130 Hercules' },
  'C17': { type: 'transport', name: 'C-17 Globemaster III' },
  'C5': { type: 'transport', name: 'C-5 Galaxy' },
  'C5M': { type: 'transport', name: 'C-5M Super Galaxy' },
  'C40': { type: 'transport', name: 'C-40 Clipper' },
  'C32': { type: 'transport', name: 'C-32 (757)' },
  'VC25': { type: 'vip', name: 'VC-25 Air Force One' },
  'A400': { type: 'transport', name: 'A400M Atlas' },
  'IL76': { type: 'transport', name: 'Il-76 Candid' },
  'AN124': { type: 'transport', name: 'An-124 Ruslan' },
  'AN225': { type: 'transport', name: 'An-225 Mriya' },
  'Y20': { type: 'transport', name: 'Y-20 Kunpeng' },

  // Tankers
  'KC135': { type: 'tanker', name: 'KC-135 Stratotanker' },
  'K35R': { type: 'tanker', name: 'KC-135R Stratotanker' },
  'KC10': { type: 'tanker', name: 'KC-10 Extender' },
  'KC46': { type: 'tanker', name: 'KC-46 Pegasus' },
  'A330': { type: 'tanker', name: 'A330 MRTT' },
  'A332': { type: 'tanker', name: 'A330 MRTT' },

  // AWACS/AEW
  'E3': { type: 'awacs', name: 'E-3 Sentry AWACS' },
  'E3TF': { type: 'awacs', name: 'E-3 Sentry AWACS' },
  'E7': { type: 'awacs', name: 'E-7 Wedgetail' },
  'E2': { type: 'awacs', name: 'E-2 Hawkeye' },
  'A50': { type: 'awacs', name: 'A-50 Mainstay' },
  'KJ2000': { type: 'awacs', name: 'KJ-2000' },

  // Reconnaissance
  'RC135': { type: 'reconnaissance', name: 'RC-135 Rivet Joint' },
  'R135': { type: 'reconnaissance', name: 'RC-135' },
  'U2': { type: 'reconnaissance', name: 'U-2 Dragon Lady' },
  'U2S': { type: 'reconnaissance', name: 'U-2S Dragon Lady' },
  'EP3': { type: 'reconnaissance', name: 'EP-3 Aries' },
  'E8': { type: 'reconnaissance', name: 'E-8 JSTARS' },
  'WC135': { type: 'reconnaissance', name: 'WC-135 Constant Phoenix' },
  'OC135': { type: 'reconnaissance', name: 'OC-135 Open Skies' },

  // Maritime Patrol
  'P8': { type: 'patrol', name: 'P-8 Poseidon' },
  'P3': { type: 'patrol', name: 'P-3 Orion' },
  'P1': { type: 'patrol', name: 'Kawasaki P-1' },

  // Drones/UAV
  'RQ4': { type: 'drone', name: 'RQ-4 Global Hawk' },
  'GLHK': { type: 'drone', name: 'RQ-4 Global Hawk' },
  'MQ9': { type: 'drone', name: 'MQ-9 Reaper' },
  'MQ1': { type: 'drone', name: 'MQ-1 Predator' },
  'RQ170': { type: 'drone', name: 'RQ-170 Sentinel' },
  'MQ4C': { type: 'drone', name: 'MQ-4C Triton' },

  // Special Operations
  'MC130': { type: 'special_ops', name: 'MC-130 Combat Talon' },
  'AC130': { type: 'special_ops', name: 'AC-130 Gunship' },
  'CV22': { type: 'special_ops', name: 'CV-22 Osprey' },
  'MV22': { type: 'special_ops', name: 'MV-22 Osprey' },

  // Helicopters
  'H60': { type: 'helicopter', name: 'UH-60 Black Hawk' },
  'S70': { type: 'helicopter', name: 'UH-60 Black Hawk' },
  'H47': { type: 'helicopter', name: 'CH-47 Chinook' },
  'CH47': { type: 'helicopter', name: 'CH-47 Chinook' },
  'AH64': { type: 'helicopter', name: 'AH-64 Apache' },
  'H64': { type: 'helicopter', name: 'AH-64 Apache' },
  'H1': { type: 'helicopter', name: 'AH-1 Cobra/Viper' },
  'MI8': { type: 'helicopter', name: 'Mi-8 Hip' },
  'MI24': { type: 'helicopter', name: 'Mi-24 Hind' },
  'MI28': { type: 'helicopter', name: 'Mi-28 Havoc' },
  'KA52': { type: 'helicopter', name: 'Ka-52 Alligator' },
};

/**
 * ICAO 24-bit hex code ranges for military aircraft
 * These help identify military aircraft even without callsigns
 * Reference: https://www.ads-b.nl/icao.php
 */
export const MILITARY_HEX_RANGES: { start: string; end: string; operator: MilitaryOperator; country: string }[] = [
  // United States Military (largest block)
  { start: 'ADF7C7', end: 'ADF7CF', operator: 'usaf', country: 'USA' }, // Known USAF tankers
  { start: 'AE0000', end: 'AFFFFF', operator: 'usaf', country: 'USA' }, // Main USAF block
  { start: 'A00000', end: 'A3FFFF', operator: 'usaf', country: 'USA' }, // Additional US military

  // UK Military
  { start: '43C000', end: '43CFFF', operator: 'raf', country: 'UK' },

  // France Military
  { start: '3A0000', end: '3AFFFF', operator: 'faf', country: 'France' },
  { start: '3B0000', end: '3BFFFF', operator: 'faf', country: 'France' },

  // Germany Military
  { start: '3F0000', end: '3FFFFF', operator: 'gaf', country: 'Germany' },

  // Israel Military (critical for Middle East)
  { start: '738000', end: '73FFFF', operator: 'iaf', country: 'Israel' },

  // NATO AWACS (Luxembourg registration but NATO operated)
  { start: '4D0000', end: '4D03FF', operator: 'nato', country: 'NATO' },

  // Italy Military
  { start: '300000', end: '33FFFF', operator: 'other', country: 'Italy' },

  // Spain Military
  { start: '340000', end: '37FFFF', operator: 'other', country: 'Spain' },

  // Netherlands Military
  { start: '480000', end: '480FFF', operator: 'other', country: 'Netherlands' },

  // Turkey Military (important for Middle East)
  { start: '4BA000', end: '4BCFFF', operator: 'other', country: 'Turkey' },

  // Saudi Arabia Military
  { start: '710000', end: '717FFF', operator: 'other', country: 'Saudi Arabia' },

  // UAE Military
  { start: '896000', end: '896FFF', operator: 'other', country: 'UAE' },

  // Qatar Military
  { start: '06A000', end: '06AFFF', operator: 'other', country: 'Qatar' },

  // Kuwait Military
  { start: '706000', end: '706FFF', operator: 'other', country: 'Kuwait' },

  // Japan Self-Defense Forces
  { start: '840000', end: '87FFFF', operator: 'other', country: 'Japan' },

  // South Korea Military
  { start: '718000', end: '71FFFF', operator: 'other', country: 'South Korea' },

  // Australia Military
  { start: '7CF800', end: '7CFFFF', operator: 'other', country: 'Australia' },

  // Canada Military
  { start: 'C00000', end: 'C0FFFF', operator: 'other', country: 'Canada' },

  // India Military
  { start: '800000', end: '83FFFF', operator: 'other', country: 'India' },

  // Pakistan Military
  { start: '760000', end: '767FFF', operator: 'other', country: 'Pakistan' },

  // Egypt Military
  { start: '500000', end: '5003FF', operator: 'other', country: 'Egypt' },

  // Poland Military
  { start: '488000', end: '48FFFF', operator: 'other', country: 'Poland' },

  // Greece Military
  { start: '468000', end: '46FFFF', operator: 'other', country: 'Greece' },

  // Sweden Military
  { start: '4A8000', end: '4AFFFF', operator: 'other', country: 'Sweden' },

  // Norway Military
  { start: '478000', end: '47FFFF', operator: 'other', country: 'Norway' },

  // Singapore Military
  { start: '768000', end: '76FFFF', operator: 'other', country: 'Singapore' },
];

/**
 * Known military vessel MMSI patterns and ranges
 * MMSI format: MIDxxxxxx where MID is the Maritime Identification Digits
 */
export interface VesselPattern {
  mmsiPrefix?: string;        // MMSI prefix to match
  mmsiRange?: { start: number; end: number };
  operator: MilitaryOperator | 'other';
  country: string;
  vesselType?: MilitaryVesselType;
}

// Military vessel MMSI patterns
export const MILITARY_VESSEL_PATTERNS: VesselPattern[] = [
  // US Navy vessels (various MMSI ranges)
  { mmsiPrefix: '3699', operator: 'usn', country: 'USA', vesselType: 'destroyer' },
  { mmsiPrefix: '369970', operator: 'usn', country: 'USA' },

  // UK Royal Navy
  { mmsiPrefix: '232', operator: 'rn', country: 'UK' },
  { mmsiPrefix: '2320', operator: 'rn', country: 'UK' },

  // Note: Many military vessels don't broadcast AIS or use obscured identities
];

/**
 * Known naval vessel names and hull numbers for identification
 */
export interface KnownNavalVessel {
  name: string;
  hullNumber?: string;
  mmsi?: string;
  operator: MilitaryOperator | 'other';
  country: string;
  vesselType: MilitaryVesselType;
  homePort?: string;
}

export const KNOWN_NAVAL_VESSELS: KnownNavalVessel[] = [
  // US Aircraft Carriers
  { name: 'USS Gerald R. Ford', hullNumber: 'CVN-78', operator: 'usn', country: 'USA', vesselType: 'carrier' },
  { name: 'USS George H.W. Bush', hullNumber: 'CVN-77', operator: 'usn', country: 'USA', vesselType: 'carrier' },
  { name: 'USS Ronald Reagan', hullNumber: 'CVN-76', operator: 'usn', country: 'USA', vesselType: 'carrier' },
  { name: 'USS Harry S. Truman', hullNumber: 'CVN-75', operator: 'usn', country: 'USA', vesselType: 'carrier' },
  { name: 'USS John C. Stennis', hullNumber: 'CVN-74', operator: 'usn', country: 'USA', vesselType: 'carrier' },
  { name: 'USS George Washington', hullNumber: 'CVN-73', operator: 'usn', country: 'USA', vesselType: 'carrier' },
  { name: 'USS Abraham Lincoln', hullNumber: 'CVN-72', operator: 'usn', country: 'USA', vesselType: 'carrier' },
  { name: 'USS Theodore Roosevelt', hullNumber: 'CVN-71', operator: 'usn', country: 'USA', vesselType: 'carrier' },
  { name: 'USS Carl Vinson', hullNumber: 'CVN-70', operator: 'usn', country: 'USA', vesselType: 'carrier' },
  { name: 'USS Dwight D. Eisenhower', hullNumber: 'CVN-69', operator: 'usn', country: 'USA', vesselType: 'carrier' },
  { name: 'USS Nimitz', hullNumber: 'CVN-68', operator: 'usn', country: 'USA', vesselType: 'carrier' },

  // UK Carriers
  { name: 'HMS Queen Elizabeth', hullNumber: 'R08', operator: 'rn', country: 'UK', vesselType: 'carrier' },
  { name: 'HMS Prince of Wales', hullNumber: 'R09', operator: 'rn', country: 'UK', vesselType: 'carrier' },

  // Chinese Carriers
  { name: 'Liaoning', hullNumber: '16', operator: 'plan', country: 'China', vesselType: 'carrier' },
  { name: 'Shandong', hullNumber: '17', operator: 'plan', country: 'China', vesselType: 'carrier' },
  { name: 'Fujian', hullNumber: '18', operator: 'plan', country: 'China', vesselType: 'carrier' },

  // Russian Carrier
  { name: 'Admiral Kuznetsov', operator: 'vks', country: 'Russia', vesselType: 'carrier' },

  // Notable Destroyers/Cruisers
  { name: 'USS Zumwalt', hullNumber: 'DDG-1000', operator: 'usn', country: 'USA', vesselType: 'destroyer' },
  { name: 'HMS Defender', hullNumber: 'D36', operator: 'rn', country: 'UK', vesselType: 'destroyer' },
  { name: 'HMS Duncan', hullNumber: 'D37', operator: 'rn', country: 'UK', vesselType: 'destroyer' },

  // Research/Intel Vessels
  { name: 'USNS Victorious', hullNumber: 'T-AGOS-19', operator: 'usn', country: 'USA', vesselType: 'research' },
  { name: 'USNS Impeccable', hullNumber: 'T-AGOS-23', operator: 'usn', country: 'USA', vesselType: 'research' },
  { name: 'Yuan Wang', operator: 'plan', country: 'China', vesselType: 'research' },
];

/**
 * Regions of interest for military activity monitoring
 */
// Consolidated regions to reduce API calls (max 4 queries)
// Names kept short for map cluster labels
export const MILITARY_HOTSPOTS = [
  // East Asia: Taiwan + SCS + Korea + Japan Sea (combined)
  { name: 'INDO-PACIFIC', lat: 28.0, lon: 125.0, radius: 18, priority: 'high' },
  // Middle East: Persian Gulf + Aden + Mediterranean (combined)
  { name: 'CENTCOM', lat: 28.0, lon: 42.0, radius: 15, priority: 'high' },
  // Europe: Black Sea + Baltic (combined)
  { name: 'EUCOM', lat: 52.0, lon: 28.0, radius: 15, priority: 'medium' },
  // Keep Arctic separate (large but low activity)
  { name: 'ARCTIC', lat: 75.0, lon: 0.0, radius: 10, priority: 'low' },
] as const;

export interface QueryRegion {
  name: string;
  lamin: number;
  lamax: number;
  lomin: number;
  lomax: number;
}

export const MILITARY_QUERY_REGIONS: QueryRegion[] = [
  { name: 'PACIFIC', lamin: 10, lamax: 46, lomin: 107, lomax: 143 },
  { name: 'WESTERN', lamin: 13, lamax: 85, lomin: -10, lomax: 57 },
];

if (import.meta.env.DEV) {
  for (const h of MILITARY_HOTSPOTS) {
    const hbox = { lamin: h.lat - h.radius, lamax: h.lat + h.radius, lomin: h.lon - h.radius, lomax: h.lon + h.radius };
    const covered = MILITARY_QUERY_REGIONS.some(r =>
      r.lamin <= hbox.lamin && r.lamax >= hbox.lamax && r.lomin <= hbox.lomin && r.lomax >= hbox.lomax
    );
    if (!covered) console.error(`[Military] HOTSPOT ${h.name} bbox not covered by any QUERY_REGION`);
  }
}

export const USNI_REGION_COORDINATES: Record<string, { lat: number; lon: number }> = {
  // Seas & Oceans
  'Philippine Sea': { lat: 18.0, lon: 130.0 },
  'South China Sea': { lat: 14.0, lon: 115.0 },
  'East China Sea': { lat: 28.0, lon: 125.0 },
  'Sea of Japan': { lat: 40.0, lon: 135.0 },
  'Arabian Sea': { lat: 18.0, lon: 63.0 },
  'Red Sea': { lat: 20.0, lon: 38.0 },
  'Mediterranean Sea': { lat: 35.0, lon: 18.0 },
  'Eastern Mediterranean': { lat: 34.5, lon: 33.0 },
  'Western Mediterranean': { lat: 37.0, lon: 3.0 },
  'Persian Gulf': { lat: 26.5, lon: 52.0 },
  'Gulf of Oman': { lat: 24.5, lon: 58.5 },
  'Gulf of Aden': { lat: 12.0, lon: 47.0 },
  'Caribbean Sea': { lat: 15.0, lon: -73.0 },
  'North Atlantic': { lat: 45.0, lon: -30.0 },
  'Atlantic Ocean': { lat: 30.0, lon: -40.0 },
  'Western Atlantic': { lat: 30.0, lon: -60.0 },
  'Pacific Ocean': { lat: 20.0, lon: -150.0 },
  'Eastern Pacific': { lat: 18.0, lon: -125.0 },
  'Western Pacific': { lat: 20.0, lon: 140.0 },
  'Indian Ocean': { lat: -5.0, lon: 75.0 },
  'Antarctic': { lat: -70.0, lon: 20.0 },
  'Baltic Sea': { lat: 58.0, lon: 20.0 },
  'Black Sea': { lat: 43.5, lon: 34.0 },
  'Bay of Bengal': { lat: 14.0, lon: 87.0 },
  'Bab el-Mandeb Strait': { lat: 12.5, lon: 43.5 },
  'Strait of Hormuz': { lat: 26.5, lon: 56.5 },
  'Taiwan Strait': { lat: 24.5, lon: 119.5 },
  'Suez Canal': { lat: 30.0, lon: 32.5 },
  // Ports & Bases
  'Yokosuka': { lat: 35.29, lon: 139.67 },
  'Japan': { lat: 35.29, lon: 139.67 },
  'Sasebo': { lat: 33.16, lon: 129.72 },
  'Guam': { lat: 13.45, lon: 144.79 },
  'Pearl Harbor': { lat: 21.35, lon: -157.95 },
  'San Diego': { lat: 32.68, lon: -117.15 },
  'Norfolk': { lat: 36.95, lon: -76.30 },
  'Mayport': { lat: 30.39, lon: -81.40 },
  'Bahrain': { lat: 26.23, lon: 50.55 },
  'Rota': { lat: 36.63, lon: -6.35 },
  'Rota Spain': { lat: 36.63, lon: -6.35 },
  'Diego Garcia': { lat: -7.32, lon: 72.42 },
  'Souda Bay': { lat: 35.49, lon: 24.08 },
  'Naples': { lat: 40.84, lon: 14.25 },
  'Bremerton': { lat: 47.57, lon: -122.63 },
  'Everett': { lat: 47.97, lon: -122.22 },
  'Kings Bay': { lat: 30.80, lon: -81.56 },
  'Bangor': { lat: 47.73, lon: -122.71 },
  'Djibouti': { lat: 11.55, lon: 43.15 },
  'Singapore': { lat: 1.35, lon: 103.82 },
};

export function normalizeUSNIRegion(regionText: string): string {
  return regionText
    .replace(/^(In the|In|The)\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function getUSNIRegionCoords(regionText: string): { lat: number; lon: number } | undefined {
  const normalized = normalizeUSNIRegion(regionText);
  if (USNI_REGION_COORDINATES[normalized]) return USNI_REGION_COORDINATES[normalized];
  const lower = normalized.toLowerCase();
  for (const [key, coords] of Object.entries(USNI_REGION_COORDINATES)) {
    if (key.toLowerCase() === lower || lower.includes(key.toLowerCase()) || key.toLowerCase().includes(lower)) {
      return coords;
    }
  }
  return undefined;
}

export function getUSNIRegionApproxCoords(regionText: string): { lat: number; lon: number } {
  const direct = getUSNIRegionCoords(regionText);
  if (direct) return direct;

  const normalized = normalizeUSNIRegion(regionText).toLowerCase();
  if (normalized.includes('eastern pacific')) return { lat: 18.0, lon: -125.0 };
  if (normalized.includes('western atlantic')) return { lat: 30.0, lon: -60.0 };
  if (normalized.includes('pacific')) return { lat: 15.0, lon: -150.0 };
  if (normalized.includes('atlantic')) return { lat: 30.0, lon: -40.0 };
  if (normalized.includes('indian')) return { lat: -5.0, lon: 75.0 };
  if (normalized.includes('mediterranean')) return { lat: 35.0, lon: 18.0 };
  if (normalized.includes('antarctic') || normalized.includes('southern')) return { lat: -70.0, lon: 20.0 };
  if (normalized.includes('arctic')) return { lat: 75.0, lon: 0.0 };

  // Deterministic fallback so previously unseen regions are still rendered.
  let hash = 0;
  for (let i = 0; i < normalized.length; i++) {
    hash = ((hash << 5) - hash) + normalized.charCodeAt(i);
    hash |= 0;
  }
  const lat = ((Math.abs(hash) % 120) - 60);
  const lon = ((Math.abs(hash * 31) % 300) - 150);
  return { lat, lon };
}

/**
 * Helper function to identify aircraft by callsign
 */
export function identifyByCallsign(callsign: string, originCountry?: string): CallsignPattern | undefined {
  const normalized = callsign.toUpperCase().trim();
  const origin = originCountry?.toLowerCase().trim();

  // Prefer country-specific operators to disambiguate (e.g. NAVY → USN vs RN)
  const preferred: MilitaryOperator[] = [];
  if (origin === 'united kingdom' || origin === 'uk') preferred.push('rn', 'raf');
  if (origin === 'united states' || origin === 'usa') preferred.push('usn', 'usaf', 'usa', 'usmc');

  if (preferred.length > 0) {
    for (const pattern of ALL_MILITARY_CALLSIGNS) {
      if (!preferred.includes(pattern.operator)) continue;
      if (new RegExp(pattern.pattern, 'i').test(normalized)) return pattern;
    }
  }

  for (const pattern of ALL_MILITARY_CALLSIGNS) {
    if (new RegExp(pattern.pattern, 'i').test(normalized)) return pattern;
  }

  return undefined;
}

/**
 * Helper function to identify aircraft by type code
 */
export function identifyByAircraftType(typeCode: string): { type: MilitaryAircraftType; name: string } | undefined {
  const normalized = typeCode.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return MILITARY_AIRCRAFT_TYPES[normalized];
}

/**
 * Helper to check if a hex code is in known military range
 */
export function isKnownMilitaryHex(hexCode: string): { operator: MilitaryOperator; country: string } | undefined {
  const hex = hexCode.toUpperCase();
  for (const range of MILITARY_HEX_RANGES) {
    if (hex >= range.start && hex <= range.end) {
      return { operator: range.operator, country: range.country };
    }
  }
  return undefined;
}

/**
 * Check if vessel is near a military hotspot
 */
export function getNearbyHotspot(lat: number, lon: number): typeof MILITARY_HOTSPOTS[number] | undefined {
  for (const hotspot of MILITARY_HOTSPOTS) {
    const distance = Math.sqrt(Math.pow(lat - hotspot.lat, 2) + Math.pow(lon - hotspot.lon, 2));
    if (distance <= hotspot.radius) {
      return hotspot;
    }
  }
  return undefined;
}
