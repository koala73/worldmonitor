// Tech Events API - Parses Techmeme ICS feed and dev.events RSS, returns structured events
import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';
export const config = { runtime: 'edge' };

const ICS_URL = 'https://www.techmeme.com/newsy_events.ics';
const DEV_EVENTS_RSS = 'https://dev.events/rss.xml';

// Curated major tech events that may fall off limited RSS feeds
// These are manually maintained for important conferences
const CURATED_EVENTS = [
  {
    id: 'step-dubai-2026',
    title: 'STEP Dubai 2026',
    type: 'conference',
    location: 'Dubai Internet City, Dubai',
    coords: { lat: 25.0956, lng: 55.1548, country: 'UAE', original: 'Dubai Internet City, Dubai' },
    startDate: '2026-02-11',
    endDate: '2026-02-12',
    url: 'https://dubai.stepconference.com',
    source: 'curated',
    description: 'Intelligence Everywhere: The AI Economy - 8,000+ attendees, 400+ startups',
  },
  {
    id: 'gitex-global-2026',
    title: 'GITEX Global 2026',
    type: 'conference',
    location: 'Dubai World Trade Centre, Dubai',
    coords: { lat: 25.2285, lng: 55.2867, country: 'UAE', original: 'Dubai World Trade Centre, Dubai' },
    startDate: '2026-12-07',
    endDate: '2026-12-11',
    url: 'https://www.gitex.com',
    source: 'curated',
    description: 'World\'s largest tech & startup show',
  },
  {
    id: 'token2049-dubai-2026',
    title: 'TOKEN2049 Dubai 2026',
    type: 'conference',
    location: 'Dubai, UAE',
    coords: { lat: 25.2048, lng: 55.2708, country: 'UAE', original: 'Dubai, UAE' },
    startDate: '2026-04-29',
    endDate: '2026-04-30',
    url: 'https://www.token2049.com',
    source: 'curated',
    description: 'Premier crypto event in Dubai',
  },
  {
    id: 'collision-2026',
    title: 'Collision 2026',
    type: 'conference',
    location: 'Toronto, Canada',
    coords: { lat: 43.6532, lng: -79.3832, country: 'Canada', original: 'Toronto, Canada' },
    startDate: '2026-06-22',
    endDate: '2026-06-25',
    url: 'https://collisionconf.com',
    source: 'curated',
    description: 'North America\'s fastest growing tech conference',
  },
  {
    id: 'web-summit-2026',
    title: 'Web Summit 2026',
    type: 'conference',
    location: 'Lisbon, Portugal',
    coords: { lat: 38.7223, lng: -9.1393, country: 'Portugal', original: 'Lisbon, Portugal' },
    startDate: '2026-11-02',
    endDate: '2026-11-05',
    url: 'https://websummit.com',
    source: 'curated',
    description: 'The world\'s premier tech conference',
  },
];

