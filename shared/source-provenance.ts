// Canonical source provenance registry shared by the browser UI and MCP tools.
// Keep this module runtime-neutral so it remains safe in both runtimes.
import { CONFIGURED_SOURCE_PROVENANCE_DECLARATIONS } from './source-provenance-declarations';

// 'unknown' = not yet reviewed (default for unlisted sources — never invent a type)
// 'other' remains available as an explicit classification when needed.
export type SourceType = 'wire' | 'gov' | 'intel' | 'mainstream' | 'market' | 'tech' | 'other' | 'unknown';

export const SOURCE_TYPES: Record<string, SourceType> = {
  // Wire services - fastest, most authoritative
  'Reuters': 'wire', 'Reuters World': 'wire', 'Reuters Business': 'wire',
  'AP News': 'wire', 'AFP': 'wire', 'Bloomberg': 'wire',

  // Government & International Org sources
  'White House': 'gov', 'State Dept': 'gov', 'Pentagon': 'gov',
  'Treasury': 'gov', 'DOJ': 'gov', 'DHS': 'gov', 'CDC': 'gov',
  'FEMA': 'gov', 'Federal Reserve': 'gov', 'SEC': 'gov',
  'UN News': 'gov', 'CISA': 'gov',
  // Direct official military publishers. Their claims remain publisher claims,
  // not independent ADS-B/AIS observations.
  'Taiwan Ministry of National Defense': 'gov', 'Japan Joint Staff': 'gov',
  // Chinese government ministries (Tier 1 official sources — not wire/verified outlets)
  'CAC (China)': 'gov', 'SAMR (China)': 'gov',
  'MIIT (China)': 'gov', 'MOFCOM (China)': 'gov',
  'NDRC (China)': 'gov', 'NBS (China)': 'gov', 'PBoC (China)': 'gov',
  'SAFE (China)': 'gov', 'GACC (China)': 'gov',

  // Intel/Defense specialty
  'Defense One': 'intel', 'Breaking Defense': 'intel', 'The War Zone': 'intel',
  'Defense News': 'intel', 'Janes': 'intel', 'Military Times': 'intel', 'Task & Purpose': 'intel',
  'USNI News': 'intel', 'gCaptain': 'intel', 'Oryx OSINT': 'intel', 'UK MOD': 'gov',
  'Bellingcat': 'intel', 'Krebs Security': 'intel',
  'Foreign Policy': 'intel', 'The Diplomat': 'intel',
  'Atlantic Council': 'intel', 'Foreign Affairs': 'intel',
  'CrisisWatch': 'intel',
  'CSIS': 'intel', 'RAND': 'intel', 'Brookings': 'intel', 'Carnegie': 'intel',
  'IAEA': 'gov', 'WHO': 'gov', 'UNHCR': 'gov',
  'Xinhua': 'wire', 'TASS': 'wire', 'RT': 'wire', 'RT Russia': 'wire',
  'NHK World': 'mainstream', 'Nikkei Asia': 'market',
  // Independent RU exile / UA English primary (default-eligible under #5950 balance rule)
  'Meduza': 'mainstream', 'Moscow Times': 'mainstream', 'Kyiv Independent': 'mainstream',
  // Ukraine depth pack (#5951) + uk native pack (#5959)
  'Ukrinform': 'wire', 'Suspilne': 'mainstream',
  'Ukrainska Pravda EN': 'mainstream', 'NV EN': 'mainstream', 'Hromadske EN': 'mainstream', 'ISW': 'intel',
  'Ukrainska Pravda': 'mainstream', 'Hromadske': 'mainstream',
  'Bihus.Info': 'intel', 'Slidstvo.Info': 'intel', 'ZN.UA': 'mainstream',

  // Mainstream outlets
  'BBC World': 'mainstream', 'BBC Middle East': 'mainstream',
  'Guardian World': 'mainstream', 'Guardian ME': 'mainstream',
  'NPR News': 'mainstream', 'Al Jazeera': 'mainstream',
  'CNN World': 'mainstream', 'Politico': 'mainstream', 'Axios': 'mainstream',
  'EuroNews': 'mainstream', 'France 24': 'mainstream', 'Le Monde': 'mainstream',
  // European Addition
  'El País': 'mainstream', 'El Mundo': 'mainstream', 'BBC Mundo': 'mainstream',
  'Tagesschau': 'mainstream', 'Der Spiegel': 'mainstream', 'Die Zeit': 'mainstream', 'DW News': 'mainstream',
  'ANSA': 'wire', 'Corriere della Sera': 'mainstream', 'Repubblica': 'mainstream',
  'NOS Nieuws': 'mainstream', 'NRC': 'mainstream', 'De Telegraaf': 'mainstream',
  // Croatian (HR)
  'N1 Croatia': 'mainstream', 'Index.hr': 'mainstream', 'Jutarnji list': 'mainstream',
  'Balkan Insight': 'intel',
  // Romanian (RO) — Eastern flank (#5952)
  'Digi24': 'mainstream', 'HotNews': 'mainstream', 'G4Media': 'mainstream',
  // Bulgarian (BG) — Black Sea flank (#5952)
  'Dnevnik': 'mainstream',
  // Baltic states — Eastern flank (#5952)
  'ERR News': 'mainstream', 'LRT English': 'mainstream', 'LSM English': 'mainstream',
  // Turkey EN path (#5952)
  'Daily Sabah': 'mainstream',
  // Czech (CS) — V4 balance (#5952)
  'Seznam Zprávy': 'mainstream',
  // Hindi (HI)
  'BBC Hindi': 'mainstream', 'Aaj Tak': 'mainstream', 'NDTV India': 'mainstream', 'Amar Ujala': 'mainstream',
  // Hungarian (HU)
  'Telex': 'mainstream', 'Index.hu': 'mainstream', 'HVG': 'mainstream',
  '444.hu': 'mainstream', '24.hu': 'mainstream', 'Híradó': 'mainstream',
  'ATV': 'mainstream', 'Portfolio.hu': 'market',
  'SVT Nyheter': 'mainstream', 'Dagens Nyheter': 'mainstream', 'Svenska Dagbladet': 'mainstream',
  // Brazilian Addition
  'Brasil Paralelo': 'mainstream',

  // Market/Finance
  'CNBC': 'market', 'MarketWatch': 'market', 'Yahoo Finance': 'market',
  'Financial Times': 'market',
  'Shanghai Stock Exchange': 'market', 'Shenzhen Stock Exchange': 'market',

  // Tech
  'Hacker News': 'tech', 'Ars Technica': 'tech', 'The Verge': 'tech',
  'The Verge AI': 'tech', 'MIT Tech Review': 'tech', 'TechCrunch Layoffs': 'tech',
  'AI News': 'tech', 'ArXiv AI': 'tech', 'VentureBeat AI': 'tech',
  'Layoffs.fyi': 'tech', 'Layoffs News': 'tech',

  // Regional Tech Startups
  'EU Startups': 'tech', 'Tech.eu': 'tech', 'Sifted (Europe)': 'tech',
  'The Next Web': 'tech', 'Tech in Asia': 'tech', 'e27 (SEA)': 'tech',
  'DealStreetAsia': 'tech', 'Pandaily (China)': 'tech', '36Kr English': 'tech',
  'TechNode (China)': 'tech', 'The Bridge (Japan)': 'tech', 'Nikkei Tech': 'tech',
  'Inc42 (India)': 'tech', 'YourStory': 'tech', 'TechCabal (Africa)': 'tech',
  'Wamda (MENA)': 'tech', 'Magnitt': 'tech',

  // Think Tanks & Policy
  'Brookings Tech': 'intel', 'CSIS Tech': 'intel', 'Stanford HAI': 'intel',
  'AI Now Institute': 'intel', 'OECD Digital': 'intel', 'Bruegel (EU)': 'intel',
  'Chatham House Tech': 'intel', 'DigiChina': 'intel', 'Lowy Institute': 'intel',
  'EFF News': 'intel', 'Politico Tech': 'intel',
  // Security/Defense Think Tanks
  'RUSI': 'intel', 'Wilson Center': 'intel', 'GMF': 'intel',
  'Stimson Center': 'intel', 'CNAS': 'intel',
  // Nuclear & Arms Control
  'Arms Control Assn': 'intel', 'Bulletin of Atomic Scientists': 'intel',
  // Food Security & Regional
  'FAO GIEWS': 'gov', 'EU ISS': 'intel',
  // Investigative journalism & accountability
  'OCCRP': 'intel', 'DFRLab': 'intel', 'Lighthouse Reports': 'intel', 'The Sentry': 'intel', 'GITOC': 'intel', 'VSquare': 'intel', 'Correctiv': 'intel',
  // New verified think tanks
  'War on the Rocks': 'intel', 'AEI': 'intel', 'Responsible Statecraft': 'intel',
  'FPRI': 'intel', 'Jamestown': 'intel',

  // Podcasts & Newsletters
  'Acquired Podcast': 'tech', 'All-In Podcast': 'tech', 'a16z Podcast': 'tech',
  'This Week in Startups': 'tech', 'The Twenty Minute VC': 'tech',
  'Hard Fork (NYT)': 'tech', 'Pivot (Vox)': 'tech', 'Stratechery': 'tech',
  'Benedict Evans': 'tech', 'How I Built This': 'tech', 'Masters of Scale': 'tech',
// Periphery packs (#5953) — Caucasus
  'Civil.ge': 'mainstream', 'OC Media': 'mainstream', 'JAMnews': 'mainstream',
  'Azertag': 'wire', 'Armenpress': 'wire',
  // Periphery packs (#5953) — Belarus / Moldova
  'Zerkalo': 'mainstream', 'NewsMaker': 'mainstream', 'Ziarul de Gardă': 'mainstream',
  // Periphery packs (#5953) — Central Asia
  'Eurasianet': 'mainstream', 'RFE/RL Central Asia': 'mainstream',
  'The Astana Times': 'mainstream', 'The Times of Central Asia': 'mainstream',
  // Indo-Pacific feeds (#5954)
  'Focus Taiwan': 'wire', 'Taipei Times': 'mainstream', 'Taiwan News': 'mainstream',
  'Dawn': 'mainstream', 'Geo News': 'mainstream',
  'Jakarta Post': 'mainstream', 'Rappler': 'mainstream', 'The Star (Malaysia)': 'mainstream', 'Irrawaddy': 'mainstream',
};

