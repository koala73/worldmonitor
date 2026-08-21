// Public trust overlay for curated X news accounts (#6654 Track A).
//
// Operational `tier` in data/x-accounts.json is poll-priority, not the public
// editorial scale. This module fills gaps so every
// enabled X `sourceName` is present in SOURCE_TYPES, SOURCE_PROPAGANDA_RISK,
// and the additive X tier overlay. Existing RSS mastheads are reused.
//
// Extension point matches #6600: spread into shared/source-provenance.ts and
// server/_shared/source-tiers.ts. Keep this file X-only. Do not register
// Telegram channels here.
//
// Types are duplicated (not imported) so this module stays a leaf and
// shared/source-provenance.ts can spread the records without a cycle.

import xAccountSourceTiers from './x-account-source-tiers.json';

type SourceType = 'wire' | 'gov' | 'intel' | 'mainstream' | 'market' | 'tech' | 'other' | 'unknown';
type PropagandaRisk = 'low' | 'medium' | 'high' | 'unknown';

interface SourceRiskProfile {
  risk: PropagandaRisk;
  stateAffiliated?: string;
  knownBiases?: string[];
  note?: string;
}

export interface XAccountTrustEntry {
  sourceName: string;
  tier: 1 | 2 | 3;
  type: SourceType;
  risk: PropagandaRisk;
  stateAffiliated?: string;
  knownBiases?: string[];
  note: string;
  /** Skip emitting a SOURCE_TYPES key that already exists on the RSS masthead. */
  reuseType?: boolean;
  /** Skip emitting a SOURCE_PROPAGANDA_RISK key that already exists. */
  reuseRisk?: boolean;
  /** Skip emitting a source-tiers.json key that already exists. */
  reuseTier?: boolean;
}

