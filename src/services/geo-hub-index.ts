import { tokenizeForMatch, matchKeyword } from '@/utils/keyword-match';
// Geopolitical Hub Index - aggregates news by strategic locations

export interface GeoHubLocation {
  id: string;
  name: string;
  region: string;
  country: string;
  lat: number;
  lon: number;
  type: 'capital' | 'conflict' | 'strategic' | 'organization';
  tier: 'critical' | 'major' | 'notable';
  keywords: string[];
}

interface GeoHubIndex {
  hubs: Map<string, GeoHubLocation>;
  byKeyword: Map<string, string[]>;
}

let cachedIndex: GeoHubIndex | null = null;

// Strategic geopolitical locations
const GEO_HUBS: GeoHubLocation[] = [
  // Critical Capitals
  { id: 'washington', name: 'Washington DC', region: 'North America', country: 'USA', lat: 38.9072, lon: -77.0369, type: 'capital', tier: 'critical', keywords: ['washington', 'white house', 'pentagon', 'state department', 'congress', 'capitol hill', 'biden', 'trump'] },
  { id: 'moscow', name: 'Moscow', region: 'Europe', country: 'Russia', lat: 55.7558, lon: 37.6173, type: 'capital', tier: 'critical', keywords: ['moscow', 'kremlin', 'putin', 'russia', 'russian'] },
  { id: 'beijing', name: 'Beijing', region: 'Asia', country: 'China', lat: 39.9042, lon: 116.4074, type: 'capital', tier: 'critical', keywords: ['beijing', 'xi jinping', 'china', 'chinese', 'ccp', 'prc'] },
  { id: 'brussels', name: 'Brussels', region: 'Europe', country: 'Belgium', lat: 50.8503, lon: 4.3517, type: 'capital', tier: 'critical', keywords: ['brussels', 'eu', 'european union', 'nato', 'european commission'] },
  { id: 'london', name: 'London', region: 'Europe', country: 'UK', lat: 51.5074, lon: -0.1278, type: 'capital', tier: 'critical', keywords: ['london', 'uk', 'britain', 'british', 'downing street', 'parliament'] },

  // Major Capitals
  { id: 'jerusalem', name: 'Jerusalem', region: 'Middle East', country: 'Israel', lat: 31.7683, lon: 35.2137, type: 'capital', tier: 'major', keywords: ['jerusalem', 'israel', 'israeli', 'knesset', 'netanyahu'] },
  { id: 'telaviv', name: 'Tel Aviv', region: 'Middle East', country: 'Israel', lat: 32.0853, lon: 34.7818, type: 'capital', tier: 'major', keywords: ['tel aviv', 'idf', 'mossad'] },
  { id: 'tehran', name: 'Tehran', region: 'Middle East', country: 'Iran', lat: 35.6892, lon: 51.3890, type: 'capital', tier: 'major', keywords: ['tehran', 'iran', 'iranian', 'khamenei', 'irgc', 'ayatollah'] },
  { id: 'kyiv', name: 'Kyiv', region: 'Europe', country: 'Ukraine', lat: 50.4501, lon: 30.5234, type: 'capital', tier: 'major', keywords: ['kyiv', 'kiev', 'ukraine', 'ukrainian', 'zelensky', 'zelenskyy'] },
  { id: 'taipei', name: 'Taipei', region: 'Asia', country: 'Taiwan', lat: 25.0330, lon: 121.5654, type: 'capital', tier: 'major', keywords: ['taipei', 'taiwan', 'taiwanese', 'tsmc'] },
  { id: 'tokyo', name: 'Tokyo', region: 'Asia', country: 'Japan', lat: 35.6762, lon: 139.6503, type: 'capital', tier: 'major', keywords: ['tokyo', 'japan', 'japanese'] },
  { id: 'seoul', name: 'Seoul', region: 'Asia', country: 'South Korea', lat: 37.5665, lon: 126.9780, type: 'capital', tier: 'major', keywords: ['seoul', 'south korea', 'korean'] },
  { id: 'pyongyang', name: 'Pyongyang', region: 'Asia', country: 'North Korea', lat: 39.0392, lon: 125.7625, type: 'capital', tier: 'major', keywords: ['pyongyang', 'north korea', 'dprk', 'kim jong un'] },
  { id: 'newdelhi', name: 'New Delhi', region: 'Asia', country: 'India', lat: 28.6139, lon: 77.2090, type: 'capital', tier: 'major', keywords: ['new delhi', 'delhi', 'india', 'indian', 'modi'] },
  { id: 'riyadh', name: 'Riyadh', region: 'Middle East', country: 'Saudi Arabia', lat: 24.7136, lon: 46.6753, type: 'capital', tier: 'major', keywords: ['riyadh', 'saudi', 'saudi arabia', 'mbs', 'mohammed bin salman'] },
  { id: 'ankara', name: 'Ankara', region: 'Middle East', country: 'Turkey', lat: 39.9334, lon: 32.8597, type: 'capital', tier: 'major', keywords: ['ankara', 'turkey', 'turkish', 'erdogan'] },
  { id: 'paris', name: 'Paris', region: 'Europe', country: 'France', lat: 48.8566, lon: 2.3522, type: 'capital', tier: 'major', keywords: ['paris', 'france', 'french', 'macron', 'elysee'] },
  { id: 'berlin', name: 'Berlin', region: 'Europe', country: 'Germany', lat: 52.5200, lon: 13.4050, type: 'capital', tier: 'major', keywords: ['berlin', 'germany', 'german', 'scholz', 'bundestag'] },
  { id: 'cairo', name: 'Cairo', region: 'Middle East', country: 'Egypt', lat: 30.0444, lon: 31.2357, type: 'capital', tier: 'major', keywords: ['cairo', 'egypt', 'egyptian', 'sisi'] },
  { id: 'islamabad', name: 'Islamabad', region: 'Asia', country: 'Pakistan', lat: 33.6844, lon: 73.0479, type: 'capital', tier: 'major', keywords: ['islamabad', 'pakistan', 'pakistani'] },

  // Conflict Zones
  { id: 'gaza', name: 'Gaza', region: 'Middle East', country: 'Palestine', lat: 31.5, lon: 34.47, type: 'conflict', tier: 'critical', keywords: ['gaza', 'hamas', 'palestinian', 'rafah', 'khan younis', 'gaza strip'] },
  { id: 'westbank', name: 'West Bank', region: 'Middle East', country: 'Palestine', lat: 31.9, lon: 35.2, type: 'conflict', tier: 'major', keywords: ['west bank', 'ramallah', 'jenin', 'nablus', 'hebron'] },
  { id: 'ukraine-front', name: 'Ukraine Front', region: 'Europe', country: 'Ukraine', lat: 48.5, lon: 37.5, type: 'conflict', tier: 'critical', keywords: ['donbas', 'donbass', 'donetsk', 'luhansk', 'kharkiv', 'bakhmut', 'avdiivka', 'zaporizhzhia', 'kherson', 'crimea'] },
  { id: 'taiwan-strait', name: 'Taiwan Strait', region: 'Asia', country: 'International', lat: 24.5, lon: 119.5, type: 'conflict', tier: 'critical', keywords: ['taiwan strait', 'formosa', 'pla', 'chinese military'] },
  { id: 'southchinasea', name: 'South China Sea', region: 'Asia', country: 'International', lat: 12.0, lon: 114.0, type: 'strategic', tier: 'critical', keywords: ['south china sea', 'spratlys', 'paracels', 'nine-dash line', 'scarborough'] },
  { id: 'yemen', name: 'Yemen', region: 'Middle East', country: 'Yemen', lat: 15.5527, lon: 48.5164, type: 'conflict', tier: 'major', keywords: ['yemen', 'houthi', 'houthis', 'sanaa', 'aden'] },
  { id: 'syria', name: 'Syria', region: 'Middle East', country: 'Syria', lat: 34.8, lon: 39.0, type: 'conflict', tier: 'major', keywords: ['syria', 'syrian', 'assad', 'damascus', 'idlib', 'aleppo'] },
  { id: 'lebanon', name: 'Lebanon', region: 'Middle East', country: 'Lebanon', lat: 33.8547, lon: 35.8623, type: 'conflict', tier: 'major', keywords: ['lebanon', 'lebanese', 'hezbollah', 'beirut'] },
  { id: 'sudan', name: 'Sudan', region: 'Africa', country: 'Sudan', lat: 15.5007, lon: 32.5599, type: 'conflict', tier: 'major', keywords: ['sudan', 'sudanese', 'khartoum', 'rsf', 'darfur'] },
  { id: 'sahel', name: 'Sahel', region: 'Africa', country: 'International', lat: 15.0, lon: 0.0, type: 'conflict', tier: 'major', keywords: ['sahel', 'mali', 'niger', 'burkina faso', 'wagner', 'junta'] },
  { id: 'ethiopia', name: 'Ethiopia', region: 'Africa', country: 'Ethiopia', lat: 9.1450, lon: 40.4897, type: 'conflict', tier: 'notable', keywords: ['ethiopia', 'ethiopian', 'tigray', 'addis ababa', 'abiy ahmed'] },
  { id: 'myanmar', name: 'Myanmar', region: 'Asia', country: 'Myanmar', lat: 19.7633, lon: 96.0785, type: 'conflict', tier: 'notable', keywords: ['myanmar', 'burma', 'rohingya', 'junta', 'naypyidaw'] },

  // Strategic Chokepoints & Regions
  { id: 'hormuz', name: 'Strait of Hormuz', region: 'Middle East', country: 'International', lat: 26.5, lon: 56.5, type: 'strategic', tier: 'critical', keywords: ['hormuz', 'strait of hormuz', 'persian gulf', 'gulf'] },
  { id: 'redsea', name: 'Red Sea', region: 'Middle East', country: 'International', lat: 20.0, lon: 38.0, type: 'strategic', tier: 'critical', keywords: ['red sea', 'bab el-mandeb', 'bab al-mandab'] },
  { id: 'suez', name: 'Suez Canal', region: 'Middle East', country: 'Egypt', lat: 30.5, lon: 32.3, type: 'strategic', tier: 'critical', keywords: ['suez', 'suez canal'] },
  { id: 'baltic', name: 'Baltic Sea', region: 'Europe', country: 'International', lat: 58.0, lon: 20.0, type: 'strategic', tier: 'major', keywords: ['baltic', 'baltic sea', 'kaliningrad', 'gotland'] },
  { id: 'arctic', name: 'Arctic', region: 'Arctic', country: 'International', lat: 75.0, lon: 0.0, type: 'strategic', tier: 'major', keywords: ['arctic', 'northern sea route', 'svalbard'] },
  { id: 'blacksea', name: 'Black Sea', region: 'Europe', country: 'International', lat: 43.0, lon: 35.0, type: 'strategic', tier: 'major', keywords: ['black sea', 'bosphorus', 'sevastopol', 'odesa', 'odessa'] },

  // International Organizations (treat as "hubs")
  { id: 'un-nyc', name: 'United Nations', region: 'North America', country: 'USA', lat: 40.7489, lon: -73.9680, type: 'organization', tier: 'critical', keywords: ['united nations', 'un', 'security council', 'general assembly', 'unsc'] },
  { id: 'nato-hq', name: 'NATO HQ', region: 'Europe', country: 'Belgium', lat: 50.8796, lon: 4.4284, type: 'organization', tier: 'critical', keywords: ['nato', 'north atlantic', 'alliance', 'stoltenberg'] },
  { id: 'iaea-vienna', name: 'IAEA', region: 'Europe', country: 'Austria', lat: 48.2352, lon: 16.4156, type: 'organization', tier: 'major', keywords: ['iaea', 'atomic energy', 'nuclear watchdog', 'grossi'] },
];

