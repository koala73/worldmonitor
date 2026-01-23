export interface StartupHub {
  id: string;
  name: string;
  city: string;
  country: string;
  lat: number;
  lon: number;
  tier: 'mega' | 'major' | 'emerging';
  unicorns?: number;
  description?: string;
}

export interface Accelerator {
  id: string;
  name: string;
  city: string;
  country: string;
  lat: number;
  lon: number;
  type: 'accelerator' | 'incubator' | 'studio';
  founded?: number;
  notable?: string[];
}

export interface TechHQ {
  id: string;
  company: string;
  city: string;
  country: string;
  lat: number;
  lon: number;
  type: 'faang' | 'unicorn' | 'public';
  employees?: number;
  marketCap?: string;
}

export interface CloudRegion {
  id: string;
  provider: 'aws' | 'gcp' | 'azure' | 'cloudflare';
  name: string;
  city: string;
  country: string;
  lat: number;
  lon: number;
  zones?: number;
}

export const STARTUP_HUBS: StartupHub[] = [
  // Mega hubs
  { id: 'sf-bay', name: 'Silicon Valley', city: 'San Francisco', country: 'USA', lat: 37.3861, lon: -122.0839, tier: 'mega', unicorns: 200 },
  { id: 'nyc', name: 'New York Tech', city: 'New York', country: 'USA', lat: 40.7128, lon: -74.0060, tier: 'mega', unicorns: 100 },
  { id: 'london', name: 'London Tech City', city: 'London', country: 'UK', lat: 51.5074, lon: -0.1278, tier: 'mega', unicorns: 45 },
  { id: 'beijing', name: 'Zhongguancun', city: 'Beijing', country: 'China', lat: 39.9042, lon: 116.4074, tier: 'mega', unicorns: 80 },
  { id: 'shanghai', name: 'Shanghai Tech', city: 'Shanghai', country: 'China', lat: 31.2304, lon: 121.4737, tier: 'mega', unicorns: 50 },

  // Major hubs
  { id: 'boston', name: 'Boston/Cambridge', city: 'Boston', country: 'USA', lat: 42.3601, lon: -71.0589, tier: 'major', unicorns: 30 },
  { id: 'seattle', name: 'Seattle Tech', city: 'Seattle', country: 'USA', lat: 47.6062, lon: -122.3321, tier: 'major', unicorns: 25 },
  { id: 'austin', name: 'Austin Tech', city: 'Austin', country: 'USA', lat: 30.2672, lon: -97.7431, tier: 'major', unicorns: 15 },
  { id: 'la', name: 'Silicon Beach', city: 'Los Angeles', country: 'USA', lat: 34.0522, lon: -118.2437, tier: 'major', unicorns: 20 },
  { id: 'berlin', name: 'Berlin Startup', city: 'Berlin', country: 'Germany', lat: 52.5200, lon: 13.4050, tier: 'major', unicorns: 15 },
  { id: 'paris', name: 'Station F', city: 'Paris', country: 'France', lat: 48.8566, lon: 2.3522, tier: 'major', unicorns: 25 },
  { id: 'telaviv', name: 'Startup Nation', city: 'Tel Aviv', country: 'Israel', lat: 32.0853, lon: 34.7818, tier: 'major', unicorns: 40 },
  { id: 'singapore', name: 'Singapore Tech', city: 'Singapore', country: 'Singapore', lat: 1.3521, lon: 103.8198, tier: 'major', unicorns: 15 },
  { id: 'bangalore', name: 'Bangalore Tech', city: 'Bangalore', country: 'India', lat: 12.9716, lon: 77.5946, tier: 'major', unicorns: 35 },
  { id: 'tokyo', name: 'Tokyo Tech', city: 'Tokyo', country: 'Japan', lat: 35.6762, lon: 139.6503, tier: 'major', unicorns: 10 },
  { id: 'toronto', name: 'Toronto-Waterloo', city: 'Toronto', country: 'Canada', lat: 43.6532, lon: -79.3832, tier: 'major', unicorns: 15 },
  { id: 'shenzhen', name: 'Shenzhen Tech', city: 'Shenzhen', country: 'China', lat: 22.5431, lon: 114.0579, tier: 'major', unicorns: 25 },

  // Emerging hubs
  { id: 'miami', name: 'Miami Tech', city: 'Miami', country: 'USA', lat: 25.7617, lon: -80.1918, tier: 'emerging' },
  { id: 'denver', name: 'Denver Tech', city: 'Denver', country: 'USA', lat: 39.7392, lon: -104.9903, tier: 'emerging' },
  { id: 'amsterdam', name: 'Amsterdam Startup', city: 'Amsterdam', country: 'Netherlands', lat: 52.3676, lon: 4.9041, tier: 'emerging' },
  { id: 'stockholm', name: 'Stockholm Tech', city: 'Stockholm', country: 'Sweden', lat: 59.3293, lon: 18.0686, tier: 'emerging' },
  { id: 'dublin', name: 'Dublin Tech', city: 'Dublin', country: 'Ireland', lat: 53.3498, lon: -6.2603, tier: 'emerging' },
  { id: 'seoul', name: 'Seoul Startup', city: 'Seoul', country: 'South Korea', lat: 37.5665, lon: 126.9780, tier: 'emerging' },
  { id: 'sydney', name: 'Sydney Tech', city: 'Sydney', country: 'Australia', lat: -33.8688, lon: 151.2093, tier: 'emerging' },
  { id: 'saopaulo', name: 'São Paulo Tech', city: 'São Paulo', country: 'Brazil', lat: -23.5505, lon: -46.6333, tier: 'emerging' },
  { id: 'nairobi', name: 'Silicon Savannah', city: 'Nairobi', country: 'Kenya', lat: -1.2921, lon: 36.8219, tier: 'emerging' },
  { id: 'lagos', name: 'Lagos Tech', city: 'Lagos', country: 'Nigeria', lat: 6.5244, lon: 3.3792, tier: 'emerging' },

  // MENA Tech Hubs
  { id: 'dubai', name: 'Dubai Internet City', city: 'Dubai', country: 'UAE', lat: 25.0994, lon: 55.1641, tier: 'major', unicorns: 5, description: 'MENA\'s largest tech hub, home to regional HQs of global tech companies' },
  { id: 'abudhabi', name: 'Hub71', city: 'Abu Dhabi', country: 'UAE', lat: 24.4539, lon: 54.3773, tier: 'emerging', description: 'Abu Dhabi\'s global tech ecosystem backed by Mubadala' },
  { id: 'riyadh', name: 'Riyadh Tech', city: 'Riyadh', country: 'Saudi Arabia', lat: 24.7136, lon: 46.6753, tier: 'emerging', unicorns: 2, description: 'Saudi Vision 2030 tech hub, rapidly growing fintech and AI ecosystem' },
  { id: 'cairo', name: 'Cairo Tech', city: 'Cairo', country: 'Egypt', lat: 30.0444, lon: 31.2357, tier: 'emerging', description: 'Egypt\'s startup capital with growing fintech scene' },
  { id: 'amman', name: 'Amman Tech', city: 'Amman', country: 'Jordan', lat: 31.9454, lon: 35.9284, tier: 'emerging', description: 'Jordan\'s tech hub, strong in gaming and edtech' },
];

