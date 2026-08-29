// src/data/aircraftClass.js
/**
 * Type-aware aircraft classification. ICAO type-designator sets adapted from
 * skylight (https://github.com/cpaczek/skylight, MIT) web/src/display/
 * aircraftGlyph.ts, extended with a fast-jet set for the military layer and
 * C17/K35R in the widebody set. Category fallbacks cover the OpenSky extended
 * integer category (states index 17) and ADS-B emitter strings ("A1".."B1").
 */

const HELI = new Set([
  'EC20', 'EC25', 'EC30', 'EC35', 'EC45', 'EC55', 'AS50', 'AS55', 'AS65', 'AS32',
  'A109', 'A119', 'A139', 'A169', 'A189', 'B06', 'B06T', 'B407', 'B412', 'B427',
  'B429', 'B430', 'B505', 'S76', 'S92', 'S61', 'S64', 'H60', 'H500', 'MD52',
  'MD60', 'R22', 'R44', 'R66', 'EXEC', 'EXPL', 'GAZL', 'LYNX', 'NH90', 'PUMA',
  'SCAV', 'UH1', 'B105', 'B212', 'B214', 'B222', 'AC', 'H47', 'H64',
]);
const QUAD = new Set([
  'B741', 'B742', 'B743', 'B744', 'B748', 'B74S', 'B74R', 'B74D', 'A388', 'A342',
  'A343', 'A345', 'A346', 'A124', 'C5M', 'A225', 'IL96', 'B52', 'A140',
]);
const WIDE = new Set([
  'A306', 'A30B', 'A310', 'A332', 'A333', 'A338', 'A339', 'A359', 'A35K', 'B762',
  'B763', 'B764', 'B772', 'B77L', 'B773', 'B77W', 'B778', 'B779', 'B788', 'B789',
  'B78X', 'MD11', 'IL86', 'DC10', 'L101', 'A337', 'B767', 'B777', 'B787',
  'C17', 'K35R', // military heavies that read as widebodies
]);
const TPROP = new Set([
  'DH8A', 'DH8B', 'DH8C', 'DH8D', 'AT43', 'AT44', 'AT45', 'AT46', 'AT72', 'AT73',
  'AT75', 'AT76', 'SF34', 'SB20', 'SW3', 'SW4', 'E110', 'E120', 'C208', 'C212',
  'C408', 'PC12', 'B190', 'BE20', 'B350', 'B300', 'JS31', 'JS32', 'JS41', 'D228',
  'D328', 'F50', 'F27', 'ATP', 'TBM7', 'TBM8', 'TBM9', 'TBM0', 'PC6', 'C441',
  'C425', 'DHC6', 'DHC7', 'C130', 'AN12', 'AN26', 'AN32', 'SH36', 'CVLT', 'SAAB',
  'A400',
]);
const GLIDER = new Set([
  'DISC', 'DUOD', 'VENT', 'NIMB', 'NIM3', 'NIM4', 'JANS', 'ARCE', 'DG40', 'DG80',
  'DG1T', 'DG30', 'DG50', 'LS3', 'LS4', 'LS6', 'LS7', 'LS8', 'STD3', 'G103',
  'G102', 'G104', 'PW5', 'PW6', 'L13', 'L23', 'L33', 'PIK', 'PEGA', 'KEST',
  'TWIN', 'AS33', 'ASW', 'ASG', 'ASK', 'VENS', 'GLID', 'MOSQ', 'DIMO',
]);
const LIGHT = new Set([
  'C150', 'C152', 'C162', 'C172', 'C72R', 'C175', 'C177', 'C180', 'C182', 'C185',
  'C188', 'C206', 'C207', 'C210', 'C310', 'C337', 'SR20', 'SR22', 'S22T', 'PA18',
  'PA24', 'PA28', 'P28A', 'P28B', 'P28R', 'PA32', 'P32R', 'PA34', 'PA38', 'PA44',
  'PA46', 'DA20', 'DA40', 'DA42', 'DA62', 'BE33', 'BE35', 'BE36', 'BE58', 'BE76',
  'BE19', 'BE23', 'BE24', 'M20P', 'M20T', 'AA1', 'AA5', 'GLAS', 'COL4', 'RV4',
  'RV6', 'RV7', 'RV8', 'RV9', 'RV10', 'RV14', 'GA8', 'G115', 'BL8', 'CH7',
]);
// GEV addition (2026-08-15 Hangar fleet): business jets — distinct class so the
// Citation II GLB + a slimmer glyph read apart from airliners.
const BIZJET = new Set([
  'C500', 'C501', 'C510', 'C525', 'C25A', 'C25B', 'C25C', 'C25M', 'C550',
  'C551', 'C560', 'C56X', 'C650', 'C680', 'C68A', 'C700', 'C750',
  'CL30', 'CL35', 'CL60', 'GLF2', 'GLF3', 'GLF4', 'GLF5', 'GLF6', 'GA5C',
  'GA6C', 'G150', 'G280', 'GL5T', 'GL7T', 'GLEX',
  'LJ23', 'LJ24', 'LJ25', 'LJ31', 'LJ35', 'LJ40', 'LJ45', 'LJ55', 'LJ60',
  'LJ70', 'LJ75', 'FA10', 'FA20', 'FA50', 'FA7X', 'FA8X', 'F900', 'F2TH',
  'H25A', 'H25B', 'H25C', 'HDJT', 'E50P', 'E55P', 'E545', 'E550', 'PC24',
  'PRM1', 'BE40', 'ASTR', 'WW24',
  'SF50', // Cirrus Vision Jet — a JET (was mis-set in LIGHT before the bizjet class existed)
]);
// GEV addition (2026-08-15 Hangar fleet): large UAVs — ICAO designators seen on
// ADS-B/adsb.lol for Predator/Reaper/Global Hawk-class airframes.
const UAV = new Set([
  'Q1', 'Q4', 'Q9', 'MQ1', 'MQ4', 'MQ9', 'RQ4', 'TB2', 'SHDW', 'HERN',
]);
// GEV addition: fast jets, for the military layer's adsb.lol `t` codes.
const FASTJET = new Set([
  'F16', 'F15', 'F18', 'FA18', 'F14', 'F22', 'F35', 'F4', 'F5', 'A10', 'AV8B',
  'TYPH', 'EUFI', 'RFAL', 'RAFL', 'GRIP', 'JAS39', 'TOR', 'MIR2', 'M2000',
  'SU27', 'SU30', 'SU33', 'SU34', 'SU35', 'SU57', 'MG29', 'MIG29', 'MG31', 'J20',
  'T38', 'HAWK', 'L39', 'M346', 'T7A',
]);