export function getSourceType(sourceName: string): SourceType {
  return SOURCE_TYPES[sourceName] ?? 'unknown';
}

export function hasReviewedSourceType(sourceName: string): boolean {
  return Object.prototype.hasOwnProperty.call(SOURCE_TYPES, sourceName);
}

/** True when a source type is either reviewed or explicitly declared unknown. */
export function hasDeclaredSourceType(sourceName: string): boolean {
  return hasReviewedSourceType(sourceName)
    || Object.prototype.hasOwnProperty.call(CONFIGURED_SOURCE_PROVENANCE_DECLARATIONS, sourceName);
}

// Propaganda risk assessment for sources (Quick Win #5)
// 'high' = State-controlled media, known to push government narratives
// 'medium' = State-affiliated or known editorial bias toward specific governments
// 'low' = Independent journalism with editorial standards (must be explicit — never defaulted)
// 'unknown' = Not yet reviewed (default for unlisted sources — do not imply independence)
export type PropagandaRisk = 'low' | 'medium' | 'high' | 'unknown';

export interface SourceRiskProfile {
  risk: PropagandaRisk;
  stateAffiliated?: string;
  knownBiases?: string[];
  note?: string;
}

/** Fail-closed default: missing provenance is not independent journalism. */
export const UNREVIEWED_SOURCE_RISK: Readonly<SourceRiskProfile> = Object.freeze({
  risk: 'unknown' as const,
  note: 'Provenance not yet reviewed — do not treat as independent journalism',
});