// Comprehensive city geocoding database (500+ cities worldwide)
const CITY_COORDS = {
  // North America - USA
  'san francisco': { lat: 37.7749, lng: -122.4194, country: 'USA' },
  'san jose': { lat: 37.3382, lng: -121.8863, country: 'USA' },
  'palo alto': { lat: 37.4419, lng: -122.1430, country: 'USA' },
  'mountain view': { lat: 37.3861, lng: -122.0839, country: 'USA' },
  'menlo park': { lat: 37.4530, lng: -122.1817, country: 'USA' },
  'cupertino': { lat: 37.3230, lng: -122.0322, country: 'USA' },
  'sunnyvale': { lat: 37.3688, lng: -122.0363, country: 'USA' },
  'santa clara': { lat: 37.3541, lng: -121.9552, country: 'USA' },
  'redwood city': { lat: 37.4852, lng: -122.2364, country: 'USA' },
  'oakland': { lat: 37.8044, lng: -122.2712, country: 'USA' },
  'berkeley': { lat: 37.8716, lng: -122.2727, country: 'USA' },
  'los angeles': { lat: 34.0522, lng: -118.2437, country: 'USA' },
  'santa monica': { lat: 34.0195, lng: -118.4912, country: 'USA' },
  'pasadena': { lat: 34.1478, lng: -118.1445, country: 'USA' },
  'irvine': { lat: 33.6846, lng: -117.8265, country: 'USA' },
  'san diego': { lat: 32.7157, lng: -117.1611, country: 'USA' },
  'seattle': { lat: 47.6062, lng: -122.3321, country: 'USA' },
  'bellevue': { lat: 47.6101, lng: -122.2015, country: 'USA' },
  'redmond': { lat: 47.6740, lng: -122.1215, country: 'USA' },
  'portland': { lat: 45.5155, lng: -122.6789, country: 'USA' },
  'new york': { lat: 40.7128, lng: -74.0060, country: 'USA' },
  'nyc': { lat: 40.7128, lng: -74.0060, country: 'USA' },
  'manhattan': { lat: 40.7831, lng: -73.9712, country: 'USA' },
  'brooklyn': { lat: 40.6782, lng: -73.9442, country: 'USA' },
  'boston': { lat: 42.3601, lng: -71.0589, country: 'USA' },
  'cambridge': { lat: 42.3736, lng: -71.1097, country: 'USA' },
  'chicago': { lat: 41.8781, lng: -87.6298, country: 'USA' },
  'austin': { lat: 30.2672, lng: -97.7431, country: 'USA' },
  'austin, tx': { lat: 30.2672, lng: -97.7431, country: 'USA' },
  'dallas': { lat: 32.7767, lng: -96.7970, country: 'USA' },
  'houston': { lat: 29.7604, lng: -95.3698, country: 'USA' },
  'denver': { lat: 39.7392, lng: -104.9903, country: 'USA' },
  'boulder': { lat: 40.0150, lng: -105.2705, country: 'USA' },
  'phoenix': { lat: 33.4484, lng: -112.0740, country: 'USA' },
  'scottsdale': { lat: 33.4942, lng: -111.9261, country: 'USA' },
  'miami': { lat: 25.7617, lng: -80.1918, country: 'USA' },
  'orlando': { lat: 28.5383, lng: -81.3792, country: 'USA' },
  'tampa': { lat: 27.9506, lng: -82.4572, country: 'USA' },
  'atlanta': { lat: 33.7490, lng: -84.3880, country: 'USA' },
  'washington': { lat: 38.9072, lng: -77.0369, country: 'USA' },
  'washington dc': { lat: 38.9072, lng: -77.0369, country: 'USA' },
  'washington, dc': { lat: 38.9072, lng: -77.0369, country: 'USA' },
  'dc': { lat: 38.9072, lng: -77.0369, country: 'USA' },
  'reston': { lat: 38.9586, lng: -77.3570, country: 'USA' },
  'philadelphia': { lat: 39.9526, lng: -75.1652, country: 'USA' },
  'pittsburgh': { lat: 40.4406, lng: -79.9959, country: 'USA' },
  'detroit': { lat: 42.3314, lng: -83.0458, country: 'USA' },
  'ann arbor': { lat: 42.2808, lng: -83.7430, country: 'USA' },
  'minneapolis': { lat: 44.9778, lng: -93.2650, country: 'USA' },
  'salt lake city': { lat: 40.7608, lng: -111.8910, country: 'USA' },
  'las vegas': { lat: 36.1699, lng: -115.1398, country: 'USA' },
  'raleigh': { lat: 35.7796, lng: -78.6382, country: 'USA' },
  'durham': { lat: 35.9940, lng: -78.8986, country: 'USA' },
  'chapel hill': { lat: 35.9132, lng: -79.0558, country: 'USA' },
  'charlotte': { lat: 35.2271, lng: -80.8431, country: 'USA' },
  'nashville': { lat: 36.1627, lng: -86.7816, country: 'USA' },
  'indianapolis': { lat: 39.7684, lng: -86.1581, country: 'USA' },
  'columbus': { lat: 39.9612, lng: -82.9988, country: 'USA' },
  'cleveland': { lat: 41.4993, lng: -81.6944, country: 'USA' },
  'cincinnati': { lat: 39.1031, lng: -84.5120, country: 'USA' },
  'st. louis': { lat: 38.6270, lng: -90.1994, country: 'USA' },
  'kansas city': { lat: 39.0997, lng: -94.5786, country: 'USA' },
  'omaha': { lat: 41.2565, lng: -95.9345, country: 'USA' },
  'milwaukee': { lat: 43.0389, lng: -87.9065, country: 'USA' },
  'new orleans': { lat: 29.9511, lng: -90.0715, country: 'USA' },
  'san antonio': { lat: 29.4241, lng: -98.4936, country: 'USA' },
  'albuquerque': { lat: 35.0844, lng: -106.6504, country: 'USA' },
  'tucson': { lat: 32.2226, lng: -110.9747, country: 'USA' },
  'honolulu': { lat: 21.3069, lng: -157.8583, country: 'USA' },
  'anchorage': { lat: 61.2181, lng: -149.9003, country: 'USA' },

  // North America - Canada
  'toronto': { lat: 43.6532, lng: -79.3832, country: 'Canada' },
  'vancouver': { lat: 49.2827, lng: -123.1207, country: 'Canada' },
  'montreal': { lat: 45.5017, lng: -73.5673, country: 'Canada' },
  'ottawa': { lat: 45.4215, lng: -75.6972, country: 'Canada' },
  'calgary': { lat: 51.0447, lng: -114.0719, country: 'Canada' },
  'edmonton': { lat: 53.5461, lng: -113.4938, country: 'Canada' },
  'winnipeg': { lat: 49.8951, lng: -97.1384, country: 'Canada' },
  'quebec city': { lat: 46.8139, lng: -71.2080, country: 'Canada' },
  'waterloo': { lat: 43.4643, lng: -80.5204, country: 'Canada' },
  'victoria': { lat: 48.4284, lng: -123.3656, country: 'Canada' },
  'halifax': { lat: 44.6488, lng: -63.5752, country: 'Canada' },

  // Mexico & Central America
  'mexico city': { lat: 19.4326, lng: -99.1332, country: 'Mexico' },
  'guadalajara': { lat: 20.6597, lng: -103.3496, country: 'Mexico' },
  'monterrey': { lat: 25.6866, lng: -100.3161, country: 'Mexico' },
  'tijuana': { lat: 32.5149, lng: -117.0382, country: 'Mexico' },
  'cancun': { lat: 21.1619, lng: -86.8515, country: 'Mexico' },
  'panama city': { lat: 8.9824, lng: -79.5199, country: 'Panama' },
  'san jose': { lat: 9.9281, lng: -84.0907, country: 'Costa Rica' },

  // South America
  'sao paulo': { lat: -23.5505, lng: -46.6333, country: 'Brazil' },
  'são paulo': { lat: -23.5505, lng: -46.6333, country: 'Brazil' },
  'rio de janeiro': { lat: -22.9068, lng: -43.1729, country: 'Brazil' },
  'brasilia': { lat: -15.7975, lng: -47.8919, country: 'Brazil' },
  'belo horizonte': { lat: -19.9167, lng: -43.9345, country: 'Brazil' },
  'porto alegre': { lat: -30.0346, lng: -51.2177, country: 'Brazil' },
  'buenos aires': { lat: -34.6037, lng: -58.3816, country: 'Argentina' },
  'santiago': { lat: -33.4489, lng: -70.6693, country: 'Chile' },
  'bogota': { lat: 4.7110, lng: -74.0721, country: 'Colombia' },
  'bogotá': { lat: 4.7110, lng: -74.0721, country: 'Colombia' },
  'medellin': { lat: 6.2476, lng: -75.5658, country: 'Colombia' },
  'medellín': { lat: 6.2476, lng: -75.5658, country: 'Colombia' },
  'lima': { lat: -12.0464, lng: -77.0428, country: 'Peru' },
  'caracas': { lat: 10.4806, lng: -66.9036, country: 'Venezuela' },
  'montevideo': { lat: -34.9011, lng: -56.1645, country: 'Uruguay' },
  'quito': { lat: -0.1807, lng: -78.4678, country: 'Ecuador' },

  // Europe - UK & Ireland
  'london': { lat: 51.5074, lng: -0.1278, country: 'UK' },
  'cambridge': { lat: 52.2053, lng: 0.1218, country: 'UK' },
  'oxford': { lat: 51.7520, lng: -1.2577, country: 'UK' },
  'manchester': { lat: 53.4808, lng: -2.2426, country: 'UK' },
  'birmingham': { lat: 52.4862, lng: -1.8904, country: 'UK' },
  'edinburgh': { lat: 55.9533, lng: -3.1883, country: 'UK' },
  'glasgow': { lat: 55.8642, lng: -4.2518, country: 'UK' },
  'bristol': { lat: 51.4545, lng: -2.5879, country: 'UK' },
  'leeds': { lat: 53.8008, lng: -1.5491, country: 'UK' },
  'liverpool': { lat: 53.4084, lng: -2.9916, country: 'UK' },
  'belfast': { lat: 54.5973, lng: -5.9301, country: 'UK' },
  'cardiff': { lat: 51.4816, lng: -3.1791, country: 'UK' },
  'dublin': { lat: 53.3498, lng: -6.2603, country: 'Ireland' },
  'cork': { lat: 51.8985, lng: -8.4756, country: 'Ireland' },
  'galway': { lat: 53.2707, lng: -9.0568, country: 'Ireland' },

  // Europe - Western
  'paris': { lat: 48.8566, lng: 2.3522, country: 'France' },
  'lyon': { lat: 45.7640, lng: 4.8357, country: 'France' },
  'marseille': { lat: 43.2965, lng: 5.3698, country: 'France' },
  'toulouse': { lat: 43.6047, lng: 1.4442, country: 'France' },
  'nice': { lat: 43.7102, lng: 7.2620, country: 'France' },
  'bordeaux': { lat: 44.8378, lng: -0.5792, country: 'France' },
  'strasbourg': { lat: 48.5734, lng: 7.7521, country: 'France' },
  'nantes': { lat: 47.2184, lng: -1.5536, country: 'France' },
  'cannes': { lat: 43.5528, lng: 7.0174, country: 'France' },
  'monaco': { lat: 43.7384, lng: 7.4246, country: 'Monaco' },
  'berlin': { lat: 52.5200, lng: 13.4050, country: 'Germany' },
  'munich': { lat: 48.1351, lng: 11.5820, country: 'Germany' },
  'münchen': { lat: 48.1351, lng: 11.5820, country: 'Germany' },
  'frankfurt': { lat: 50.1109, lng: 8.6821, country: 'Germany' },
  'hamburg': { lat: 53.5511, lng: 9.9937, country: 'Germany' },
  'cologne': { lat: 50.9375, lng: 6.9603, country: 'Germany' },
  'köln': { lat: 50.9375, lng: 6.9603, country: 'Germany' },
  'düsseldorf': { lat: 51.2277, lng: 6.7735, country: 'Germany' },
  'dusseldorf': { lat: 51.2277, lng: 6.7735, country: 'Germany' },
  'stuttgart': { lat: 48.7758, lng: 9.1829, country: 'Germany' },
  'hanover': { lat: 52.3759, lng: 9.7320, country: 'Germany' },
  'hannover': { lat: 52.3759, lng: 9.7320, country: 'Germany' },
  'dresden': { lat: 51.0504, lng: 13.7373, country: 'Germany' },
  'leipzig': { lat: 51.3397, lng: 12.3731, country: 'Germany' },
  'nuremberg': { lat: 49.4521, lng: 11.0767, country: 'Germany' },
  'amsterdam': { lat: 52.3676, lng: 4.9041, country: 'Netherlands' },
  'rotterdam': { lat: 51.9225, lng: 4.4792, country: 'Netherlands' },
  'the hague': { lat: 52.0705, lng: 4.3007, country: 'Netherlands' },
  'eindhoven': { lat: 51.4416, lng: 5.4697, country: 'Netherlands' },
  'utrecht': { lat: 52.0907, lng: 5.1214, country: 'Netherlands' },
  'brussels': { lat: 50.8503, lng: 4.3517, country: 'Belgium' },
  'antwerp': { lat: 51.2194, lng: 4.4025, country: 'Belgium' },
  'ghent': { lat: 51.0543, lng: 3.7174, country: 'Belgium' },
  'luxembourg': { lat: 49.6116, lng: 6.1319, country: 'Luxembourg' },
  'zurich': { lat: 47.3769, lng: 8.5417, country: 'Switzerland' },
  'zürich': { lat: 47.3769, lng: 8.5417, country: 'Switzerland' },
  'geneva': { lat: 46.2044, lng: 6.1432, country: 'Switzerland' },
  'genève': { lat: 46.2044, lng: 6.1432, country: 'Switzerland' },
  'basel': { lat: 47.5596, lng: 7.5886, country: 'Switzerland' },
  'bern': { lat: 46.9480, lng: 7.4474, country: 'Switzerland' },
  'lausanne': { lat: 46.5197, lng: 6.6323, country: 'Switzerland' },
  'davos': { lat: 46.8027, lng: 9.8360, country: 'Switzerland' },
  'vienna': { lat: 48.2082, lng: 16.3738, country: 'Austria' },
  'wien': { lat: 48.2082, lng: 16.3738, country: 'Austria' },
  'salzburg': { lat: 47.8095, lng: 13.0550, country: 'Austria' },
  'graz': { lat: 47.0707, lng: 15.4395, country: 'Austria' },
  'innsbruck': { lat: 47.2692, lng: 11.4041, country: 'Austria' },

  // Europe - Southern
  'barcelona': { lat: 41.3851, lng: 2.1734, country: 'Spain' },
  'madrid': { lat: 40.4168, lng: -3.7038, country: 'Spain' },
  'valencia': { lat: 39.4699, lng: -0.3763, country: 'Spain' },
  'seville': { lat: 37.3891, lng: -5.9845, country: 'Spain' },
  'sevilla': { lat: 37.3891, lng: -5.9845, country: 'Spain' },
  'malaga': { lat: 36.7213, lng: -4.4214, country: 'Spain' },
  'málaga': { lat: 36.7213, lng: -4.4214, country: 'Spain' },
  'bilbao': { lat: 43.2630, lng: -2.9350, country: 'Spain' },
  'lisbon': { lat: 38.7223, lng: -9.1393, country: 'Portugal' },
  'lisboa': { lat: 38.7223, lng: -9.1393, country: 'Portugal' },
  'porto': { lat: 41.1579, lng: -8.6291, country: 'Portugal' },
  'rome': { lat: 41.9028, lng: 12.4964, country: 'Italy' },
  'roma': { lat: 41.9028, lng: 12.4964, country: 'Italy' },
  'milan': { lat: 45.4642, lng: 9.1900, country: 'Italy' },
  'milano': { lat: 45.4642, lng: 9.1900, country: 'Italy' },
  'florence': { lat: 43.7696, lng: 11.2558, country: 'Italy' },
  'firenze': { lat: 43.7696, lng: 11.2558, country: 'Italy' },
  'venice': { lat: 45.4408, lng: 12.3155, country: 'Italy' },
  'venezia': { lat: 45.4408, lng: 12.3155, country: 'Italy' },
  'turin': { lat: 45.0703, lng: 7.6869, country: 'Italy' },
  'torino': { lat: 45.0703, lng: 7.6869, country: 'Italy' },
  'naples': { lat: 40.8518, lng: 14.2681, country: 'Italy' },
  'napoli': { lat: 40.8518, lng: 14.2681, country: 'Italy' },
  'bologna': { lat: 44.4949, lng: 11.3426, country: 'Italy' },
  'athens': { lat: 37.9838, lng: 23.7275, country: 'Greece' },
  'thessaloniki': { lat: 40.6401, lng: 22.9444, country: 'Greece' },
  'malta': { lat: 35.8989, lng: 14.5146, country: 'Malta' },
  'valletta': { lat: 35.8989, lng: 14.5146, country: 'Malta' },

  // Europe - Northern
  'stockholm': { lat: 59.3293, lng: 18.0686, country: 'Sweden' },
  'gothenburg': { lat: 57.7089, lng: 11.9746, country: 'Sweden' },
  'göteborg': { lat: 57.7089, lng: 11.9746, country: 'Sweden' },
  'malmö': { lat: 55.6050, lng: 13.0038, country: 'Sweden' },
  'malmo': { lat: 55.6050, lng: 13.0038, country: 'Sweden' },
  'copenhagen': { lat: 55.6761, lng: 12.5683, country: 'Denmark' },
  'københavn': { lat: 55.6761, lng: 12.5683, country: 'Denmark' },
  'aarhus': { lat: 56.1629, lng: 10.2039, country: 'Denmark' },
  'oslo': { lat: 59.9139, lng: 10.7522, country: 'Norway' },
  'bergen': { lat: 60.3913, lng: 5.3221, country: 'Norway' },
  'helsinki': { lat: 60.1699, lng: 24.9384, country: 'Finland' },
  'espoo': { lat: 60.2055, lng: 24.6559, country: 'Finland' },
  'tampere': { lat: 61.4978, lng: 23.7610, country: 'Finland' },
  'reykjavik': { lat: 64.1466, lng: -21.9426, country: 'Iceland' },

  // Europe - Eastern
  'warsaw': { lat: 52.2297, lng: 21.0122, country: 'Poland' },
  'warszawa': { lat: 52.2297, lng: 21.0122, country: 'Poland' },
  'krakow': { lat: 50.0647, lng: 19.9450, country: 'Poland' },
  'kraków': { lat: 50.0647, lng: 19.9450, country: 'Poland' },
  'wroclaw': { lat: 51.1079, lng: 17.0385, country: 'Poland' },
  'wrocław': { lat: 51.1079, lng: 17.0385, country: 'Poland' },
  'gdansk': { lat: 54.3520, lng: 18.6466, country: 'Poland' },
  'prague': { lat: 50.0755, lng: 14.4378, country: 'Czech Republic' },
  'praha': { lat: 50.0755, lng: 14.4378, country: 'Czech Republic' },
  'brno': { lat: 49.1951, lng: 16.6068, country: 'Czech Republic' },
  'budapest': { lat: 47.4979, lng: 19.0402, country: 'Hungary' },
  'bucharest': { lat: 44.4268, lng: 26.1025, country: 'Romania' },
  'bucurești': { lat: 44.4268, lng: 26.1025, country: 'Romania' },
  'cluj-napoca': { lat: 46.7712, lng: 23.6236, country: 'Romania' },
  'sofia': { lat: 42.6977, lng: 23.3219, country: 'Bulgaria' },
  'belgrade': { lat: 44.7866, lng: 20.4489, country: 'Serbia' },
  'beograd': { lat: 44.7866, lng: 20.4489, country: 'Serbia' },
  'zagreb': { lat: 45.8150, lng: 15.9819, country: 'Croatia' },
  'ljubljana': { lat: 46.0569, lng: 14.5058, country: 'Slovenia' },
  'bratislava': { lat: 48.1486, lng: 17.1077, country: 'Slovakia' },
  'tallinn': { lat: 59.4370, lng: 24.7536, country: 'Estonia' },
  'riga': { lat: 56.9496, lng: 24.1052, country: 'Latvia' },
  'vilnius': { lat: 54.6872, lng: 25.2797, country: 'Lithuania' },
  'kyiv': { lat: 50.4501, lng: 30.5234, country: 'Ukraine' },
  'kiev': { lat: 50.4501, lng: 30.5234, country: 'Ukraine' },
  'lviv': { lat: 49.8397, lng: 24.0297, country: 'Ukraine' },
  'minsk': { lat: 53.9045, lng: 27.5615, country: 'Belarus' },
  'moscow': { lat: 55.7558, lng: 37.6173, country: 'Russia' },
  'st. petersburg': { lat: 59.9311, lng: 30.3609, country: 'Russia' },
  'saint petersburg': { lat: 59.9311, lng: 30.3609, country: 'Russia' },

  // Middle East
  'dubai': { lat: 25.2048, lng: 55.2708, country: 'UAE' },
  'abu dhabi': { lat: 24.4539, lng: 54.3773, country: 'UAE' },
  'doha': { lat: 25.2854, lng: 51.5310, country: 'Qatar' },
  'riyadh': { lat: 24.7136, lng: 46.6753, country: 'Saudi Arabia' },
  'jeddah': { lat: 21.4858, lng: 39.1925, country: 'Saudi Arabia' },
  'neom': { lat: 28.0000, lng: 35.0000, country: 'Saudi Arabia' },
  'tel aviv': { lat: 32.0853, lng: 34.7818, country: 'Israel' },
  'jerusalem': { lat: 31.7683, lng: 35.2137, country: 'Israel' },
  'haifa': { lat: 32.7940, lng: 34.9896, country: 'Israel' },
  'amman': { lat: 31.9454, lng: 35.9284, country: 'Jordan' },
  'beirut': { lat: 33.8938, lng: 35.5018, country: 'Lebanon' },
  'istanbul': { lat: 41.0082, lng: 28.9784, country: 'Turkey' },
  'ankara': { lat: 39.9334, lng: 32.8597, country: 'Turkey' },
  'izmir': { lat: 38.4237, lng: 27.1428, country: 'Turkey' },
  'tehran': { lat: 35.6892, lng: 51.3890, country: 'Iran' },
  'cairo': { lat: 30.0444, lng: 31.2357, country: 'Egypt' },
  'muscat': { lat: 23.5880, lng: 58.3829, country: 'Oman' },
  'manama': { lat: 26.2285, lng: 50.5860, country: 'Bahrain' },
  'kuwait city': { lat: 29.3759, lng: 47.9774, country: 'Kuwait' },

  // Asia - East
  'tokyo': { lat: 35.6762, lng: 139.6503, country: 'Japan' },
  'osaka': { lat: 34.6937, lng: 135.5023, country: 'Japan' },
  'kyoto': { lat: 35.0116, lng: 135.7681, country: 'Japan' },
  'yokohama': { lat: 35.4437, lng: 139.6380, country: 'Japan' },
  'nagoya': { lat: 35.1815, lng: 136.9066, country: 'Japan' },
  'fukuoka': { lat: 33.5904, lng: 130.4017, country: 'Japan' },
  'sapporo': { lat: 43.0618, lng: 141.3545, country: 'Japan' },
  'kobe': { lat: 34.6901, lng: 135.1956, country: 'Japan' },
  'seoul': { lat: 37.5665, lng: 126.9780, country: 'South Korea' },
  'busan': { lat: 35.1796, lng: 129.0756, country: 'South Korea' },
  'incheon': { lat: 37.4563, lng: 126.7052, country: 'South Korea' },
  'beijing': { lat: 39.9042, lng: 116.4074, country: 'China' },
  'shanghai': { lat: 31.2304, lng: 121.4737, country: 'China' },
  'shenzhen': { lat: 22.5431, lng: 114.0579, country: 'China' },
  'guangzhou': { lat: 23.1291, lng: 113.2644, country: 'China' },
  'hong kong': { lat: 22.3193, lng: 114.1694, country: 'Hong Kong' },
  'hangzhou': { lat: 30.2741, lng: 120.1551, country: 'China' },
  'chengdu': { lat: 30.5728, lng: 104.0668, country: 'China' },
  'xian': { lat: 34.3416, lng: 108.9398, country: 'China' },
  "xi'an": { lat: 34.3416, lng: 108.9398, country: 'China' },
  'nanjing': { lat: 32.0603, lng: 118.7969, country: 'China' },
  'wuhan': { lat: 30.5928, lng: 114.3055, country: 'China' },
  'tianjin': { lat: 39.3434, lng: 117.3616, country: 'China' },
  'suzhou': { lat: 31.2990, lng: 120.5853, country: 'China' },
  'taipei': { lat: 25.0330, lng: 121.5654, country: 'Taiwan' },
  'kaohsiung': { lat: 22.6273, lng: 120.3014, country: 'Taiwan' },
  'macau': { lat: 22.1987, lng: 113.5439, country: 'Macau' },
  'macao': { lat: 22.1987, lng: 113.5439, country: 'Macau' },

  // Asia - Southeast
  'singapore': { lat: 1.3521, lng: 103.8198, country: 'Singapore' },
  'kuala lumpur': { lat: 3.1390, lng: 101.6869, country: 'Malaysia' },
  'penang': { lat: 5.4141, lng: 100.3288, country: 'Malaysia' },
  'jakarta': { lat: -6.2088, lng: 106.8456, country: 'Indonesia' },
  'bali': { lat: -8.3405, lng: 115.0920, country: 'Indonesia' },
  'denpasar': { lat: -8.6705, lng: 115.2126, country: 'Indonesia' },
  'bandung': { lat: -6.9175, lng: 107.6191, country: 'Indonesia' },
  'surabaya': { lat: -7.2575, lng: 112.7521, country: 'Indonesia' },
  'bangkok': { lat: 13.7563, lng: 100.5018, country: 'Thailand' },
  'chiang mai': { lat: 18.7883, lng: 98.9853, country: 'Thailand' },
  'phuket': { lat: 7.8804, lng: 98.3923, country: 'Thailand' },
  'ho chi minh city': { lat: 10.8231, lng: 106.6297, country: 'Vietnam' },
  'saigon': { lat: 10.8231, lng: 106.6297, country: 'Vietnam' },
  'hanoi': { lat: 21.0278, lng: 105.8342, country: 'Vietnam' },
  'da nang': { lat: 16.0544, lng: 108.2022, country: 'Vietnam' },
  'manila': { lat: 14.5995, lng: 120.9842, country: 'Philippines' },
  'cebu': { lat: 10.3157, lng: 123.8854, country: 'Philippines' },
  'phnom penh': { lat: 11.5564, lng: 104.9282, country: 'Cambodia' },
  'yangon': { lat: 16.8661, lng: 96.1951, country: 'Myanmar' },

  // Asia - South
  'mumbai': { lat: 19.0760, lng: 72.8777, country: 'India' },
  'bombay': { lat: 19.0760, lng: 72.8777, country: 'India' },
  'delhi': { lat: 28.7041, lng: 77.1025, country: 'India' },
  'new delhi': { lat: 28.6139, lng: 77.2090, country: 'India' },
  'bangalore': { lat: 12.9716, lng: 77.5946, country: 'India' },
  'bengaluru': { lat: 12.9716, lng: 77.5946, country: 'India' },
  'hyderabad': { lat: 17.3850, lng: 78.4867, country: 'India' },
  'chennai': { lat: 13.0827, lng: 80.2707, country: 'India' },
  'madras': { lat: 13.0827, lng: 80.2707, country: 'India' },
  'pune': { lat: 18.5204, lng: 73.8567, country: 'India' },
  'kolkata': { lat: 22.5726, lng: 88.3639, country: 'India' },
  'calcutta': { lat: 22.5726, lng: 88.3639, country: 'India' },
  'ahmedabad': { lat: 23.0225, lng: 72.5714, country: 'India' },
  'jaipur': { lat: 26.9124, lng: 75.7873, country: 'India' },
  'gurgaon': { lat: 28.4595, lng: 77.0266, country: 'India' },
  'gurugram': { lat: 28.4595, lng: 77.0266, country: 'India' },
  'noida': { lat: 28.5355, lng: 77.3910, country: 'India' },
  'kochi': { lat: 9.9312, lng: 76.2673, country: 'India' },
  'goa': { lat: 15.2993, lng: 74.1240, country: 'India' },
  'karachi': { lat: 24.8607, lng: 67.0011, country: 'Pakistan' },
  'lahore': { lat: 31.5497, lng: 74.3436, country: 'Pakistan' },
  'islamabad': { lat: 33.6844, lng: 73.0479, country: 'Pakistan' },
  'dhaka': { lat: 23.8103, lng: 90.4125, country: 'Bangladesh' },
  'colombo': { lat: 6.9271, lng: 79.8612, country: 'Sri Lanka' },
  'kathmandu': { lat: 27.7172, lng: 85.3240, country: 'Nepal' },

  // Africa
  'cape town': { lat: -33.9249, lng: 18.4241, country: 'South Africa' },
  'johannesburg': { lat: -26.2041, lng: 28.0473, country: 'South Africa' },
  'pretoria': { lat: -25.7479, lng: 28.2293, country: 'South Africa' },
  'durban': { lat: -29.8587, lng: 31.0218, country: 'South Africa' },
  'lagos': { lat: 6.5244, lng: 3.3792, country: 'Nigeria' },
  'abuja': { lat: 9.0765, lng: 7.3986, country: 'Nigeria' },
  'nairobi': { lat: -1.2921, lng: 36.8219, country: 'Kenya' },
  'accra': { lat: 5.6037, lng: -0.1870, country: 'Ghana' },
  'casablanca': { lat: 33.5731, lng: -7.5898, country: 'Morocco' },
  'marrakech': { lat: 31.6295, lng: -7.9811, country: 'Morocco' },
  'tunis': { lat: 36.8065, lng: 10.1815, country: 'Tunisia' },
  'algiers': { lat: 36.7538, lng: 3.0588, country: 'Algeria' },
  'addis ababa': { lat: 8.9806, lng: 38.7578, country: 'Ethiopia' },
  'dar es salaam': { lat: -6.7924, lng: 39.2083, country: 'Tanzania' },
  'kampala': { lat: 0.3476, lng: 32.5825, country: 'Uganda' },
  'kigali': { lat: -1.9403, lng: 29.8739, country: 'Rwanda' },
  'mauritius': { lat: -20.3484, lng: 57.5522, country: 'Mauritius' },
  'port louis': { lat: -20.1609, lng: 57.5012, country: 'Mauritius' },

  // Oceania
  'sydney': { lat: -33.8688, lng: 151.2093, country: 'Australia' },
  'melbourne': { lat: -37.8136, lng: 144.9631, country: 'Australia' },
  'brisbane': { lat: -27.4698, lng: 153.0251, country: 'Australia' },
  'perth': { lat: -31.9505, lng: 115.8605, country: 'Australia' },
  'adelaide': { lat: -34.9285, lng: 138.6007, country: 'Australia' },
  'canberra': { lat: -35.2809, lng: 149.1300, country: 'Australia' },
  'gold coast': { lat: -28.0167, lng: 153.4000, country: 'Australia' },
  'auckland': { lat: -36.8509, lng: 174.7645, country: 'New Zealand' },
  'wellington': { lat: -41.2865, lng: 174.7762, country: 'New Zealand' },
  'christchurch': { lat: -43.5321, lng: 172.6362, country: 'New Zealand' },

  // Online/Virtual
  'online': { lat: 0, lng: 0, country: 'Virtual', virtual: true },
  'virtual': { lat: 0, lng: 0, country: 'Virtual', virtual: true },
  'hybrid': { lat: 0, lng: 0, country: 'Virtual', virtual: true },
};