/** OpenSky extended-states integer category → class. */
const OPENSKY_CATEGORY = {
  2: 'light',      // Light (< 15 500 lbs)
  3: 'airliner',   // Small
  4: 'airliner',   // Large
  5: 'airliner',   // High-vortex large (B757)
  6: 'widebody',   // Heavy
  7: 'fastjet',    // High performance (>5g, >400 kt)
  8: 'helicopter', // Rotorcraft
  9: 'glider',
};

/** ADS-B emitter-category string → class. */
const EMITTER_CATEGORY = {
  A1: 'light', A2: 'light', A3: 'airliner', A4: 'airliner',
  A5: 'widebody', A6: 'fastjet', A7: 'helicopter', B1: 'glider',
};

export function classifyAircraft({ typeCode, category } = {}) {
  const code = String(typeCode || '').trim().toUpperCase();
  if (code) {
    if (FASTJET.has(code)) return 'fastjet';
    if (UAV.has(code)) return 'uav';
    if (HELI.has(code)) return 'helicopter';
    if (QUAD.has(code)) return 'quadjet';
    if (WIDE.has(code)) return 'widebody';
    if (TPROP.has(code)) return 'turboprop';
    if (GLIDER.has(code)) return 'glider';
    if (BIZJET.has(code)) return 'bizjet';
    if (LIGHT.has(code)) return 'light';
    return 'airliner'; // known type code, not in a special set → default jet
  }
  if (Number.isFinite(category) && OPENSKY_CATEGORY[category]) return OPENSKY_CATEGORY[category];
  const cat = String(category || '').trim().toUpperCase();
  if (EMITTER_CATEGORY[cat]) return EMITTER_CATEGORY[cat];
  return 'airliner';
}

