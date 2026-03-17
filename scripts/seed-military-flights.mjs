#!/usr/bin/env node

import { loadEnvFile, CHROME_UA, getRedisCredentials, acquireLockSafely, releaseLock, withRetry, writeFreshnessMetadata, logSeedResult, verifySeedKey, extendExistingTtl } from './_seed-utils.mjs';
import { summarizeMilitaryTheaters, buildMilitarySurges, appendMilitaryHistory } from './_military-surges.mjs';
import { spawn } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { fileURLToPath, pathToFileURL } from 'node:url';

loadEnvFile(import.meta.url);

const LIVE_KEY = 'military:flights:v1';
const STALE_KEY = 'military:flights:stale:v1';
const LIVE_TTL = 600;
const STALE_TTL = 86400;

const THEATER_POSTURE_LIVE_KEY = 'theater-posture:sebuf:v1';
const THEATER_POSTURE_STALE_KEY = 'theater_posture:sebuf:stale:v1';
const THEATER_POSTURE_BACKUP_KEY = 'theater-posture:sebuf:backup:v1';
const THEATER_POSTURE_LIVE_TTL = 900;
const THEATER_POSTURE_STALE_TTL = 86400;
const THEATER_POSTURE_BACKUP_TTL = 604800;
const MILITARY_FORECAST_INPUTS_LIVE_KEY = 'military:forecast-inputs:v1';
const MILITARY_FORECAST_INPUTS_STALE_KEY = 'military:forecast-inputs:stale:v1';
const MILITARY_FORECAST_INPUTS_LIVE_TTL = 900;
const MILITARY_FORECAST_INPUTS_STALE_TTL = 86400;
const MILITARY_SURGES_LIVE_KEY = 'military:surges:v1';
const MILITARY_SURGES_STALE_KEY = 'military:surges:stale:v1';
const MILITARY_SURGES_HISTORY_KEY = 'military:surges:history:v1';
const MILITARY_SURGES_LIVE_TTL = 900;
const MILITARY_SURGES_STALE_TTL = 86400;
const MILITARY_SURGES_HISTORY_TTL = 604800;
const MILITARY_SURGES_HISTORY_MAX = 72;
const MILITARY_CLASSIFICATION_AUDIT_LIVE_KEY = 'military:classification-audit:v1';
const MILITARY_CLASSIFICATION_AUDIT_STALE_KEY = 'military:classification-audit:stale:v1';
const MILITARY_CLASSIFICATION_AUDIT_LIVE_TTL = 900;
const MILITARY_CLASSIFICATION_AUDIT_STALE_TTL = 86400;
const CHAIN_FORECAST_SEED = process.env.CHAIN_FORECAST_SEED_ON_MILITARY === '1';

// ── Proxy Config ─────────────────────────────────────────
const OPENSKY_PROXY_AUTH = process.env.OPENSKY_PROXY_AUTH || process.env.OREF_PROXY_AUTH || '';
const PROXY_ENABLED = !!OPENSKY_PROXY_AUTH;

// ── Query Regions ──────────────────────────────────────────
const QUERY_REGIONS = [
  { name: 'PACIFIC', lamin: 10, lamax: 46, lomin: 107, lomax: 143 },
  { name: 'WESTERN', lamin: 13, lamax: 85, lomin: -10, lomax: 57 },
];

// ── Military Hex Ranges (ICAO 24-bit) ─────────────────────
const HEX_RANGES = [
  { start: 'ADF7C8', end: 'AFFFFF', operator: 'usaf', country: 'USA' },
  { start: '400000', end: '40003F', operator: 'raf', country: 'UK' },
  { start: '43C000', end: '43CFFF', operator: 'raf', country: 'UK' },
  { start: '3AA000', end: '3AFFFF', operator: 'faf', country: 'France' },
  { start: '3B7000', end: '3BFFFF', operator: 'faf', country: 'France' },
  { start: '3EA000', end: '3EBFFF', operator: 'gaf', country: 'Germany' },
  { start: '3F4000', end: '3FBFFF', operator: 'gaf', country: 'Germany' },
  { start: '738A00', end: '738BFF', operator: 'iaf', country: 'Israel' },
  { start: '4D0000', end: '4D03FF', operator: 'nato', country: 'NATO' },
  { start: '33FF00', end: '33FFFF', operator: 'other', country: 'Italy' },
  { start: '350000', end: '3503FF', operator: 'other', country: 'Spain' },
  { start: '480000', end: '480FFF', operator: 'other', country: 'Netherlands' },
  { start: '4B8200', end: '4B82FF', operator: 'other', country: 'Turkey' },
  { start: '710258', end: '71028F', operator: 'other', country: 'Saudi Arabia' },
  { start: '710380', end: '71039F', operator: 'other', country: 'Saudi Arabia' },
  { start: '896800', end: '896BFF', operator: 'other', country: 'UAE' },
  { start: '06A200', end: '06A3FF', operator: 'other', country: 'Qatar' },
  { start: '706000', end: '706FFF', operator: 'other', country: 'Kuwait' },
  { start: '7CF800', end: '7CFAFF', operator: 'other', country: 'Australia' },
  { start: 'C2D000', end: 'C2DFFF', operator: 'other', country: 'Canada' },
  { start: '800200', end: '8002FF', operator: 'other', country: 'India' },
  { start: '010070', end: '01008F', operator: 'other', country: 'Egypt' },
  { start: '48D800', end: '48D87F', operator: 'other', country: 'Poland' },
  { start: '468000', end: '4683FF', operator: 'other', country: 'Greece' },
  { start: '478100', end: '4781FF', operator: 'other', country: 'Norway' },
  { start: '444000', end: '446FFF', operator: 'other', country: 'Austria' },
  { start: '44F000', end: '44FFFF', operator: 'other', country: 'Belgium' },
  { start: '4B7000', end: '4B7FFF', operator: 'other', country: 'Switzerland' },
  { start: 'E40000', end: 'E41FFF', operator: 'other', country: 'Brazil' },
];

// ── Commercial ICAO 3-letter codes (blocklist for ambiguous patterns) ────
const COMMERCIAL_CALLSIGNS = new Set([
  'CCA', 'CHH', 'SVA', 'THY', 'THK', 'TUR', 'ELY', 'ELAL',
  'UAE', 'QTR', 'ETH', 'SAA', 'PAK', 'AME', 'RED',
]);

const COMMERCIAL_CALLSIGN_PATTERNS = [
  /^CLX\d/i,
  /^QTR/i,
  /^QR\d/i,
  /^UAE\d/i,
  /^ETH\d/i,
  /^THY\d/i,
  /^SVA\d/i,
  /^CCA\d/i,
  /^CHH\d/i,
  /^ELY\d/i,
  /^ELAL/i,
];

const TRUSTED_HEX_OPERATORS = new Set(['usaf', 'raf', 'faf', 'gaf', 'iaf', 'nato', 'plaaf', 'plan', 'vks']);