export const SOURCE_PROPAGANDA_RISK: Record<string, SourceRiskProfile> = {
  // High risk - State-controlled media
  'Xinhua': { risk: 'high', stateAffiliated: 'China', note: 'Official CCP news agency' },
  'TASS': { risk: 'high', stateAffiliated: 'Russia', note: 'Russian state news agency' },
  'RT': { risk: 'high', stateAffiliated: 'Russia', note: 'Russian state media, banned in EU' },
  'RT Russia': { risk: 'high', stateAffiliated: 'Russia', note: 'Russian state media, Russia desk' },
  'Sputnik': { risk: 'high', stateAffiliated: 'Russia', note: 'Russian state media' },
  'CGTN': { risk: 'high', stateAffiliated: 'China', note: 'Chinese state broadcaster' },
  'Press TV': { risk: 'high', stateAffiliated: 'Iran', note: 'Iranian state media' },
  'IRNA': { risk: 'high', stateAffiliated: 'Iran', note: 'Iranian state news agency (Islamic Republic News Agency)' },
  'Mehr News': { risk: 'high', stateAffiliated: 'Iran', note: 'Iranian state-affiliated, Basij-linked' },
  'KCNA': { risk: 'high', stateAffiliated: 'North Korea', note: 'North Korean state media' },
  // Official Chinese ministry feeds (government sources, not independent media)
  'MIIT (China)': {
    risk: 'high',
    stateAffiliated: 'China',
    note: 'Chinese Ministry of Industry and Information Technology official feed',
  },
  'MOFCOM (China)': {
    risk: 'high',
    stateAffiliated: 'China',
    note: 'Chinese Ministry of Commerce official feed',
  },
  // Official exchange authorities. These are authoritative primary publishers,
  // not independent journalism; omit stateAffiliated so the shared validator
  // does not conflate an exchange authority with state-controlled media.
  'Shanghai Stock Exchange': {
    risk: 'high',
    note: 'Official mainland China exchange authority; metadata-only source',
  },
  'Shenzhen Stock Exchange': {
    risk: 'high',
    note: 'Official mainland China exchange authority; metadata-only source',
  },
  'Taiwan Ministry of National Defense': {
    risk: 'high',
    stateAffiliated: 'Taiwan',
    note: 'Direct government activity reports; treat values as official publisher claims, not independent observations',
  },
  'Japan Joint Staff': {
    risk: 'high',
    stateAffiliated: 'Japan',
    note: 'Direct government activity reports; only manually reviewed documents are admitted as regional augmentation',
  },
  'CAC (China)': {
    risk: 'high',
    stateAffiliated: 'China',
    note: 'Cyberspace Administration of China official publication',
  },
  'SAMR (China)': {
    risk: 'high',
    stateAffiliated: 'China',
    note: 'State Administration for Market Regulation official publication',
  },
  'NDRC (China)': {
    risk: 'high',
    stateAffiliated: 'China',
    note: 'National Development and Reform Commission official publication',
  },
  'NBS (China)': {
    risk: 'high',
    stateAffiliated: 'China',
    note: 'National Bureau of Statistics of China official data release',
  },
  'PBoC (China)': {
    risk: 'high',
    stateAffiliated: 'China',
    note: "People's Bank of China official publication",
  },
  'SAFE (China)': {
    risk: 'high',
    stateAffiliated: 'China',
    note: 'State Administration of Foreign Exchange official data release',
  },
  'GACC (China)': {
    risk: 'high',
    stateAffiliated: 'China',
    note: 'General Administration of Customs of China official data release',
  },

  // Medium risk - State-affiliated or known bias
  'Al Jazeera': { risk: 'medium', stateAffiliated: 'Qatar', note: 'Qatari state-funded, independent editorial' },
  'Al Arabiya': { risk: 'medium', stateAffiliated: 'Saudi Arabia', note: 'Saudi-owned, reflects Gulf perspective' },
  'TRT World': { risk: 'medium', stateAffiliated: 'Turkey', note: 'Turkish state broadcaster' },
  'France 24': { risk: 'medium', stateAffiliated: 'France', note: 'French state-funded, editorially independent' },
  'EuroNews': { risk: 'low', note: 'European public broadcaster consortium', knownBiases: ['Pro-EU'] },
  'Le Monde': { risk: 'low', note: 'French newspaper of record' },
  'DW News': { risk: 'medium', stateAffiliated: 'Germany', note: 'German state-funded, editorially independent' },
  'Voice of America': { risk: 'medium', stateAffiliated: 'USA', note: 'US government-funded' },
  'Kyiv Independent': { risk: 'medium', knownBiases: ['Pro-Ukraine'], note: 'Ukrainian English-language primary on Russia-Ukraine war (#5950 balance: dedicated UA voice)' },
  // Ukraine depth pack (#5951) — local institutions + frontline assessment
  'Ukrinform': { risk: 'high', stateAffiliated: 'Ukraine', note: 'Ukrainian national state news agency (UKRINFORM)' },
  'Suspilne': { risk: 'medium', stateAffiliated: 'Ukraine', note: 'Ukrainian public broadcaster, state-funded' },
  'Ukrainska Pravda EN': { risk: 'medium', knownBiases: ['Pro-Ukraine'], note: 'Independent Ukrainian outlet, high-signal English edition' },
  'NV EN': { risk: 'medium', knownBiases: ['Pro-Ukraine'], note: 'New Voice of Ukraine English edition, independent' },
  'Hromadske EN': { risk: 'medium', knownBiases: ['Pro-Ukraine'], note: 'Ukrainian independent public broadcaster (English)' },
  // Ukrainian native outlets (#5959) — locale-boosted for uk UI
  'Ukrainska Pravda': { risk: 'medium', knownBiases: ['Pro-Ukraine'], note: 'Independent Ukrainian outlet, Ukrainian-language edition' },
  'Hromadske': { risk: 'medium', knownBiases: ['Pro-Ukraine'], note: 'Ukrainian independent public broadcaster (Ukrainian)' },
  'Bihus.Info': { risk: 'medium', knownBiases: ['Pro-Ukraine'], note: 'Ukrainian investigative anti-corruption outlet' },
  'Slidstvo.Info': { risk: 'medium', knownBiases: ['Pro-Ukraine'], note: 'Ukrainian investigative journalism project (Radio Free Europe partnership)' },
  'ZN.UA': { risk: 'medium', knownBiases: ['Pro-Ukraine'], note: 'Dzerkalo Tyzhnia — Ukrainian weekly analytical newspaper' },
  'ISW': { risk: 'low', note: 'Institute for the Study of War, nonpartisan research nonprofit, daily frontline assessments' },
  'Moscow Times': { risk: 'medium', knownBiases: ['Anti-Kremlin'], note: 'Independent English-language Russian outlet, critical of Kremlin' },
  // Independent RU exile press — not state media; eligible for EN defaults (#5950)
  'Meduza': { risk: 'low', knownBiases: ['Anti-Kremlin'], note: 'Independent Russian exile outlet (Riga); English + Russian RSS' },

  // Low risk - Independent with editorial standards (explicit)
  'Jerusalem Post': { risk: 'low', knownBiases: ['Israeli centre-right'], note: 'English-language Israeli daily of record' },
  'Ynetnews': { risk: 'low', knownBiases: ['Israeli mainstream'], note: 'Yedioth Ahronoth English edition' },
  'Digi24': { risk: 'low', note: 'Romanian independent news channel, member of ERNO' },
  'HotNews': { risk: 'low', note: 'Romanian independent online news portal' },
  'G4Media': { risk: 'low', note: 'Romanian independent investigative outlet' },
  'Dnevnik': { risk: 'low', note: 'Bulgarian independent daily newspaper' },
  'ERR News': { risk: 'low', note: 'Estonian Public Broadcasting English service' },
  'LRT English': { risk: 'low', note: 'Lithuanian Public Broadcasting English service' },
  'LSM English': { risk: 'low', note: 'Latvian Public Broadcasting English service' },
  'Daily Sabah': { risk: 'medium', stateAffiliated: 'Turkey', note: 'Turkish pro-government daily, English edition' },
  'Seznam Zprávy': { risk: 'low', note: 'Czech independent online news outlet' },
  'Reuters': { risk: 'low', note: 'Wire service, strict editorial standards' },
  'AP News': { risk: 'low', note: 'Wire service, nonprofit cooperative' },
  'AFP': { risk: 'low', note: 'Wire service, editorially independent' },
  'BBC World': { risk: 'low', note: 'Public broadcaster, editorial independence charter' },
  'BBC Middle East': { risk: 'low', note: 'Public broadcaster, editorial independence charter' },
  'Guardian World': { risk: 'low', knownBiases: ['Center-left'], note: 'Scott Trust ownership, no shareholders' },
  'Financial Times': { risk: 'low', note: 'Business focus, Nikkei-owned' },
  'Bellingcat': { risk: 'low', note: 'Open-source investigations, methodology transparent' },
  'Brasil Paralelo': { risk: 'low', note: 'Independent media company: no political ties, no public funding, 100% subscriber-funded.' },
  // Periphery packs (#5953) — Caucasus
  'Civil.ge': { risk: 'low', note: 'Independent Georgian English-language news outlet' },
  'OC Media': { risk: 'low', note: 'Independent South Caucasus regional news outlet' },
  'JAMnews': { risk: 'medium', note: 'Regional Caucasus news platform, limited editorial transparency' },
  'Azertag': { risk: 'high', stateAffiliated: 'Azerbaijan', note: 'Azerbaijani state news agency (AZERTAC)' },
  'Armenpress': { risk: 'high', stateAffiliated: 'Armenia', note: 'Armenian state news agency' },
  // Periphery packs (#5953) — Belarus / Moldova
  'Zerkalo': { risk: 'low', note: 'Independent Belarusian exile news outlet (formerly TUT.BY)' },
  'NewsMaker': { risk: 'medium', note: 'Moldovan independent news outlet; configured Russian-language feed' },
  'Ziarul de Gardă': { risk: 'medium', note: 'Moldovan investigative journalism outlet, Romanian-language' },
  // Periphery packs (#5953) — Central Asia
  'Eurasianet': { risk: 'medium', note: 'Nonprofit regional news covering Eurasia, Carnegie-funded' },
  'RFE/RL Central Asia': { risk: 'medium', stateAffiliated: 'USA', note: 'US government-funded Central Asia desk (Radio Free Europe)' },
  'The Astana Times': { risk: 'medium', stateAffiliated: 'Kazakhstan', note: 'Kazakhstan government-funded English-language news' },
  'The Times of Central Asia': { risk: 'medium', note: 'Independent English-language Central Asia news outlet' },
};

