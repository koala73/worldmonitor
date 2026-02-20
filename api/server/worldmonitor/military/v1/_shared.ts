declare const process: { env: Record<string, string | undefined> };

import type {
  AircraftDetails,
} from '../../../../../src/generated/server/worldmonitor/military/v1/service_server';

// @ts-expect-error -- JS data module, no declarations
import { MILITARY_HEX_LIST } from './military-hex-db.js';

// ========================================================================
// Military identification
// ========================================================================

export const MILITARY_HEX_SET = new Set(
  (MILITARY_HEX_LIST as string[]).map((h: string) => h.toLowerCase()),
);

export function isMilitaryHex(hexId: string | null | undefined): boolean {
  if (!hexId) return false;
  return MILITARY_HEX_SET.has(String(hexId).replace(/^~/, '').toLowerCase());
}

export const MILITARY_PREFIXES = [
  'RCH', 'REACH', 'MOOSE', 'EVAC', 'DUSTOFF', 'PEDRO',
  'DUKE', 'HAVOC', 'KNIFE', 'WARHAWK', 'VIPER', 'RAGE', 'FURY',
  'SHELL', 'TEXACO', 'ARCO', 'ESSO', 'PETRO',
  'SENTRY', 'AWACS', 'MAGIC', 'DISCO', 'DARKSTAR',
  'COBRA', 'PYTHON', 'RAPTOR', 'EAGLE', 'HAWK', 'TALON',
  'BOXER', 'OMNI', 'TOPCAT', 'SKULL', 'REAPER', 'HUNTER',
  'ARMY', 'NAVY', 'USAF', 'USMC', 'USCG',
  'AE', 'CNV', 'PAT', 'SAM', 'EXEC',
  'OPS', 'CTF', 'TF',
  'NATO', 'GAF', 'RRF', 'RAF', 'FAF', 'IAF', 'RNLAF', 'BAF', 'DAF', 'HAF', 'PAF',
  'SWORD', 'LANCE', 'ARROW', 'SPARTAN',
  'RSAF', 'EMIRI', 'UAEAF', 'KAF', 'QAF', 'BAHAF', 'OMAAF',
  'IRIAF', 'IRG', 'IRGC',
  'TAF', 'TUAF',
  'RSD', 'RF', 'RFF', 'VKS',
  'CHN', 'PLAAF', 'PLA',
];

export const AIRLINE_CODES = new Set([
  'SVA', 'QTR', 'THY', 'UAE', 'ETD', 'GFA', 'MEA', 'RJA', 'KAC', 'ELY',
  'IAW', 'IRA', 'MSR', 'SYR', 'PGT', 'AXB', 'FDB', 'KNE', 'FAD', 'ADY', 'OMA',
  'ABQ', 'ABY', 'NIA', 'FJA', 'SWR', 'HZA', 'OMS', 'EGF', 'NOS', 'SXD',
  'BAW', 'AFR', 'DLH', 'KLM', 'AUA', 'SAS', 'FIN', 'LOT', 'AZA', 'TAP', 'IBE',
  'VLG', 'RYR', 'EZY', 'WZZ', 'NOZ', 'BEL', 'AEE', 'ROT',
  'AIC', 'CPA', 'SIA', 'MAS', 'THA', 'VNM', 'JAL', 'ANA', 'KAL', 'AAR', 'EVA',
  'CAL', 'CCA', 'CES', 'CSN', 'HDA', 'CHH', 'CXA', 'GIA', 'PAL', 'SLK',
  'AAL', 'DAL', 'UAL', 'SWA', 'JBU', 'FFT', 'ASA', 'NKS', 'WJA', 'ACA',
  'FDX', 'UPS', 'GTI', 'ABW', 'CLX', 'MPH',
  'AIR', 'SKY', 'JET',
]);

export function isMilitaryCallsign(callsign: string | null | undefined): boolean {
  if (!callsign) return false;
  const cs = callsign.toUpperCase().trim();
  for (const prefix of MILITARY_PREFIXES) {
    if (cs.startsWith(prefix)) return true;
  }
  if (/^[A-Z]{4,}\d{1,3}$/.test(cs)) return true;
  if (/^[A-Z]{3}\d{1,2}$/.test(cs)) {
    const prefix = cs.slice(0, 3);
    if (!AIRLINE_CODES.has(prefix)) return true;
  }
  return false;
}