// ── Military Callsign Patterns ─────────────────────────────
const CALLSIGN_PATTERNS = [
  // US Air Force — distinctive military callsigns
  { re: /^RCH\d/i, operator: 'usaf', aircraftType: 'transport' },
  { re: /^REACH\d/i, operator: 'usaf', aircraftType: 'transport' },
  { re: /^DUKE\d/i, operator: 'usaf', aircraftType: 'transport' },
  { re: /^SAM\d{2,}/i, operator: 'usaf', aircraftType: 'vip' },
  { re: /^AF[12]\d/i, operator: 'usaf', aircraftType: 'vip' },
  { re: /^EXEC\d/i, operator: 'usaf', aircraftType: 'vip' },
  { re: /^GOLD\d/i, operator: 'usaf', aircraftType: 'special_ops' },
  { re: /^KING\d/i, operator: 'usaf', aircraftType: 'tanker' },
  { re: /^SHELL\d/i, operator: 'usaf', aircraftType: 'tanker' },
  { re: /^TEAL\d/i, operator: 'usaf', aircraftType: 'tanker' },
  { re: /^BOLT\d/i, operator: 'usaf', aircraftType: 'fighter' },
  { re: /^VIPER\d/i, operator: 'usaf', aircraftType: 'fighter' },
  { re: /^RAPTOR/i, operator: 'usaf', aircraftType: 'fighter' },
  { re: /^BONE\d/i, operator: 'usaf', aircraftType: 'bomber' },
  { re: /^DEATH\d/i, operator: 'usaf', aircraftType: 'bomber' },
  { re: /^DOOM\d/i, operator: 'usaf', aircraftType: 'bomber' },
  { re: /^SNTRY/i, operator: 'usaf', aircraftType: 'awacs' },
  { re: /^DRAGN/i, operator: 'usaf', aircraftType: 'reconnaissance' },
  { re: /^COBRA\d/i, operator: 'usaf', aircraftType: 'reconnaissance' },
  { re: /^RIVET/i, operator: 'usaf', aircraftType: 'reconnaissance' },
  { re: /^OLIVE\d/i, operator: 'usaf', aircraftType: 'reconnaissance' },
  { re: /^JAKE\d/i, operator: 'usaf', aircraftType: 'reconnaissance' },
  { re: /^NCHO/i, operator: 'usaf', aircraftType: 'special_ops' },
  { re: /^SHADOW\d/i, operator: 'usaf', aircraftType: 'special_ops' },
  { re: /^EVAC\d/i, operator: 'usaf', aircraftType: 'transport' },
  { re: /^MOOSE\d/i, operator: 'usaf', aircraftType: 'transport' },
  { re: /^HERKY/i, operator: 'usaf', aircraftType: 'transport' },
  { re: /^FORTE\d/i, operator: 'usaf', aircraftType: 'drone' },
  { re: /^HAWK\d/i, operator: 'usaf', aircraftType: 'drone' },
  { re: /^REAPER/i, operator: 'usaf', aircraftType: 'drone' },
  // US Navy
  { re: /^NAVY\d/i, operator: 'usn', aircraftType: null },
  { re: /^CNV\d/i, operator: 'usn', aircraftType: 'transport' },
  { re: /^VRC\d/i, operator: 'usn', aircraftType: 'transport' },
  { re: /^TRIDENT/i, operator: 'usn', aircraftType: 'patrol' },
  { re: /^BRONCO/i, operator: 'usn', aircraftType: 'fighter' },
  // US Marines
  { re: /^MARINE/i, operator: 'usmc', aircraftType: null },
  { re: /^HMX/i, operator: 'usmc', aircraftType: 'vip' },
  // US Army
  { re: /^ARMY\d/i, operator: 'usa', aircraftType: null },
  { re: /^PAT\d{2,}/i, operator: 'usa', aircraftType: 'transport' },
  { re: /^DUSTOFF/i, operator: 'usa', aircraftType: 'helicopter' },
  // US Coast Guard
  { re: /^COAST GUARD/i, operator: 'other', aircraftType: 'patrol' },
  { re: /^CG\d{3,}/i, operator: 'other', aircraftType: 'patrol' },
  // UK RAF / Royal Navy
  { re: /^RNAVY/i, operator: 'rn', aircraftType: null },
  { re: /^RRR\d/i, operator: 'raf', aircraftType: null },
  { re: /^ASCOT/i, operator: 'raf', aircraftType: 'transport' },
  { re: /^RAFAIR/i, operator: 'raf', aircraftType: 'transport' },
  { re: /^TARTAN/i, operator: 'raf', aircraftType: 'tanker' },
  // NATO
  { re: /^NATO\d/i, operator: 'nato', aircraftType: 'awacs' },
  // France
  { re: /^FAF\d/i, operator: 'faf', aircraftType: null },
  { re: /^CTM\d/i, operator: 'faf', aircraftType: 'transport' },
  { re: /^FRENCH\s?(AIR|MIL|NAVY)/i, operator: 'faf', aircraftType: null },
  // Germany
  { re: /^GAF\d/i, operator: 'gaf', aircraftType: null },
  { re: /^GERMAN\s?(AIR|MIL|NAVY)/i, operator: 'gaf', aircraftType: null },
  // Israel — ELAL removed (commercial El Al), IAF requires digit suffix
  { re: /^IAF\d{2,}/i, operator: 'iaf', aircraftType: null },
  // Turkey — THK removed (civil Turkish Aeronautical Assoc), TURAF is Turkish AF
  { re: /^TURAF/i, operator: 'other', aircraftType: null },
  { re: /^TRKAF/i, operator: 'other', aircraftType: null },
  // Saudi Arabia — SVA removed (Saudia commercial ICAO code)
  { re: /^RSAF\d/i, operator: 'other', aircraftType: null },
  // Other specific military
  { re: /^UAF\d/i, operator: 'other', aircraftType: null },
  { re: /^AIR INDIA ONE/i, operator: 'other', aircraftType: 'vip' },
  { re: /^IAM\d/i, operator: 'other', aircraftType: null },
  { re: /^JASDF/i, operator: 'other', aircraftType: null },
  { re: /^ROKAF/i, operator: 'other', aircraftType: null },
  { re: /^KAF\d/i, operator: 'other', aircraftType: null },
  { re: /^RAAF\d/i, operator: 'other', aircraftType: null },
  { re: /^AUSSIE\d/i, operator: 'other', aircraftType: null },
  { re: /^CANFORCE/i, operator: 'other', aircraftType: 'transport' },
  { re: /^CFC\d/i, operator: 'other', aircraftType: null },
  { re: /^PLF\d/i, operator: 'other', aircraftType: null },
  { re: /^HAF\d/i, operator: 'other', aircraftType: null },
  { re: /^EGY\d{3,}/i, operator: 'other', aircraftType: null },
  { re: /^PAF\d/i, operator: 'other', aircraftType: null },
  // Russia
  { re: /^RFF\d/i, operator: 'vks', aircraftType: null },
  { re: /^RSD\d/i, operator: 'vks', aircraftType: null },
  { re: /^RUSSIAN/i, operator: 'vks', aircraftType: null },
  // China — CCA removed (China Airlines ICAO), CHH removed (Hainan Airlines ICAO)
  { re: /^PLAAF/i, operator: 'plaaf', aircraftType: null },
  { re: /^PLA\d/i, operator: 'plaaf', aircraftType: null },
  { re: /^CHINA\s?(AIR\s?FORCE|MIL|NAVY)/i, operator: 'plaaf', aircraftType: null },
];

const OPERATOR_COUNTRY = {
  usaf: 'USA', usn: 'USA', usmc: 'USA', usa: 'USA',
  raf: 'UK', rn: 'UK', faf: 'France', gaf: 'Germany',
  plaaf: 'China', plan: 'China', vks: 'Russia',
  iaf: 'Israel', nato: 'NATO', other: 'Unknown',
};

const HOTSPOTS = [
  { name: 'INDO-PACIFIC', lat: 28.0, lon: 125.0, radius: 18, priority: 'high' },
  { name: 'CENTCOM', lat: 28.0, lon: 42.0, radius: 15, priority: 'high' },
  { name: 'EUCOM', lat: 52.0, lon: 28.0, radius: 15, priority: 'medium' },
  { name: 'ARCTIC', lat: 75.0, lon: 0.0, radius: 10, priority: 'low' },
];

// ── Theater Posture Theaters ───────────────────────────────
const POSTURE_THEATERS = [
  { id: 'iran-theater', bounds: { north: 42, south: 20, east: 65, west: 30 }, thresholds: { elevated: 8, critical: 20 }, strikeIndicators: { minTankers: 2, minAwacs: 1, minFighters: 5 } },
  { id: 'taiwan-theater', bounds: { north: 30, south: 18, east: 130, west: 115 }, thresholds: { elevated: 6, critical: 15 }, strikeIndicators: { minTankers: 1, minAwacs: 1, minFighters: 4 } },
  { id: 'baltic-theater', bounds: { north: 65, south: 52, east: 32, west: 10 }, thresholds: { elevated: 5, critical: 12 }, strikeIndicators: { minTankers: 1, minAwacs: 1, minFighters: 3 } },
  { id: 'blacksea-theater', bounds: { north: 48, south: 40, east: 42, west: 26 }, thresholds: { elevated: 4, critical: 10 }, strikeIndicators: { minTankers: 1, minAwacs: 1, minFighters: 3 } },
  { id: 'korea-theater', bounds: { north: 43, south: 33, east: 132, west: 124 }, thresholds: { elevated: 5, critical: 12 }, strikeIndicators: { minTankers: 1, minAwacs: 1, minFighters: 3 } },
  { id: 'south-china-sea', bounds: { north: 25, south: 5, east: 121, west: 105 }, thresholds: { elevated: 6, critical: 15 }, strikeIndicators: { minTankers: 1, minAwacs: 1, minFighters: 4 } },
  { id: 'east-med-theater', bounds: { north: 37, south: 33, east: 37, west: 25 }, thresholds: { elevated: 4, critical: 10 }, strikeIndicators: { minTankers: 1, minAwacs: 1, minFighters: 3 } },
  { id: 'israel-gaza-theater', bounds: { north: 33, south: 29, east: 36, west: 33 }, thresholds: { elevated: 3, critical: 8 }, strikeIndicators: { minTankers: 1, minAwacs: 1, minFighters: 3 } },
  { id: 'yemen-redsea-theater', bounds: { north: 22, south: 11, east: 54, west: 32 }, thresholds: { elevated: 4, critical: 10 }, strikeIndicators: { minTankers: 1, minAwacs: 1, minFighters: 3 } },
];

// ── Detection Functions ────────────────────────────────────
function isKnownHex(hexCode) {
  const hex = hexCode.toUpperCase();
  for (const r of HEX_RANGES) {
    if (hex >= r.start && hex <= r.end) return r;
  }
  return null;
}

function identifyByCallsign(callsign, originCountry) {
  const cs = callsign.toUpperCase().trim();
  const prefix3 = cs.substring(0, 3);
  if (COMMERCIAL_CALLSIGNS.has(prefix3) || COMMERCIAL_CALLSIGNS.has(cs)) return null;
  const origin = (originCountry || '').toLowerCase().trim();
  const preferred = [];
  if (origin === 'united kingdom' || origin === 'uk') preferred.push('rn', 'raf');
  if (origin === 'united states' || origin === 'usa') preferred.push('usn', 'usaf', 'usa', 'usmc');
  if (preferred.length > 0) {
    for (const p of CALLSIGN_PATTERNS) {
      if (!preferred.includes(p.operator)) continue;
      if (p.re.test(cs)) return p;
    }
  }
  for (const p of CALLSIGN_PATTERNS) {
    if (p.re.test(cs)) return p;
  }
  return null;
}

function identifyCommercialCallsign(callsign) {
  if (!callsign) return null;
  const cs = callsign.toUpperCase().trim();
  const prefix3 = cs.substring(0, 3);
  if (COMMERCIAL_CALLSIGNS.has(prefix3) || COMMERCIAL_CALLSIGNS.has(cs)) {
    return { type: 'prefix', value: COMMERCIAL_CALLSIGNS.has(prefix3) ? prefix3 : cs };
  }
  for (const re of COMMERCIAL_CALLSIGN_PATTERNS) {
    if (re.test(cs)) return { type: 'pattern', value: re.source };
  }
  return null;
}

