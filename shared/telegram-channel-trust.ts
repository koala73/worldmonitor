// Public trust overlay for curated Telegram channels (#6600).
//
// Operational `tier` in data/telegram-channels.json is poll-priority, not the
// public editorial scale in shared/source-tiers.json. This module maps each
// enabled channel to a public display name, editorial tier, source type, and
// propaganda-risk profile. Wire/gov publishers and anonymous OSINT aggregators
// are not the same source class — do not copy operational tiers blindly.
//
// Extension point for #6654 Track A: add an analogous X-account overlay and
// spread it the same way. Keep this file Telegram-only.
//
// Types are duplicated (not imported) so this module stays a leaf and
// shared/source-provenance.ts can spread the records without a cycle.
type SourceType = 'wire' | 'gov' | 'intel' | 'mainstream' | 'market' | 'tech' | 'other' | 'unknown';
type PropagandaRisk = 'low' | 'medium' | 'high' | 'unknown';

interface SourceRiskProfile {
  risk: PropagandaRisk;
  stateAffiliated?: string;
  knownBiases?: string[];
  note?: string;
}

export interface TelegramChannelTrustEntry {
  handle: string;
  /** Public registry key. Matches the Telegram channel `label` (display name). */
  name: string;
  tier: 1 | 2 | 3 | 4;
  type: SourceType;
  risk: PropagandaRisk;
  stateAffiliated?: string;
  knownBiases?: string[];
  note: string;
  /**
   * The public masthead already exists in SOURCE_TYPES / SOURCE_PROPAGANDA_RISK
   * / source-tiers.json. Reuse it; do not emit a duplicate key.
   */
  reuseExisting?: boolean;
}