/** Billboard scale multipliers (skylight GLYPH_SCALE, + fastjet). */
export const CLASS_SCALE_2D = {
  light: 0.62, glider: 0.58, turboprop: 0.86, airliner: 1.0,
  widebody: 1.3, quadjet: 1.45, helicopter: 0.82, fastjet: 0.8,
  bizjet: 0.72, uav: 0.75,
};

/** 3D model scale multipliers — clamped [0.75, 1.45] while every class shares
 *  the single airplane.glb (a jet mesh at C172 scale reads wrong). Widen when
 *  real per-class models land in CLASS_MODEL_URL. */
export const CLASS_SCALE_3D = {
  light: 0.75, glider: 0.75, turboprop: 0.85, airliner: 1.0,
  widebody: 1.3, quadjet: 1.45, helicopter: 0.8, fastjet: 0.8,
  bizjet: 0.8, uav: 0.8,
};

/** Per-class glTF — all the shared airplane today; drop real assets in here.
 *  NOTE for future models: each asset may need its own heading offset (the
 *  shared GLB uses MODEL_HEADING_OFFSET_DEG = 180 in both layers). */
export const CLASS_MODEL_URL = {
  light: '/models/airplane.glb', glider: '/models/airplane.glb',
  turboprop: '/models/airplane.glb', airliner: '/models/airplane.glb',
  widebody: '/models/airplane.glb', quadjet: '/models/airplane.glb',
  helicopter: '/models/airplane.glb', fastjet: '/models/airplane.glb',
  bizjet: '/models/airplane.glb', uav: '/models/airplane.glb',
};

/** Real per-class GLBs (2026-08-15 Hangar fleet, selected assets; CC-BY 4.0 —
 *  provenance in public/models/README.md). Every asset is vertex-baked to the
 *  airplane.glb convention: Y-up, X = length, Z = span, nose −X (so the layers'
 *  MODEL_HEADING_OFFSET_DEG = 180 applies unchanged), origin at bbox centre,
 *  REAL-WORLD METERS (render at scale 1 — no MODEL_SCALE, no CLASS_SCALE_3D).
 *  bellyM = origin→lowest-vertex distance (grounded-model lift, replaces the
 *  airplane.glb MODEL_BELLY_OFFSET_NATIVE formula); radiusM = bounding-sphere
 *  radius in meters (pixel-size math). Values measured from the shipped GLBs —
 *  pinned by modelScale.test.mjs. Classes NOT listed (airliner, quadjet,
 *  glider, fastjet) still render the shared airplane.glb via CLASS_MODEL_URL. */
export const CLASS_MODEL_REAL = {
  helicopter: { url: '/models/bell206.glb',   bellyM: 1.66, radiusM: 8.24 },
  light:      { url: '/models/c172.glb',      bellyM: 1.36, radiusM: 7.0 },
  bizjet:     { url: '/models/citation2.glb', bellyM: 2.86, radiusM: 11.24 },
  uav:        { url: '/models/mq9.glb',       bellyM: 2.02, radiusM: 12.0 },
  widebody:   { url: '/models/b789.glb',      bellyM: 7.81, radiusM: 44.08 },
  turboprop:  { url: '/models/atr72.glb',     bellyM: 3.81, radiusM: 19.49 },
};