function detectAircraftType(callsign) {
  if (!callsign) return 'unknown';
  const cs = callsign.toUpperCase().trim();
  if (/^(SHELL|TEXACO|ARCO|ESSO|PETRO|KC|STRAT)/.test(cs)) return 'tanker';
  if (/^(SENTRY|AWACS|MAGIC|DISCO|DARKSTAR|E3|E8|E6)/.test(cs)) return 'awacs';
  if (/^(RCH|REACH|MOOSE|EVAC|DUSTOFF|C17|C5|C130|C40)/.test(cs)) return 'transport';
  if (/^(HOMER|OLIVE|JAKE|PSEUDO|GORDO|RC|U2|SR)/.test(cs)) return 'reconnaissance';
  if (/^(RQ|MQ|REAPER|PREDATOR|GLOBAL)/.test(cs)) return 'drone';
  if (/^(DEATH|BONE|DOOM|B52|B1|B2)/.test(cs)) return 'bomber';
  if (/^(BOLT|VIPER|RAPTOR|BRONCO|EAGLE|HORNET|FALCON|STRIKE|TANGO|FURY)/.test(cs)) return 'fighter';
  return 'unknown';
}

function buildWingbitsSourceMeta(flight) {
  return {
    source: 'wingbits',
    rawKeys: Object.keys(flight || {}),
    rawPreview: {
      operator: flight?.operator || '',
      operatorName: flight?.operatorName || '',
      airline: flight?.airline || '',
      owner: flight?.owner || '',
      type: flight?.type || '',
      category: flight?.category || '',
      aircraftType: flight?.aircraftType || '',
      aircraftTypeCode: flight?.aircraftTypeCode || flight?.icaoType || flight?.aircraftCode || '',
      description: flight?.description || flight?.aircraftDescription || '',
      registration: flight?.registration || flight?.reg || flight?.tail || '',
      originCountry: flight?.co || flight?.originCountry || '',
    },
    operatorName: flight?.operator || flight?.operatorName || flight?.airline || flight?.owner || flight?.o || '',
    operatorCode: flight?.operatorCode || flight?.airlineCode || flight?.icaoOperator || flight?.iataOperator || '',
    ownerName: flight?.owner || flight?.ownerName || '',
    aircraftModel: flight?.aircraftModel || flight?.model || flight?.aircraftDescription || '',
    aircraftTypeLabel: flight?.type || flight?.category || flight?.aircraftType || flight?.aircraftCategory || flight?.description || '',
    aircraftTypeCode: flight?.aircraftTypeCode || flight?.icaoType || flight?.aircraftCode || '',
    aircraftDescription: flight?.aircraftDescription || flight?.description || '',
    registration: flight?.registration || flight?.reg || flight?.tail || '',
    originCountry: flight?.co || flight?.originCountry || '',
  };
}

function getSourceHintText(sourceMeta = {}) {
  return [
    sourceMeta.operatorName,
    sourceMeta.operatorCode,
    sourceMeta.ownerName,
    sourceMeta.aircraftModel,
    sourceMeta.aircraftTypeLabel,
    sourceMeta.aircraftTypeCode,
    sourceMeta.aircraftDescription,
    sourceMeta.registration,
  ]
    .filter(Boolean)
    .join(' ')
    .toUpperCase();
}

function summarizeSourceMeta(sourceMeta = {}) {
  return {
    source: sourceMeta.source || '',
    operatorName: sourceMeta.operatorName || '',
    operatorCode: sourceMeta.operatorCode || '',
    ownerName: sourceMeta.ownerName || '',
    aircraftModel: sourceMeta.aircraftModel || '',
    aircraftTypeLabel: sourceMeta.aircraftTypeLabel || '',
    aircraftTypeCode: sourceMeta.aircraftTypeCode || '',
    aircraftDescription: sourceMeta.aircraftDescription || '',
    registration: sourceMeta.registration || '',
    originCountry: sourceMeta.originCountry || '',
  };
}

function summarizeRawSourcePreview(sourceMeta = {}) {
  const preview = sourceMeta.rawPreview || {};
  return Object.fromEntries(
    Object.entries(preview).filter(([, value]) => Boolean(value)),
  );
}

const SOURCE_META_FIELDS = [
  'operatorName',
  'operatorCode',
  'ownerName',
  'aircraftModel',
  'aircraftTypeLabel',
  'aircraftTypeCode',
  'aircraftDescription',
  'registration',
  'originCountry',
];

function hasMeaningfulSourceMeta(sourceMeta = {}) {
  const summary = summarizeSourceMeta(sourceMeta);
  return SOURCE_META_FIELDS.some((field) => Boolean(summary[field]));
}

function createClassificationStageCounters() {
  return {
    positionEligible: 0,
    sourceMetaAttached: 0,
    callsignPresent: 0,
    callsignMatched: 0,
    hexMatched: 0,
    candidateStates: 0,
    sourceTypeCandidateHits: 0,
    sourceOperatorCandidateHits: 0,
    sourceFieldCoverage: Object.fromEntries(SOURCE_META_FIELDS.map((field) => [field, 0])),
    sourceHintCounts: {
      militaryHint: 0,
      militaryOperatorHint: 0,
      commercialHint: 0,
    },
    sourceRawKeyCounts: {},
    rawKeyOnlyCandidates: 0,
    rawKeyOnlySamples: [],
    sourceShapeSamples: [],
  };
}

function recordSourceCoverage(stageCounters, sourceMeta = {}, sourceHints = {}, sourceOperator = null, sourceType = 'unknown', callsign = '') {
  const summary = summarizeSourceMeta(sourceMeta);
  const rawPreview = summarizeRawSourcePreview(sourceMeta);
  if (hasMeaningfulSourceMeta(sourceMeta)) {
    stageCounters.sourceMetaAttached += 1;
  }
  if ((sourceMeta.rawKeys || []).length > 0 && !hasMeaningfulSourceMeta(sourceMeta)) {
    stageCounters.rawKeyOnlyCandidates += 1;
    if (stageCounters.rawKeyOnlySamples.length < 5) {
      stageCounters.rawKeyOnlySamples.push({
        callsign,
        rawKeys: [...(sourceMeta.rawKeys || [])].slice(0, 20).sort(),
      });
    }
  }
  for (const field of SOURCE_META_FIELDS) {
    if (summary[field]) stageCounters.sourceFieldCoverage[field] += 1;
  }
  if (sourceHints.militaryHint) stageCounters.sourceHintCounts.militaryHint += 1;
  if (sourceHints.militaryOperatorHint) stageCounters.sourceHintCounts.militaryOperatorHint += 1;
  if (sourceHints.commercialHint) stageCounters.sourceHintCounts.commercialHint += 1;
  if (sourceOperator) stageCounters.sourceOperatorCandidateHits += 1;
  if (sourceType !== 'unknown') stageCounters.sourceTypeCandidateHits += 1;
  for (const rawKey of sourceMeta.rawKeys || []) {
    if (!rawKey) continue;
    stageCounters.sourceRawKeyCounts[rawKey] = (stageCounters.sourceRawKeyCounts[rawKey] || 0) + 1;
  }
  if (stageCounters.sourceShapeSamples.length < 5 && ((sourceMeta.rawKeys || []).length > 0 || Object.keys(rawPreview).length > 0)) {
    stageCounters.sourceShapeSamples.push({
      callsign,
      rawKeys: [...(sourceMeta.rawKeys || [])].slice(0, 20).sort(),
      normalized: summary,
      rawPreview,
    });
  }
}

function deriveSourceHints(sourceMeta = {}) {
  const hintText = getSourceHintText(sourceMeta);
  return {
    hintText,
    militaryHint: /(AIR FORCE|AIR ?SELF ?DEFEN[CS]E|MILIT|NAVY|MARINE|ARMY|DEFEN[CS]E|SQUADRON|\bUSAF\b|\bUSN\b|\bUSMC\b|\bRAF\b|\bRCAF\b|\bRAAF\b|NATO|\bPLAAF\b|\bPLAN\b|\bVKS\b|RECON|AWACS|TANKER|AIRLIFT|FIGHTER|BOMBER|DRONE)/.test(hintText),
    militaryOperatorHint: /(AIR FORCE|AIR ?SELF ?DEFEN[CS]E|NAVY|MARINE|ARMY|DEFEN[CS]E|SQUADRON|EMIRI AIR FORCE|ROYAL .* AIR FORCE|AEROSPACE FORCES|\bPLAAF\b|\bPLAN\b|NATO)/.test(hintText),
    commercialHint: /(AIRLINES|AIRWAYS|LOGISTICS|EXPRESS|CARGOLUX|TURKISH AIRLINES|ETHIOPIAN AIRLINES|QATAR AIRWAYS|EMIRATES SKYCARGO|SAUDIA)/.test(hintText),
  };
}