export const TELEGRAM_CHANNEL_TRUST: readonly TelegramChannelTrustEntry[] = [
  {
    handle: 'VahidOnline',
    name: 'Vahid Online',
    tier: 2,
    type: 'intel',
    risk: 'medium',
    note: 'Independent Iranian journalist. Operational Telegram priority is not a wire-service rating',
  },
  {
    handle: 'abualiexpress',
    name: 'Abu Ali Express',
    tier: 3,
    type: 'intel',
    risk: 'medium',
    note: 'Hebrew-language military OSINT channel; treat posts as leads, not confirmation',
  },
  {
    handle: 'AuroraIntel',
    name: 'Aurora Intel',
    tier: 3,
    type: 'intel',
    risk: 'medium',
    note: 'OSINT aggregator; not a major established newsroom',
  },
  {
    handle: 'BNONews',
    name: 'BNO News',
    tier: 3,
    type: 'mainstream',
    risk: 'medium',
    note: 'Breaking-news aggregator; useful speed, thinner editorial process than a wire',
  },
  {
    handle: 'ClashReport',
    name: 'Clash Report',
    tier: 3,
    type: 'intel',
    risk: 'medium',
    note: 'Conflict OSINT aggregator; unverified battlefield claims are common',
  },
  {
    handle: 'DeepStateUA',
    name: 'DeepState',
    tier: 3,
    type: 'intel',
    risk: 'medium',
    knownBiases: ['Pro-Ukraine'],
    note: 'Ukrainian OSINT mapping project; high-signal maps, not a wire service',
  },
  {
    handle: 'DefenderDome',
    name: 'The Defender Dome',
    tier: 3,
    type: 'intel',
    risk: 'medium',
    note: 'Conflict OSINT aggregator',
  },
  {
    handle: 'englishabuali',
    name: 'Abu Ali Express EN',
    tier: 3,
    type: 'intel',
    risk: 'medium',
    note: 'English edition of Abu Ali Express military OSINT',
  },
  {
    handle: 'IranIntl_En',
    name: 'Iran International EN',
    tier: 2,
    type: 'mainstream',
    risk: 'medium',
    stateAffiliated: 'Saudi Arabia',
    knownBiases: ['Iranian opposition'],
    note: 'Saudi-funded Iranian exile broadcaster; established newsroom, not independent of a state sponsor',
  },
  {
    handle: 'kpszsu',
    name: 'Air Force of the Armed Forces of Ukraine',
    tier: 1,
    type: 'gov',
    risk: 'high',
    stateAffiliated: 'Ukraine',
    note: 'Official Ukrainian Air Force publisher; treat statements as government claims',
  },
  {
    handle: 'LiveUAMap',
    name: 'LiveUAMap',
    tier: 3,
    type: 'intel',
    risk: 'medium',
    note: 'Live conflict-mapping aggregator; source quality varies by incident',
  },
  {
    handle: 'OSINTdefender',
    name: 'OSINTdefender',
    tier: 3,
    type: 'intel',
    risk: 'medium',
    note: 'Military OSINT aggregator; treat as a lead',
  },
  {
    handle: 'OsintUpdates',
    name: 'Osint Updates',
    tier: 3,
    type: 'intel',
    risk: 'medium',
    note: 'Breaking OSINT aggregator',
  },
  {
    handle: 'bellingcat',
    name: 'Bellingcat',
    tier: 3,
    type: 'intel',
    risk: 'low',
    note: 'Open-source investigations, methodology transparent',
    reuseExisting: true,
  },
  {
    handle: 'CyberDetective',
    name: 'CyberDetective',
    tier: 3,
    type: 'intel',
    risk: 'medium',
    note: 'Cyber OSINT specialist',
  },
  {
    handle: 'GeopoliticalCenter',
    name: 'GeopoliticalCenter',
    tier: 3,
    type: 'intel',
    risk: 'medium',
    note: 'Geopolitical commentary aggregator',
  },
  {
    handle: 'Middle_East_Spectator',
    name: 'Middle East Spectator',
    tier: 3,
    type: 'intel',
    risk: 'medium',
    note: 'Middle East OSINT aggregator',
  },
  {
    handle: 'MiddleEastNow_Breaking',
    name: 'Middle East Now Breaking',
    tier: 3,
    type: 'intel',
    risk: 'medium',
    note: 'Regional breaking-news aggregator',
  },
  {
    handle: 'nexta_tv',
    name: 'NEXTA',
    tier: 3,
    type: 'mainstream',
    risk: 'medium',
    knownBiases: ['Belarusian opposition'],
    note: 'Belarusian opposition media; useful primary, not a wire',
  },
  {
    handle: 'OSINTIndustries',
    name: 'OSINT Industries',
    tier: 3,
    type: 'intel',
    risk: 'medium',
    note: 'Commercial OSINT vendor channel',
  },
  {
    handle: 'Osintlatestnews',
    name: 'OSIntOps News',
    tier: 4,
    type: 'intel',
    risk: 'medium',
    note: 'Anonymous OSINT news aggregator; not an editorial newsroom',
  },
  {
    handle: 'osintlive',
    name: 'OSINT Live',
    tier: 4,
    type: 'intel',
    risk: 'medium',
    note: 'Anonymous OSINT aggregator',
  },
  {
    handle: 'OsintTv',
    name: 'OsintTV',
    tier: 4,
    type: 'intel',
    risk: 'medium',
    note: 'Anonymous OSINT video aggregator',
  },
  {
    handle: 'spectatorindex',
    name: 'The Spectator Index',
    tier: 3,
    type: 'intel',
    risk: 'medium',
    note: 'Headline aggregator; speed over original reporting',
  },
  {
    handle: 'wfwitness',
    name: 'Witness',
    tier: 3,
    type: 'intel',
    risk: 'medium',
    note: 'Conflict-witness aggregator',
  },
  {
    handle: 'war_monitor',
    name: 'monitor',
    tier: 3,
    type: 'intel',
    risk: 'medium',
    note: 'Ukraine-focused conflict monitor; label matches the product-managed channel list',
  },
  {
    handle: 'nayaforiraq',
    name: 'Naya for Iraq',
    tier: 3,
    type: 'mainstream',
    risk: 'medium',
    note: 'Iraq-focused regional desk',
  },
  {
    handle: 'yediotnews25',
    name: 'Yedioth News',
    tier: 2,
    type: 'mainstream',
    risk: 'low',
    knownBiases: ['Israeli mainstream'],
    note: 'Yedioth Ahronoth Telegram desk; same newsroom family as Ynetnews',
  },
  {
    handle: 'DDGeopolitics',
    name: 'DD Geopolitics',
    tier: 4,
    type: 'intel',
    risk: 'medium',
    knownBiases: ['Pro-Russia'],
    note: 'Anonymous partisan aggregator; not independent journalism',
  },
  {
    handle: 'FotrosResistancee',
    name: 'Fotros Resistance',
    tier: 4,
    type: 'intel',
    risk: 'medium',
    knownBiases: ['Iran-aligned resistance'],
    note: 'Partisan resistance channel; treat as advocacy, not reporting',
  },
  {
    handle: 'RezistanceTrench1',
    name: 'Resistance Trench',
    tier: 4,
    type: 'intel',
    risk: 'medium',
    knownBiases: ['Iran-aligned resistance'],
    note: 'Partisan resistance channel; treat as advocacy, not reporting',
  },
  {
    handle: 'geopolitics_prime',
    name: 'Geopolitics Prime',
    tier: 4,
    type: 'intel',
    risk: 'medium',
    note: 'State-adjacent geopolitical aggregator; not an independent newsroom',
  },
  {
    handle: 'thecradlemedia',
    name: 'The Cradle',
    tier: 3,
    type: 'mainstream',
    risk: 'medium',
    knownBiases: ['West-Asia alignment'],
    note: 'West Asia analytical outlet with a disclosed editorial line',
  },
  {
    handle: 'LebUpdate',
    name: 'Lebanon Update',
    tier: 3,
    type: 'mainstream',
    risk: 'medium',
    note: 'Lebanon breaking-news aggregator',
  },
  {
    handle: 'middleeastobserver',
    name: 'Middle East Observer',
    tier: 3,
    type: 'intel',
    risk: 'medium',
    note: 'Regional observer/OSINT desk',
  },
  {
    handle: 'MiddleEastEye_TG',
    name: 'Middle East Eye',
    tier: 2,
    type: 'mainstream',
    risk: 'medium',
    stateAffiliated: 'Qatar',
    note: 'Qatar-linked Middle East newsroom; established outlet, not a wire',
  },
  {
    handle: 'dragonwatch',
    name: 'Dragon Watch',
    tier: 3,
    type: 'intel',
    risk: 'medium',
    note: 'Indo-Pacific OSINT aggregator',
  },
  {
    handle: 'IDFofficial',
    name: 'IDF Official',
    tier: 1,
    type: 'gov',
    risk: 'high',
    stateAffiliated: 'Israel',
    note: 'Official IDF publisher; treat statements as government claims, not independent observation',
  },
  {
    handle: 'RocketAlert',
    name: 'Rocket Alert',
    tier: 1,
    type: 'gov',
    risk: 'high',
    stateAffiliated: 'Israel',
    note: 'Official Israeli civilian rocket-alert publisher; values are primary government claims',
  },
  {
    handle: 'sepah',
    name: 'IRGC Official',
    tier: 1,
    type: 'gov',
    risk: 'high',
    stateAffiliated: 'Iran',
    note: 'Official IRGC publisher; treat statements as government claims',
  },
  {
    handle: 'defapress_ir',
    name: 'DefaPress (Iran MOD)',
    tier: 1,
    type: 'gov',
    risk: 'high',
    stateAffiliated: 'Iran',
    note: 'Iranian Ministry of Defence publisher; treat statements as government claims',
  },
  {
    handle: 'TasnimNewsEN',
    name: 'Tasnim News EN',
    tier: 3,
    type: 'mainstream',
    risk: 'high',
    stateAffiliated: 'Iran',
    note: 'Iranian state-affiliated outlet; not a wire service',
  },
  {
    handle: 'PressTV',
    name: 'PressTV (Iran State)',
    tier: 3,
    type: 'mainstream',
    risk: 'high',
    stateAffiliated: 'Iran',
    note: 'Iranian state media Telegram desk; distinct key from RSS "Press TV"',
  },
  {
    handle: 'FarsNews_EN',
    name: 'Fars News EN',
    tier: 3,
    type: 'mainstream',
    risk: 'high',
    stateAffiliated: 'Iran',
    note: 'Iranian state-affiliated outlet; distinct key from RSS "Fars News"',
  },
  {
    handle: 'SaberinFa',
    name: 'Saberin (IRGC Intel)',
    tier: 1,
    type: 'gov',
    risk: 'high',
    stateAffiliated: 'Iran',
    note: 'IRGC-linked intelligence publisher; treat statements as government claims',
  },
  {
    handle: 'warfareanalysis',
    name: 'Warfare Analysis',
    tier: 3,
    type: 'intel',
    risk: 'medium',
    note: 'Military analysis/OSINT desk',
  },
  {
    handle: 'rnintel',
    name: 'RN Intel',
    tier: 3,
    type: 'intel',
    risk: 'medium',
    note: 'OSINT aggregator',
  },
  {
    handle: 'bintjbeilnews',
    name: 'Bint Jbeil News',
    tier: 3,
    type: 'mainstream',
    risk: 'medium',
    note: 'Southern Lebanon local desk in a polarized media environment',
  },
  {
    handle: 'HAMASW',
    name: 'Hamas-Israel War',
    tier: 4,
    type: 'intel',
    risk: 'medium',
    knownBiases: ['Faction-aligned'],
    note: 'Faction-aligned war aggregator; not an editorial newsroom',
  },
  {
    handle: 'QudsNen',
    name: 'Quds News',
    tier: 4,
    type: 'intel',
    risk: 'medium',
    knownBiases: ['Faction-aligned'],
    note: 'Faction-aligned aggregator; treat as advocacy, not reporting',
  },
  {
    handle: 'Alsaa_plus_EN',
    name: 'Al-Saa EN',
    tier: 3,
    type: 'mainstream',
    risk: 'medium',
    note: 'Arabic-to-English regional desk',
  },
  {
    handle: 'GeoPWatch',
    name: 'GeoPol Watch',
    tier: 4,
    type: 'intel',
    risk: 'medium',
    note: 'Anonymous geopolitical aggregator',
  },
  {
    handle: 'dropsitenews',
    name: 'Drop Site News',
    tier: 3,
    type: 'intel',
    risk: 'medium',
    note: 'Investigative digital outlet; specialty desk, not a wire',
  },
  {
    handle: 'france24_en',
    name: 'France 24 EN',
    tier: 2,
    type: 'mainstream',
    risk: 'medium',
    stateAffiliated: 'France',
    note: 'French state-funded broadcaster Telegram desk; editorially independent charter, distinct key from RSS "France 24"',
  },
  {
    handle: 'kianmeli1',
    name: 'Kian Meli (Iran)',
    tier: 4,
    type: 'intel',
    risk: 'medium',
    note: 'Unverified personal Iran desk; not a reviewed newsroom',
  },
  {
    handle: 'TimesofIsrael',
    name: 'Times of Israel',
    tier: 2,
    type: 'mainstream',
    risk: 'low',
    knownBiases: ['Israeli mainstream'],
    note: 'English-language Israeli newspaper Telegram desk',
  },
  {
    handle: 'thehackernews',
    name: 'The Hacker News',
    tier: 3,
    type: 'tech',
    risk: 'medium',
    note: 'Cybersecurity news specialist; not a general wire',
  },
  {
    handle: 'cybersecboardrm',
    name: 'Cybersecurity Boardroom',
    tier: 3,
    type: 'tech',
    risk: 'medium',
    note: 'Cybersecurity industry aggregator',
  },
  {
    handle: 'securelist',
    name: 'Securelist by Kaspersky',
    tier: 3,
    type: 'intel',
    risk: 'medium',
    note: 'Kaspersky research blog; vendor research, not independent journalism',
  },
  {
    handle: 'DarkWebInformer',
    name: 'Dark Web Informer',
    tier: 3,
    type: 'intel',
    risk: 'medium',
    note: 'Dark-web monitoring aggregator',
  },
  {
    handle: 'CYBERWARCOM',
    name: 'CYBERWAR.COM',
    tier: 3,
    type: 'intel',
    risk: 'medium',
    note: 'Cyber-conflict aggregator',
  },
  {
    handle: 'thecyberwire',
    name: 'The CyberWire',
    tier: 3,
    type: 'intel',
    risk: 'medium',
    note: 'Cybersecurity briefing specialist',
  },
  {
    handle: 'vxunderground',
    name: 'vx-underground',
    tier: 3,
    type: 'intel',
    risk: 'medium',
    note: 'Malware-research archive; technical primary, not a newsroom',
  },
  {
    handle: 'falconfeeds',
    name: 'FalconFeeds.io',
    tier: 3,
    type: 'intel',
    risk: 'medium',
    note: 'Commercial threat-intel feed',
  },
];