function normalizeLocation(location) {
  if (!location) return null;

  // Clean up the location string
  let normalized = location.toLowerCase().trim();

  // Remove common suffixes/prefixes
  normalized = normalized.replace(/^hybrid:\s*/i, '');
  normalized = normalized.replace(/,\s*(usa|us|uk|canada)$/i, '');

  // Direct lookup
  if (CITY_COORDS[normalized]) {
    return { ...CITY_COORDS[normalized], original: location };
  }

  // Try removing state/country suffix
  const parts = normalized.split(',');
  if (parts.length > 1) {
    const city = parts[0].trim();
    if (CITY_COORDS[city]) {
      return { ...CITY_COORDS[city], original: location };
    }
  }

  // Try fuzzy match (contains)
  for (const [key, coords] of Object.entries(CITY_COORDS)) {
    if (normalized.includes(key) || key.includes(normalized)) {
      return { ...coords, original: location };
    }
  }

  return null;
}

function parseICS(icsText) {
  const events = [];
  const eventBlocks = icsText.split('BEGIN:VEVENT').slice(1);

  for (const block of eventBlocks) {
    const summaryMatch = block.match(/SUMMARY:(.+)/);
    const locationMatch = block.match(/LOCATION:(.+)/);
    const dtstartMatch = block.match(/DTSTART;VALUE=DATE:(\d+)/);
    const dtendMatch = block.match(/DTEND;VALUE=DATE:(\d+)/);
    const urlMatch = block.match(/URL:(.+)/);
    const uidMatch = block.match(/UID:(.+)/);

    if (summaryMatch && dtstartMatch) {
      const summary = summaryMatch[1].trim();
      const location = locationMatch ? locationMatch[1].trim() : null;
      const startDate = dtstartMatch[1];
      const endDate = dtendMatch ? dtendMatch[1] : startDate;
      const url = urlMatch ? urlMatch[1].trim() : null;
      const uid = uidMatch ? uidMatch[1].trim() : null;

      // Determine event type
      let type = 'other';
      if (summary.startsWith('Earnings:')) type = 'earnings';
      else if (summary.startsWith('IPO')) type = 'ipo';
      else if (location) type = 'conference';

      // Parse coordinates if location exists
      const coords = normalizeLocation(location);

      events.push({
        id: uid,
        title: summary,
        type,
        location: location,
        coords: coords,
        startDate: `${startDate.slice(0, 4)}-${startDate.slice(4, 6)}-${startDate.slice(6, 8)}`,
        endDate: `${endDate.slice(0, 4)}-${endDate.slice(4, 6)}-${endDate.slice(6, 8)}`,
        url: url,
        source: 'techmeme',
      });
    }
  }

  return events.sort((a, b) => a.startDate.localeCompare(b.startDate));
}