function detectAircraftTypeFromSourceMeta(sourceMeta = {}) {
  const hintText = getSourceHintText(sourceMeta);
  if (!hintText) return 'unknown';
  if (/(KC-?135|KC-?46|KC-?10|A330 MRTT|MRTT|TANKER|REFUEL)/.test(hintText)) return 'tanker';
  if (/(AWACS|AEW&C|AEW|E-2|E-3|E-6|E-7|EARLY WARNING)/.test(hintText)) return 'awacs';
  if (/(C-17|C17|C-130|C130|C-2|C2|C-27|C27|A400M|IL-76|IL76|Y-20|Y20|TRANSPORT|AIRLIFT|CARGO)/.test(hintText)) return 'transport';
  if (/(RC-135|RC135|RECON|SURVEILLANCE|SIGINT|ELINT|ISR|U-2|P-8|P8|P-3|P3|PATROL)/.test(hintText)) return 'reconnaissance';
  if (/(MQ-9|MQ9|RQ-4|RQ4|DRONE|UAS|UAV)/.test(hintText)) return 'drone';
  if (/(B-52|B52|B-1|B1|B-2|B2|BOMBER)/.test(hintText)) return 'bomber';
  if (/(F-16|F16|F-15|F15|F-18|F18|F-22|F22|F-35|F35|J-10|J10|J-11|J11|J-16|J16|SU-27|SU27|SU-30|SU30|SU-35|SU35|MIG-29|MIG29|FIGHTER)/.test(hintText)) return 'fighter';
  return 'unknown';
}

function deriveOperatorFromSourceMeta(sourceMeta = {}) {
  const hintText = getSourceHintText(sourceMeta);
  if (!hintText) return null;
  if (/PEOPLE'?S LIBERATION ARMY AIR FORCE|\bPLAAF\b|CHINESE AIR FORCE/.test(hintText)) return { operator: 'plaaf', operatorCountry: 'China', reason: 'source_operator', confidence: 'high' };
  if (/PEOPLE'?S LIBERATION ARMY NAVY|\bPLAN\b/.test(hintText)) return { operator: 'plan', operatorCountry: 'China', reason: 'source_operator', confidence: 'high' };
  if (/UNITED STATES AIR FORCE|US AIR FORCE|\bUSAF\b/.test(hintText)) return { operator: 'usaf', operatorCountry: 'USA', reason: 'source_operator', confidence: 'high' };
  if (/UNITED STATES NAVY|US NAVY|\bUSN\b/.test(hintText)) return { operator: 'usn', operatorCountry: 'USA', reason: 'source_operator', confidence: 'high' };
  if (/UNITED STATES MARINE CORPS|US MARINE|\bUSMC\b/.test(hintText)) return { operator: 'usmc', operatorCountry: 'USA', reason: 'source_operator', confidence: 'high' };
  if (/UNITED STATES ARMY|US ARMY/.test(hintText)) return { operator: 'usa', operatorCountry: 'USA', reason: 'source_operator', confidence: 'high' };
  if (/ROYAL AIR FORCE|\bRAF\b/.test(hintText)) return { operator: 'raf', operatorCountry: 'UK', reason: 'source_operator', confidence: 'high' };
  if (/ROYAL NAVY/.test(hintText)) return { operator: 'rn', operatorCountry: 'UK', reason: 'source_operator', confidence: 'high' };
  if (/FRENCH AIR FORCE|ARMEE DE L'?AIR|ARMÉE DE L'?AIR|\bFAF\b/.test(hintText)) return { operator: 'faf', operatorCountry: 'France', reason: 'source_operator', confidence: 'high' };
  if (/GERMAN AIR FORCE|LUFTWAFFE|\bGAF\b/.test(hintText)) return { operator: 'gaf', operatorCountry: 'Germany', reason: 'source_operator', confidence: 'high' };
  if (/ISRAELI AIR FORCE|\bIAF\b/.test(hintText)) return { operator: 'iaf', operatorCountry: 'Israel', reason: 'source_operator', confidence: 'high' };
  if (/NATO/.test(hintText)) return { operator: 'nato', operatorCountry: 'NATO', reason: 'source_operator', confidence: 'high' };
  if (/QATAR EMIRI AIR FORCE|\bQEAF\b/.test(hintText)) return { operator: 'qeaf', operatorCountry: 'Qatar', reason: 'source_operator', confidence: 'high' };
  if (/ROYAL SAUDI AIR FORCE|\bRSAF\b/.test(hintText)) return { operator: 'rsaf', operatorCountry: 'Saudi Arabia', reason: 'source_operator', confidence: 'high' };
  if (/TURKISH AIR FORCE|\bTURAF\b|\bTRKAF\b/.test(hintText)) return { operator: 'turaf', operatorCountry: 'Turkey', reason: 'source_operator', confidence: 'high' };
  if (/UNITED ARAB EMIRATES AIR FORCE|UAE AIR FORCE|EMIRATI AIR FORCE/.test(hintText)) return { operator: 'uaeaf', operatorCountry: 'UAE', reason: 'source_operator', confidence: 'high' };
  if (/KUWAIT AIR FORCE/.test(hintText)) return { operator: 'kuwaf', operatorCountry: 'Kuwait', reason: 'source_operator', confidence: 'high' };
  if (/EGYPTIAN AIR FORCE/.test(hintText)) return { operator: 'egyaf', operatorCountry: 'Egypt', reason: 'source_operator', confidence: 'high' };
  if (/PAKISTAN AIR FORCE|\bPAF\b/.test(hintText)) return { operator: 'paf', operatorCountry: 'Pakistan', reason: 'source_operator', confidence: 'high' };
  if (/\bJASDF\b|JAPAN AIR SELF DEFENSE FORCE/.test(hintText)) return { operator: 'jasdf', operatorCountry: 'Japan', reason: 'source_operator', confidence: 'high' };
  if (/\bROKAF\b|REPUBLIC OF KOREA AIR FORCE/.test(hintText)) return { operator: 'rokaf', operatorCountry: 'South Korea', reason: 'source_operator', confidence: 'high' };
  if (/RUSSIAN AEROSPACE FORCES|\bVKS\b/.test(hintText)) return { operator: 'vks', operatorCountry: 'Russia', reason: 'source_operator', confidence: 'high' };
  if (/ROYAL AUSTRALIAN AIR FORCE|\bRAAF\b/.test(hintText)) return { operator: 'raaf', operatorCountry: 'Australia', reason: 'source_operator', confidence: 'high' };
  if (/ROYAL CANADIAN AIR FORCE|\bRCAF\b|CANADIAN ARMED FORCES/.test(hintText)) return { operator: 'rcaf', operatorCountry: 'Canada', reason: 'source_operator', confidence: 'high' };
  return null;
}

function getNearbyHotspot(lat, lon) {
  for (const h of HOTSPOTS) {
    const d = Math.sqrt((lat - h.lat) ** 2 + (lon - h.lon) ** 2);
    if (d <= h.radius) return h;
  }
  return null;
}

// ── HTTP CONNECT Tunnel via Residential Proxy ──────────────
function redactProxy(msg) {
  return String(msg || '').replace(/\/\/[^@]+@/g, '//<redacted>@');
}

function parseProxyAuth() {
  const atIdx = OPENSKY_PROXY_AUTH.lastIndexOf('@');
  if (atIdx === -1) return null;
  const userPass = OPENSKY_PROXY_AUTH.substring(0, atIdx);
  const hostPort = OPENSKY_PROXY_AUTH.substring(atIdx + 1);
  const colonIdx = hostPort.lastIndexOf(':');
  return {
    userPass,
    host: hostPort.substring(0, colonIdx),
    port: parseInt(hostPort.substring(colonIdx + 1), 10),
  };
}

function proxyFetchJson(url, { headers = {}, timeout = 15000, method = 'GET', body = null } = {}) {
  const parsed = new URL(url);
  const proxy = parseProxyAuth();
  if (!proxy) return Promise.reject(new Error('No proxy config'));

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error('PROXY TIMEOUT')); }, timeout + 5000);
    const connectReq = http.request({
      host: proxy.host,
      port: proxy.port,
      method: 'CONNECT',
      path: `${parsed.hostname}:443`,
      headers: {
        'Host': `${parsed.hostname}:443`,
        'Proxy-Authorization': 'Basic ' + Buffer.from(proxy.userPass).toString('base64'),
      },
      timeout,
    });
    connectReq.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        clearTimeout(timer);
        socket.destroy();
        return reject(new Error(`CONNECT ${res.statusCode}`));
      }
      const tlsSocket = tls.connect({ socket, servername: parsed.hostname }, () => {
        const requestHeaders = { ...headers, 'Accept': 'application/json', 'User-Agent': CHROME_UA };
        if (body != null && !Object.keys(requestHeaders).some((k) => k.toLowerCase() === 'content-length')) {
          requestHeaders['Content-Length'] = Buffer.byteLength(body);
        }
        const req = https.request({
          socket: tlsSocket,
          hostname: parsed.hostname,
          path: parsed.pathname + parsed.search,
          method,
          headers: requestHeaders,
          timeout,
        }, (resp) => {
          let data = '';
          resp.on('data', chunk => data += chunk);
          resp.on('end', () => {
            clearTimeout(timer);
            if (resp.statusCode >= 400) {
              return reject(new Error(`HTTP ${resp.statusCode}: ${data.substring(0, 200)}`));
            }
            try { resolve(JSON.parse(data)); }
            catch (e) { reject(new Error(`JSON parse: ${e.message}`)); }
          });
        });
        req.on('error', (e) => { clearTimeout(timer); reject(e); });
        req.on('timeout', () => { req.destroy(); clearTimeout(timer); reject(new Error('TIMEOUT')); });
        if (body != null) req.write(body);
        req.end();
      });
      tlsSocket.on('error', (e) => { clearTimeout(timer); reject(e); });
    });
    connectReq.on('error', (e) => { clearTimeout(timer); reject(new Error(redactProxy(e.message))); });
    connectReq.on('timeout', () => { connectReq.destroy(); clearTimeout(timer); reject(new Error('CONNECT TIMEOUT')); });
    connectReq.end();
  });
}