export const ACCELERATORS: Accelerator[] = [
  // ============ USA - Bay Area ============
  { id: 'yc', name: 'Y Combinator', city: 'San Francisco', country: 'USA', lat: 37.7749, lon: -122.4194, type: 'accelerator', founded: 2005, notable: ['Airbnb', 'Stripe', 'Dropbox'] },
  { id: '500', name: '500 Global', city: 'San Francisco', country: 'USA', lat: 37.7849, lon: -122.4094, type: 'accelerator', founded: 2010 },
  { id: 'nfx', name: 'NFX Guild', city: 'San Francisco', country: 'USA', lat: 37.7849, lon: -122.4294, type: 'accelerator', notable: ['Lyft', 'Trulia'] },
  { id: 'a16z-css', name: 'a16z crypto startup school', city: 'Menlo Park', country: 'USA', lat: 37.4530, lon: -122.1817, type: 'accelerator' },
  { id: 'plug-play', name: 'Plug and Play', city: 'Sunnyvale', country: 'USA', lat: 37.3688, lon: -122.0363, type: 'accelerator', founded: 2006, notable: ['Dropbox', 'PayPal'] },
  { id: 'alchemist', name: 'Alchemist Accelerator', city: 'San Francisco', country: 'USA', lat: 37.7849, lon: -122.4144, type: 'accelerator', notable: ['LaunchDarkly', 'Rigetti'] },
  { id: 'indiebio', name: 'IndieBio', city: 'San Francisco', country: 'USA', lat: 37.7809, lon: -122.4044, type: 'accelerator', notable: ['Memphis Meats', 'Clara Foods'] },
  { id: 'hax', name: 'HAX', city: 'San Francisco', country: 'USA', lat: 37.7789, lon: -122.3944, type: 'accelerator', notable: ['Makeblock', 'Mellow'] },
  { id: 'boost-vc', name: 'Boost VC', city: 'San Mateo', country: 'USA', lat: 37.5585, lon: -122.2711, type: 'accelerator', notable: ['Coinbase', 'Etherscan'] },
  { id: 'imagine-k12', name: 'Imagine K12', city: 'San Francisco', country: 'USA', lat: 37.7849, lon: -122.4094, type: 'accelerator' },
  { id: 'angelpad', name: 'AngelPad', city: 'San Francisco', country: 'USA', lat: 37.7849, lon: -122.4044, type: 'accelerator', founded: 2010, notable: ['Postmates', 'Mopub'] },
  { id: 'launch', name: 'LAUNCH Accelerator', city: 'San Francisco', country: 'USA', lat: 37.7799, lon: -122.4094, type: 'accelerator' },
  { id: 'sequoia-arc', name: 'Sequoia Arc', city: 'Menlo Park', country: 'USA', lat: 37.4520, lon: -122.1787, type: 'accelerator' },

  // USA - Boulder/Denver
  { id: 'techstars-boulder', name: 'Techstars Boulder', city: 'Boulder', country: 'USA', lat: 40.0150, lon: -105.2705, type: 'accelerator', founded: 2006 },
  { id: 'boomtown', name: 'Boomtown', city: 'Boulder', country: 'USA', lat: 40.0193, lon: -105.2765, type: 'accelerator' },

  // USA - NYC
  { id: 'techstars-nyc', name: 'Techstars NYC', city: 'New York', country: 'USA', lat: 40.7128, lon: -74.0060, type: 'accelerator' },
  { id: 'dreamit', name: 'DreamIt Ventures', city: 'New York', country: 'USA', lat: 40.7484, lon: -73.9857, type: 'accelerator', founded: 2008 },
  { id: 'era-nyc', name: 'ERA NYC', city: 'New York', country: 'USA', lat: 40.7426, lon: -73.9878, type: 'accelerator' },
  { id: 'newlab', name: 'Newlab', city: 'Brooklyn', country: 'USA', lat: 40.6914, lon: -73.9785, type: 'incubator' },
  { id: 'betaworks', name: 'Betaworks', city: 'New York', country: 'USA', lat: 40.7395, lon: -74.0018, type: 'studio', notable: ['Giphy', 'Bitly'] },
  { id: 'fintech-innovation', name: 'Fintech Innovation Lab', city: 'New York', country: 'USA', lat: 40.7580, lon: -73.9855, type: 'accelerator' },

  // USA - Boston
  { id: 'techstars-boston', name: 'Techstars Boston', city: 'Boston', country: 'USA', lat: 42.3601, lon: -71.0589, type: 'accelerator' },
  { id: 'masschallenge', name: 'MassChallenge', city: 'Boston', country: 'USA', lat: 42.3480, lon: -71.0466, type: 'accelerator', founded: 2009 },
  { id: 'harvard-ilab', name: 'Harvard i-lab', city: 'Boston', country: 'USA', lat: 42.3639, lon: -71.1244, type: 'incubator' },
  { id: 'greentown', name: 'Greentown Labs', city: 'Somerville', country: 'USA', lat: 42.3876, lon: -71.0995, type: 'incubator' },

  // USA - LA
  { id: 'techstars-la', name: 'Techstars LA', city: 'Los Angeles', country: 'USA', lat: 34.0195, lon: -118.4912, type: 'accelerator' },
  { id: 'amplify', name: 'Amplify LA', city: 'Los Angeles', country: 'USA', lat: 34.0407, lon: -118.2468, type: 'accelerator' },
  { id: 'launchpad-la', name: 'Launchpad LA', city: 'Los Angeles', country: 'USA', lat: 34.0159, lon: -118.4961, type: 'accelerator' },
  { id: 'science-inc', name: 'Science Inc', city: 'Santa Monica', country: 'USA', lat: 34.0195, lon: -118.4912, type: 'studio', notable: ['Dollar Shave Club'] },

  // USA - Austin/Texas
  { id: 'techstars-austin', name: 'Techstars Austin', city: 'Austin', country: 'USA', lat: 30.2672, lon: -97.7431, type: 'accelerator' },
  { id: 'capital-factory', name: 'Capital Factory', city: 'Austin', country: 'USA', lat: 30.2686, lon: -97.7435, type: 'accelerator', founded: 2009 },
  { id: 'techstars-san-antonio', name: 'Techstars San Antonio', city: 'San Antonio', country: 'USA', lat: 29.4241, lon: -98.4936, type: 'accelerator' },

  // USA - Seattle/Pacific NW
  { id: 'techstars-seattle', name: 'Techstars Seattle', city: 'Seattle', country: 'USA', lat: 47.6062, lon: -122.3321, type: 'accelerator' },

  // USA - Other
  { id: 'techstars-chicago', name: 'Techstars Chicago', city: 'Chicago', country: 'USA', lat: 41.8781, lon: -87.6298, type: 'accelerator' },
  { id: 'techstars-detroit', name: 'Techstars Detroit', city: 'Detroit', country: 'USA', lat: 42.3314, lon: -83.0458, type: 'accelerator' },
  { id: 'gener8tor', name: 'gener8tor', city: 'Milwaukee', country: 'USA', lat: 43.0389, lon: -87.9065, type: 'accelerator' },

  // USA - Corporate Accelerators
  { id: 'google-startups', name: 'Google for Startups', city: 'Mountain View', country: 'USA', lat: 37.4220, lon: -122.0841, type: 'accelerator' },
  { id: 'microsoft-accelerator', name: 'Microsoft Accelerator', city: 'Redmond', country: 'USA', lat: 47.6740, lon: -122.1215, type: 'accelerator' },
  { id: 'nvidia-inception', name: 'NVIDIA Inception', city: 'Santa Clara', country: 'USA', lat: 37.3708, lon: -121.9675, type: 'accelerator' },
  { id: 'aws-activate', name: 'AWS Activate', city: 'Seattle', country: 'USA', lat: 47.6205, lon: -122.3493, type: 'accelerator' },
  { id: 'cisco-launchpad', name: 'Cisco Launchpad', city: 'San Jose', country: 'USA', lat: 37.4089, lon: -121.9533, type: 'accelerator' },

  // ============ EUROPE - UK ============
  { id: 'seedcamp', name: 'Seedcamp', city: 'London', country: 'UK', lat: 51.5074, lon: -0.1278, type: 'accelerator', founded: 2007, notable: ['TransferWise', 'Revolut'] },
  { id: 'ef-london', name: 'Entrepreneur First', city: 'London', country: 'UK', lat: 51.5174, lon: -0.0878, type: 'accelerator', founded: 2011 },
  { id: 'techstars-london', name: 'Techstars London', city: 'London', country: 'UK', lat: 51.5214, lon: -0.0724, type: 'accelerator' },
  { id: 'founders-factory', name: 'Founders Factory', city: 'London', country: 'UK', lat: 51.5154, lon: -0.1410, type: 'studio', founded: 2015 },
  { id: 'wayra-uk', name: 'Wayra UK', city: 'London', country: 'UK', lat: 51.5034, lon: -0.0196, type: 'accelerator' },
  { id: 'bethnal-green', name: 'Bethnal Green Ventures', city: 'London', country: 'UK', lat: 51.5268, lon: -0.0556, type: 'accelerator' },
  { id: 'codebase', name: 'CodeBase', city: 'Edinburgh', country: 'UK', lat: 55.9533, lon: -3.1883, type: 'incubator' },

  // Europe - France
  { id: 'stationf', name: 'Station F', city: 'Paris', country: 'France', lat: 48.8341, lon: 2.3699, type: 'incubator', founded: 2017 },
  { id: 'thefamily', name: 'The Family', city: 'Paris', country: 'France', lat: 48.8644, lon: 2.3749, type: 'accelerator' },
  { id: 'techstars-paris', name: 'Techstars Paris', city: 'Paris', country: 'France', lat: 48.8566, lon: 2.3522, type: 'accelerator' },
  { id: 'numa', name: 'NUMA', city: 'Paris', country: 'France', lat: 48.8651, lon: 2.3490, type: 'accelerator' },

  // Europe - Germany
  { id: 'techstars-berlin', name: 'Techstars Berlin', city: 'Berlin', country: 'Germany', lat: 52.5200, lon: 13.4050, type: 'accelerator' },
  { id: 'rocket-internet', name: 'Rocket Internet', city: 'Berlin', country: 'Germany', lat: 52.5067, lon: 13.3244, type: 'studio', notable: ['Zalando', 'Delivery Hero'] },
  { id: 'axel-springer', name: 'Axel Springer Plug & Play', city: 'Berlin', country: 'Germany', lat: 52.5097, lon: 13.3879, type: 'accelerator' },
  { id: 'hub-berlin', name: 'hub:raum', city: 'Berlin', country: 'Germany', lat: 52.5255, lon: 13.3695, type: 'accelerator' },
  { id: 'startupbootcamp-berlin', name: 'Startupbootcamp Berlin', city: 'Berlin', country: 'Germany', lat: 52.5200, lon: 13.4050, type: 'accelerator' },

  // Europe - Netherlands
  { id: 'startupbootcamp', name: 'Startupbootcamp', city: 'Amsterdam', country: 'Netherlands', lat: 52.3702, lon: 4.8952, type: 'accelerator', founded: 2010 },
  { id: 'rockstart', name: 'Rockstart', city: 'Amsterdam', country: 'Netherlands', lat: 52.3676, lon: 4.9041, type: 'accelerator' },

  // Europe - Nordics
  { id: 'ef-stockholm', name: 'Entrepreneur First Stockholm', city: 'Stockholm', country: 'Sweden', lat: 59.3293, lon: 18.0686, type: 'accelerator' },
  { id: 'startup-wiseguys', name: 'Startup Wise Guys', city: 'Tallinn', country: 'Estonia', lat: 59.4370, lon: 24.7536, type: 'accelerator', founded: 2012 },
  { id: 'antler-stockholm', name: 'Antler Stockholm', city: 'Stockholm', country: 'Sweden', lat: 59.3346, lon: 18.0717, type: 'accelerator' },
  { id: 'nordic-makers', name: 'Nordic Makers', city: 'Copenhagen', country: 'Denmark', lat: 55.6761, lon: 12.5683, type: 'accelerator' },
  { id: 'slush', name: 'Slush', city: 'Helsinki', country: 'Finland', lat: 60.1699, lon: 24.9384, type: 'accelerator' },

  // Europe - Spain & Portugal
  { id: 'wayra-spain', name: 'Wayra Spain', city: 'Madrid', country: 'Spain', lat: 40.4168, lon: -3.7038, type: 'accelerator' },
  { id: 'lanzadera', name: 'Lanzadera', city: 'Valencia', country: 'Spain', lat: 39.4699, lon: -0.3763, type: 'accelerator', notable: ['Flywire'] },
  { id: 'seedrs', name: 'Seedrs', city: 'Barcelona', country: 'Spain', lat: 41.3851, lon: 2.1734, type: 'accelerator' },

  // Europe - Switzerland
  { id: 'venture-kick', name: 'Venture Kick', city: 'Zurich', country: 'Switzerland', lat: 47.3769, lon: 8.5417, type: 'accelerator' },
  { id: 'f10', name: 'F10 Fintech', city: 'Zurich', country: 'Switzerland', lat: 47.3686, lon: 8.5391, type: 'accelerator' },

  // ============ ASIA - Singapore ============
  { id: 'antler-sg', name: 'Antler', city: 'Singapore', country: 'Singapore', lat: 1.2833, lon: 103.8333, type: 'accelerator', founded: 2017 },
  { id: 'ef-singapore', name: 'Entrepreneur First Singapore', city: 'Singapore', country: 'Singapore', lat: 1.2966, lon: 103.8536, type: 'accelerator' },
  { id: 'jungle-ventures', name: 'Jungle Ventures', city: 'Singapore', country: 'Singapore', lat: 1.2789, lon: 103.8496, type: 'accelerator' },
  { id: 'iterative', name: 'Iterative', city: 'Singapore', country: 'Singapore', lat: 1.3048, lon: 103.8318, type: 'accelerator' },
  { id: 'sparklabs-sg', name: 'SparkLabs Singapore', city: 'Singapore', country: 'Singapore', lat: 1.2966, lon: 103.8500, type: 'accelerator' },

  // Asia - India
  { id: 'techstars-bangalore', name: 'Techstars Bangalore', city: 'Bangalore', country: 'India', lat: 12.9716, lon: 77.5946, type: 'accelerator' },
  { id: 't-hub', name: 'T-Hub', city: 'Hyderabad', country: 'India', lat: 17.4486, lon: 78.3908, type: 'incubator', founded: 2015 },
  { id: 'nasscom', name: 'NASSCOM 10000 Startups', city: 'Bangalore', country: 'India', lat: 12.9352, lon: 77.6245, type: 'accelerator' },
  { id: 'zone-startups', name: 'Zone Startups', city: 'Mumbai', country: 'India', lat: 19.0748, lon: 72.8856, type: 'accelerator' },
  { id: 'axilor', name: 'Axilor Ventures', city: 'Bangalore', country: 'India', lat: 12.9279, lon: 77.6271, type: 'accelerator' },

  // Asia - China
  { id: 'chinaccelerator', name: 'Chinaccelerator', city: 'Shanghai', country: 'China', lat: 31.2304, lon: 121.4737, type: 'accelerator' },
  { id: 'hax-shenzhen', name: 'HAX Shenzhen', city: 'Shenzhen', country: 'China', lat: 22.5431, lon: 114.0579, type: 'accelerator' },
  { id: 'sinovation', name: 'Sinovation Ventures', city: 'Beijing', country: 'China', lat: 39.9042, lon: 116.4074, type: 'accelerator' },
  { id: 'sosv-china', name: 'SOSV Chinaccelerator', city: 'Shanghai', country: 'China', lat: 31.2243, lon: 121.4690, type: 'accelerator' },

  // Asia - Japan & Korea
  { id: 'techstars-tokyo', name: 'Techstars Tokyo', city: 'Tokyo', country: 'Japan', lat: 35.6762, lon: 139.6503, type: 'accelerator' },
  { id: 'open-network-lab', name: 'Open Network Lab', city: 'Tokyo', country: 'Japan', lat: 35.6591, lon: 139.7007, type: 'accelerator' },
  { id: 'sparklabs-korea', name: 'SparkLabs Korea', city: 'Seoul', country: 'South Korea', lat: 37.5665, lon: 126.9780, type: 'accelerator' },
  { id: 'primer', name: 'Primer', city: 'Seoul', country: 'South Korea', lat: 37.4980, lon: 127.0276, type: 'accelerator' },

  // ============ MENA ============
  { id: 'flat6labs', name: 'Flat6Labs', city: 'Cairo', country: 'Egypt', lat: 30.0444, lon: 31.2357, type: 'accelerator', founded: 2011 },
  { id: 'flat6labs-uae', name: 'Flat6Labs Abu Dhabi', city: 'Abu Dhabi', country: 'UAE', lat: 24.4539, lon: 54.3773, type: 'accelerator' },
  { id: 'hub71', name: 'Hub71', city: 'Abu Dhabi', country: 'UAE', lat: 24.4669, lon: 54.3659, type: 'accelerator' },
  { id: 'dtec', name: 'DTEC', city: 'Dubai', country: 'UAE', lat: 25.0755, lon: 55.1713, type: 'incubator' },
  { id: 'in5', name: 'in5', city: 'Dubai', country: 'UAE', lat: 25.1003, lon: 55.1720, type: 'incubator' },
  { id: 'misk', name: 'Misk Accelerator', city: 'Riyadh', country: 'Saudi Arabia', lat: 24.7136, lon: 46.6753, type: 'accelerator' },
  { id: 'impact46', name: 'Impact46', city: 'Riyadh', country: 'Saudi Arabia', lat: 24.6877, lon: 46.6850, type: 'accelerator' },
  { id: 'oasis500', name: 'Oasis500', city: 'Amman', country: 'Jordan', lat: 31.9454, lon: 35.9284, type: 'accelerator' },
  { id: 'wamda', name: 'Wamda', city: 'Dubai', country: 'UAE', lat: 25.0994, lon: 55.1641, type: 'accelerator' },

  // ============ AUSTRALIA & NZ ============
  { id: 'startmate', name: 'Startmate', city: 'Sydney', country: 'Australia', lat: -33.8688, lon: 151.2093, type: 'accelerator', founded: 2010 },
  { id: 'blackbird', name: 'Blackbird Ventures', city: 'Sydney', country: 'Australia', lat: -33.8651, lon: 151.2099, type: 'accelerator' },
  { id: 'airtree', name: 'AirTree Ventures', city: 'Sydney', country: 'Australia', lat: -33.8670, lon: 151.2051, type: 'accelerator' },
  { id: 'antler-sydney', name: 'Antler Sydney', city: 'Sydney', country: 'Australia', lat: -33.8623, lon: 151.2108, type: 'accelerator' },
  { id: 'lightning-lab', name: 'Lightning Lab', city: 'Auckland', country: 'New Zealand', lat: -36.8509, lon: 174.7645, type: 'accelerator' },
  { id: 'icehouse', name: 'The Icehouse', city: 'Auckland', country: 'New Zealand', lat: -36.8485, lon: 174.7633, type: 'accelerator' },

  // ============ LATAM ============
  { id: 'startup-chile', name: 'Startup Chile', city: 'Santiago', country: 'Chile', lat: -33.4489, lon: -70.6693, type: 'accelerator', founded: 2010 },
  { id: 'wayra-latam', name: 'Wayra Hispam', city: 'Mexico City', country: 'Mexico', lat: 19.4326, lon: -99.1332, type: 'accelerator' },
  { id: '500-latam', name: '500 Startups LATAM', city: 'Mexico City', country: 'Mexico', lat: 19.4285, lon: -99.1332, type: 'accelerator' },
  { id: 'cubo', name: 'Cubo Itaú', city: 'São Paulo', country: 'Brazil', lat: -23.5629, lon: -46.6544, type: 'incubator' },
  { id: 'ace-startups', name: 'ACE Startups', city: 'São Paulo', country: 'Brazil', lat: -23.5505, lon: -46.6333, type: 'accelerator' },

  // ============ AFRICA ============
  { id: 'yc-africa', name: 'Y Combinator Africa', city: 'Lagos', country: 'Nigeria', lat: 6.5244, lon: 3.3792, type: 'accelerator' },
  { id: 'vc4a', name: 'VC4A', city: 'Lagos', country: 'Nigeria', lat: 6.4698, lon: 3.3872, type: 'accelerator' },
  { id: 'ihub', name: 'iHub', city: 'Nairobi', country: 'Kenya', lat: -1.2921, lon: 36.8219, type: 'incubator', founded: 2010 },
  { id: 'ccHub', name: 'CcHUB', city: 'Lagos', country: 'Nigeria', lat: 6.4300, lon: 3.4200, type: 'incubator' },
  { id: 'meltwater', name: 'Meltwater Entrepreneurial School', city: 'Accra', country: 'Ghana', lat: 5.6037, lon: -0.1870, type: 'accelerator' },
];

