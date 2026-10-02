export const MISSION_PRESET_IDS = [
  'crisis-desk',
  'supply-chain-risk',
  'energy-security',
  'osint-newsroom',
  'macro-market-watch',
  'tech-ai-watch',
  'good-news-explorer',
  'nq-day-trader',
  'country-watcher',
] as const;

export type MissionPresetId = (typeof MISSION_PRESET_IDS)[number];

const MISSION_PRESET_ID_SET = new Set<string>(MISSION_PRESET_IDS);

export function parseMissionPresetId(value: unknown): MissionPresetId | null {
  return typeof value === 'string' && MISSION_PRESET_ID_SET.has(value)
    ? value as MissionPresetId
    : null;
}