function telegramRiskProfile(entry: TelegramChannelTrustEntry): SourceRiskProfile {
  return {
    risk: entry.risk,
    ...(entry.stateAffiliated ? { stateAffiliated: entry.stateAffiliated } : {}),
    ...(entry.knownBiases ? { knownBiases: entry.knownBiases } : {}),
    note: entry.note,
  };
}

export const TELEGRAM_SOURCE_TYPES: Record<string, SourceType> = Object.fromEntries(
  TELEGRAM_CHANNEL_TRUST
    .filter((entry) => !entry.reuseExisting)
    .map((entry) => [entry.name, entry.type]),
);

export const TELEGRAM_SOURCE_PROPAGANDA_RISK: Record<string, SourceRiskProfile> = Object.fromEntries(
  TELEGRAM_CHANNEL_TRUST
    .filter((entry) => !entry.reuseExisting)
    .map((entry) => [entry.name, telegramRiskProfile(entry)]),
);

export const TELEGRAM_SOURCE_TIERS: Record<string, number> = Object.fromEntries(
  TELEGRAM_CHANNEL_TRUST
    .filter((entry) => !entry.reuseExisting)
    .map((entry) => [entry.name, entry.tier]),
);

export const TELEGRAM_HANDLE_TO_PUBLIC_NAME: Record<string, string> = Object.fromEntries(
  TELEGRAM_CHANNEL_TRUST.map((entry) => [entry.handle, entry.name]),
);