export const TECH_HQS: TechHQ[] = [
  // ============ USA - FAANG & Big Tech ============
  { id: 'apple', company: 'Apple', city: 'Cupertino', country: 'USA', lat: 37.3349, lon: -122.0090, type: 'faang', marketCap: '$3T' },
  { id: 'google', company: 'Google', city: 'Mountain View', country: 'USA', lat: 37.4220, lon: -122.0841, type: 'faang', marketCap: '$2T' },
  { id: 'amazon', company: 'Amazon', city: 'Seattle', country: 'USA', lat: 47.6205, lon: -122.3493, type: 'faang', marketCap: '$1.8T' },
  { id: 'meta', company: 'Meta', city: 'Menlo Park', country: 'USA', lat: 37.4530, lon: -122.1817, type: 'faang', marketCap: '$1.2T' },
  { id: 'microsoft', company: 'Microsoft', city: 'Redmond', country: 'USA', lat: 47.6740, lon: -122.1215, type: 'faang', marketCap: '$3T' },
  { id: 'nvidia', company: 'NVIDIA', city: 'Santa Clara', country: 'USA', lat: 37.3708, lon: -121.9675, type: 'faang', marketCap: '$1.5T' },
  { id: 'netflix', company: 'Netflix', city: 'Los Gatos', country: 'USA', lat: 37.2358, lon: -121.9624, type: 'faang' },

  // USA - AI Leaders
  { id: 'openai', company: 'OpenAI', city: 'San Francisco', country: 'USA', lat: 37.7749, lon: -122.4194, type: 'unicorn' },
  { id: 'anthropic', company: 'Anthropic', city: 'San Francisco', country: 'USA', lat: 37.7849, lon: -122.4094, type: 'unicorn' },
  { id: 'databricks', company: 'Databricks', city: 'San Francisco', country: 'USA', lat: 37.7749, lon: -122.4294, type: 'unicorn' },
  { id: 'scale-ai', company: 'Scale AI', city: 'San Francisco', country: 'USA', lat: 37.7849, lon: -122.3994, type: 'unicorn' },
  { id: 'cohere', company: 'Cohere', city: 'San Francisco', country: 'USA', lat: 37.7899, lon: -122.4094, type: 'unicorn' },

  // USA - Enterprise & Cloud
  { id: 'salesforce', company: 'Salesforce', city: 'San Francisco', country: 'USA', lat: 37.7897, lon: -122.3972, type: 'public' },
  { id: 'oracle', company: 'Oracle', city: 'Austin', country: 'USA', lat: 30.2672, lon: -97.7431, type: 'public' },
  { id: 'ibm', company: 'IBM', city: 'Armonk', country: 'USA', lat: 41.1118, lon: -73.7204, type: 'public' },
  { id: 'vmware', company: 'VMware', city: 'Palo Alto', country: 'USA', lat: 37.3957, lon: -122.1408, type: 'public' },
  { id: 'servicenow', company: 'ServiceNow', city: 'Santa Clara', country: 'USA', lat: 37.3861, lon: -121.9543, type: 'public' },
  { id: 'workday', company: 'Workday', city: 'Pleasanton', country: 'USA', lat: 37.6624, lon: -121.8747, type: 'public' },
  { id: 'snowflake', company: 'Snowflake', city: 'Bozeman', country: 'USA', lat: 45.6770, lon: -111.0429, type: 'public' },
  { id: 'splunk', company: 'Splunk', city: 'San Francisco', country: 'USA', lat: 37.7897, lon: -122.4000, type: 'public' },
  { id: 'cloudflare', company: 'Cloudflare', city: 'San Francisco', country: 'USA', lat: 37.7849, lon: -122.3894, type: 'public' },

  // USA - Semiconductors
  { id: 'intel', company: 'Intel', city: 'Santa Clara', country: 'USA', lat: 37.3875, lon: -121.9636, type: 'public' },
  { id: 'amd', company: 'AMD', city: 'Santa Clara', country: 'USA', lat: 37.3803, lon: -121.9610, type: 'public' },
  { id: 'qualcomm', company: 'Qualcomm', city: 'San Diego', country: 'USA', lat: 32.8998, lon: -117.2016, type: 'public' },
  { id: 'broadcom', company: 'Broadcom', city: 'San Jose', country: 'USA', lat: 37.3874, lon: -121.9637, type: 'public' },
  { id: 'micron', company: 'Micron', city: 'Boise', country: 'USA', lat: 43.6150, lon: -116.2023, type: 'public' },

  // USA - Software & SaaS
  { id: 'adobe', company: 'Adobe', city: 'San Jose', country: 'USA', lat: 37.3309, lon: -121.8930, type: 'public' },
  { id: 'cisco', company: 'Cisco', city: 'San Jose', country: 'USA', lat: 37.4089, lon: -121.9533, type: 'public' },
  { id: 'zoom', company: 'Zoom', city: 'San Jose', country: 'USA', lat: 37.3748, lon: -121.9648, type: 'public' },
  { id: 'slack', company: 'Slack', city: 'San Francisco', country: 'USA', lat: 37.7836, lon: -122.3896, type: 'public' },
  { id: 'palantir', company: 'Palantir', city: 'Denver', country: 'USA', lat: 39.7392, lon: -104.9903, type: 'public' },
  { id: 'crowdstrike', company: 'CrowdStrike', city: 'Austin', country: 'USA', lat: 30.2672, lon: -97.7431, type: 'public' },
  { id: 'palo-alto', company: 'Palo Alto Networks', city: 'Santa Clara', country: 'USA', lat: 37.3930, lon: -121.9856, type: 'public' },
  { id: 'fortinet', company: 'Fortinet', city: 'Sunnyvale', country: 'USA', lat: 37.3921, lon: -122.0371, type: 'public' },
  { id: 'okta', company: 'Okta', city: 'San Francisco', country: 'USA', lat: 37.7897, lon: -122.3952, type: 'public' },
  { id: 'mongodb', company: 'MongoDB', city: 'New York', country: 'USA', lat: 40.7520, lon: -73.9932, type: 'public' },
  { id: 'elastic', company: 'Elastic', city: 'Mountain View', country: 'USA', lat: 37.4030, lon: -122.1152, type: 'public' },
  { id: 'datadog', company: 'Datadog', city: 'New York', country: 'USA', lat: 40.7363, lon: -73.9919, type: 'public' },

  // USA - Fintech & Consumer
  { id: 'paypal', company: 'PayPal', city: 'San Jose', country: 'USA', lat: 37.3760, lon: -121.9217, type: 'public' },
  { id: 'square', company: 'Block (Square)', city: 'San Francisco', country: 'USA', lat: 37.7697, lon: -122.4294, type: 'public' },
  { id: 'stripe', company: 'Stripe', city: 'San Francisco', country: 'USA', lat: 37.7902, lon: -122.4069, type: 'unicorn' },
  { id: 'plaid', company: 'Plaid', city: 'San Francisco', country: 'USA', lat: 37.7851, lon: -122.4014, type: 'unicorn' },
  { id: 'coinbase', company: 'Coinbase', city: 'San Francisco', country: 'USA', lat: 37.7792, lon: -122.4191, type: 'public' },
  { id: 'robinhood', company: 'Robinhood', city: 'Menlo Park', country: 'USA', lat: 37.4516, lon: -122.1797, type: 'public' },
  { id: 'airbnb', company: 'Airbnb', city: 'San Francisco', country: 'USA', lat: 37.7717, lon: -122.4063, type: 'public' },
  { id: 'uber', company: 'Uber', city: 'San Francisco', country: 'USA', lat: 37.7749, lon: -122.4148, type: 'public' },
  { id: 'lyft', company: 'Lyft', city: 'San Francisco', country: 'USA', lat: 37.7699, lon: -122.4116, type: 'public' },
  { id: 'doordash', company: 'DoorDash', city: 'San Francisco', country: 'USA', lat: 37.7847, lon: -122.4041, type: 'public' },
  { id: 'instacart', company: 'Instacart', city: 'San Francisco', country: 'USA', lat: 37.7834, lon: -122.4004, type: 'public' },

  // USA - Social & Media
  { id: 'twitter', company: 'X (Twitter)', city: 'San Francisco', country: 'USA', lat: 37.7769, lon: -122.4158, type: 'public' },
  { id: 'pinterest', company: 'Pinterest', city: 'San Francisco', country: 'USA', lat: 37.7689, lon: -122.4126, type: 'public' },
  { id: 'snap', company: 'Snap', city: 'Santa Monica', country: 'USA', lat: 34.0195, lon: -118.4912, type: 'public' },
  { id: 'discord', company: 'Discord', city: 'San Francisco', country: 'USA', lat: 37.7809, lon: -122.3914, type: 'unicorn' },
  { id: 'reddit', company: 'Reddit', city: 'San Francisco', country: 'USA', lat: 37.7801, lon: -122.4037, type: 'public' },
  { id: 'linkedin', company: 'LinkedIn', city: 'Sunnyvale', country: 'USA', lat: 37.4257, lon: -122.0712, type: 'public' },
  { id: 'ebay', company: 'eBay', city: 'San Jose', country: 'USA', lat: 37.3653, lon: -121.9289, type: 'public' },

  // USA - Hardware & Devices
  { id: 'hp', company: 'HP Inc', city: 'Palo Alto', country: 'USA', lat: 37.4129, lon: -122.1476, type: 'public' },
  { id: 'dell', company: 'Dell', city: 'Round Rock', country: 'USA', lat: 30.5083, lon: -97.6789, type: 'public' },
  { id: 'tesla', company: 'Tesla', city: 'Austin', country: 'USA', lat: 30.2231, lon: -97.6228, type: 'public', marketCap: '$800B' },
  { id: 'spacex', company: 'SpaceX', city: 'Hawthorne', country: 'USA', lat: 33.9207, lon: -118.3280, type: 'unicorn' },
  { id: 'rivian', company: 'Rivian', city: 'Irvine', country: 'USA', lat: 33.6846, lon: -117.8265, type: 'public' },
  { id: 'lucid', company: 'Lucid Motors', city: 'Newark', country: 'USA', lat: 37.5174, lon: -122.0479, type: 'public' },

  // ============ EUROPE ============
  // UK
  { id: 'arm', company: 'ARM', city: 'Cambridge', country: 'UK', lat: 52.2053, lon: 0.1218, type: 'public', marketCap: '$120B' },
  { id: 'revolut', company: 'Revolut', city: 'London', country: 'UK', lat: 51.5154, lon: -0.1410, type: 'unicorn' },
  { id: 'wise', company: 'Wise', city: 'London', country: 'UK', lat: 51.5174, lon: -0.0870, type: 'public' },
  { id: 'deliveroo', company: 'Deliveroo', city: 'London', country: 'UK', lat: 51.5194, lon: -0.1302, type: 'public' },
  { id: 'deepmind', company: 'DeepMind', city: 'London', country: 'UK', lat: 51.5334, lon: -0.1254, type: 'unicorn' },
  { id: 'darktrace', company: 'Darktrace', city: 'Cambridge', country: 'UK', lat: 52.2044, lon: 0.1180, type: 'public' },
  { id: 'monzo', company: 'Monzo', city: 'London', country: 'UK', lat: 51.5186, lon: -0.0844, type: 'unicorn' },
  { id: 'checkout', company: 'Checkout.com', city: 'London', country: 'UK', lat: 51.5118, lon: -0.0825, type: 'unicorn' },

  // Germany
  { id: 'sap', company: 'SAP', city: 'Walldorf', country: 'Germany', lat: 49.3064, lon: 8.6498, type: 'public', marketCap: '$200B' },
  { id: 'n26', company: 'N26', city: 'Berlin', country: 'Germany', lat: 52.5200, lon: 13.4050, type: 'unicorn' },
  { id: 'zalando', company: 'Zalando', city: 'Berlin', country: 'Germany', lat: 52.5067, lon: 13.3244, type: 'public' },
  { id: 'delivery-hero', company: 'Delivery Hero', city: 'Berlin', country: 'Germany', lat: 52.5038, lon: 13.4432, type: 'public' },
  { id: 'celonis', company: 'Celonis', city: 'Munich', country: 'Germany', lat: 48.1351, lon: 11.5820, type: 'unicorn' },
  { id: 'personio', company: 'Personio', city: 'Munich', country: 'Germany', lat: 48.1372, lon: 11.5754, type: 'unicorn' },

  // Netherlands
  { id: 'asml', company: 'ASML', city: 'Veldhoven', country: 'Netherlands', lat: 51.4200, lon: 5.4000, type: 'public', marketCap: '$300B' },
  { id: 'adyen', company: 'Adyen', city: 'Amsterdam', country: 'Netherlands', lat: 52.3547, lon: 4.8945, type: 'public' },
  { id: 'booking', company: 'Booking.com', city: 'Amsterdam', country: 'Netherlands', lat: 52.3592, lon: 4.9038, type: 'public' },
  { id: 'messagebird', company: 'MessageBird', city: 'Amsterdam', country: 'Netherlands', lat: 52.3653, lon: 4.8929, type: 'unicorn' },
  { id: 'mollie', company: 'Mollie', city: 'Amsterdam', country: 'Netherlands', lat: 52.3508, lon: 4.9039, type: 'unicorn' },

  // Sweden
  { id: 'spotify', company: 'Spotify', city: 'Stockholm', country: 'Sweden', lat: 59.3293, lon: 18.0686, type: 'public' },
  { id: 'klarna', company: 'Klarna', city: 'Stockholm', country: 'Sweden', lat: 59.3366, lon: 18.0717, type: 'unicorn' },
  { id: 'king', company: 'King', city: 'Stockholm', country: 'Sweden', lat: 59.3342, lon: 18.0544, type: 'public' },
  { id: 'northvolt', company: 'Northvolt', city: 'Stockholm', country: 'Sweden', lat: 59.3340, lon: 18.0499, type: 'unicorn' },

  // France
  { id: 'dassault', company: 'Dassault Systèmes', city: 'Vélizy', country: 'France', lat: 48.7845, lon: 2.1896, type: 'public' },
  { id: 'criteo', company: 'Criteo', city: 'Paris', country: 'France', lat: 48.8688, lon: 2.3490, type: 'public' },
  { id: 'ubisoft', company: 'Ubisoft', city: 'Montreuil', country: 'France', lat: 48.8622, lon: 2.4432, type: 'public' },
  { id: 'blablacar', company: 'BlaBlaCar', city: 'Paris', country: 'France', lat: 48.8703, lon: 2.3540, type: 'unicorn' },
  { id: 'doctolib', company: 'Doctolib', city: 'Paris', country: 'France', lat: 48.8764, lon: 2.3576, type: 'unicorn' },
  { id: 'mistral', company: 'Mistral AI', city: 'Paris', country: 'France', lat: 48.8716, lon: 2.3427, type: 'unicorn' },

  // Ireland
  { id: 'stripe-eu', company: 'Stripe EU', city: 'Dublin', country: 'Ireland', lat: 53.3382, lon: -6.2591, type: 'unicorn' },
  { id: 'intercom', company: 'Intercom', city: 'Dublin', country: 'Ireland', lat: 53.3433, lon: -6.2605, type: 'unicorn' },

  // Finland
  { id: 'nokia', company: 'Nokia', city: 'Espoo', country: 'Finland', lat: 60.1756, lon: 24.8272, type: 'public' },
  { id: 'supercell', company: 'Supercell', city: 'Helsinki', country: 'Finland', lat: 60.1699, lon: 24.9384, type: 'unicorn' },
  { id: 'wolt', company: 'Wolt', city: 'Helsinki', country: 'Finland', lat: 60.1650, lon: 24.9550, type: 'unicorn' },

  // Estonia
  { id: 'bolt', company: 'Bolt', city: 'Tallinn', country: 'Estonia', lat: 59.4370, lon: 24.7536, type: 'unicorn' },
  { id: 'wise-ee', company: 'Wise HQ', city: 'Tallinn', country: 'Estonia', lat: 59.4388, lon: 24.7545, type: 'public' },

  // Switzerland
  { id: 'google-zurich', company: 'Google Zurich', city: 'Zurich', country: 'Switzerland', lat: 47.3667, lon: 8.5247, type: 'faang' },

  // ============ MENA - UAE ============
  { id: 'careem', company: 'Careem', city: 'Dubai', country: 'UAE', lat: 25.0771, lon: 55.1396, type: 'unicorn' },
  { id: 'noon', company: 'Noon', city: 'Dubai', country: 'UAE', lat: 25.1120, lon: 55.1380, type: 'unicorn' },
  { id: 'talabat', company: 'Talabat', city: 'Dubai', country: 'UAE', lat: 25.0972, lon: 55.1611, type: 'unicorn' },
  { id: 'g42', company: 'G42', city: 'Abu Dhabi', country: 'UAE', lat: 24.4669, lon: 54.3659, type: 'unicorn' },
  { id: 'anghami', company: 'Anghami', city: 'Abu Dhabi', country: 'UAE', lat: 24.4539, lon: 54.3773, type: 'public' },
  { id: 'dubizzle', company: 'Dubizzle Group', city: 'Dubai', country: 'UAE', lat: 25.1152, lon: 55.1375, type: 'unicorn' },
  { id: 'tabby-uae', company: 'Tabby', city: 'Dubai', country: 'UAE', lat: 25.0773, lon: 55.1409, type: 'unicorn', marketCap: '$4.5B' },
  { id: 'swvl', company: 'Swvl', city: 'Dubai', country: 'UAE', lat: 25.0657, lon: 55.1713, type: 'public' },
  { id: 'aramex', company: 'Aramex', city: 'Dubai', country: 'UAE', lat: 25.0717, lon: 55.1335, type: 'public' },
  { id: 'etisalat', company: 'e&', city: 'Abu Dhabi', country: 'UAE', lat: 24.4872, lon: 54.3563, type: 'public' },
  { id: 'mashreq', company: 'Mashreq Neo', city: 'Dubai', country: 'UAE', lat: 25.2614, lon: 55.2977, type: 'public' },

  // MENA - Saudi Arabia
  { id: 'tamara', company: 'Tamara', city: 'Riyadh', country: 'Saudi Arabia', lat: 24.7136, lon: 46.6753, type: 'unicorn', marketCap: '$1B' }, // BNPL
  { id: 'stc', company: 'STC', city: 'Riyadh', country: 'Saudi Arabia', lat: 24.6877, lon: 46.6850, type: 'public' },
  { id: 'stc-pay', company: 'stc pay', city: 'Riyadh', country: 'Saudi Arabia', lat: 24.7001, lon: 46.6753, type: 'unicorn' },
  { id: 'jahez', company: 'Jahez', city: 'Riyadh', country: 'Saudi Arabia', lat: 24.7070, lon: 46.6890, type: 'public' },
  { id: 'sary', company: 'Sary', city: 'Riyadh', country: 'Saudi Arabia', lat: 24.6950, lon: 46.7100, type: 'unicorn', marketCap: '$1B' }, // B2B marketplace
  { id: 'nana', company: 'Nana', city: 'Riyadh', country: 'Saudi Arabia', lat: 24.7470, lon: 46.6348, type: 'unicorn', marketCap: '$1B' }, // Grocery delivery
  { id: 'leejam', company: 'Leejam Sports', city: 'Riyadh', country: 'Saudi Arabia', lat: 24.7003, lon: 46.6859, type: 'public' },

  // MENA - Egypt
  { id: 'halan', company: 'MNT-Halan', city: 'Cairo', country: 'Egypt', lat: 30.0444, lon: 31.2357, type: 'unicorn', marketCap: '$1B' },
  { id: 'fawry', company: 'Fawry', city: 'Cairo', country: 'Egypt', lat: 30.0500, lon: 31.2333, type: 'public' },

  // MENA - Other
  { id: 'zain', company: 'Zain', city: 'Kuwait City', country: 'Kuwait', lat: 29.3759, lon: 47.9774, type: 'public' },

  // ============ CHINA ============
  { id: 'tencent', company: 'Tencent', city: 'Shenzhen', country: 'China', lat: 22.5333, lon: 114.1333, type: 'public', marketCap: '$400B' },
  { id: 'alibaba', company: 'Alibaba', city: 'Hangzhou', country: 'China', lat: 30.2741, lon: 120.1551, type: 'public', marketCap: '$200B' },
  { id: 'bytedance', company: 'ByteDance', city: 'Beijing', country: 'China', lat: 39.9876, lon: 116.4841, type: 'unicorn' },
  { id: 'baidu', company: 'Baidu', city: 'Beijing', country: 'China', lat: 40.0564, lon: 116.3053, type: 'public' },
  { id: 'jd', company: 'JD.com', city: 'Beijing', country: 'China', lat: 39.9792, lon: 116.4929, type: 'public' },
  { id: 'xiaomi', company: 'Xiaomi', city: 'Beijing', country: 'China', lat: 40.0010, lon: 116.3062, type: 'public' },
  { id: 'huawei', company: 'Huawei', city: 'Shenzhen', country: 'China', lat: 22.7240, lon: 114.1181, type: 'public' },
  { id: 'dji', company: 'DJI', city: 'Shenzhen', country: 'China', lat: 22.5388, lon: 113.9461, type: 'unicorn' },
  { id: 'meituan', company: 'Meituan', city: 'Beijing', country: 'China', lat: 39.9564, lon: 116.4274, type: 'public' },
  { id: 'pinduoduo', company: 'PDD Holdings', city: 'Shanghai', country: 'China', lat: 31.2304, lon: 121.4737, type: 'public', marketCap: '$180B' },
  { id: 'netease', company: 'NetEase', city: 'Hangzhou', country: 'China', lat: 30.2900, lon: 120.1616, type: 'public' },
  { id: 'bilibili', company: 'Bilibili', city: 'Shanghai', country: 'China', lat: 31.2400, lon: 121.4850, type: 'public' },
  { id: 'nio', company: 'NIO', city: 'Shanghai', country: 'China', lat: 31.2231, lon: 121.4697, type: 'public' },
  { id: 'xpeng', company: 'XPeng', city: 'Guangzhou', country: 'China', lat: 23.1291, lon: 113.2644, type: 'public' },
  { id: 'byd', company: 'BYD', city: 'Shenzhen', country: 'China', lat: 22.6506, lon: 114.0572, type: 'public' },
  { id: 'didi', company: 'DiDi', city: 'Beijing', country: 'China', lat: 39.9847, lon: 116.3074, type: 'public' },
  { id: 'sensetime', company: 'SenseTime', city: 'Hong Kong', country: 'China', lat: 22.3193, lon: 114.1694, type: 'public' },
  { id: 'kuaishou', company: 'Kuaishou', city: 'Beijing', country: 'China', lat: 40.0000, lon: 116.4167, type: 'public' },
  { id: 'ant-group', company: 'Ant Group', city: 'Hangzhou', country: 'China', lat: 30.2593, lon: 120.2193, type: 'unicorn' },
  { id: 'midea', company: 'Midea', city: 'Foshan', country: 'China', lat: 23.0218, lon: 113.1214, type: 'public' },

  // ============ INDIA ============
  // Bangalore Unicorns
  { id: 'flipkart', company: 'Flipkart', city: 'Bangalore', country: 'India', lat: 12.9716, lon: 77.5946, type: 'public', marketCap: '$37B' },
  { id: 'swiggy', company: 'Swiggy', city: 'Bangalore', country: 'India', lat: 12.9279, lon: 77.6271, type: 'public' },
  { id: 'byju', company: "BYJU'S", city: 'Bangalore', country: 'India', lat: 12.9352, lon: 77.6245, type: 'unicorn' },
  { id: 'razorpay', company: 'Razorpay', city: 'Bangalore', country: 'India', lat: 12.9716, lon: 77.5946, type: 'unicorn', marketCap: '$7.5B' },
  { id: 'phonepe', company: 'PhonePe', city: 'Bangalore', country: 'India', lat: 12.9641, lon: 77.5967, type: 'unicorn', marketCap: '$12B' },
  { id: 'meesho', company: 'Meesho', city: 'Bangalore', country: 'India', lat: 12.9616, lon: 77.6387, type: 'unicorn' },
  { id: 'cred', company: 'CRED', city: 'Bangalore', country: 'India', lat: 12.9716, lon: 77.6412, type: 'unicorn' },
  { id: 'ather', company: 'Ather Energy', city: 'Bangalore', country: 'India', lat: 12.9352, lon: 77.6100, type: 'unicorn' },
  { id: 'zerodha', company: 'Zerodha', city: 'Bangalore', country: 'India', lat: 12.9784, lon: 77.6408, type: 'unicorn', marketCap: '$2B' },
  { id: 'infosys', company: 'Infosys', city: 'Bangalore', country: 'India', lat: 12.8399, lon: 77.6770, type: 'public' },
  { id: 'wipro', company: 'Wipro', city: 'Bangalore', country: 'India', lat: 12.9259, lon: 77.6229, type: 'public' },
  { id: 'urban-company', company: 'Urban Company', city: 'Gurgaon', country: 'India', lat: 28.4595, lon: 77.0266, type: 'unicorn' },
  { id: 'quikr', company: 'Quikr', city: 'Bangalore', country: 'India', lat: 12.9716, lon: 77.5946, type: 'unicorn' },
  { id: 'netradyne', company: 'Netradyne', city: 'Bangalore', country: 'India', lat: 12.9783, lon: 77.6408, type: 'unicorn' },
  { id: 'porter-in', company: 'Porter', city: 'Bangalore', country: 'India', lat: 12.9547, lon: 77.6205, type: 'unicorn' },
  { id: 'perfios', company: 'Perfios', city: 'Bangalore', country: 'India', lat: 12.9294, lon: 77.6869, type: 'unicorn', marketCap: '$2.57B' },
  { id: 'juspay', company: 'Juspay', city: 'Bangalore', country: 'India', lat: 12.9778, lon: 77.5908, type: 'unicorn' },
  { id: 'krutrim', company: 'Krutrim', city: 'Bangalore', country: 'India', lat: 12.9698, lon: 77.7500, type: 'unicorn' },

  // Mumbai & Gurgaon Unicorns
  { id: 'zomato', company: 'Zomato', city: 'Gurgaon', country: 'India', lat: 28.4595, lon: 77.0266, type: 'public' },
  { id: 'ola', company: 'Ola', city: 'Bangalore', country: 'India', lat: 12.9352, lon: 77.6245, type: 'unicorn' },
  { id: 'paytm', company: 'Paytm', city: 'Noida', country: 'India', lat: 28.5355, lon: 77.3910, type: 'public' },
  { id: 'policybazaar', company: 'PolicyBazaar', city: 'Gurgaon', country: 'India', lat: 28.4231, lon: 77.0453, type: 'public' },
  { id: 'nykaa', company: 'Nykaa', city: 'Mumbai', country: 'India', lat: 19.0760, lon: 72.8777, type: 'public' },
  { id: 'coindcx', company: 'CoinDCX', city: 'Mumbai', country: 'India', lat: 19.0748, lon: 72.8856, type: 'unicorn' },
  { id: 'lenskart', company: 'Lenskart', city: 'Gurgaon', country: 'India', lat: 28.4595, lon: 77.0266, type: 'unicorn' },
  { id: 'dream11', company: 'Dream11', city: 'Mumbai', country: 'India', lat: 19.0760, lon: 72.8777, type: 'unicorn' },
  { id: 'oyo', company: 'OYO', city: 'Gurgaon', country: 'India', lat: 28.4595, lon: 77.0266, type: 'unicorn' },
  { id: 'freshworks', company: 'Freshworks', city: 'Chennai', country: 'India', lat: 13.0827, lon: 80.2707, type: 'public' },
  { id: 'moneyview', company: 'Money View', city: 'Bangalore', country: 'India', lat: 12.9716, lon: 77.5946, type: 'unicorn' },
  { id: 'delhivery', company: 'Delhivery', city: 'Gurgaon', country: 'India', lat: 28.4595, lon: 77.0266, type: 'public' },
  { id: 'groww', company: 'Groww', city: 'Bangalore', country: 'India', lat: 12.9716, lon: 77.5946, type: 'unicorn' },
  { id: 'cars24', company: 'Cars24', city: 'Gurgaon', country: 'India', lat: 28.4595, lon: 77.0266, type: 'unicorn' },
  { id: 'vedantu', company: 'Vedantu', city: 'Bangalore', country: 'India', lat: 12.9716, lon: 77.5946, type: 'unicorn' },
  { id: 'unacademy', company: 'Unacademy', city: 'Bangalore', country: 'India', lat: 12.9716, lon: 77.5946, type: 'unicorn' },
  { id: 'slice', company: 'Slice', city: 'Bangalore', country: 'India', lat: 12.9352, lon: 77.6245, type: 'unicorn' },
  { id: 'sharechat', company: 'ShareChat', city: 'Bangalore', country: 'India', lat: 12.9716, lon: 77.5946, type: 'unicorn' },
  { id: 'drools', company: 'Drools', city: 'Bangalore', country: 'India', lat: 12.9553, lon: 77.6344, type: 'unicorn' },

  // ============ SOUTH EAST ASIA - Singapore ============
  { id: 'grab', company: 'Grab', city: 'Singapore', country: 'Singapore', lat: 1.3080, lon: 103.8545, type: 'public' },
  { id: 'sea', company: 'Sea Limited', city: 'Singapore', country: 'Singapore', lat: 1.2966, lon: 103.8560, type: 'public' },
  { id: 'lazada', company: 'Lazada', city: 'Singapore', country: 'Singapore', lat: 1.2789, lon: 103.8536, type: 'unicorn' },
  { id: 'razer', company: 'Razer', city: 'Singapore', country: 'Singapore', lat: 1.2936, lon: 103.8547, type: 'public' },
  { id: 'propertyguru', company: 'PropertyGuru', city: 'Singapore', country: 'Singapore', lat: 1.2823, lon: 103.8500, type: 'public' },
  { id: 'ninja-van', company: 'Ninja Van', city: 'Singapore', country: 'Singapore', lat: 1.2870, lon: 103.8490, type: 'unicorn', marketCap: '$2B' },
  { id: 'silicon-box', company: 'Silicon Box', city: 'Singapore', country: 'Singapore', lat: 1.2973, lon: 103.8515, type: 'unicorn' },
  { id: 'xendit', company: 'Xendit', city: 'Singapore', country: 'Singapore', lat: 1.2966, lon: 103.8560, type: 'unicorn', marketCap: '$1.5B' },
  { id: 'moglix', company: 'Moglix', city: 'Singapore', country: 'Singapore', lat: 1.3080, lon: 103.8545, type: 'unicorn', marketCap: '$3B' },
  { id: 'trax', company: 'Trax', city: 'Singapore', country: 'Singapore', lat: 1.2789, lon: 103.8536, type: 'unicorn' },
  { id: 'patsnap', company: 'PatSnap', city: 'Singapore', country: 'Singapore', lat: 1.2936, lon: 103.8547, type: 'unicorn' },
  { id: 'carro', company: 'Carro', city: 'Singapore', country: 'Singapore', lat: 1.2823, lon: 103.8500, type: 'unicorn' },

  // South East Asia - Indonesia
  { id: 'goto', company: 'GoTo', city: 'Jakarta', country: 'Indonesia', lat: -6.2088, lon: 106.8456, type: 'public' },
  { id: 'bukalapak', company: 'Bukalapak', city: 'Jakarta', country: 'Indonesia', lat: -6.2146, lon: 106.8451, type: 'public' },
  { id: 'traveloka', company: 'Traveloka', city: 'Jakarta', country: 'Indonesia', lat: -6.2250, lon: 106.8100, type: 'unicorn' },
  { id: 'jt-express', company: 'J&T Express', city: 'Jakarta', country: 'Indonesia', lat: -6.2297, lon: 106.8295, type: 'unicorn', marketCap: '$20B' },
  { id: 'kopi-kenangan', company: 'Kopi Kenangan', city: 'Jakarta', country: 'Indonesia', lat: -6.2146, lon: 106.8451, type: 'unicorn' },
  { id: 'blibli', company: 'Blibli', city: 'Jakarta', country: 'Indonesia', lat: -6.2250, lon: 106.8100, type: 'public' },
  { id: 'akulaku', company: 'Akulaku', city: 'Jakarta', country: 'Indonesia', lat: -6.1944, lon: 106.8229, type: 'unicorn' },
  { id: 'kredivo', company: 'Kredivo', city: 'Jakarta', country: 'Indonesia', lat: -6.2088, lon: 106.8456, type: 'unicorn' },

  // South East Asia - Vietnam, Thailand, Philippines
  { id: 'vng', company: 'VNG Corporation', city: 'Ho Chi Minh City', country: 'Vietnam', lat: 10.7769, lon: 106.7009, type: 'unicorn' },
  { id: 'momo-vn', company: 'MoMo', city: 'Ho Chi Minh City', country: 'Vietnam', lat: 10.7800, lon: 106.6958, type: 'unicorn' },
  { id: 'vnpay', company: 'VNPay', city: 'Hanoi', country: 'Vietnam', lat: 21.0285, lon: 105.8542, type: 'unicorn' },
  { id: 'sky-mavis', company: 'Sky Mavis', city: 'Ho Chi Minh City', country: 'Vietnam', lat: 10.7620, lon: 106.6602, type: 'unicorn' },
  { id: 'flash-express', company: 'Flash Express', city: 'Bangkok', country: 'Thailand', lat: 13.7563, lon: 100.5018, type: 'unicorn' },
  { id: 'ascend-money', company: 'Ascend Money', city: 'Bangkok', country: 'Thailand', lat: 13.7563, lon: 100.5018, type: 'unicorn' },
  { id: 'mynt', company: 'Mynt (GCash)', city: 'Taguig', country: 'Philippines', lat: 14.5176, lon: 121.0509, type: 'unicorn' },
  { id: 'voyager', company: 'Voyager Innovations', city: 'Taguig', country: 'Philippines', lat: 14.5547, lon: 121.0244, type: 'unicorn' },

  // ============ NORTH ASIA ============
  // Japan
  { id: 'sony', company: 'Sony', city: 'Tokyo', country: 'Japan', lat: 35.6192, lon: 139.7500, type: 'public' },
  { id: 'softbank', company: 'SoftBank', city: 'Tokyo', country: 'Japan', lat: 35.6558, lon: 139.7513, type: 'public' },
  { id: 'rakuten', company: 'Rakuten', city: 'Tokyo', country: 'Japan', lat: 35.6269, lon: 139.7255, type: 'public' },
  { id: 'nintendo', company: 'Nintendo', city: 'Kyoto', country: 'Japan', lat: 34.9696, lon: 135.7557, type: 'public' },
  { id: 'mercari', company: 'Mercari', city: 'Tokyo', country: 'Japan', lat: 35.6591, lon: 139.7007, type: 'public' },

  // South Korea
  { id: 'samsung', company: 'Samsung', city: 'Seoul', country: 'South Korea', lat: 37.5284, lon: 127.0366, type: 'public', marketCap: '$350B' },
  { id: 'sk-hynix', company: 'SK Hynix', city: 'Icheon', country: 'South Korea', lat: 37.2792, lon: 127.4349, type: 'public' },
  { id: 'lg-electronics', company: 'LG Electronics', city: 'Seoul', country: 'South Korea', lat: 37.5014, lon: 126.9392, type: 'public' },
  { id: 'naver', company: 'Naver', city: 'Seongnam', country: 'South Korea', lat: 37.3595, lon: 127.1054, type: 'public' },
  { id: 'kakao', company: 'Kakao', city: 'Jeju', country: 'South Korea', lat: 33.4507, lon: 126.5703, type: 'public' },
  { id: 'coupang', company: 'Coupang', city: 'Seoul', country: 'South Korea', lat: 37.5015, lon: 127.0413, type: 'public' },

  // Taiwan
  { id: 'tsmc', company: 'TSMC', city: 'Hsinchu', country: 'Taiwan', lat: 24.7736, lon: 120.9974, type: 'public', marketCap: '$600B' },
  { id: 'foxconn', company: 'Foxconn', city: 'New Taipei', country: 'Taiwan', lat: 25.0459, lon: 121.4652, type: 'public' },
  { id: 'mediatek', company: 'MediaTek', city: 'Hsinchu', country: 'Taiwan', lat: 24.7831, lon: 120.9897, type: 'public' },

  // ============ AUSTRALIA ============
  { id: 'atlassian', company: 'Atlassian', city: 'Sydney', country: 'Australia', lat: -33.8688, lon: 151.2093, type: 'public' },
  { id: 'canva', company: 'Canva', city: 'Sydney', country: 'Australia', lat: -33.8651, lon: 151.2099, type: 'unicorn' },
  { id: 'afterpay', company: 'Afterpay', city: 'Melbourne', country: 'Australia', lat: -37.8136, lon: 144.9631, type: 'public' },
  { id: 'safetyculture', company: 'SafetyCulture', city: 'Sydney', country: 'Australia', lat: -33.8523, lon: 151.2108, type: 'unicorn' },
  { id: 'culture-amp', company: 'Culture Amp', city: 'Melbourne', country: 'Australia', lat: -37.8166, lon: 144.9640, type: 'unicorn' },
  { id: 'airwallex', company: 'Airwallex', city: 'Melbourne', country: 'Australia', lat: -37.8175, lon: 144.9679, type: 'unicorn' },

  // ============ CANADA ============
  { id: 'shopify', company: 'Shopify', city: 'Ottawa', country: 'Canada', lat: 45.4215, lon: -75.6972, type: 'public' },
  { id: 'opentext', company: 'OpenText', city: 'Waterloo', country: 'Canada', lat: 43.4643, lon: -80.5204, type: 'public' },
  { id: 'lightspeed', company: 'Lightspeed', city: 'Montreal', country: 'Canada', lat: 45.5017, lon: -73.5673, type: 'public' },
  { id: 'clio', company: 'Clio', city: 'Burnaby', country: 'Canada', lat: 49.2488, lon: -122.9805, type: 'unicorn' },
  { id: 'hootsuite', company: 'Hootsuite', city: 'Vancouver', country: 'Canada', lat: 49.2827, lon: -123.1207, type: 'unicorn' },

  // ============ LATIN AMERICA - Brazil ============
  { id: 'nubank', company: 'Nubank', city: 'São Paulo', country: 'Brazil', lat: -23.5629, lon: -46.6544, type: 'public', marketCap: '$45B' },
  { id: 'ifood', company: 'iFood', city: 'São Paulo', country: 'Brazil', lat: -23.5505, lon: -46.6333, type: 'unicorn', marketCap: '$5.4B' },
  { id: 'quintoandar', company: 'QuintoAndar', city: 'São Paulo', country: 'Brazil', lat: -23.5505, lon: -46.6333, type: 'unicorn', marketCap: '$5.1B' },
  { id: 'creditas', company: 'Creditas', city: 'São Paulo', country: 'Brazil', lat: -23.5629, lon: -46.6544, type: 'unicorn', marketCap: '$4.8B' },
  { id: 'c6bank', company: 'C6 Bank', city: 'São Paulo', country: 'Brazil', lat: -23.5629, lon: -46.6544, type: 'unicorn' },
  { id: 'pagseguro', company: 'PagSeguro', city: 'São Paulo', country: 'Brazil', lat: -23.5505, lon: -46.6333, type: 'public' },
  { id: 'stone', company: 'Stone', city: 'São Paulo', country: 'Brazil', lat: -23.5629, lon: -46.6544, type: 'public' },
  { id: 'ebanx', company: 'EBANX', city: 'Curitiba', country: 'Brazil', lat: -25.4284, lon: -49.2733, type: 'unicorn' },
  { id: 'vtex', company: 'VTEX', city: 'São Paulo', country: 'Brazil', lat: -23.5505, lon: -46.6333, type: 'public' },
  { id: 'loft', company: 'Loft', city: 'São Paulo', country: 'Brazil', lat: -23.5629, lon: -46.6544, type: 'unicorn' },
  { id: 'gympass', company: 'Gympass', city: 'São Paulo', country: 'Brazil', lat: -23.5505, lon: -46.6333, type: 'unicorn' },
  { id: 'loggi', company: 'Loggi', city: 'São Paulo', country: 'Brazil', lat: -23.5629, lon: -46.6544, type: 'unicorn' },
  { id: 'neon', company: 'Neon', city: 'São Paulo', country: 'Brazil', lat: -23.5505, lon: -46.6333, type: 'unicorn' },
  { id: 'hotmart', company: 'Hotmart', city: 'Belo Horizonte', country: 'Brazil', lat: -19.9167, lon: -43.9345, type: 'unicorn' },
  { id: 'madeiramadeira', company: 'MadeiraMadeira', city: 'Curitiba', country: 'Brazil', lat: -25.4284, lon: -49.2733, type: 'unicorn' },
  { id: 'cloudwalk', company: 'CloudWalk', city: 'São Paulo', country: 'Brazil', lat: -23.5629, lon: -46.6544, type: 'unicorn' },
  { id: 'qitech', company: 'QI Tech', city: 'São Paulo', country: 'Brazil', lat: -23.5505, lon: -46.6333, type: 'unicorn' },
  { id: 'tractian', company: 'Tractian', city: 'São Paulo', country: 'Brazil', lat: -23.5629, lon: -46.6544, type: 'unicorn' },
  { id: 'mottu', company: 'Mottu', city: 'São Paulo', country: 'Brazil', lat: -23.5505, lon: -46.6333, type: 'unicorn' },
  { id: 'starkbank', company: 'Stark Bank', city: 'São Paulo', country: 'Brazil', lat: -23.5629, lon: -46.6544, type: 'unicorn' },

  // Latin America - Mexico
  { id: 'kavak', company: 'Kavak', city: 'Mexico City', country: 'Mexico', lat: 19.4326, lon: -99.1332, type: 'unicorn' },
  { id: 'clip', company: 'Clip', city: 'Mexico City', country: 'Mexico', lat: 19.4285, lon: -99.1277, type: 'unicorn', marketCap: '$2B' },
  { id: 'bitso', company: 'Bitso', city: 'Mexico City', country: 'Mexico', lat: 19.4326, lon: -99.1332, type: 'unicorn', marketCap: '$2.2B' },
  { id: 'konfio', company: 'Konfío', city: 'Mexico City', country: 'Mexico', lat: 19.4326, lon: -99.1332, type: 'unicorn' },
  { id: 'kueski', company: 'Kueski', city: 'Guadalajara', country: 'Mexico', lat: 20.6597, lon: -103.3496, type: 'unicorn' },
  { id: 'clara', company: 'Clara', city: 'Mexico City', country: 'Mexico', lat: 19.4326, lon: -99.1332, type: 'unicorn' },
  { id: 'stori', company: 'Stori', city: 'Mexico City', country: 'Mexico', lat: 19.4285, lon: -99.1277, type: 'unicorn' },
  { id: 'incode', company: 'Incode', city: 'Mexico City', country: 'Mexico', lat: 19.4326, lon: -99.1332, type: 'unicorn' },

  // Latin America - Argentina & Colombia
  { id: 'mercadolibre', company: 'MercadoLibre', city: 'Buenos Aires', country: 'Argentina', lat: -34.6037, lon: -58.3816, type: 'public', marketCap: '$80B' },
  { id: 'uala', company: 'Ualá', city: 'Buenos Aires', country: 'Argentina', lat: -34.6037, lon: -58.3816, type: 'unicorn', marketCap: '$2.8B' },
  { id: 'pomelo', company: 'Pomelo', city: 'Buenos Aires', country: 'Argentina', lat: -34.6037, lon: -58.3816, type: 'unicorn' },
  { id: 'auth0-ar', company: 'Auth0', city: 'Buenos Aires', country: 'Argentina', lat: -34.6037, lon: -58.3816, type: 'unicorn' },
  { id: 'tiendanube', company: 'Tiendanube', city: 'Buenos Aires', country: 'Argentina', lat: -34.5867, lon: -58.4264, type: 'unicorn' },
  { id: 'rappi', company: 'Rappi', city: 'Bogotá', country: 'Colombia', lat: 4.6097, lon: -74.0817, type: 'unicorn' },
  { id: 'addi', company: 'Addi', city: 'Bogotá', country: 'Colombia', lat: 4.6097, lon: -74.0817, type: 'unicorn' },
  { id: 'frubana', company: 'Frubana', city: 'Bogotá', country: 'Colombia', lat: 4.6097, lon: -74.0817, type: 'unicorn' },

  // ============ AFRICA ============
  { id: 'flutterwave', company: 'Flutterwave', city: 'Lagos', country: 'Nigeria', lat: 6.4541, lon: 3.3947, type: 'unicorn' },
  { id: 'paystack', company: 'Paystack', city: 'Lagos', country: 'Nigeria', lat: 6.4500, lon: 3.3900, type: 'unicorn' },
  { id: 'jumia', company: 'Jumia', city: 'Lagos', country: 'Nigeria', lat: 6.4698, lon: 3.5852, type: 'public' },
  { id: 'mtn', company: 'MTN', city: 'Johannesburg', country: 'South Africa', lat: -26.1076, lon: 28.0567, type: 'public' },
  { id: 'safaricom', company: 'Safaricom', city: 'Nairobi', country: 'Kenya', lat: -1.2864, lon: 36.8172, type: 'public' },
];