function parseDevEventsRSS(rssText) {
  const events = [];

  // Simple regex-based RSS parsing for edge runtime
  const itemMatches = rssText.matchAll(/<item>([\s\S]*?)<\/item>/g);

  for (const match of itemMatches) {
    const item = match[1];

    const titleMatch = item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>|<title>(.*?)<\/title>/);
    const linkMatch = item.match(/<link>(.*?)<\/link>/);
    const descMatch = item.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>|<description>(.*?)<\/description>/s);
    const guidMatch = item.match(/<guid[^>]*>(.*?)<\/guid>/);

    const title = titleMatch ? (titleMatch[1] || titleMatch[2]) : null;
    const link = linkMatch ? linkMatch[1] : null;
    const description = descMatch ? (descMatch[1] || descMatch[2]) : '';
    const guid = guidMatch ? guidMatch[1] : null;

    if (!title) continue;

    // Parse date from description: "EventName is happening on Month Day, Year"
    const dateMatch = description.match(/on\s+(\w+\s+\d{1,2},?\s+\d{4})/i);
    let startDate = null;
    if (dateMatch) {
      const parsed = new Date(dateMatch[1]);
      if (!isNaN(parsed.getTime())) {
        startDate = parsed.toISOString().split('T')[0];
      }
    }

    // Parse location from description: various formats
    let location = null;
    const locationMatch = description.match(/(?:in|at)\s+([A-Za-z\s]+,\s*[A-Za-z\s]+)(?:\.|$)/i) ||
                          description.match(/Location:\s*([^<\n]+)/i);
    if (locationMatch) {
      location = locationMatch[1].trim();
    }
    // Check for "Online" events
    if (description.toLowerCase().includes('online')) {
      location = 'Online';
    }

    // Skip events without valid dates or in the past
    if (!startDate) continue;
    const eventDate = new Date(startDate);
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    if (eventDate < now) continue;

    const coords = location && location !== 'Online' ? normalizeLocation(location) : null;
    if (location === 'Online') {
      // Mark as virtual
      if (coords) coords.virtual = true;
    }

    events.push({
      id: guid || `dev-events-${title.slice(0, 20)}`,
      title: title,
      type: 'conference',
      location: location,
      coords: coords || (location === 'Online' ? { virtual: true, original: 'Online' } : null),
      startDate: startDate,
      endDate: startDate, // RSS doesn't have end date
      url: link,
      source: 'dev.events',
    });
  }

  return events;
}