export function detectAircraftType(callsign: string | null | undefined): string {
  if (!callsign) return 'unknown';
  const cs = callsign.toUpperCase().trim();
  if (/^(SHELL|TEXACO|ARCO|ESSO|PETRO|KC|STRAT)/.test(cs)) return 'tanker';
  if (/^(SENTRY|AWACS|MAGIC|DISCO|DARKSTAR|E3|E8|E6)/.test(cs)) return 'awacs';
  if (/^(RCH|REACH|MOOSE|EVAC|DUSTOFF|C17|C5|C130|C40)/.test(cs)) return 'transport';
  if (/^(HOMER|OLIVE|JAKE|PSEUDO|GORDO|RC|U2|SR)/.test(cs)) return 'reconnaissance';
  if (/^(RQ|MQ|REAPER|PREDATOR|GLOBAL)/.test(cs)) return 'drone';
  if (/^(DEATH|BONE|DOOM|B52|B1|B2)/.test(cs)) return 'bomber';
  return 'unknown';
}

// ========================================================================
// Theater definitions
// ========================================================================

export interface TheaterDef {
  id: string;
  name: string;
  bounds: { north: number; south: number; east: number; west: number };
  thresholds: { elevated: number; critical: number };
  strikeIndicators: { minTankers: number; minAwacs: number; minFighters: number };
}

export const POSTURE_THEATERS: TheaterDef[] = [
  { id: 'iran-theater', name: 'Iran Theater', bounds: { north: 42, south: 20, east: 65, west: 30 }, thresholds: { elevated: 8, critical: 20 }, strikeIndicators: { minTankers: 2, minAwacs: 1, minFighters: 5 } },
  { id: 'taiwan-theater', name: 'Taiwan Strait', bounds: { north: 30, south: 18, east: 130, west: 115 }, thresholds: { elevated: 6, critical: 15 }, strikeIndicators: { minTankers: 1, minAwacs: 1, minFighters: 4 } },
  { id: 'baltic-theater', name: 'Baltic Theater', bounds: { north: 65, south: 52, east: 32, west: 10 }, thresholds: { elevated: 5, critical: 12 }, strikeIndicators: { minTankers: 1, minAwacs: 1, minFighters: 3 } },
  { id: 'blacksea-theater', name: 'Black Sea', bounds: { north: 48, south: 40, east: 42, west: 26 }, thresholds: { elevated: 4, critical: 10 }, strikeIndicators: { minTankers: 1, minAwacs: 1, minFighters: 3 } },
  { id: 'korea-theater', name: 'Korean Peninsula', bounds: { north: 43, south: 33, east: 132, west: 124 }, thresholds: { elevated: 5, critical: 12 }, strikeIndicators: { minTankers: 1, minAwacs: 1, minFighters: 3 } },
  { id: 'south-china-sea', name: 'South China Sea', bounds: { north: 25, south: 5, east: 121, west: 105 }, thresholds: { elevated: 6, critical: 15 }, strikeIndicators: { minTankers: 1, minAwacs: 1, minFighters: 4 } },
  { id: 'east-med-theater', name: 'Eastern Mediterranean', bounds: { north: 37, south: 33, east: 37, west: 25 }, thresholds: { elevated: 4, critical: 10 }, strikeIndicators: { minTankers: 1, minAwacs: 1, minFighters: 3 } },
  { id: 'israel-gaza-theater', name: 'Israel/Gaza', bounds: { north: 33, south: 29, east: 36, west: 33 }, thresholds: { elevated: 3, critical: 8 }, strikeIndicators: { minTankers: 1, minAwacs: 1, minFighters: 3 } },
  { id: 'yemen-redsea-theater', name: 'Yemen/Red Sea', bounds: { north: 22, south: 11, east: 54, west: 32 }, thresholds: { elevated: 4, critical: 10 }, strikeIndicators: { minTankers: 1, minAwacs: 1, minFighters: 3 } },
];

// ========================================================================
// Raw flight type (used by theater posture)
// ========================================================================

export interface RawFlight {
  id: string;
  callsign: string;
  lat: number;
  lon: number;
  altitude: number;
  heading: number;
  speed: number;
  aircraftType: string;
}

export const UPSTREAM_TIMEOUT_MS = 20_000;

// ========================================================================
// Wingbits response mapper (shared by single + batch RPCs)
// ========================================================================

export function mapWingbitsDetails(icao24: string, data: Record<string, unknown>): AircraftDetails {
  return {
    icao24,
    registration: String(data.registration ?? ''),
    manufacturerIcao: String(data.manufacturerIcao ?? ''),
    manufacturerName: String(data.manufacturerName ?? ''),
    model: String(data.model ?? ''),
    typecode: String(data.typecode ?? ''),
    serialNumber: String(data.serialNumber ?? ''),
    icaoAircraftType: String(data.icaoAircraftType ?? ''),
    operator: String(data.operator ?? ''),
    operatorCallsign: String(data.operatorCallsign ?? ''),
    operatorIcao: String(data.operatorIcao ?? ''),
    owner: String(data.owner ?? ''),
    built: String(data.built ?? ''),
    engines: String(data.engines ?? ''),
    categoryDescription: String(data.categoryDescription ?? ''),
  };
}

export { process };