export const CLOUD_REGIONS: CloudRegion[] = [
  // AWS Major Regions
  { id: 'aws-us-east-1', provider: 'aws', name: 'US East (N. Virginia)', city: 'Ashburn', country: 'USA', lat: 39.0438, lon: -77.4874, zones: 6 },
  { id: 'aws-us-west-2', provider: 'aws', name: 'US West (Oregon)', city: 'Boardman', country: 'USA', lat: 45.8399, lon: -119.7006, zones: 4 },
  { id: 'aws-eu-west-1', provider: 'aws', name: 'EU (Ireland)', city: 'Dublin', country: 'Ireland', lat: 53.3498, lon: -6.2603, zones: 3 },
  { id: 'aws-eu-central-1', provider: 'aws', name: 'EU (Frankfurt)', city: 'Frankfurt', country: 'Germany', lat: 50.1109, lon: 8.6821, zones: 3 },
  { id: 'aws-ap-northeast-1', provider: 'aws', name: 'Asia Pacific (Tokyo)', city: 'Tokyo', country: 'Japan', lat: 35.6762, lon: 139.6503, zones: 4 },
  { id: 'aws-ap-southeast-1', provider: 'aws', name: 'Asia Pacific (Singapore)', city: 'Singapore', country: 'Singapore', lat: 1.3521, lon: 103.8198, zones: 3 },
  { id: 'aws-ap-south-1', provider: 'aws', name: 'Asia Pacific (Mumbai)', city: 'Mumbai', country: 'India', lat: 19.0760, lon: 72.8777, zones: 3 },
  { id: 'aws-sa-east-1', provider: 'aws', name: 'South America (São Paulo)', city: 'São Paulo', country: 'Brazil', lat: -23.5505, lon: -46.6333, zones: 3 },

  // GCP Major Regions
  { id: 'gcp-us-central1', provider: 'gcp', name: 'Iowa', city: 'Council Bluffs', country: 'USA', lat: 41.2619, lon: -95.8608, zones: 4 },
  { id: 'gcp-us-east1', provider: 'gcp', name: 'South Carolina', city: 'Moncks Corner', country: 'USA', lat: 33.1960, lon: -80.0131, zones: 3 },
  { id: 'gcp-europe-west1', provider: 'gcp', name: 'Belgium', city: 'St. Ghislain', country: 'Belgium', lat: 50.4489, lon: 3.8187, zones: 3 },
  { id: 'gcp-asia-east1', provider: 'gcp', name: 'Taiwan', city: 'Changhua', country: 'Taiwan', lat: 24.0518, lon: 120.5161, zones: 3 },
  { id: 'gcp-asia-northeast1', provider: 'gcp', name: 'Tokyo', city: 'Tokyo', country: 'Japan', lat: 35.6895, lon: 139.6917, zones: 3 },

  // Azure Major Regions
  { id: 'azure-eastus', provider: 'azure', name: 'East US', city: 'Virginia', country: 'USA', lat: 37.3719, lon: -79.8164, zones: 3 },
  { id: 'azure-westeurope', provider: 'azure', name: 'West Europe', city: 'Amsterdam', country: 'Netherlands', lat: 52.3676, lon: 4.9041, zones: 3 },
  { id: 'azure-northeurope', provider: 'azure', name: 'North Europe', city: 'Dublin', country: 'Ireland', lat: 53.3331, lon: -6.2489, zones: 3 },
  { id: 'azure-southeastasia', provider: 'azure', name: 'Southeast Asia', city: 'Singapore', country: 'Singapore', lat: 1.2833, lon: 103.8333, zones: 3 },

  // Cloudflare Edge
  { id: 'cf-sfo', provider: 'cloudflare', name: 'San Francisco', city: 'San Francisco', country: 'USA', lat: 37.6213, lon: -122.3790 },
  { id: 'cf-lhr', provider: 'cloudflare', name: 'London', city: 'London', country: 'UK', lat: 51.4700, lon: -0.4543 },
  { id: 'cf-nrt', provider: 'cloudflare', name: 'Tokyo', city: 'Tokyo', country: 'Japan', lat: 35.7653, lon: 140.3864 },

  // MENA Cloud Regions
  { id: 'aws-me-south-1', provider: 'aws', name: 'Middle East (Bahrain)', city: 'Manama', country: 'Bahrain', lat: 26.2285, lon: 50.5860, zones: 3 },
  { id: 'aws-me-central-1', provider: 'aws', name: 'Middle East (UAE)', city: 'Dubai', country: 'UAE', lat: 25.2048, lon: 55.2708, zones: 3 },
  { id: 'azure-uaenorth', provider: 'azure', name: 'UAE North', city: 'Dubai', country: 'UAE', lat: 25.2669, lon: 55.3172, zones: 3 },
  { id: 'azure-uaecentral', provider: 'azure', name: 'UAE Central', city: 'Abu Dhabi', country: 'UAE', lat: 24.4539, lon: 54.3773 },
  { id: 'gcp-me-central1', provider: 'gcp', name: 'Doha', city: 'Doha', country: 'Qatar', lat: 25.2854, lon: 51.5310, zones: 3 },
  { id: 'gcp-me-west1', provider: 'gcp', name: 'Tel Aviv', city: 'Tel Aviv', country: 'Israel', lat: 32.0853, lon: 34.7818, zones: 3 },
];
