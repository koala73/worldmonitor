/**
 * Curated theater policy for the shared military-surge engine.
 *
 * Separated from the stateful engine so thresholds, region membership, and
 * geographic bounds remain reviewable as data.
 */
export interface PostureTheater {
  id: string;
  name: string;
  shortName: string;
  targetNation: string | null;
  regions: string[];
  bounds: { north: number; south: number; east: number; west: number };
  thresholds: { elevated: number; critical: number };
  navalThresholds: { elevated: number; critical: number };
  strikeIndicators: { minTankers: number; minAwacs: number; minFighters: number };
}

export const POSTURE_THEATERS: PostureTheater[] = [
  {
    id: 'iran-theater',
    name: 'Iran Theater',
    shortName: 'IRAN',
    targetNation: 'Iran',
    regions: ['persian-gulf', 'strait-hormuz', 'iran-border'],
    bounds: { north: 42, south: 20, east: 65, west: 30 },
    thresholds: { elevated: 8, critical: 20 },
    navalThresholds: { elevated: 2, critical: 5 },
    strikeIndicators: { minTankers: 2, minAwacs: 1, minFighters: 5 },
  },
  {
    id: 'taiwan-theater',
    name: 'Taiwan Strait',
    shortName: 'TAIWAN',
    targetNation: 'Taiwan',
    regions: ['taiwan-strait', 'south-china-sea'],
    bounds: { north: 30, south: 18, east: 130, west: 115 },
    thresholds: { elevated: 6, critical: 15 },
    navalThresholds: { elevated: 4, critical: 10 },
    strikeIndicators: { minTankers: 1, minAwacs: 1, minFighters: 4 },
  },
  {
    id: 'baltic-theater',
    name: 'Baltic Theater',
    shortName: 'BALTIC',
    targetNation: null,
    regions: ['baltics', 'poland-border', 'kaliningrad'],
    bounds: { north: 65, south: 52, east: 32, west: 10 },
    thresholds: { elevated: 5, critical: 12 },
    navalThresholds: { elevated: 3, critical: 8 },
    strikeIndicators: { minTankers: 1, minAwacs: 1, minFighters: 3 },
  },
  {
    id: 'blacksea-theater',
    name: 'Black Sea',
    shortName: 'BLACK SEA',
    targetNation: null,
    regions: ['black-sea'],
    bounds: { north: 48, south: 40, east: 42, west: 26 },
    thresholds: { elevated: 4, critical: 10 },
    navalThresholds: { elevated: 3, critical: 6 },
    strikeIndicators: { minTankers: 1, minAwacs: 1, minFighters: 3 },
  },
  {
    id: 'korea-theater',
    name: 'Korean Peninsula',
    shortName: 'KOREA',
    targetNation: 'North Korea',
    regions: ['korean-dmz', 'sea-of-japan'],
    bounds: { north: 43, south: 33, east: 132, west: 124 },
    thresholds: { elevated: 5, critical: 12 },
    navalThresholds: { elevated: 3, critical: 8 },
    strikeIndicators: { minTankers: 1, minAwacs: 1, minFighters: 3 },
  },
  {
    id: 'south-china-sea',
    name: 'South China Sea',
    shortName: 'SCS',
    targetNation: null,
    regions: ['south-china-sea', 'spratly-islands'],
    bounds: { north: 25, south: 5, east: 121, west: 105 },
    thresholds: { elevated: 6, critical: 15 },
    navalThresholds: { elevated: 4, critical: 10 },
    strikeIndicators: { minTankers: 1, minAwacs: 1, minFighters: 4 },
  },
  {
    id: 'east-med-theater',
    name: 'Eastern Mediterranean',
    shortName: 'E.MED',
    targetNation: null,
    regions: ['eastern-med', 'levant'],
    bounds: { north: 37, south: 33, east: 37, west: 25 },
    thresholds: { elevated: 4, critical: 10 },
    navalThresholds: { elevated: 3, critical: 6 },
    strikeIndicators: { minTankers: 1, minAwacs: 1, minFighters: 3 },
  },
  {
    id: 'israel-gaza-theater',
    name: 'Israel/Gaza',
    shortName: 'GAZA',
    targetNation: 'Gaza',
    regions: ['israel', 'gaza', 'west-bank'],
    bounds: { north: 33, south: 29, east: 36, west: 33 },
    thresholds: { elevated: 3, critical: 8 },
    navalThresholds: { elevated: 2, critical: 5 },
    strikeIndicators: { minTankers: 1, minAwacs: 1, minFighters: 3 },
  },
  {
    id: 'yemen-redsea-theater',
    name: 'Yemen/Red Sea',
    shortName: 'RED SEA',
    targetNation: 'Yemen',
    regions: ['yemen', 'red-sea', 'bab-el-mandeb'],
    bounds: { north: 22, south: 11, east: 54, west: 32 },
    thresholds: { elevated: 4, critical: 10 },
    navalThresholds: { elevated: 3, critical: 8 },
    strikeIndicators: { minTankers: 1, minAwacs: 1, minFighters: 3 },
  },
];