export default async function handler(req) {
  const cors = getCorsHeaders(req);
  if (isDisallowedOrigin(req)) {
    return new Response(JSON.stringify({ error: 'Origin not allowed' }), { status: 403, headers: cors });
  }
  const url = new URL(req.url);
  const type = url.searchParams.get('type'); // 'all', 'conferences', 'earnings', 'ipo'
  const mappable = url.searchParams.get('mappable') === 'true'; // Only return events with coords
  const limit = parseInt(url.searchParams.get('limit')) || 0; // Max events (0 = unlimited)
  const days = parseInt(url.searchParams.get('days')) || 0; // Events within N days (0 = unlimited)

  try {
    // Fetch both sources in parallel
    const [icsResponse, rssResponse] = await Promise.allSettled([
      fetch(ICS_URL, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; IntelHQ/1.0)' },
      }),
      fetch(DEV_EVENTS_RSS, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; IntelHQ/1.0)' },
      }),
    ]);

    let events = [];

    // Parse Techmeme ICS
    if (icsResponse.status === 'fulfilled' && icsResponse.value.ok) {
      const icsText = await icsResponse.value.text();
      events.push(...parseICS(icsText));
    } else {
      console.warn('Failed to fetch Techmeme ICS');
    }

    // Parse dev.events RSS
    if (rssResponse.status === 'fulfilled' && rssResponse.value.ok) {
      const rssText = await rssResponse.value.text();
      const devEvents = parseDevEventsRSS(rssText);
      events.push(...devEvents);
    } else {
      console.warn('Failed to fetch dev.events RSS');
    }

    // Add curated events (major conferences that may fall off limited RSS feeds)
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    for (const curated of CURATED_EVENTS) {
      const eventDate = new Date(curated.startDate);
      if (eventDate >= now) {
        events.push(curated);
      }
    }

    // Deduplicate by title similarity (rough match)
    const seen = new Set();
    events = events.filter(e => {
      const key = e.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 30);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Sort by date
    events.sort((a, b) => a.startDate.localeCompare(b.startDate));

    // Filter by type if specified
    if (type && type !== 'all') {
      events = events.filter(e => e.type === type);
    }

    // Filter to only mappable events if requested
    if (mappable) {
      events = events.filter(e => e.coords && !e.coords.virtual);
    }

    // Filter by time range if specified
    if (days > 0) {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() + days);
      events = events.filter(e => new Date(e.startDate) <= cutoff);
    }

    // Apply limit if specified
    if (limit > 0) {
      events = events.slice(0, limit);
    }

    // Add metadata
    const conferences = events.filter(e => e.type === 'conference');
    const mappableCount = conferences.filter(e => e.coords && !e.coords.virtual).length;

    return new Response(JSON.stringify({
      success: true,
      count: events.length,
      conferenceCount: conferences.length,
      mappableCount,
      lastUpdated: new Date().toISOString(),
      events,
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        ...cors,
        'Cache-Control': 'public, max-age=1800, s-maxage=1800, stale-while-revalidate=300',
      },
    });
  } catch (error) {
    console.error('Tech events error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message,
    }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        ...cors,
      },
    });
  }
}