// ── Data Sources ───────────────────────────────────────────
const OPENSKY_BASE = 'https://opensky-network.org/api';
const WINGBITS_BASE = 'https://customer-api.wingbits.com/v1/flights';
const OPENSKY_TOKEN_URL = 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';
const OPENSKY_AUTH_COOLDOWN_MS = 60_000;
const OPENSKY_AUTH_RETRY_DELAYS = [0, 2_000, 5_000];
let openskyToken = null;
let openskyTokenExpiry = 0;
let openskyTokenPromise = null;
let openskyAuthCooldownUntil = 0;

function clearOpenSkyToken() {
  openskyToken = null;
  openskyTokenExpiry = 0;
}

function isOpenSkyUnauthorizedError(error) {
  return /HTTP 401\b/i.test(String(error?.message || error || ''));
}

function getOpenSkyAuthStatus() {
  if (!process.env.OPENSKY_CLIENT_ID || !process.env.OPENSKY_CLIENT_SECRET) return 'not_configured';
  if (Date.now() < openskyAuthCooldownUntil) return 'cooldown';
  return 'pending';
}

async function fetchJsonDirect(url, { headers = {}, method = 'GET', body = null, timeout = 15_000 } = {}) {
  const resp = await fetch(url, {
    method,
    headers: { ...headers, 'User-Agent': CHROME_UA, Accept: 'application/json' },
    body,
    signal: AbortSignal.timeout(timeout),
  });
  if (!resp.ok) {
    const bodyText = await resp.text().catch(() => '');
    throw new Error(`HTTP ${resp.status}: ${bodyText.substring(0, 200)}`);
  }
  return resp.json();
}

async function getOpenSkyToken() {
  const clientId = process.env.OPENSKY_CLIENT_ID;
  const clientSecret = process.env.OPENSKY_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  if (openskyToken && Date.now() < openskyTokenExpiry - 60_000) {
    return openskyToken;
  }
  if (Date.now() < openskyAuthCooldownUntil) {
    return null;
  }
  if (openskyTokenPromise) return openskyTokenPromise;

  openskyTokenPromise = (async () => {
    let lastError = null;

    for (let attempt = 0; attempt < OPENSKY_AUTH_RETRY_DELAYS.length; attempt += 1) {
      const delay = OPENSKY_AUTH_RETRY_DELAYS[attempt];
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }

      const postData = `grant_type=client_credentials&client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}`;
      const headers = {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': CHROME_UA,
      };

      try {
        let data;
        try {
          data = await fetchJsonDirect(OPENSKY_TOKEN_URL, {
            method: 'POST',
            headers,
            body: postData,
          });
        } catch (directError) {
          if (!PROXY_ENABLED) throw directError;
          try {
            data = await proxyFetchJson(OPENSKY_TOKEN_URL, {
              method: 'POST',
              headers,
              body: postData,
              timeout: 15_000,
            });
          } catch (proxyError) {
            throw new Error(`direct=${redactProxy(directError.message)} | proxy=${redactProxy(proxyError.message)}`);
          }
        }

        if (!data?.access_token) {
          throw new Error('OpenSky token response missing access_token');
        }
        openskyToken = data.access_token;
        openskyTokenExpiry = Date.now() + (Number(data.expires_in) || 1800) * 1000;
        openskyAuthCooldownUntil = 0;
        return openskyToken;
      } catch (error) {
        lastError = error;
      }
    }

    clearOpenSkyToken();
    openskyAuthCooldownUntil = Date.now() + OPENSKY_AUTH_COOLDOWN_MS;
    throw lastError || new Error('OpenSky token acquisition failed');
  })();

  try {
    return await openskyTokenPromise;
  } finally {
    openskyTokenPromise = null;
  }
}

async function fetchOpenSkyAuthenticated(region) {
  const params = `lamin=${region.lamin}&lamax=${region.lamax}&lomin=${region.lomin}&lomax=${region.lomax}&extended=1`;
  const url = `${OPENSKY_BASE}/states/all?${params}`;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = await getOpenSkyToken();
    if (!token) return { states: null, status: getOpenSkyAuthStatus() };
    const headers = { Authorization: `Bearer ${token}` };

    try {
      let data;
      try {
        data = await fetchJsonDirect(url, { headers });
        return { states: data.states || [], status: `success:direct` };
      } catch (directError) {
        if (isOpenSkyUnauthorizedError(directError)) {
          clearOpenSkyToken();
          if (attempt === 0) continue;
        }
        if (!PROXY_ENABLED) throw directError;
        try {
          data = await proxyFetchJson(url, { headers });
          return { states: data.states || [], status: `success:proxy` };
        } catch (proxyError) {
          if (isOpenSkyUnauthorizedError(proxyError)) {
            clearOpenSkyToken();
            if (attempt === 0) continue;
          }
          throw new Error(`direct=${redactProxy(directError.message)} | proxy=${redactProxy(proxyError.message)}`);
        }
      }
    } catch (error) {
      return { states: null, status: `error:${redactProxy(error.message)}` };
    }
  }

  return { states: null, status: getOpenSkyAuthStatus() };
}

async function fetchOpenSkyAnonymous(region) {
  const params = `lamin=${region.lamin}&lamax=${region.lamax}&lomin=${region.lomin}&lomax=${region.lomax}`;
  const url = `${OPENSKY_BASE}/states/all?${params}`;

  try {
    const data = await fetchJsonDirect(url);
    return { states: data.states || [], status: 'success:direct' };
  } catch (directError) {
    if (!PROXY_ENABLED) {
      throw new Error(`error:${redactProxy(directError.message)}`);
    }
    try {
      const data = await proxyFetchJson(url);
      return { states: data.states || [], status: 'success:proxy' };
    } catch (proxyError) {
      throw new Error(`error:direct=${redactProxy(directError.message)} | proxy=${redactProxy(proxyError.message)}`);
    }
  }
}

async function fetchOpenSkyRegion(region, { source, fetchSources, seenIds, allStates }) {
  let states = null;
  const regionSource = {
    name: region.name,
    authStatus: getOpenSkyAuthStatus(),
    anonStatus: 'not_needed',
    statesSeen: 0,
    statesAdded: 0,
  };

  try {
    const authResult = await fetchOpenSkyAuthenticated(region);
    states = authResult?.states || null;
    regionSource.authStatus = authResult?.status || regionSource.authStatus;
    if (states && states.length > 0) {
      if (source.value === 'none') source.value = 'opensky-auth';
      fetchSources.openSkyAuthSuccess = true;
      regionSource.statesSeen = states.length;
      console.log(`  [OpenSky Auth] ${region.name}: ${states.length} states`);
    } else if (regionSource.authStatus.startsWith('success:')) {
      fetchSources.openSkyAuthSuccess = true;
      regionSource.authStatus = regionSource.authStatus.replace('success:', 'empty:');
    }
  } catch (e) {
    regionSource.authStatus = `error:${redactProxy(e.message)}`;
    console.warn(`  [OpenSky Auth] ${region.name}: ${redactProxy(e.message)}`);
  }

  if (!states || states.length === 0) {
    try {
      const anonResult = await fetchOpenSkyAnonymous(region);
      states = anonResult?.states || null;
      regionSource.anonStatus = anonResult?.status || regionSource.anonStatus;
      if (states && states.length > 0) {
        if (source.value === 'none') source.value = 'opensky-anon';
        fetchSources.openSkyAnonFallbackUsed = true;
        regionSource.statesSeen = states.length;
        console.log(`  [OpenSky Anon] ${region.name}: ${states.length} states`);
      } else if (regionSource.anonStatus.startsWith('success:')) {
        regionSource.anonStatus = regionSource.anonStatus.replace('success:', 'empty:');
      }
    } catch (e) {
      regionSource.anonStatus = `error:${redactProxy(e.message)}`;
      console.warn(`  [OpenSky Anon] ${region.name}: ${redactProxy(e.message)}`);
    }
  }

  if (states) {
    let added = 0;
    for (const state of states) {
      const icao24 = state[0];
      if (seenIds.has(icao24)) continue;
      seenIds.add(icao24);
      allStates.push(state);
      added++;
    }
    regionSource.statesAdded = added;
    if (added > 0) console.log(`  [OpenSky] +${added} new from ${region.name} (total: ${allStates.length})`);
  }

  fetchSources.regions.push(regionSource);
}

