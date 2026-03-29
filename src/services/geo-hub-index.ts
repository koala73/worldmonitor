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
  // ── Critical Capitals ────────────────────────────────────────
  { id: 'washington', name: 'Washington DC', region: 'North America', country: 'USA', lat: 38.9072, lon: -77.0369, type: 'capital', tier: 'critical', keywords: ['washington', 'white house', 'pentagon', 'state department', 'congress', 'capitol hill', 'biden', 'trump'] },
  { id: 'moscow', name: 'Moscow', region: 'Europe', country: 'Russia', lat: 55.7558, lon: 37.6173, type: 'capital', tier: 'critical', keywords: ['moscow', 'kremlin', 'putin', 'russia', 'russian'] },
  { id: 'beijing', name: 'Beijing', region: 'Asia', country: 'China', lat: 39.9042, lon: 116.4074, type: 'capital', tier: 'critical', keywords: ['beijing', 'xi jinping', 'china', 'chinese', 'ccp', 'prc'] },
  { id: 'brussels', name: 'Brussels', region: 'Europe', country: 'Belgium', lat: 50.8503, lon: 4.3517, type: 'capital', tier: 'critical', keywords: ['brussels', 'european union', 'european commission'] },
  { id: 'london', name: 'London', region: 'Europe', country: 'UK', lat: 51.5074, lon: -0.1278, type: 'capital', tier: 'critical', keywords: ['london', 'uk', 'britain', 'british', 'downing street'] },

  // ── Middle East Capitals & Cities ────────────────────────────
  { id: 'jerusalem', name: 'Jerusalem', region: 'Middle East', country: 'Israel', lat: 31.7683, lon: 35.2137, type: 'capital', tier: 'major', keywords: ['jerusalem', 'israel', 'israeli', 'knesset', 'netanyahu'] },
  { id: 'telaviv', name: 'Tel Aviv', region: 'Middle East', country: 'Israel', lat: 32.0853, lon: 34.7818, type: 'capital', tier: 'major', keywords: ['tel aviv', 'idf', 'mossad'] },
  { id: 'haifa', name: 'Haifa', region: 'Middle East', country: 'Israel', lat: 32.794, lon: 34.9896, type: 'capital', tier: 'notable', keywords: ['haifa'] },
  { id: 'dimona', name: 'Dimona', region: 'Middle East', country: 'Israel', lat: 31.07, lon: 35.03, type: 'strategic', tier: 'notable', keywords: ['dimona', 'negev nuclear'] },
  { id: 'tehran', name: 'Tehran', region: 'Middle East', country: 'Iran', lat: 35.6892, lon: 51.389, type: 'capital', tier: 'major', keywords: ['tehran', 'iran', 'iranian', 'khamenei', 'irgc', 'ayatollah'] },
  { id: 'isfahan', name: 'Isfahan', region: 'Middle East', country: 'Iran', lat: 32.6546, lon: 51.668, type: 'capital', tier: 'notable', keywords: ['isfahan', 'esfahan'] },
  { id: 'abudhabi', name: 'Abu Dhabi', region: 'Middle East', country: 'UAE', lat: 24.4539, lon: 54.3773, type: 'capital', tier: 'major', keywords: ['abu dhabi', 'uae', 'emirati', 'united arab emirates', 'al dhafra'] },
  { id: 'dubai', name: 'Dubai', region: 'Middle East', country: 'UAE', lat: 25.2048, lon: 55.2708, type: 'capital', tier: 'major', keywords: ['dubai', 'jebel ali'] },
  { id: 'doha', name: 'Doha', region: 'Middle East', country: 'Qatar', lat: 25.2854, lon: 51.531, type: 'capital', tier: 'major', keywords: ['doha', 'qatar', 'qatari', 'al udeid'] },
  { id: 'manama', name: 'Manama', region: 'Middle East', country: 'Bahrain', lat: 26.2285, lon: 50.586, type: 'capital', tier: 'major', keywords: ['manama', 'bahrain', 'bahraini'] },
  { id: 'riyadh', name: 'Riyadh', region: 'Middle East', country: 'Saudi Arabia', lat: 24.7136, lon: 46.6753, type: 'capital', tier: 'major', keywords: ['riyadh', 'saudi', 'saudi arabia', 'mbs', 'mohammed bin salman'] },
  { id: 'jeddah', name: 'Jeddah', region: 'Middle East', country: 'Saudi Arabia', lat: 21.4858, lon: 39.1925, type: 'capital', tier: 'notable', keywords: ['jeddah', 'mecca', 'medina'] },
  { id: 'baghdad', name: 'Baghdad', region: 'Middle East', country: 'Iraq', lat: 33.3152, lon: 44.3661, type: 'capital', tier: 'major', keywords: ['baghdad', 'iraq', 'iraqi'] },
  { id: 'erbil', name: 'Erbil', region: 'Middle East', country: 'Iraq', lat: 36.1912, lon: 44.0119, type: 'capital', tier: 'notable', keywords: ['erbil', 'irbil', 'kurdistan', 'kurdish', 'peshmerga'] },
  { id: 'basra', name: 'Basra', region: 'Middle East', country: 'Iraq', lat: 30.5085, lon: 47.7804, type: 'capital', tier: 'notable', keywords: ['basra'] },
  { id: 'kuwait', name: 'Kuwait City', region: 'Middle East', country: 'Kuwait', lat: 29.3759, lon: 47.9774, type: 'capital', tier: 'notable', keywords: ['kuwait', 'kuwaiti'] },
  { id: 'muscat', name: 'Muscat', region: 'Middle East', country: 'Oman', lat: 23.588, lon: 58.3829, type: 'capital', tier: 'notable', keywords: ['muscat', 'oman', 'omani'] },
  { id: 'amman', name: 'Amman', region: 'Middle East', country: 'Jordan', lat: 31.9454, lon: 35.9284, type: 'capital', tier: 'notable', keywords: ['amman', 'jordan', 'jordanian'] },
  { id: 'ankara', name: 'Ankara', region: 'Middle East', country: 'Turkey', lat: 39.9334, lon: 32.8597, type: 'capital', tier: 'major', keywords: ['ankara', 'turkey', 'turkish', 'erdogan'] },
  { id: 'istanbul', name: 'Istanbul', region: 'Middle East', country: 'Turkey', lat: 41.0082, lon: 28.9784, type: 'capital', tier: 'notable', keywords: ['istanbul'] },
  { id: 'cairo', name: 'Cairo', region: 'Middle East', country: 'Egypt', lat: 30.0444, lon: 31.2357, type: 'capital', tier: 'major', keywords: ['cairo', 'egypt', 'egyptian', 'sisi'] },

  // ── Asia-Pacific Capitals ────────────────────────────────────
  { id: 'kyiv', name: 'Kyiv', region: 'Europe', country: 'Ukraine', lat: 50.4501, lon: 30.5234, type: 'capital', tier: 'major', keywords: ['kyiv', 'kiev', 'ukraine', 'ukrainian', 'zelensky', 'zelenskyy'] },
  { id: 'taipei', name: 'Taipei', region: 'Asia', country: 'Taiwan', lat: 25.033, lon: 121.5654, type: 'capital', tier: 'major', keywords: ['taipei', 'taiwan', 'taiwanese', 'tsmc'] },
  { id: 'tokyo', name: 'Tokyo', region: 'Asia', country: 'Japan', lat: 35.6762, lon: 139.6503, type: 'capital', tier: 'major', keywords: ['tokyo', 'japan', 'japanese'] },
  { id: 'seoul', name: 'Seoul', region: 'Asia', country: 'South Korea', lat: 37.5665, lon: 126.978, type: 'capital', tier: 'major', keywords: ['seoul', 'south korea', 'korean'] },
  { id: 'pyongyang', name: 'Pyongyang', region: 'Asia', country: 'North Korea', lat: 39.0392, lon: 125.7625, type: 'capital', tier: 'major', keywords: ['pyongyang', 'north korea', 'dprk', 'kim jong un'] },
  { id: 'newdelhi', name: 'New Delhi', region: 'Asia', country: 'India', lat: 28.6139, lon: 77.209, type: 'capital', tier: 'major', keywords: ['new delhi', 'delhi', 'india', 'indian', 'modi'] },
  { id: 'mumbai', name: 'Mumbai', region: 'Asia', country: 'India', lat: 19.076, lon: 72.8777, type: 'capital', tier: 'notable', keywords: ['mumbai', 'bombay'] },
  { id: 'islamabad', name: 'Islamabad', region: 'Asia', country: 'Pakistan', lat: 33.6844, lon: 73.0479, type: 'capital', tier: 'major', keywords: ['islamabad', 'pakistan', 'pakistani'] },
  { id: 'kabul', name: 'Kabul', region: 'Asia', country: 'Afghanistan', lat: 34.5553, lon: 69.2075, type: 'capital', tier: 'notable', keywords: ['kabul', 'afghanistan', 'afghan', 'taliban'] },
  { id: 'hanoi', name: 'Hanoi', region: 'Asia', country: 'Vietnam', lat: 21.0285, lon: 105.8542, type: 'capital', tier: 'notable', keywords: ['hanoi', 'vietnam', 'vietnamese'] },
  { id: 'manila', name: 'Manila', region: 'Asia', country: 'Philippines', lat: 14.5995, lon: 120.9842, type: 'capital', tier: 'notable', keywords: ['manila', 'philippines', 'filipino', 'marcos'] },
  { id: 'jakarta', name: 'Jakarta', region: 'Asia', country: 'Indonesia', lat: -6.2088, lon: 106.8456, type: 'capital', tier: 'notable', keywords: ['jakarta', 'indonesia', 'indonesian'] },
  { id: 'bangkok', name: 'Bangkok', region: 'Asia', country: 'Thailand', lat: 13.7563, lon: 100.5018, type: 'capital', tier: 'notable', keywords: ['bangkok', 'thailand', 'thai'] },
  { id: 'singapore', name: 'Singapore', region: 'Asia', country: 'Singapore', lat: 1.3521, lon: 103.8198, type: 'capital', tier: 'notable', keywords: ['singapore'] },
  { id: 'canberra', name: 'Canberra', region: 'Oceania', country: 'Australia', lat: -35.2809, lon: 149.13, type: 'capital', tier: 'notable', keywords: ['canberra', 'australia', 'australian'] },
  { id: 'shanghai', name: 'Shanghai', region: 'Asia', country: 'China', lat: 31.2304, lon: 121.4737, type: 'capital', tier: 'notable', keywords: ['shanghai'] },
  { id: 'hongkong', name: 'Hong Kong', region: 'Asia', country: 'China', lat: 22.3193, lon: 114.1694, type: 'capital', tier: 'notable', keywords: ['hong kong'] },

  // ── European Capitals ────────────────────────────────────────
  { id: 'paris', name: 'Paris', region: 'Europe', country: 'France', lat: 48.8566, lon: 2.3522, type: 'capital', tier: 'major', keywords: ['paris', 'france', 'french', 'macron', 'elysee'] },
  { id: 'berlin', name: 'Berlin', region: 'Europe', country: 'Germany', lat: 52.52, lon: 13.405, type: 'capital', tier: 'major', keywords: ['berlin', 'germany', 'german', 'scholz', 'bundestag'] },
  { id: 'rome', name: 'Rome', region: 'Europe', country: 'Italy', lat: 41.9028, lon: 12.4964, type: 'capital', tier: 'notable', keywords: ['rome', 'italy', 'italian', 'meloni'] },
  { id: 'madrid', name: 'Madrid', region: 'Europe', country: 'Spain', lat: 40.4168, lon: -3.7038, type: 'capital', tier: 'notable', keywords: ['madrid', 'spain', 'spanish'] },
  { id: 'warsaw', name: 'Warsaw', region: 'Europe', country: 'Poland', lat: 52.2297, lon: 21.0122, type: 'capital', tier: 'notable', keywords: ['warsaw', 'poland', 'polish'] },
  { id: 'bucharest', name: 'Bucharest', region: 'Europe', country: 'Romania', lat: 44.4268, lon: 26.1025, type: 'capital', tier: 'notable', keywords: ['bucharest', 'romania', 'romanian'] },
  { id: 'helsinki', name: 'Helsinki', region: 'Europe', country: 'Finland', lat: 60.1699, lon: 24.9384, type: 'capital', tier: 'notable', keywords: ['helsinki', 'finland', 'finnish'] },
  { id: 'stockholm', name: 'Stockholm', region: 'Europe', country: 'Sweden', lat: 59.3293, lon: 18.0686, type: 'capital', tier: 'notable', keywords: ['stockholm', 'sweden', 'swedish'] },
  { id: 'oslo', name: 'Oslo', region: 'Europe', country: 'Norway', lat: 59.9139, lon: 10.7522, type: 'capital', tier: 'notable', keywords: ['oslo', 'norway', 'norwegian'] },
  { id: 'tallinn', name: 'Tallinn', region: 'Europe', country: 'Estonia', lat: 59.437, lon: 24.7536, type: 'capital', tier: 'notable', keywords: ['tallinn', 'estonia', 'estonian'] },
  { id: 'riga', name: 'Riga', region: 'Europe', country: 'Latvia', lat: 56.9496, lon: 24.1052, type: 'capital', tier: 'notable', keywords: ['riga', 'latvia', 'latvian'] },
  { id: 'vilnius', name: 'Vilnius', region: 'Europe', country: 'Lithuania', lat: 54.6872, lon: 25.2797, type: 'capital', tier: 'notable', keywords: ['vilnius', 'lithuania', 'lithuanian'] },
  { id: 'athens', name: 'Athens', region: 'Europe', country: 'Greece', lat: 37.9838, lon: 23.7275, type: 'capital', tier: 'notable', keywords: ['athens', 'greece', 'greek'] },
  { id: 'belgrade', name: 'Belgrade', region: 'Europe', country: 'Serbia', lat: 44.7866, lon: 20.4489, type: 'capital', tier: 'notable', keywords: ['belgrade', 'serbia', 'serbian', 'vucic'] },
  { id: 'minsk', name: 'Minsk', region: 'Europe', country: 'Belarus', lat: 53.9006, lon: 27.559, type: 'capital', tier: 'notable', keywords: ['minsk', 'belarus', 'belarusian', 'lukashenko'] },
  { id: 'tbilisi', name: 'Tbilisi', region: 'Europe', country: 'Georgia', lat: 41.7151, lon: 44.8271, type: 'capital', tier: 'notable', keywords: ['tbilisi', 'georgia', 'georgian'] },
  { id: 'chisinau', name: 'Chisinau', region: 'Europe', country: 'Moldova', lat: 47.0105, lon: 28.8638, type: 'capital', tier: 'notable', keywords: ['chisinau', 'moldova', 'moldovan', 'transnistria'] },
  { id: 'yerevan', name: 'Yerevan', region: 'Europe', country: 'Armenia', lat: 40.1792, lon: 44.4991, type: 'capital', tier: 'notable', keywords: ['yerevan', 'armenia', 'armenian'] },
  { id: 'baku', name: 'Baku', region: 'Europe', country: 'Azerbaijan', lat: 40.4093, lon: 49.8671, type: 'capital', tier: 'notable', keywords: ['baku', 'azerbaijan', 'azerbaijani', 'nagorno-karabakh'] },

  // ── Americas ─────────────────────────────────────────────────
  { id: 'ottawa', name: 'Ottawa', region: 'North America', country: 'Canada', lat: 45.4215, lon: -75.6972, type: 'capital', tier: 'notable', keywords: ['ottawa', 'canada', 'canadian', 'trudeau'] },
  { id: 'mexicocity', name: 'Mexico City', region: 'North America', country: 'Mexico', lat: 19.4326, lon: -99.1332, type: 'capital', tier: 'notable', keywords: ['mexico city', 'mexico', 'mexican'] },
  { id: 'brasilia', name: 'Brasilia', region: 'South America', country: 'Brazil', lat: -15.7975, lon: -47.8919, type: 'capital', tier: 'notable', keywords: ['brasilia', 'brazil', 'brazilian', 'lula'] },
  { id: 'buenosaires', name: 'Buenos Aires', region: 'South America', country: 'Argentina', lat: -34.6037, lon: -58.3816, type: 'capital', tier: 'notable', keywords: ['buenos aires', 'argentina', 'argentinian', 'milei'] },
  { id: 'caracas', name: 'Caracas', region: 'South America', country: 'Venezuela', lat: 10.4806, lon: -66.9036, type: 'capital', tier: 'notable', keywords: ['caracas', 'venezuela', 'venezuelan', 'maduro'] },
  { id: 'bogota', name: 'Bogota', region: 'South America', country: 'Colombia', lat: 4.711, lon: -74.0721, type: 'capital', tier: 'notable', keywords: ['bogota', 'colombia', 'colombian'] },
  { id: 'havana', name: 'Havana', region: 'North America', country: 'Cuba', lat: 23.1136, lon: -82.3666, type: 'capital', tier: 'notable', keywords: ['havana', 'cuba', 'cuban'] },

  // ── Africa ───────────────────────────────────────────────────
  { id: 'ethiopia', name: 'Addis Ababa', region: 'Africa', country: 'Ethiopia', lat: 9.025, lon: 38.7469, type: 'capital', tier: 'notable', keywords: ['addis ababa', 'ethiopia', 'ethiopian', 'tigray', 'abiy ahmed'] },
  { id: 'nairobi', name: 'Nairobi', region: 'Africa', country: 'Kenya', lat: -1.2921, lon: 36.8219, type: 'capital', tier: 'notable', keywords: ['nairobi', 'kenya', 'kenyan'] },
  { id: 'pretoria', name: 'Pretoria', region: 'Africa', country: 'South Africa', lat: -25.7479, lon: 28.2293, type: 'capital', tier: 'notable', keywords: ['pretoria', 'south africa', 'south african', 'johannesburg'] },
  { id: 'lagos', name: 'Lagos', region: 'Africa', country: 'Nigeria', lat: 6.5244, lon: 3.3792, type: 'capital', tier: 'notable', keywords: ['lagos', 'abuja', 'nigeria', 'nigerian'] },
  { id: 'kinshasa', name: 'Kinshasa', region: 'Africa', country: 'DR Congo', lat: -4.4419, lon: 15.2663, type: 'capital', tier: 'notable', keywords: ['kinshasa', 'congo', 'congolese', 'drc'] },
  { id: 'mogadishu', name: 'Mogadishu', region: 'Africa', country: 'Somalia', lat: 2.0469, lon: 45.3182, type: 'capital', tier: 'notable', keywords: ['mogadishu', 'somalia', 'somali', 'al-shabaab'] },
  { id: 'tripoli', name: 'Tripoli', region: 'Africa', country: 'Libya', lat: 32.9022, lon: 13.18, type: 'capital', tier: 'notable', keywords: ['tripoli', 'libya', 'libyan', 'benghazi'] },
  { id: 'tunis', name: 'Tunis', region: 'Africa', country: 'Tunisia', lat: 36.8065, lon: 10.1815, type: 'capital', tier: 'notable', keywords: ['tunis', 'tunisia', 'tunisian'] },
  { id: 'algiers', name: 'Algiers', region: 'Africa', country: 'Algeria', lat: 36.7538, lon: 3.0588, type: 'capital', tier: 'notable', keywords: ['algiers', 'algeria', 'algerian'] },
  { id: 'rabat', name: 'Rabat', region: 'Africa', country: 'Morocco', lat: 34.0209, lon: -6.8416, type: 'capital', tier: 'notable', keywords: ['rabat', 'morocco', 'moroccan', 'casablanca'] },

  // ── Conflict Zones ───────────────────────────────────────────
  { id: 'gaza', name: 'Gaza', region: 'Middle East', country: 'Palestine', lat: 31.5, lon: 34.47, type: 'conflict', tier: 'critical', keywords: ['gaza', 'hamas', 'palestinian', 'rafah', 'khan younis', 'gaza strip'] },
  { id: 'westbank', name: 'West Bank', region: 'Middle East', country: 'Palestine', lat: 31.9, lon: 35.2, type: 'conflict', tier: 'major', keywords: ['west bank', 'ramallah', 'jenin', 'nablus', 'hebron'] },
  { id: 'ukraine-front', name: 'Ukraine Front', region: 'Europe', country: 'Ukraine', lat: 48.5, lon: 37.5, type: 'conflict', tier: 'critical', keywords: ['donbas', 'donbass', 'donetsk', 'luhansk', 'kharkiv', 'bakhmut', 'avdiivka', 'zaporizhzhia', 'kherson', 'crimea'] },
  { id: 'taiwan-strait', name: 'Taiwan Strait', region: 'Asia', country: 'International', lat: 24.5, lon: 119.5, type: 'conflict', tier: 'critical', keywords: ['taiwan strait', 'formosa', 'pla', 'chinese military'] },
  { id: 'southchinasea', name: 'South China Sea', region: 'Asia', country: 'International', lat: 12, lon: 114, type: 'strategic', tier: 'critical', keywords: ['south china sea', 'spratlys', 'paracels', 'nine-dash line', 'scarborough'] },
  { id: 'yemen', name: 'Yemen', region: 'Middle East', country: 'Yemen', lat: 15.5527, lon: 48.5164, type: 'conflict', tier: 'major', keywords: ['yemen', 'houthi', 'houthis', 'sanaa', 'aden'] },
  { id: 'syria', name: 'Syria', region: 'Middle East', country: 'Syria', lat: 34.8, lon: 39, type: 'conflict', tier: 'major', keywords: ['syria', 'syrian', 'assad', 'damascus', 'idlib', 'aleppo'] },
  { id: 'lebanon', name: 'Lebanon', region: 'Middle East', country: 'Lebanon', lat: 33.8547, lon: 35.8623, type: 'conflict', tier: 'major', keywords: ['lebanon', 'lebanese', 'hezbollah', 'beirut'] },
  { id: 'sudan', name: 'Sudan', region: 'Africa', country: 'Sudan', lat: 15.5007, lon: 32.5599, type: 'conflict', tier: 'major', keywords: ['sudan', 'sudanese', 'khartoum', 'rsf', 'darfur'] },
  { id: 'sahel', name: 'Sahel', region: 'Africa', country: 'International', lat: 15, lon: 0, type: 'conflict', tier: 'major', keywords: ['sahel', 'mali', 'niger', 'burkina faso', 'wagner'] },
  { id: 'myanmar', name: 'Myanmar', region: 'Asia', country: 'Myanmar', lat: 19.7633, lon: 96.0785, type: 'conflict', tier: 'notable', keywords: ['myanmar', 'burma', 'rohingya', 'naypyidaw'] },
  { id: 'iraq-conflict', name: 'Iraq Conflict', region: 'Middle East', country: 'Iraq', lat: 33.3, lon: 44.4, type: 'conflict', tier: 'major', keywords: ['al asad', 'ain al-asad', 'tikrit', 'mosul', 'fallujah', 'najaf', 'karbala'] },
  { id: 'kashmir', name: 'Kashmir', region: 'Asia', country: 'International', lat: 34.0837, lon: 74.7973, type: 'conflict', tier: 'notable', keywords: ['kashmir', 'srinagar', 'line of control'] },
  { id: 'golan', name: 'Golan Heights', region: 'Middle East', country: 'International', lat: 33, lon: 35.8, type: 'conflict', tier: 'notable', keywords: ['golan', 'golan heights'] },

  // ── Strategic Chokepoints & Regions ──────────────────────────
  { id: 'hormuz', name: 'Strait of Hormuz', region: 'Middle East', country: 'International', lat: 26.5, lon: 56.5, type: 'strategic', tier: 'critical', keywords: ['hormuz', 'strait of hormuz', 'persian gulf'] },
  { id: 'redsea', name: 'Red Sea', region: 'Middle East', country: 'International', lat: 20, lon: 38, type: 'strategic', tier: 'critical', keywords: ['red sea', 'bab el-mandeb', 'bab al-mandab'] },
  { id: 'suez', name: 'Suez Canal', region: 'Middle East', country: 'Egypt', lat: 30.5, lon: 32.3, type: 'strategic', tier: 'critical', keywords: ['suez', 'suez canal'] },
  { id: 'baltic', name: 'Baltic Sea', region: 'Europe', country: 'International', lat: 58, lon: 20, type: 'strategic', tier: 'major', keywords: ['baltic', 'baltic sea', 'kaliningrad', 'gotland'] },
  { id: 'arctic', name: 'Arctic', region: 'Arctic', country: 'International', lat: 75, lon: 0, type: 'strategic', tier: 'major', keywords: ['arctic', 'northern sea route', 'svalbard'] },
  { id: 'blacksea', name: 'Black Sea', region: 'Europe', country: 'International', lat: 43, lon: 35, type: 'strategic', tier: 'major', keywords: ['black sea', 'bosphorus', 'sevastopol', 'odesa', 'odessa'] },
  { id: 'malacca', name: 'Strait of Malacca', region: 'Asia', country: 'International', lat: 2.5, lon: 101.5, type: 'strategic', tier: 'major', keywords: ['malacca', 'strait of malacca'] },
  { id: 'panama', name: 'Panama Canal', region: 'North America', country: 'Panama', lat: 9.08, lon: -79.68, type: 'strategic', tier: 'major', keywords: ['panama canal', 'panama'] },
  { id: 'gibraltar', name: 'Strait of Gibraltar', region: 'Europe', country: 'International', lat: 35.96, lon: -5.5, type: 'strategic', tier: 'notable', keywords: ['gibraltar', 'strait of gibraltar'] },

  // ── International Organizations ──────────────────────────────
  { id: 'un-nyc', name: 'United Nations', region: 'North America', country: 'USA', lat: 40.7489, lon: -73.968, type: 'organization', tier: 'critical', keywords: ['united nations', 'security council', 'general assembly', 'unsc'] },
  { id: 'nato-hq', name: 'NATO HQ', region: 'Europe', country: 'Belgium', lat: 50.8796, lon: 4.4284, type: 'organization', tier: 'critical', keywords: ['nato', 'north atlantic', 'alliance'] },
  { id: 'iaea-vienna', name: 'IAEA', region: 'Europe', country: 'Austria', lat: 48.2352, lon: 16.4156, type: 'organization', tier: 'major', keywords: ['iaea', 'atomic energy', 'nuclear watchdog', 'grossi'] },

  // ── US Military Bases (frequently in news) ───────────────────
  { id: 'ramstein', name: 'Ramstein Air Base', region: 'Europe', country: 'Germany', lat: 49.4369, lon: 7.6003, type: 'strategic', tier: 'notable', keywords: ['ramstein'] },
  { id: 'incirlik', name: 'Incirlik Air Base', region: 'Middle East', country: 'Turkey', lat: 37.0021, lon: 35.4259, type: 'strategic', tier: 'notable', keywords: ['incirlik'] },
  { id: 'diegogarcia', name: 'Diego Garcia', region: 'Indian Ocean', country: 'UK', lat: -7.3195, lon: 72.4229, type: 'strategic', tier: 'notable', keywords: ['diego garcia'] },
  { id: 'guam', name: 'Guam', region: 'Pacific', country: 'USA', lat: 13.4443, lon: 144.7937, type: 'strategic', tier: 'notable', keywords: ['guam', 'andersen air force base'] },
  { id: 'okinawa', name: 'Okinawa', region: 'Asia', country: 'Japan', lat: 26.3344, lon: 127.8056, type: 'strategic', tier: 'notable', keywords: ['okinawa', 'kadena'] },
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
  return [...index.hubs.values()];
}
