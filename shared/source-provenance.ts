// Canonical source provenance registry shared by the browser UI and MCP tools.
// Keep this module runtime-neutral so it remains safe in both runtimes.
import { CONFIGURED_SOURCE_PROVENANCE_DECLARATIONS } from './source-provenance-declarations';
import { X_ACCOUNT_SOURCE_PROPAGANDA_RISK, X_ACCOUNT_SOURCE_TYPES } from './x-account-trust';
import {
  TELEGRAM_SOURCE_PROPAGANDA_RISK,
  TELEGRAM_SOURCE_TYPES,
} from './telegram-channel-trust';

// 'unknown' = not yet reviewed (default for unlisted sources — never invent a type)
// 'other' remains available as an explicit classification when needed.
export type SourceType = 'wire' | 'gov' | 'intel' | 'mainstream' | 'market' | 'tech' | 'other' | 'unknown';

export const SOURCE_TYPES: Record<string, SourceType> = {
  // Wire services - fastest, most authoritative
  'Reuters': 'wire', 'Reuters World': 'wire', 'Reuters Business': 'wire',
  'AP News': 'wire', 'AFP': 'wire', 'Bloomberg': 'wire',

  // Government & International Org sources
  'White House': 'gov', 'White House Actions': 'gov', 'State Dept': 'gov', 'Pentagon': 'gov',
  'Treasury': 'gov', 'DOJ': 'gov', 'DHS': 'gov', 'CDC': 'gov',
  'FEMA': 'gov', 'Federal Reserve': 'gov', 'SEC': 'gov',
  'U.S. Trade Representative': 'gov',
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
  'Handelsblatt': 'market', 'Welt': 'mainstream', 'Telegraph': 'mainstream',
  'Interfax RU': 'wire', 'Interfax EN': 'wire',
  'NOS Nieuws': 'mainstream', 'NRC': 'mainstream', 'De Telegraaf': 'mainstream',
  // Croatian (HR)
  'N1 Croatia': 'mainstream', 'Index.hr': 'mainstream', 'Jutarnji list': 'mainstream',
  'Balkan Insight': 'intel',
  // Romanian (RO) — Eastern flank (#5952)
  'Digi24': 'mainstream', 'HotNews': 'mainstream', 'G4Media': 'mainstream',
  // Bulgarian (BG) — Black Sea flank (#5952)
  'Dnevnik': 'mainstream',
  // Greek (EL) — locale-boosted; Kathimerini is the EN strategic default
  'Kathimerini': 'mainstream', 'Naftemporiki': 'mainstream', 'in.gr': 'mainstream',
  'iefimerida': 'mainstream', 'Proto Thema': 'mainstream',
  'ERT': 'mainstream', 'AMNA': 'wire',
  'Ta Nea': 'mainstream', 'Liberal GR': 'mainstream', 'CNN Greece': 'mainstream',
  // Baltic states — Eastern flank (#5952)
  'ERR News': 'mainstream', 'LRT English': 'mainstream', 'LSM English': 'mainstream',
  // Turkey EN path (#5952)
  'Daily Sabah': 'mainstream',
  // Polish (PL) depth — catalog opt-in, locale-boosted
  'PAP': 'wire', 'Gazeta Wyborcza': 'mainstream', 'Polityka': 'mainstream',
  'Onet': 'mainstream', 'OKO.press': 'intel', 'TVP Info': 'mainstream',
  // Czech (CS) — V4 balance (#5952)
  'Seznam Zprávy': 'mainstream',
  // Hindi (HI)
  'BBC Hindi': 'mainstream', 'Aaj Tak': 'mainstream', 'NDTV India': 'mainstream', 'Amar Ujala': 'mainstream',
  // Hungarian (HU)
  'Telex': 'mainstream', 'Index.hu': 'mainstream', 'HVG': 'mainstream',
  '444.hu': 'mainstream', '24.hu': 'mainstream', 'Híradó': 'mainstream',
  'ATV': 'mainstream', 'Portfolio.hu': 'market',
  'SVT Nyheter': 'mainstream', 'Dagens Nyheter': 'mainstream', 'Svenska Dagbladet': 'mainstream',
  // Canada + Arctic/Nordic pack (#5960) + depth pack (#6604/#6605)
  'CBC News': 'mainstream', 'Globe and Mail': 'mainstream', 'Global News': 'mainstream',
  'Toronto Star': 'mainstream', 'National Post': 'mainstream',
  'Financial Post': 'market', 'iPolitics': 'mainstream',
  'The Narwhal': 'mainstream', 'The Tyee': 'mainstream', "Maclean's": 'mainstream',
  'Radio-Canada': 'mainstream', 'La Presse': 'mainstream', 'Le Devoir': 'mainstream',
  'TVA Nouvelles': 'mainstream',
  'Vancouver Sun': 'mainstream', 'Calgary Herald': 'mainstream',
  'Winnipeg Free Press': 'mainstream', 'Edmonton Journal': 'mainstream',
  'Ottawa Citizen': 'mainstream', 'The Province': 'mainstream',
  'CTV News': 'mainstream', 'CP24': 'mainstream',
  'Montreal Gazette': 'mainstream',
  'Yle News': 'mainstream', 'NRK': 'mainstream', 'Aftenposten': 'mainstream',
  'DR Nyheder': 'mainstream', 'Arctic Today': 'mainstream',
  // Brazilian Addition
  'Brasil Paralelo': 'mainstream',

  // Market/Finance
  'CNBC': 'market', 'MarketWatch': 'market', 'Yahoo Finance': 'market',
  'Financial Times': 'market',
  'Fox Business': 'market', 'Business Insider': 'market', 'Jin10': 'market',
  'Coinbase Blog': 'market', 'Binance Announcements': 'market',
  // Press-release distribution is publisher-submitted content. Do not label
  // these feeds as independent wire reporting.
  'GlobeNewswire': 'other', 'Business Wire': 'other', 'PR Newswire': 'other', 'Chainwire': 'other',
  'Shanghai Stock Exchange': 'market', 'Shenzhen Stock Exchange': 'market',

  // Tech
  'Hacker News': 'tech', 'Ars Technica': 'tech', 'The Verge': 'tech',
  'The Verge AI': 'tech', 'MIT Tech Review': 'tech', 'TechCrunch Layoffs': 'tech',
  'AI News': 'tech', 'ArXiv AI': 'tech', 'VentureBeat AI': 'tech', 'Wired': 'tech',
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
  // Validated crisis desks (#6813-#6830)
  'Yemen Online': 'mainstream', "Sana'a Center": 'intel',
  'Syria Direct': 'mainstream', 'Enab Baladi English': 'mainstream',
  '+972 Magazine': 'mainstream', 'WAFA English': 'gov',
  'HaitiLibre English': 'mainstream', 'AyiboPost': 'mainstream',
  'Amu TV': 'mainstream', 'Pajhwok Afghan News': 'wire',
  'Naharnet Lebanon': 'mainstream', "L'Orient Today": 'mainstream', 'Annahar': 'mainstream',
  'Studio Tamani': 'mainstream', 'leFaso.net': 'mainstream',
  'ActuNiger': 'mainstream', 'Aïr Info': 'mainstream',
  'Caracas Chronicles': 'mainstream', 'Efecto Cocuyo': 'mainstream',
  'Havana Times': 'mainstream', '14ymedio': 'mainstream',
  'Libya Herald': 'mainstream', 'Egypt Independent': 'mainstream',
  'Mada Masr': 'mainstream', 'The Daily Star': 'mainstream',
  'Dhaka Tribune': 'mainstream', 'Daily Nation': 'mainstream',
  'Times of India': 'mainstream',
  'The Guardian Post': 'mainstream', 'Tchadinfos': 'mainstream',
  'Alwihda Info': 'mainstream', 'Radio Ndeke Luka': 'mainstream',

  // Telegram channels (#6600). Additive keys keyed by channel display label.
  ...TELEGRAM_SOURCE_TYPES,

  // Curated X news-account overlay (#6654). Additive to Telegram.
  ...X_ACCOUNT_SOURCE_TYPES,
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
  'U.S. Trade Representative': {
    risk: 'high',
    stateAffiliated: 'USA',
    note: 'Official U.S. government trade-policy publication; treat statements as primary government claims',
  },

  // Medium risk - State-affiliated or known bias
  'Al Jazeera': { risk: 'medium', stateAffiliated: 'Qatar', note: 'Qatari state-funded, independent editorial' },
  'Al Arabiya': { risk: 'medium', stateAffiliated: 'Saudi Arabia', note: 'Saudi-owned, reflects Gulf perspective' },
  'TRT World': { risk: 'medium', stateAffiliated: 'Turkey', note: 'Turkish state broadcaster' },
  'France 24': { risk: 'medium', stateAffiliated: 'France', note: 'French state-funded, editorially independent' },
  'EuroNews': { risk: 'low', note: 'European public broadcaster consortium', knownBiases: ['Pro-EU'] },
  'Le Monde': { risk: 'low', note: 'French newspaper of record' },
  'DW News': { risk: 'medium', stateAffiliated: 'Germany', note: 'German state-funded, editorially independent' },
  'ERT': { risk: 'medium', stateAffiliated: 'Greece', note: 'Greek public broadcaster' },
  'AMNA': { risk: 'medium', stateAffiliated: 'Greece', note: 'Greek national news agency' },
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
  'Interfax RU': { risk: 'medium', note: 'Russian private news agency operating under domestic media restrictions; Russian-language feed' },
  'Interfax EN': { risk: 'medium', note: 'Russian private news agency operating under domestic media restrictions; English-language edition' },
  'GlobeNewswire': { risk: 'medium', note: 'Publisher-submitted press releases; not independent reporting' },
  'Business Wire': { risk: 'medium', note: 'Publisher-submitted press releases; not independent reporting' },
  'PR Newswire': { risk: 'medium', note: 'Publisher-submitted press releases; not independent reporting' },
  'Chainwire': { risk: 'medium', note: 'Paid crypto press-release distribution; not independent reporting' },
  'Coinbase Blog': { risk: 'medium', note: 'Coinbase first-party company publication; treat statements as issuer claims' },
  'Binance Announcements': { risk: 'medium', note: 'Binance first-party announcement channel; treat statements as issuer claims' },
  'Jin10': { risk: 'medium', note: 'Chinese financial-news and market-data publisher; limited English editorial transparency' },
  // Independent RU exile press — not state media; eligible for EN defaults (#5950)
  'Meduza': { risk: 'low', knownBiases: ['Anti-Kremlin'], note: 'Independent Russian exile outlet (Riga); English + Russian RSS' },

  // Validated crisis desks (#6813-#6830). These declarations are editorial
  // provenance, not endorsements of every publisher claim.
  'Yemen Online': { risk: 'medium', note: 'Independent English-language Yemeni platform; exile and conflict-reporting context' },
  "Sana'a Center": { risk: 'low', note: 'Independent Yemeni policy and analysis center' },
  'Syria Direct': { risk: 'low', note: 'Independent nonprofit Syria newsroom' },
  'Enab Baladi English': { risk: 'medium', knownBiases: ['Syrian opposition perspective'], note: 'Independent Syrian newsroom founded by citizen journalists' },
  '+972 Magazine': { risk: 'medium', knownBiases: ['Israeli-Palestinian human-rights perspective'], note: 'Independent Israeli-Palestinian magazine' },
  'WAFA English': { risk: 'high', stateAffiliated: 'Palestine', note: 'Official Palestinian news agency; treat statements as government claims' },
  'HaitiLibre English': { risk: 'medium', note: 'Translated Haiti-focused desk; retain explicit publisher attribution' },
  'AyiboPost': { risk: 'low', note: 'Independent Haitian investigative newsroom' },
  'Amu TV': { risk: 'medium', note: 'Independent Afghan exile newsroom with reporters inside Afghanistan' },
  'Pajhwok Afghan News': { risk: 'medium', note: 'Independent Kabul-based news agency operating under domestic restrictions' },
  'Naharnet Lebanon': { risk: 'low', note: 'Independent Lebanese digital outlet' },
  "L'Orient Today": { risk: 'low', note: 'Independent English-language Lebanese newsroom' },
  'Annahar': { risk: 'low', note: 'Independent Lebanese Arabic-language political newspaper' },
  'PAP': { risk: 'medium', stateAffiliated: 'Poland', note: 'Polish national news agency (Polska Agencja Prasowa); state-owned wire' },
  'Gazeta Wyborcza': { risk: 'low', note: 'Independent Polish daily newspaper published by Agora' },
  'Polityka': { risk: 'low', note: 'Independent Polish weekly news magazine' },
  'Onet': { risk: 'low', note: 'Polish commercial news portal published by Ringier Axel Springer Polska' },
  'OKO.press': { risk: 'low', note: 'Independent Polish investigative and fact-checking outlet' },
  'TVP Info': { risk: 'medium', stateAffiliated: 'Poland', note: 'Polish public-service news channel; state-funded broadcaster' },
  'Studio Tamani': { risk: 'low', note: 'Mali newsroom operated by Fondation Hirondelle; Journalism Trust Initiative certified' },
  'leFaso.net': { risk: 'low', note: 'Independent Burkina Faso digital newsroom' },
  'ActuNiger': { risk: 'medium', note: 'Niger-focused independent newsroom' },
  'Aïr Info': { risk: 'low', note: 'Independent northern Niger and Agadez newsroom' },
  'Caracas Chronicles': { risk: 'medium', knownBiases: ['Opposition-leaning Venezuela analysis'], note: 'Independent English-language Venezuela analysis outlet' },
  'Efecto Cocuyo': { risk: 'low', note: 'Independent Venezuelan newsroom' },
  'Havana Times': { risk: 'medium', knownBiases: ['Independent Cuban perspective'], note: 'Independent English-language Cuba-focused publication' },
  '14ymedio': { risk: 'medium', knownBiases: ['Cuban opposition perspective'], note: 'Independent Cuban digital newspaper' },
  'Libya Herald': { risk: 'medium', note: 'Independent English-language Libya newsroom in a polarized media environment' },
  'Egypt Independent': { risk: 'medium', note: 'Independent English-language Egypt newsroom operating under domestic restrictions' },
  'Mada Masr': { risk: 'medium', note: 'Independent Egyptian newsroom operating under domestic restrictions' },
  'The Daily Star': { risk: 'low', note: 'Independent English-language Bangladesh newspaper' },
  'Dhaka Tribune': { risk: 'low', note: 'Independent English-language Bangladesh newspaper' },
  'Daily Nation': { risk: 'low', note: 'Kenyan newspaper published by Nation Media Group' },
  'The Guardian Post': { risk: 'medium', note: 'Independent Cameroon English-language newspaper' },
  'Tchadinfos': { risk: 'medium', note: 'Chad-focused French-language newsroom' },
  'Alwihda Info': { risk: 'medium', note: 'Pan-African French-language publisher with Chad coverage; source mapping is not article geolocation' },
  'Radio Ndeke Luka': { risk: 'low', note: 'CAR-focused newsroom; Journalism Trust Initiative certified' },

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
  // Canada + Arctic/Nordic pack (#5960) + depth pack (#6604/#6605)
  'CBC News': { risk: 'medium', stateAffiliated: 'Canada', note: 'Canadian public broadcaster (CBC/Radio-Canada), editorially independent charter' },
  'Globe and Mail': { risk: 'low', note: 'Canadian newspaper of record' },
  'Global News': { risk: 'low', note: 'Canadian national news network (Corus Entertainment)' },
  'Toronto Star': { risk: 'low', note: 'Canadian metropolitan daily newspaper of record (Toronto)' },
  'National Post': { risk: 'low', note: 'Canadian national newspaper (Postmedia)' },
  'Financial Post': { risk: 'low', note: 'Canadian business newspaper (Postmedia)' },
  'iPolitics': { risk: 'low', note: 'Canadian political news outlet' },
  'The Narwhal': { risk: 'low', note: 'Canadian independent environmental investigative outlet' },
  'The Tyee': { risk: 'low', note: 'Canadian independent British Columbia news magazine' },
  "Maclean's": { risk: 'low', note: 'Canadian national news magazine' },
  'Radio-Canada': { risk: 'medium', stateAffiliated: 'Canada', note: 'CBC/Radio-Canada French service, editorially independent charter' },
  'La Presse': { risk: 'low', note: 'Quebec French-language daily newspaper' },
  'Le Devoir': { risk: 'low', note: 'Quebec French-language newspaper of record' },
  'TVA Nouvelles': { risk: 'low', note: 'Quebec private television news (Quebecor); not state-affiliated' },
  'Vancouver Sun': { risk: 'low', note: 'Vancouver daily newspaper (Postmedia)' },
  'Calgary Herald': { risk: 'low', note: 'Calgary daily newspaper (Postmedia)' },
  'Winnipeg Free Press': { risk: 'low', note: 'Winnipeg daily newspaper' },
  'Edmonton Journal': { risk: 'low', note: 'Edmonton daily newspaper (Postmedia)' },
  'Ottawa Citizen': { risk: 'low', note: 'Ottawa daily newspaper (Postmedia)' },
  'The Province': { risk: 'low', note: 'Vancouver daily tabloid (Postmedia)' },
  'CTV News': { risk: 'low', note: 'Canadian national television news (Bell Media); GNews site: fallback, no native RSS' },
  'CP24': { risk: 'low', note: 'Toronto 24-hour news channel (Bell Media); GNews site: fallback, no native RSS' },
  'Montreal Gazette': { risk: 'low', note: 'Montreal English daily (Postmedia); GNews site: fallback, native RSS dead' },
  'Yle News': { risk: 'medium', stateAffiliated: 'Finland', note: 'Finnish public broadcaster English service (Yle)' },
  'NRK': { risk: 'medium', stateAffiliated: 'Norway', note: 'Norwegian public broadcaster' },
  'Aftenposten': { risk: 'low', note: 'Norwegian newspaper of record (Schibsted)' },
  'DR Nyheder': { risk: 'medium', stateAffiliated: 'Denmark', note: 'Danish public broadcaster (DR)' },
  'Arctic Today': { risk: 'low', note: 'Independent High North / Arctic security and business news' },
  'Daily Sabah': { risk: 'medium', stateAffiliated: 'Turkey', note: 'Turkish pro-government daily, English edition' },
  'Seznam Zprávy': { risk: 'low', note: 'Czech independent online news outlet' },
  'Reuters': { risk: 'low', note: 'Wire service, strict editorial standards' },
  'AP News': { risk: 'low', note: 'Wire service, nonprofit cooperative' },
  'AFP': { risk: 'low', note: 'Wire service, editorially independent' },
  'BBC World': { risk: 'low', note: 'Public broadcaster, editorial independence charter' },
  'BBC Middle East': { risk: 'low', note: 'Public broadcaster, editorial independence charter' },
  'Guardian World': { risk: 'low', knownBiases: ['Center-left'], note: 'Scott Trust ownership, no shareholders' },
  'Financial Times': { risk: 'low', note: 'Business focus, Nikkei-owned' },
  'Times of India': { risk: 'low', note: 'Major Indian national newspaper with an established editorial newsroom' },
  'Fox Business': { risk: 'low', note: 'Commercial U.S. business-news publisher' },
  'Business Insider': { risk: 'low', note: 'Commercial business-news publisher with editorial standards' },
  'Wired': { risk: 'low', note: 'Technology publication with editorial standards' },
  'Handelsblatt': { risk: 'low', note: 'German business newspaper with editorial standards' },
  'Welt': { risk: 'low', note: 'German national newspaper with editorial standards' },
  'Telegraph': { risk: 'low', note: 'British national newspaper with editorial standards' },
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

  // Telegram channels (#6600). Additive keys keyed by channel display label.
  ...TELEGRAM_SOURCE_PROPAGANDA_RISK,

  // Curated X news-account overlay (#6654). Additive to Telegram.
  ...X_ACCOUNT_SOURCE_PROPAGANDA_RISK,
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