async function fetchWingbits() {
  const apiKey = process.env.WINGBITS_API_KEY;
  if (!apiKey) {
    console.log('  [Wingbits] No WINGBITS_API_KEY — skipped');
    return [];
  }

  const areas = QUERY_REGIONS.map((r) => ({
    alias: r.name,
    by: 'box',
    la: (r.lamax + r.lamin) / 2,
    lo: (r.lomax + r.lomin) / 2,
    w: Math.abs(r.lomax - r.lomin) * 60,
    h: Math.abs(r.lamax - r.lamin) * 60,
    unit: 'nm',
  }));

  console.log(`  [Wingbits] POST ${WINGBITS_BASE} with ${areas.length} areas: ${areas.map(a => `${a.alias}(${a.w}x${a.h}nm)`).join(', ')}`);

  const resp = await fetch(WINGBITS_BASE, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': CHROME_UA },
    body: JSON.stringify(areas),
    signal: AbortSignal.timeout(20_000),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Wingbits HTTP ${resp.status}: ${body.substring(0, 200)}`);
  }
  const data = await resp.json();

  if (!Array.isArray(data)) {
    console.warn(`  [Wingbits] Unexpected response shape: ${typeof data}, keys: ${Object.keys(data || {}).join(',')}`);
    return [];
  }
  console.log(`  [Wingbits] Response: ${data.length} area results`);
  for (let i = 0; i < data.length; i++) {
    const ar = data[i];
    const flightList = Array.isArray(ar.data) ? ar.data : Array.isArray(ar.flights) ? ar.flights : Array.isArray(ar) ? ar : [];
    console.log(`  [Wingbits]   area[${i}] ${ar.alias || areas[i]?.alias || '?'}: ${flightList.length} flights, keys: ${Object.keys(ar || {}).join(',')}`);
    if (flightList.length > 0) {
      console.log(`  [Wingbits]     sample[0]: ${JSON.stringify(flightList[0]).substring(0, 200)}`);
    }
  }

  const states = [];
  const seenIds = new Set();
  for (const areaResult of data) {
    const flightList = Array.isArray(areaResult.data) ? areaResult.data
      : Array.isArray(areaResult.flights) ? areaResult.flights
      : Array.isArray(areaResult) ? areaResult : [];
    for (const f of flightList) {
      const icao24 = f.h || f.icao24 || f.id;
      if (!icao24 || seenIds.has(icao24)) continue;
      seenIds.add(icao24);
      const callsign = (f.f || f.callsign || f.flight || '').trim();
      const raMs = f.ra ? new Date(f.ra).getTime() : (f.ts || Date.now());
      states.push([
        icao24,
        callsign,
        f.co || f.originCountry || '',
        null,
        raMs / 1000,
        f.lo || f.longitude || f.lon || f.lng,
        f.la || f.latitude || f.lat,
        (f.ab || f.altitude || f.alt || 0) * 0.3048,
        f.og ?? f.gr ?? f.onGround ?? false,
        (f.gs || f.groundSpeed || f.speed || 0) * 0.514444,
        f.th || f.heading || f.track || 0,
        (f.vr || f.verticalRate || 0) * 0.00508,
        null,
        null,
        f.sq || f.squawk || null,
        buildWingbitsSourceMeta(f),
      ]);
    }
  }
  return states;
}

// ── Fetch All States (Wingbits first, OpenSky supplements) ─
async function fetchAllStates() {
  const seenIds = new Set();
  const allStates = [];
  const source = { value: 'none' };
  const oauthConfigured = Boolean(process.env.OPENSKY_CLIENT_ID && process.env.OPENSKY_CLIENT_SECRET);
  const fetchSources = {
    wingbitsUsed: false,
    oauthConfigured,
    proxyEnabled: PROXY_ENABLED,
    openSkyAuthSuccess: false,
    openSkyAnonFallbackUsed: false,
    regions: [],
  };

  // Tier 1: Wingbits — no proxy needed, fast, reliable
  try {
    const wbStates = await fetchWingbits();
    for (const state of wbStates) {
      const icao24 = state[0];
      if (seenIds.has(icao24)) continue;
      seenIds.add(icao24);
      allStates.push(state);
    }
    if (wbStates.length > 0) {
      source.value = 'wingbits';
      fetchSources.wingbitsUsed = true;
      console.log(`  [Wingbits] ${wbStates.length} unique aircraft loaded`);
    }
  } catch (e) {
    console.warn(`  [Wingbits] ${e.message}`);
  }

  for (const region of QUERY_REGIONS) {
    await fetchOpenSkyRegion(region, { source, fetchSources, seenIds, allStates });
  }

  return { allStates, source: source.value, fetchSources };
}

// ── Filter & Build Military Flights ────────────────────────
function summarizeClassificationAudit(rawStates, flights, rejected, stageCounters) {
  const admittedByReason = {};
  const rejectedByReason = {};
  let typedByCallsign = 0;
  let typedBySource = 0;
  let hexOnly = 0;
  let unknownType = 0;
  let operatorOther = 0;
  let sourceOperatorInferred = 0;
  let typedFlights = 0;
  let operatorResolved = 0;
  let highConfidenceFlights = 0;

  for (const flight of flights) {
    admittedByReason[flight.admissionReason] = (admittedByReason[flight.admissionReason] || 0) + 1;
    if (flight.aircraftTypeInferenceReason === 'callsign_pattern' || flight.classificationReason === 'callsign_pattern') typedByCallsign += 1;
    if (flight.aircraftTypeInferenceReason === 'source_metadata' || flight.operatorInferenceReason === 'source_metadata' || flight.classificationReason === 'source_metadata') typedBySource += 1;
    if (flight.operatorInferenceReason === 'source_metadata') sourceOperatorInferred += 1;
    if (flight.admissionReason.startsWith('hex_')) hexOnly += 1;
    if (flight.aircraftType === 'unknown') unknownType += 1;
    else typedFlights += 1;
    if (flight.operator === 'other') operatorOther += 1;
    else operatorResolved += 1;
    if (flight.confidence === 'high') highConfidenceFlights += 1;
  }

  for (const row of rejected) {
    rejectedByReason[row.reason] = (rejectedByReason[row.reason] || 0) + 1;
  }

  return {
    rawStates,
    acceptedFlights: flights.length,
    rejectedFlights: rejected.length,
    admittedByReason,
    rejectedByReason,
    typedByCallsign,
    typedBySource,
    sourceOperatorInferred,
    hexOnlyAdmissions: hexOnly,
    operatorOtherRate: flights.length ? Number((operatorOther / flights.length).toFixed(3)) : 0,
    unknownTypeRate: flights.length ? Number((unknownType / flights.length).toFixed(3)) : 0,
    stageWaterfall: {
      rawStates,
      positionEligible: stageCounters.positionEligible,
      sourceMetaAttached: stageCounters.sourceMetaAttached,
      callsignPresent: stageCounters.callsignPresent,
      callsignMatched: stageCounters.callsignMatched,
      hexMatched: stageCounters.hexMatched,
      candidateStates: stageCounters.candidateStates,
      admittedFlights: flights.length,
      typedFlights,
      operatorResolved,
      highConfidenceFlights,
    },
    sourceCoverage: {
      ...Object.fromEntries(
        Object.entries(stageCounters.sourceFieldCoverage).map(([field, count]) => [`${field}Present`, count]),
      ),
      militaryHint: stageCounters.sourceHintCounts.militaryHint,
      militaryOperatorHint: stageCounters.sourceHintCounts.militaryOperatorHint,
      commercialHint: stageCounters.sourceHintCounts.commercialHint,
      sourceOperatorCandidateHits: stageCounters.sourceOperatorCandidateHits,
      sourceTypeCandidateHits: stageCounters.sourceTypeCandidateHits,
      rawKeyOnlyCandidates: stageCounters.rawKeyOnlyCandidates,
      topRawKeys: Object.entries(stageCounters.sourceRawKeyCounts)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 10)
        .map(([key, count]) => ({ key, count })),
      rawKeyOnlySamples: stageCounters.rawKeyOnlySamples,
      sourceShapeSamples: stageCounters.sourceShapeSamples,
    },
    samples: {
      accepted: flights.slice(0, 8).map((flight) => ({
        callsign: flight.callsign,
        operator: flight.operator,
        operatorCountry: flight.operatorCountry,
        aircraftType: flight.aircraftType,
        confidence: flight.confidence,
        admissionReason: flight.admissionReason,
        classificationReason: flight.classificationReason,
        operatorInferenceReason: flight.operatorInferenceReason,
        aircraftTypeInferenceReason: flight.aircraftTypeInferenceReason,
        sourceMeta: summarizeSourceMeta(flight.sourceMeta),
      })),
      rejected: rejected.slice(0, 8),
    },
  };
}

function pushRejectedFlight(rejected, state, reason, extra = {}) {
  rejected.push({
    callsign: (state[1] || '').trim(),
    hexCode: String(state[0] || '').toUpperCase(),
    reason,
    ...extra,
  });
}

function classifyCallsignMatchedFlight({ csMatch, hexMatch, callsign, sourceMeta }) {
  const sourceOperator = deriveOperatorFromSourceMeta(sourceMeta);
  const operator = (csMatch.operator === 'other' && sourceOperator?.operator) ? sourceOperator.operator : csMatch.operator;
  const operatorCountry = (csMatch.operator === 'other' && sourceOperator?.operatorCountry)
    ? sourceOperator.operatorCountry
    : (OPERATOR_COUNTRY[csMatch.operator] || 'Unknown');
  let aircraftType = csMatch.aircraftType || detectAircraftType(callsign);
  let classificationReason = csMatch.aircraftType ? 'callsign_pattern' : 'untyped';
  let aircraftTypeInferenceReason = csMatch.aircraftType ? 'callsign_pattern' : 'untyped';
  const operatorInferenceReason = operator !== csMatch.operator ? 'source_metadata' : 'callsign_pattern';
  if (aircraftType === 'unknown') {
    const sourceType = detectAircraftTypeFromSourceMeta(sourceMeta);
    if (sourceType !== 'unknown') {
      aircraftType = sourceType;
      classificationReason = 'source_metadata';
      aircraftTypeInferenceReason = 'source_metadata';
    }
  } else if (!csMatch.aircraftType) {
    classificationReason = 'callsign_pattern';
    aircraftTypeInferenceReason = 'callsign_pattern';
  }

  return {
    operator,
    operatorCountry,
    aircraftType,
    confidence: hexMatch ? 'high' : 'medium',
    admissionReason: hexMatch ? 'callsign_plus_hex' : 'callsign_pattern',
    classificationReason,
    aircraftTypeInferenceReason,
    operatorInferenceReason,
  };
}

function classifyHexMatchedFlight({ state, hexMatch, callsign, sourceMeta, sourceHints, rejected }) {
  const trustedHex = TRUSTED_HEX_OPERATORS.has(hexMatch.operator);
  if (!trustedHex && (!sourceHints.militaryHint || (sourceHints.commercialHint && !sourceHints.militaryOperatorHint))) {
    pushRejectedFlight(rejected, state, 'ambiguous_hex_without_support', {
      operatorCountry: hexMatch.country,
    });
    return null;
  }

  const sourceOperator = deriveOperatorFromSourceMeta(sourceMeta);
  let aircraftType = detectAircraftType(callsign);
  let classificationReason = sourceOperator ? 'source_metadata' : 'untyped';
  let aircraftTypeInferenceReason = 'untyped';
  if (aircraftType === 'unknown') {
    const sourceType = detectAircraftTypeFromSourceMeta(sourceMeta);
    if (sourceType !== 'unknown') {
      aircraftType = sourceType;
      classificationReason = 'source_metadata';
      aircraftTypeInferenceReason = 'source_metadata';
    }
  } else if (!sourceOperator) {
    classificationReason = 'callsign_heuristic';
    aircraftTypeInferenceReason = 'callsign_heuristic';
  } else {
    aircraftTypeInferenceReason = 'callsign_heuristic';
  }

  return {
    operator: sourceOperator?.operator || hexMatch.operator,
    operatorCountry: sourceOperator?.operatorCountry || hexMatch.country,
    aircraftType,
    confidence: trustedHex ? 'medium' : 'low',
    admissionReason: trustedHex ? 'hex_trusted' : 'hex_supported_by_source',
    classificationReason,
    aircraftTypeInferenceReason,
    operatorInferenceReason: sourceOperator ? 'source_metadata' : 'hex_range',
  };
}

function buildMilitaryFlightRecord(state, classified, sourceHints) {
  const icao24 = state[0];
  const callsign = (state[1] || '').trim();
  const lat = state[6];
  const lon = state[5];
  const baroAlt = state[7];
  const velocity = state[9];
  const track = state[10];
  const vertRate = state[11];
  const hotspot = getNearbyHotspot(lat, lon);
  const isInteresting = (hotspot && hotspot.priority === 'high') ||
    classified.aircraftType === 'bomber' || classified.aircraftType === 'reconnaissance' || classified.aircraftType === 'awacs';

  return {
    id: `opensky-${icao24}`,
    callsign: callsign || `UNKN-${icao24.substring(0, 4).toUpperCase()}`,
    hexCode: icao24.toUpperCase(),
    lat,
    lon,
    altitude: baroAlt != null ? Math.round(baroAlt * 3.28084) : 0,
    heading: track != null ? track : 0,
    speed: velocity != null ? Math.round(velocity * 1.94384) : 0,
    verticalRate: vertRate != null ? Math.round(vertRate * 196.85) : undefined,
    onGround: state[8],
    squawk: state[14] || undefined,
    ...classified,
    sourceMeta: summarizeSourceMeta(state[15] || {}),
    sourceHints: {
      militaryHint: sourceHints.militaryHint,
      militaryOperatorHint: sourceHints.militaryOperatorHint,
      commercialHint: sourceHints.commercialHint,
    },
    isInteresting: isInteresting || false,
    note: hotspot ? `Near ${hotspot.name}` : undefined,
    lastSeenMs: state[4] ? state[4] * 1000 : Date.now(),
  };
}

function filterMilitaryFlights(allStates) {
  const flights = [];
  const byType = {};
  const rejected = [];
  const stageCounters = createClassificationStageCounters();

  for (const state of allStates) {
    const icao24 = state[0];
    const callsign = (state[1] || '').trim();
    const lat = state[6];
    const lon = state[5];
    if (lat == null || lon == null) continue;
    stageCounters.positionEligible += 1;

    const originCountry = state[2] || '';
    const sourceMeta = state[15] || {};
    const sourceHints = deriveSourceHints(sourceMeta);
    const sourceOperator = deriveOperatorFromSourceMeta(sourceMeta);
    const sourceType = detectAircraftTypeFromSourceMeta(sourceMeta);
    recordSourceCoverage(stageCounters, sourceMeta, sourceHints, sourceOperator, sourceType, callsign);
    if (callsign) stageCounters.callsignPresent += 1;
    const csMatch = callsign ? identifyByCallsign(callsign, originCountry) : null;
    const commercialMatch = callsign ? identifyCommercialCallsign(callsign) : null;
    const hexMatch = isKnownHex(icao24);
    if (csMatch) stageCounters.callsignMatched += 1;
    if (hexMatch) stageCounters.hexMatched += 1;
    if (csMatch || hexMatch) stageCounters.candidateStates += 1;

    if (!csMatch && commercialMatch && !sourceHints.militaryHint) {
      pushRejectedFlight(rejected, state, 'commercial_callsign_override');
      continue;
    }

    if (!csMatch && !hexMatch) {
      pushRejectedFlight(rejected, state, 'no_military_signal');
      continue;
    }

    const classified = csMatch
      ? classifyCallsignMatchedFlight({ csMatch, hexMatch, callsign, sourceMeta })
      : classifyHexMatchedFlight({ state, hexMatch, callsign, sourceMeta, sourceHints, rejected });
    if (!classified) continue;

    const flight = buildMilitaryFlightRecord(state, {
      ...classified,
      callsignMatch: csMatch?.operator || '',
      hexMatch: hexMatch?.operator || '',
    }, sourceHints);
    flights.push(flight);
    byType[flight.aircraftType] = (byType[flight.aircraftType] || 0) + 1;
  }

  return {
    flights,
    byType,
    audit: summarizeClassificationAudit(allStates.length, flights, rejected, stageCounters),
  };
}

// ── Theater Posture Calculation ────────────────────────────
function calculateTheaterPostures(flights) {
  return POSTURE_THEATERS.map((theater) => {
    const tf = flights.filter(
      (f) => f.lat >= theater.bounds.south && f.lat <= theater.bounds.north &&
        f.lon >= theater.bounds.west && f.lon <= theater.bounds.east,
    );
    const total = tf.length;
    const tankers = tf.filter((f) => f.aircraftType === 'tanker').length;
    const awacs = tf.filter((f) => f.aircraftType === 'awacs').length;
    const fighters = tf.filter((f) => f.aircraftType === 'fighter').length;
    const postureLevel = total >= theater.thresholds.critical ? 'critical'
      : total >= theater.thresholds.elevated ? 'elevated' : 'normal';
    const strikeCapable = tankers >= theater.strikeIndicators.minTankers &&
      awacs >= theater.strikeIndicators.minAwacs && fighters >= theater.strikeIndicators.minFighters;
    const ops = [];
    if (strikeCapable) ops.push('strike_capable');
    if (tankers > 0) ops.push('aerial_refueling');
    if (awacs > 0) ops.push('airborne_early_warning');
    return {
      theater: theater.id, postureLevel, activeFlights: total,
      trackedVessels: 0, activeOperations: ops, assessedAt: Date.now(),
    };
  });
}

// ── Redis Write ────────────────────────────────────────────
async function redisSet(url, token, key, value, ttl) {
  const payload = JSON.stringify(value);
  const cmd = ttl ? ['SET', key, payload, 'EX', ttl] : ['SET', key, payload];
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) throw new Error(`Redis SET ${key} failed: HTTP ${resp.status}`);
}

async function redisGet(url, token, key) {
  const resp = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  if (!data?.result) return null;
  try { return JSON.parse(data.result); } catch { return null; }
}

async function triggerForecastSeedIfEnabled() {
  if (!CHAIN_FORECAST_SEED) return;

  const scriptPath = fileURLToPath(new URL('./seed-forecasts.mjs', import.meta.url));
  console.log('  Triggering forecast reseed after military publish...');

  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      stdio: 'inherit',
      env: process.env,
    });

    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`forecast reseed exited with code ${code}`));
    });
  });
}

// ── Main ───────────────────────────────────────────────────
async function main() {
  const startMs = Date.now();
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const { url, token } = getRedisCredentials();
  let lockReleased = false;

  console.log(`=== military:flights Seed (proxy: ${PROXY_ENABLED ? 'enabled' : 'direct'}) ===`);

  const lockResult = await acquireLockSafely('military:flights', runId, 120_000, { label: 'military:flights' });
  if (lockResult.skipped) {
    process.exit(0);
  }
  if (!lockResult.locked) {
    console.log('  SKIPPED: another seed run in progress');
    process.exit(0);
  }

  let allStates, source, flights, byType, classificationAudit, fetchSources;
  try {
    console.log('  Fetching from all sources...');
    ({ allStates, source, fetchSources } = await fetchAllStates());
    console.log(`  Raw states: ${allStates.length} (source: ${source})`);

    ({ flights, byType, audit: classificationAudit } = filterMilitaryFlights(allStates));
    classificationAudit.fetchSources = fetchSources;
    console.log(`  Military: ${flights.length} (${Object.entries(byType).map(([t, n]) => `${t}:${n}`).join(', ')})`);
    if (classificationAudit) {
      console.log(`  [Audit] unknownRate=${classificationAudit.unknownTypeRate} hexOnly=${classificationAudit.hexOnlyAdmissions} rejected=${classificationAudit.rejectedFlights}`);
      console.log(
        `  [Source] wingbits=${fetchSources.wingbitsUsed ? 'yes' : 'no'} oauthConfigured=${fetchSources.oauthConfigured ? 'yes' : 'no'} authSuccess=${fetchSources.openSkyAuthSuccess ? 'yes' : 'no'} anonFallback=${fetchSources.openSkyAnonFallbackUsed ? 'yes' : 'no'}`,
      );
      console.log(
        `  [Source] regions=${fetchSources.regions.map((region) => `${region.name}:auth=${region.authStatus},anon=${region.anonStatus},seen=${region.statesSeen},added=${region.statesAdded}`).join(' | ')}`,
      );
      console.log(
        `  [Audit] waterfall raw=${classificationAudit.stageWaterfall.rawStates} pos=${classificationAudit.stageWaterfall.positionEligible} candidate=${classificationAudit.stageWaterfall.candidateStates} admitted=${classificationAudit.stageWaterfall.admittedFlights} typed=${classificationAudit.stageWaterfall.typedFlights}`,
      );
      console.log(
        `  [Audit] source attached=${classificationAudit.stageWaterfall.sourceMetaAttached} operatorHits=${classificationAudit.sourceCoverage.sourceOperatorCandidateHits} typeHits=${classificationAudit.sourceCoverage.sourceTypeCandidateHits} topKeys=${classificationAudit.sourceCoverage.topRawKeys.map((item) => `${item.key}:${item.count}`).join(',') || 'none'}`,
      );
      console.log(
        `  [Audit] rawKeyOnly=${classificationAudit.sourceCoverage.rawKeyOnlyCandidates} samples=${classificationAudit.sourceCoverage.rawKeyOnlySamples.length} sourceShapeSamples=${classificationAudit.sourceCoverage.sourceShapeSamples.length}`,
      );
    }
  } catch (err) {
    await releaseLock('military:flights', runId);
    console.error(`  FETCH FAILED: ${err.message || err}`);
    await extendExistingTtl([LIVE_KEY, 'seed-meta:military:flights'], LIVE_TTL);
    await extendExistingTtl([STALE_KEY, THEATER_POSTURE_STALE_KEY, MILITARY_SURGES_STALE_KEY, MILITARY_FORECAST_INPUTS_STALE_KEY, MILITARY_CLASSIFICATION_AUDIT_STALE_KEY], STALE_TTL);
    await extendExistingTtl([THEATER_POSTURE_LIVE_KEY, MILITARY_FORECAST_INPUTS_LIVE_KEY, MILITARY_CLASSIFICATION_AUDIT_LIVE_KEY], THEATER_POSTURE_LIVE_TTL);
    await extendExistingTtl([THEATER_POSTURE_BACKUP_KEY], THEATER_POSTURE_BACKUP_TTL);
    await extendExistingTtl([MILITARY_SURGES_LIVE_KEY], MILITARY_SURGES_LIVE_TTL);
    console.log(`\n=== Failed gracefully (${Math.round(Date.now() - startMs)}ms) ===`);
    process.exit(0);
  }

  if (flights.length === 0) {
    console.log('  SKIPPED: 0 military flights — extending existing TTLs');
    await extendExistingTtl([LIVE_KEY, 'seed-meta:military:flights'], LIVE_TTL);
    await extendExistingTtl([STALE_KEY, THEATER_POSTURE_STALE_KEY, MILITARY_SURGES_STALE_KEY, MILITARY_FORECAST_INPUTS_STALE_KEY, MILITARY_CLASSIFICATION_AUDIT_STALE_KEY], STALE_TTL);
    await extendExistingTtl([THEATER_POSTURE_LIVE_KEY, MILITARY_FORECAST_INPUTS_LIVE_KEY, MILITARY_CLASSIFICATION_AUDIT_LIVE_KEY], THEATER_POSTURE_LIVE_TTL);
    await extendExistingTtl([THEATER_POSTURE_BACKUP_KEY], THEATER_POSTURE_BACKUP_TTL);
    await extendExistingTtl([MILITARY_SURGES_LIVE_KEY], MILITARY_SURGES_LIVE_TTL);
    await extendExistingTtl(['seed-meta:theater-posture', 'seed-meta:military-forecast-inputs', 'seed-meta:military-surges'], STALE_TTL);
    await releaseLock('military:flights', runId);
    lockReleased = true;
    process.exit(0);
  }

  try {
    const assessedAt = Date.now();
    const payload = { flights, fetchedAt: assessedAt, stats: { total: flights.length, byType }, classificationAudit };

    await redisSet(url, token, LIVE_KEY, payload, LIVE_TTL);
    await redisSet(url, token, STALE_KEY, payload, STALE_TTL);
    await redisSet(url, token, MILITARY_CLASSIFICATION_AUDIT_LIVE_KEY, { fetchedAt: assessedAt, sourceVersion: source || '', ...classificationAudit }, MILITARY_CLASSIFICATION_AUDIT_LIVE_TTL);
    await redisSet(url, token, MILITARY_CLASSIFICATION_AUDIT_STALE_KEY, { fetchedAt: assessedAt, sourceVersion: source || '', ...classificationAudit }, MILITARY_CLASSIFICATION_AUDIT_STALE_TTL);
    console.log(`  ${LIVE_KEY}: written`);
    console.log(`  ${STALE_KEY}: written`);
    console.log(`  ${MILITARY_CLASSIFICATION_AUDIT_LIVE_KEY}: written`);

    await writeFreshnessMetadata('military', 'flights', flights.length, source);

    const verified = await verifySeedKey(LIVE_KEY);
    console.log(`  Verified: ${verified ? 'yes' : 'NO'}`);

    const theaterFlights = flights.map((f) => ({
      id: f.hexCode || f.id,
      callsign: f.callsign,
      lat: f.lat, lon: f.lon,
      altitude: f.altitude || 0, heading: f.heading || 0, speed: f.speed || 0,
      aircraftType: f.aircraftType || detectAircraftType(f.callsign),
    }));
    const theaters = calculateTheaterPostures(theaterFlights).map((theater) => ({
      ...theater,
      assessedAt,
    }));
    const posturePayload = { theaters };
    await redisSet(url, token, THEATER_POSTURE_LIVE_KEY, posturePayload, THEATER_POSTURE_LIVE_TTL);
    await redisSet(url, token, THEATER_POSTURE_STALE_KEY, posturePayload, THEATER_POSTURE_STALE_TTL);
    await redisSet(url, token, THEATER_POSTURE_BACKUP_KEY, posturePayload, THEATER_POSTURE_BACKUP_TTL);
    await redisSet(url, token, 'seed-meta:theater-posture', { fetchedAt: assessedAt, recordCount: theaterFlights.length, sourceVersion: source || '' }, 604800);
    const elevated = theaters.filter((t) => t.postureLevel !== 'normal').length;
    console.log(`  Theater posture: ${theaters.length} theaters (${elevated} elevated)`);

    const priorSurgeHistory = ((await redisGet(url, token, MILITARY_SURGES_HISTORY_KEY))?.history || []);
    const theaterActivity = summarizeMilitaryTheaters(flights, POSTURE_THEATERS, assessedAt);
    const surges = buildMilitarySurges(theaterActivity, priorSurgeHistory, { sourceVersion: source || '' });
    const surgePayload = {
      surges,
      theaters: theaterActivity,
      fetchedAt: assessedAt,
      sourceVersion: source || '',
    };
    const forecastInputsPayload = {
      fetchedAt: assessedAt,
      sourceVersion: source || '',
      theaters,
      theaterActivity,
      surges,
      stats: {
        totalFlights: flights.length,
        elevatedTheaters: elevated,
      },
      classificationAudit,
    };
    const surgeHistory = appendMilitaryHistory(priorSurgeHistory, {
      assessedAt,
      sourceVersion: source || '',
      theaters: theaterActivity,
    }, MILITARY_SURGES_HISTORY_MAX);
    await redisSet(url, token, MILITARY_FORECAST_INPUTS_LIVE_KEY, forecastInputsPayload, MILITARY_FORECAST_INPUTS_LIVE_TTL);
    await redisSet(url, token, MILITARY_FORECAST_INPUTS_STALE_KEY, forecastInputsPayload, MILITARY_FORECAST_INPUTS_STALE_TTL);
    await redisSet(url, token, MILITARY_SURGES_LIVE_KEY, surgePayload, MILITARY_SURGES_LIVE_TTL);
    await redisSet(url, token, MILITARY_SURGES_STALE_KEY, surgePayload, MILITARY_SURGES_STALE_TTL);
    await redisSet(url, token, MILITARY_SURGES_HISTORY_KEY, { history: surgeHistory }, MILITARY_SURGES_HISTORY_TTL);
    await redisSet(url, token, 'seed-meta:military-surges', {
      fetchedAt: assessedAt,
      recordCount: surges.length,
      sourceVersion: source || '',
    }, 604800);
    await redisSet(url, token, 'seed-meta:military-forecast-inputs', {
      fetchedAt: assessedAt,
      recordCount: theaters.length,
      sourceVersion: source || '',
    }, 604800);
    console.log(`  Military surges: ${surges.length} detected (history: ${surgeHistory.length} runs)`);
    await releaseLock('military:flights', runId);
    lockReleased = true;
    try {
      await triggerForecastSeedIfEnabled();
    } catch (err) {
      console.warn(`  Forecast reseed failed after military publish: ${err.message || err}`);
    }

    const durationMs = Date.now() - startMs;
    logSeedResult('military', flights.length, durationMs);
    console.log(`\n=== Done (${Math.round(durationMs)}ms) ===`);
  } finally {
    if (!lockReleased) await releaseLock('military:flights', runId);
  }
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main().catch((err) => {
    console.error(`PUBLISH FAILED: ${err.message || err}`);
    process.exit(1);
  });
}

export {
  isKnownHex,
  identifyByCallsign,
  identifyCommercialCallsign,
  detectAircraftType,
  detectAircraftTypeFromSourceMeta,
  deriveSourceHints,
  deriveOperatorFromSourceMeta,
  filterMilitaryFlights,
};