export const X_ACCOUNT_TRUST: readonly XAccountTrustEntry[] = [
  {
    sourceName: 'Al Arabiya',
    tier: 2,
    type: 'mainstream',
    risk: 'medium',
    stateAffiliated: 'Saudi Arabia',
    note: 'Saudi-owned Gulf newsroom; established outlet, not a wire',
    reuseRisk: true,
  },
  {
    sourceName: 'Aurora Intel',
    tier: 3,
    type: 'intel',
    risk: 'medium',
    note: 'OSINT aggregator; not a major established newsroom',
  },
  {
    sourceName: 'BNO News',
    tier: 3,
    type: 'mainstream',
    risk: 'medium',
    note: 'Breaking-news aggregator; useful speed, thinner editorial process than a wire',
  },
  {
    sourceName: 'Bloomberg',
    tier: 1,
    type: 'wire',
    risk: 'low',
    note: 'Financial wire service with editorial standards',
    reuseType: true,
    reuseTier: true,
  },
  {
    sourceName: 'Breaking Defense',
    tier: 3,
    type: 'intel',
    risk: 'medium',
    note: 'Defense trade press; specialty desk, not a wire',
    reuseType: true,
    reuseTier: true,
  },
  {
    sourceName: 'CGTN',
    tier: 3,
    type: 'mainstream',
    risk: 'high',
    stateAffiliated: 'China',
    note: 'Chinese state broadcaster',
    reuseRisk: true,
  },
  {
    sourceName: 'CISA',
    tier: 1,
    type: 'gov',
    risk: 'high',
    stateAffiliated: 'USA',
    note: 'Official US cybersecurity agency publisher; treat statements as government claims',
    reuseType: true,
    reuseTier: true,
  },
  {
    sourceName: 'CNN World',
    tier: 2,
    type: 'mainstream',
    risk: 'medium',
    note: 'US cable news world desk; established outlet, not a wire',
    reuseType: true,
    reuseTier: true,
  },
  {
    sourceName: 'Clash Report',
    tier: 3,
    type: 'intel',
    risk: 'medium',
    note: 'Conflict OSINT aggregator; unverified battlefield claims are common',
  },
  {
    sourceName: 'CrowdStrike',
    tier: 3,
    type: 'intel',
    risk: 'medium',
    note: 'Vendor threat-intel publisher; not independent journalism',
  },
  {
    sourceName: 'Dark Web Informer',
    tier: 3,
    type: 'intel',
    risk: 'medium',
    note: 'Dark-web monitoring aggregator',
  },
  {
    sourceName: 'DeepState',
    tier: 3,
    type: 'intel',
    risk: 'medium',
    knownBiases: ['Pro-Ukraine'],
    note: 'Ukrainian OSINT mapping project; high-signal maps, not a wire service',
  },
  {
    sourceName: 'Defense One',
    tier: 3,
    type: 'intel',
    risk: 'medium',
    note: 'Defense trade press; specialty desk, not a wire',
    reuseType: true,
    reuseTier: true,
  },
  {
    sourceName: 'Haaretz',
    tier: 2,
    type: 'mainstream',
    risk: 'low',
    knownBiases: ['Israeli left-liberal'],
    note: 'Israeli newspaper of record with editorial standards',
  },
  {
    sourceName: 'IAEA',
    tier: 1,
    type: 'gov',
    risk: 'medium',
    note: 'UN nuclear watchdog official publisher; treat statements as institutional claims',
    reuseType: true,
    reuseTier: true,
  },
  {
    sourceName: 'IDF',
    tier: 1,
    type: 'gov',
    risk: 'high',
    stateAffiliated: 'Israel',
    note: 'Official IDF publisher on X; treat statements as government claims, not independent observation',
  },
  {
    sourceName: 'IRNA',
    tier: 3,
    type: 'wire',
    risk: 'high',
    stateAffiliated: 'Iran',
    note: 'Iranian state news agency',
    reuseRisk: true,
  },
  {
    sourceName: 'Intel Crab',
    tier: 3,
    type: 'intel',
    risk: 'medium',
    note: 'Military OSINT aggregator; treat as a lead',
  },
  {
    sourceName: 'Iran International',
    tier: 3,
    type: 'mainstream',
    risk: 'medium',
    stateAffiliated: 'Saudi Arabia',
    knownBiases: ['Iranian opposition'],
    note: 'Saudi-funded Iranian exile broadcaster; established newsroom, not independent of a state sponsor',
    reuseTier: true,
  },
  {
    sourceName: 'Janes',
    tier: 3,
    type: 'intel',
    risk: 'low',
    note: 'Defense intelligence publisher with editorial standards',
    reuseType: true,
    reuseTier: true,
  },
  {
    sourceName: 'Jerusalem Post',
    tier: 2,
    type: 'mainstream',
    risk: 'low',
    knownBiases: ['Israeli centre-right'],
    note: 'English-language Israeli daily of record',
    reuseRisk: true,
  },
  {
    sourceName: 'Kaspersky',
    tier: 3,
    type: 'intel',
    risk: 'medium',
    note: 'Vendor research publisher; not independent journalism',
  },
  {
    sourceName: 'Krebs Security',
    tier: 3,
    type: 'intel',
    risk: 'low',
    note: 'Independent cybersecurity reporting',
    reuseType: true,
    reuseTier: true,
  },
  {
    sourceName: 'Kyiv Independent',
    tier: 2,
    type: 'mainstream',
    risk: 'medium',
    knownBiases: ['Pro-Ukraine'],
    note: 'Ukrainian English-language primary',
    reuseType: true,
    reuseRisk: true,
  },
  {
    sourceName: 'LiveUAMap',
    tier: 3,
    type: 'intel',
    risk: 'medium',
    note: 'Live conflict-mapping aggregator; source quality varies by incident',
  },
  {
    sourceName: 'Moscow Times',
    tier: 2,
    type: 'mainstream',
    risk: 'medium',
    knownBiases: ['Anti-Kremlin'],
    note: 'Independent English-language Russian outlet, critical of Kremlin',
    reuseType: true,
    reuseRisk: true,
  },
  {
    sourceName: 'NATO',
    tier: 1,
    type: 'gov',
    risk: 'high',
    note: 'Official NATO publisher; treat statements as alliance claims, not independent observation',
  },
  {
    sourceName: 'NHK World',
    tier: 2,
    type: 'mainstream',
    risk: 'medium',
    stateAffiliated: 'Japan',
    note: 'Japanese public broadcaster English service',
    reuseType: true,
    reuseTier: true,
  },
  {
    sourceName: 'New York Times',
    tier: 2,
    type: 'mainstream',
    risk: 'low',
    note: 'US newspaper of record with editorial standards',
  },
  {
    sourceName: 'Nikkei Asia',
    tier: 2,
    type: 'market',
    risk: 'low',
    note: 'Nikkei English-language Asia desk',
    reuseType: true,
    reuseTier: true,
  },
  {
    sourceName: 'OSINT Technical',
    tier: 3,
    type: 'intel',
    risk: 'medium',
    note: 'Technical OSINT aggregator; treat as a lead',
  },
  {
    sourceName: 'OSINTdefender',
    tier: 3,
    type: 'intel',
    risk: 'medium',
    note: 'Military OSINT aggregator; treat as a lead',
  },
  {
    // Renamed from 'Pentagon' (#6654 follow-up). @PentagonPresSec no longer
    // exists: the department rebranded and the account is now @DeptofWar.
    // Beware the neighbours — @WarDepartment, @SecretaryOfWar and @thePentagon
    // are unrelated personal accounts with three-figure follower counts, so
    // only the id verified against the API belongs in a tier-1 slot.
    sourceName: 'Department of War',
    tier: 1,
    type: 'gov',
    risk: 'high',
    stateAffiliated: 'USA',
    note: 'Official US Department of War publisher; treat statements as government claims',
    // No reuse flags: 'Pentagon' could borrow the existing defense.gov RSS
    // masthead's type/risk, but 'Department of War' is a new public name with
    // no masthead behind it, so this entry must emit its own keys or the
    // account falls through to the tier-4 default and is dropped from alerts.
  },
  {
    sourceName: 'Press TV',
    tier: 3,
    type: 'mainstream',
    risk: 'high',
    stateAffiliated: 'Iran',
    note: 'Iranian state media',
    reuseRisk: true,
  },
  {
    sourceName: 'State Dept',
    tier: 1,
    type: 'gov',
    risk: 'high',
    stateAffiliated: 'USA',
    note: 'Official US State Department publisher; treat statements as government claims',
    reuseType: true,
    reuseTier: true,
  },
  {
    sourceName: 'The CyberWire',
    tier: 3,
    type: 'intel',
    risk: 'medium',
    note: 'Cybersecurity briefing specialist',
  },
  {
    sourceName: 'The Economist',
    tier: 2,
    type: 'mainstream',
    risk: 'low',
    note: 'Weekly news magazine with editorial standards',
  },
  {
    sourceName: 'The Hacker News',
    tier: 3,
    type: 'tech',
    risk: 'medium',
    note: 'Cybersecurity news specialist; not a general wire',
  },
  {
    sourceName: 'The War Zone',
    tier: 3,
    type: 'intel',
    risk: 'medium',
    note: 'Defense specialty desk; not a wire',
    reuseType: true,
    reuseTier: true,
  },
  {
    sourceName: 'Times of Israel',
    tier: 2,
    type: 'mainstream',
    risk: 'low',
    knownBiases: ['Israeli mainstream'],
    note: 'English-language Israeli newspaper',
  },
  {
    sourceName: 'UK MOD',
    tier: 1,
    type: 'gov',
    risk: 'high',
    stateAffiliated: 'UK',
    note: 'Official UK Ministry of Defence publisher; treat statements as government claims',
    reuseType: true,
    reuseTier: true,
  },
  {
    sourceName: 'UN News',
    tier: 1,
    type: 'gov',
    risk: 'medium',
    note: 'Official UN news publisher; treat statements as institutional claims',
    reuseType: true,
    reuseTier: true,
  },
  {
    sourceName: 'US CENTCOM',
    tier: 1,
    type: 'gov',
    risk: 'high',
    stateAffiliated: 'USA',
    note: 'Official US Central Command publisher; treat statements as government claims',
  },
  {
    sourceName: 'Wall Street Journal',
    tier: 1,
    type: 'market',
    risk: 'low',
    note: 'US business newspaper with editorial standards',
    reuseTier: true,
  },
  {
    sourceName: 'Washington Post',
    tier: 2,
    type: 'mainstream',
    risk: 'low',
    note: 'US national newspaper with editorial standards',
  },
  {
    sourceName: 'vx-underground',
    tier: 3,
    type: 'intel',
    risk: 'medium',
    note: 'Malware-research archive; technical primary, not a newsroom',
  },
];

function xRiskProfile(entry: XAccountTrustEntry): SourceRiskProfile {
  return {
    risk: entry.risk,
    ...(entry.stateAffiliated ? { stateAffiliated: entry.stateAffiliated } : {}),
    ...(entry.knownBiases ? { knownBiases: entry.knownBiases } : {}),
    note: entry.note,
  };
}

export const X_ACCOUNT_SOURCE_TYPES: Record<string, SourceType> = Object.fromEntries(
  X_ACCOUNT_TRUST
    .filter((entry) => !entry.reuseType)
    .map((entry) => [entry.sourceName, entry.type]),
);

export const X_ACCOUNT_SOURCE_PROPAGANDA_RISK: Record<string, SourceRiskProfile> = Object.fromEntries(
  X_ACCOUNT_TRUST
    .filter((entry) => !entry.reuseRisk)
    .map((entry) => [entry.sourceName, xRiskProfile(entry)]),
);

export const X_ACCOUNT_SOURCE_TIERS = xAccountSourceTiers as Record<string, number>;