function buildGeoHubIndex(): GeoHubIndex {
  if (cachedIndex) return cachedIndex;

  const hubs = new Map<string, GeoHubLocation>();
  const byKeyword = new Map<string, string[]>();

  const addKeyword = (keyword: string, hubId: string) => {
    const lower = keyword.toLowerCase();
    const existing = byKeyword.get(lower) || [];
    if (!existing.includes(hubId)) {
      existing.push(hubId);
      byKeyword.set(lower, existing);
    }
  };

  for (const hub of GEO_HUBS) {
    hubs.set(hub.id, hub);
    for (const kw of hub.keywords) {
      addKeyword(kw, hub.id);
    }
  }

  cachedIndex = { hubs, byKeyword };
  return cachedIndex;
}

export interface GeoHubMatch {
  hubId: string;
  hub: GeoHubLocation;
  confidence: number;
  matchedKeyword: string;
}

export function inferGeoHubsFromTitle(title: string): GeoHubMatch[] {
  const index = buildGeoHubIndex();
  const matches: GeoHubMatch[] = [];
  const tokens = tokenizeForMatch(title);
  const seenHubs = new Set<string>();

  for (const [keyword, hubIds] of index.byKeyword) {
    if (keyword.length < 2) continue;

    if (matchKeyword(tokens, keyword)) {
      for (const hubId of hubIds) {
        if (seenHubs.has(hubId)) continue;
        seenHubs.add(hubId);

        const hub = index.hubs.get(hubId);
        if (!hub) continue;

        let confidence = 0.5;
        if (keyword.length >= 10) confidence = 0.9;
        else if (keyword.length >= 6) confidence = 0.75;
        else if (keyword.length >= 4) confidence = 0.6;

        // Boost for conflict/strategic zones (more newsworthy)
        if (hub.type === 'conflict' || hub.type === 'strategic') {
          confidence = Math.min(1, confidence + 0.1);
        }

        // Boost for critical tier
        if (hub.tier === 'critical') {
          confidence = Math.min(1, confidence + 0.1);
        }

        matches.push({ hubId, hub, confidence, matchedKeyword: keyword });
      }
    }
  }

  matches.sort((a, b) => b.confidence - a.confidence);
  return matches;
}

export function getGeoHubById(hubId: string): GeoHubLocation | undefined {
  const index = buildGeoHubIndex();
  return index.hubs.get(hubId);
}

export function getAllGeoHubs(): GeoHubLocation[] {
  const index = buildGeoHubIndex();
  return Array.from(index.hubs.values());
}