export function getSourcePropagandaRisk(sourceName: string): SourceRiskProfile {
  return SOURCE_PROPAGANDA_RISK[sourceName] ?? UNREVIEWED_SOURCE_RISK;
}

export function hasReviewedPropagandaRisk(sourceName: string): boolean {
  return Object.prototype.hasOwnProperty.call(SOURCE_PROPAGANDA_RISK, sourceName);
}

/** True when propaganda risk is either reviewed or explicitly declared unknown. */
export function hasDeclaredPropagandaRisk(sourceName: string): boolean {
  return hasReviewedPropagandaRisk(sourceName)
    || Object.prototype.hasOwnProperty.call(CONFIGURED_SOURCE_PROVENANCE_DECLARATIONS, sourceName);
}

export function isStateAffiliatedSource(sourceName: string): boolean {
  const profile = SOURCE_PROPAGANDA_RISK[sourceName];
  return !!profile?.stateAffiliated;
}

/**
 * Tooltip for the Tier 1/2 credibility badge.
 * Never presents unreviewed / non-wire / non-gov sources as "Verified News Outlet".
 */
export function getSourceTierBadgeTitle(sourceType: SourceType): string {
  if (sourceType === 'wire') return 'Wire Service - Highest reliability';
  if (sourceType === 'gov') return 'Official Government Source';
  if (sourceType === 'unknown') return 'Source type not yet reviewed';
  if (sourceType === 'intel') return 'Specialist / intel outlet';
  if (sourceType === 'mainstream') return 'Major news outlet';
  if (sourceType === 'market') return 'Market / financial outlet';
  if (sourceType === 'tech') return 'Technology outlet';
  return 'News source';
}