function normalizeTelegramHandle(handle: string): string {
  return handle.trim().replace(/^@/, '').toLowerCase();
}

const TELEGRAM_NORMALIZED_HANDLE_TO_PUBLIC_NAME: ReadonlyMap<string, string> = (() => {
  const entries = new Map<string, string>();
  for (const entry of TELEGRAM_CHANNEL_TRUST) {
    const normalizedHandle = normalizeTelegramHandle(entry.handle);
    if (entries.has(normalizedHandle)) {
      throw new Error(`Duplicate Telegram trust handle: ${entry.handle}`);
    }
    entries.set(normalizedHandle, entry.name);
  }
  return entries;
})();

/** Resolve a trust-registry key only when the immutable channel handle is registered. */
export function resolveRegisteredTelegramSourceName(handle?: string): string | null {
  const trimmedHandle = handle?.trim();
  if (!trimmedHandle) return null;
  return TELEGRAM_NORMALIZED_HANDLE_TO_PUBLIC_NAME.get(normalizeTelegramHandle(trimmedHandle)) ?? null;
}

/** Resolve the public trust-registry key for a Telegram feed item. */
export function resolveTelegramSourceName(channelTitle?: string, handle?: string): string {
  const trimmedHandle = handle?.trim();
  const mapped = resolveRegisteredTelegramSourceName(trimmedHandle);
  if (mapped) return mapped;
  const title = channelTitle?.trim();
  if (title) return title;
  return trimmedHandle || 'telegram';
}