/**
 * Propaganda-risk badge presentation. `null` only for explicit reviewed `low`
 * (independent journalism). Unknown always surfaces so silence never implies independence.
 */
export function describePropagandaBadge(profile: SourceRiskProfile, sourceType: SourceType = 'unknown'): {
  risk: PropagandaRisk;
  label: string;
  shortLabel: string;
  title: string;
} | null {
  if (profile.risk === 'unknown') {
    return {
      risk: 'unknown',
      label: '? Unreviewed',
      shortLabel: '?',
      title: profile.note || UNREVIEWED_SOURCE_RISK.note || 'Provenance not yet reviewed',
    };
  }
  const title = profile.note
    || (sourceType === 'gov'
      ? `Official government source${profile.stateAffiliated ? `: ${profile.stateAffiliated}` : ''}`
      : profile.stateAffiliated
        ? `State-affiliated: ${profile.stateAffiliated}`
        : 'Provenance not yet reviewed');
  if (sourceType === 'gov') {
    return {
      risk: profile.risk,
      label: 'Official Government Source',
      shortLabel: 'Gov',
      title,
    };
  }
  if (profile.risk === 'low') return null;
  if (profile.risk === 'high') {
    return { risk: 'high', label: '⚠ State Media', shortLabel: '⚠', title };
  }
  return { risk: 'medium', label: '! Caution', shortLabel: '!', title };
}

export interface SourceProvenanceState {
  risk: PropagandaRisk;
  type: SourceType;
  riskDeclared: boolean;
  typeDeclared: boolean;
  riskReviewed: boolean;
  typeReviewed: boolean;
  stateAffiliated?: string;
  note?: string;
}

/** Complete, fail-closed provenance state for UI and agent consumers. */
export function getSourceProvenanceState(sourceName: string): SourceProvenanceState {
  const profile = getSourcePropagandaRisk(sourceName);
  return {
    risk: profile.risk,
    type: getSourceType(sourceName),
    riskDeclared: hasDeclaredPropagandaRisk(sourceName),
    typeDeclared: hasDeclaredSourceType(sourceName),
    riskReviewed: hasReviewedPropagandaRisk(sourceName),
    typeReviewed: hasReviewedSourceType(sourceName),
    ...(profile.stateAffiliated ? { stateAffiliated: profile.stateAffiliated } : {}),
    ...(profile.note ? { note: profile.note } : {}),
  };
}
