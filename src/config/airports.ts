import type { MonitoredAirport } from '@/types';

export const MONITORED_AIRPORTS: MonitoredAirport[] = [
  // Americas - Major US Hubs
  { iata: 'JFK', icao: 'KJFK', name: 'John F. Kennedy International', city: 'New York', country: 'USA', lat: 40.6413, lon: -73.7781, region: 'americas' },
  { iata: 'LAX', icao: 'KLAX', name: 'Los Angeles International', city: 'Los Angeles', country: 'USA', lat: 33.9416, lon: -118.4085, region: 'americas' },
  { iata: 'ORD', icao: 'KORD', name: "O'Hare International", city: 'Chicago', country: 'USA', lat: 41.9742, lon: -87.9073, region: 'americas' },
  { iata: 'ATL', icao: 'KATL', name: 'Hartsfield-Jackson Atlanta', city: 'Atlanta', country: 'USA', lat: 33.6407, lon: -84.4277, region: 'americas' },
  { iata: 'DFW', icao: 'KDFW', name: 'Dallas/Fort Worth International', city: 'Dallas', country: 'USA', lat: 32.8998, lon: -97.0403, region: 'americas' },
  { iata: 'DEN', icao: 'KDEN', name: 'Denver International', city: 'Denver', country: 'USA', lat: 39.8561, lon: -104.6737, region: 'americas' },
  { iata: 'SFO', icao: 'KSFO', name: 'San Francisco International', city: 'San Francisco', country: 'USA', lat: 37.6213, lon: -122.3790, region: 'americas' },
  { iata: 'SEA', icao: 'KSEA', name: 'Seattle-Tacoma International', city: 'Seattle', country: 'USA', lat: 47.4502, lon: -122.3088, region: 'americas' },
  { iata: 'MIA', icao: 'KMIA', name: 'Miami International', city: 'Miami', country: 'USA', lat: 25.7959, lon: -80.2870, region: 'americas' },
  { iata: 'BOS', icao: 'KBOS', name: 'Boston Logan International', city: 'Boston', country: 'USA', lat: 42.3656, lon: -71.0096, region: 'americas' },
  { iata: 'EWR', icao: 'KEWR', name: 'Newark Liberty International', city: 'Newark', country: 'USA', lat: 40.6895, lon: -74.1745, region: 'americas' },
  { iata: 'IAH', icao: 'KIAH', name: 'George Bush Intercontinental', city: 'Houston', country: 'USA', lat: 29.9902, lon: -95.3368, region: 'americas' },
  { iata: 'PHX', icao: 'KPHX', name: 'Phoenix Sky Harbor', city: 'Phoenix', country: 'USA', lat: 33.4373, lon: -112.0078, region: 'americas' },
  { iata: 'LAS', icao: 'KLAS', name: 'Harry Reid International', city: 'Las Vegas', country: 'USA', lat: 36.0840, lon: -115.1537, region: 'americas' },
  // Americas - Other
  { iata: 'YYZ', icao: 'CYYZ', name: 'Toronto Pearson', city: 'Toronto', country: 'Canada', lat: 43.6777, lon: -79.6248, region: 'americas' },
  { iata: 'YVR', icao: 'CYVR', name: 'Vancouver International', city: 'Vancouver', country: 'Canada', lat: 49.1947, lon: -123.1792, region: 'americas' },
  { iata: 'MEX', icao: 'MMSM', name: 'Felipe Angeles International', city: 'Mexico City', country: 'Mexico', lat: 19.7500, lon: -99.0200, region: 'americas' },
  { iata: 'GRU', icao: 'SBGR', name: 'São Paulo–Guarulhos', city: 'São Paulo', country: 'Brazil', lat: -23.4356, lon: -46.4731, region: 'americas' },
  { iata: 'EZE', icao: 'SAEZ', name: 'Ministro Pistarini', city: 'Buenos Aires', country: 'Argentina', lat: -34.8222, lon: -58.5358, region: 'americas' },
  { iata: 'BOG', icao: 'SKBO', name: 'El Dorado International', city: 'Bogotá', country: 'Colombia', lat: 4.7016, lon: -74.1469, region: 'americas' },
  { iata: 'SCL', icao: 'SCEL', name: 'Arturo Merino Benítez', city: 'Santiago', country: 'Chile', lat: -33.3930, lon: -70.7858, region: 'americas' },
  { iata: 'LIM', icao: 'SPJC', name: 'Jorge Chávez International', city: 'Lima', country: 'Peru', lat: -12.0219, lon: -77.1143, region: 'americas' },

  // Europe - Major Hubs
  { iata: 'LHR', icao: 'EGLL', name: 'London Heathrow', city: 'London', country: 'UK', lat: 51.4700, lon: -0.4543, region: 'europe' },
  { iata: 'CDG', icao: 'LFPG', name: 'Paris Charles de Gaulle', city: 'Paris', country: 'France', lat: 49.0097, lon: 2.5479, region: 'europe' },
  { iata: 'FRA', icao: 'EDDF', name: 'Frankfurt Airport', city: 'Frankfurt', country: 'Germany', lat: 50.0379, lon: 8.5622, region: 'europe' },
  { iata: 'AMS', icao: 'EHAM', name: 'Amsterdam Schiphol', city: 'Amsterdam', country: 'Netherlands', lat: 52.3105, lon: 4.7683, region: 'europe' },
  { iata: 'MAD', icao: 'LEMD', name: 'Adolfo Suárez Madrid–Barajas', city: 'Madrid', country: 'Spain', lat: 40.4983, lon: -3.5676, region: 'europe' },
  { iata: 'FCO', icao: 'LIRF', name: 'Leonardo da Vinci–Fiumicino', city: 'Rome', country: 'Italy', lat: 41.8003, lon: 12.2389, region: 'europe' },
  { iata: 'MUC', icao: 'EDDM', name: 'Munich Airport', city: 'Munich', country: 'Germany', lat: 48.3537, lon: 11.7750, region: 'europe' },
  { iata: 'BCN', icao: 'LEBL', name: 'Barcelona–El Prat', city: 'Barcelona', country: 'Spain', lat: 41.2974, lon: 2.0833, region: 'europe' },
  { iata: 'LGW', icao: 'EGKK', name: 'London Gatwick', city: 'London', country: 'UK', lat: 51.1537, lon: -0.1821, region: 'europe' },
  { iata: 'ZRH', icao: 'LSZH', name: 'Zurich Airport', city: 'Zurich', country: 'Switzerland', lat: 47.4647, lon: 8.5492, region: 'europe' },
  { iata: 'VIE', icao: 'LOWW', name: 'Vienna International', city: 'Vienna', country: 'Austria', lat: 48.1103, lon: 16.5697, region: 'europe' },
  { iata: 'CPH', icao: 'EKCH', name: 'Copenhagen Airport', city: 'Copenhagen', country: 'Denmark', lat: 55.6180, lon: 12.6508, region: 'europe' },
  { iata: 'DUB', icao: 'EIDW', name: 'Dublin Airport', city: 'Dublin', country: 'Ireland', lat: 53.4264, lon: -6.2499, region: 'europe' },
  { iata: 'IST', icao: 'LTFM', name: 'Istanbul Airport', city: 'Istanbul', country: 'Turkey', lat: 41.2753, lon: 28.7519, region: 'europe' },
  { iata: 'SVO', icao: 'UUEE', name: 'Sheremetyevo International', city: 'Moscow', country: 'Russia', lat: 55.9736, lon: 37.4125, region: 'europe' },
  { iata: 'ARN', icao: 'ESSA', name: 'Stockholm Arlanda', city: 'Stockholm', country: 'Sweden', lat: 59.6519, lon: 17.9186, region: 'europe' },
  { iata: 'OSL', icao: 'ENGM', name: 'Oslo Gardermoen', city: 'Oslo', country: 'Norway', lat: 60.1939, lon: 11.1004, region: 'europe' },
  { iata: 'HEL', icao: 'EFHK', name: 'Helsinki-Vantaa', city: 'Helsinki', country: 'Finland', lat: 60.3172, lon: 24.9633, region: 'europe' },

  // Asia-Pacific
  { iata: 'HND', icao: 'RJTT', name: 'Tokyo Haneda', city: 'Tokyo', country: 'Japan', lat: 35.5494, lon: 139.7798, region: 'apac' },
  { iata: 'NRT', icao: 'RJAA', name: 'Narita International', city: 'Tokyo', country: 'Japan', lat: 35.7720, lon: 140.3929, region: 'apac' },
  { iata: 'PEK', icao: 'ZBAA', name: 'Beijing Capital', city: 'Beijing', country: 'China', lat: 40.0799, lon: 116.6031, region: 'apac' },
  { iata: 'PVG', icao: 'ZSPD', name: 'Shanghai Pudong', city: 'Shanghai', country: 'China', lat: 31.1443, lon: 121.8083, region: 'apac' },
  { iata: 'HKG', icao: 'VHHH', name: 'Hong Kong International', city: 'Hong Kong', country: 'China', lat: 22.3080, lon: 113.9185, region: 'apac' },
  { iata: 'SIN', icao: 'WSSS', name: 'Singapore Changi', city: 'Singapore', country: 'Singapore', lat: 1.3644, lon: 103.9915, region: 'apac' },
  { iata: 'ICN', icao: 'RKSI', name: 'Incheon International', city: 'Seoul', country: 'South Korea', lat: 37.4602, lon: 126.4407, region: 'apac' },
  { iata: 'BKK', icao: 'VTBS', name: 'Suvarnabhumi Airport', city: 'Bangkok', country: 'Thailand', lat: 13.6900, lon: 100.7501, region: 'apac' },
  { iata: 'SYD', icao: 'YSSY', name: 'Sydney Kingsford Smith', city: 'Sydney', country: 'Australia', lat: -33.9461, lon: 151.1772, region: 'apac' },
  { iata: 'MEL', icao: 'YMML', name: 'Melbourne Airport', city: 'Melbourne', country: 'Australia', lat: -37.6690, lon: 144.8410, region: 'apac' },
  { iata: 'DEL', icao: 'VIDP', name: 'Indira Gandhi International', city: 'Delhi', country: 'India', lat: 28.5562, lon: 77.1000, region: 'apac' },
  { iata: 'BOM', icao: 'VABB', name: 'Chhatrapati Shivaji Maharaj', city: 'Mumbai', country: 'India', lat: 19.0896, lon: 72.8656, region: 'apac' },
  { iata: 'KUL', icao: 'WMKK', name: 'Kuala Lumpur International', city: 'Kuala Lumpur', country: 'Malaysia', lat: 2.7456, lon: 101.7099, region: 'apac' },
  { iata: 'CGK', icao: 'WIII', name: 'Soekarno-Hatta International', city: 'Jakarta', country: 'Indonesia', lat: -6.1256, lon: 106.6558, region: 'apac' },
  { iata: 'MNL', icao: 'RPLL', name: 'Ninoy Aquino International', city: 'Manila', country: 'Philippines', lat: 14.5086, lon: 121.0197, region: 'apac' },
  { iata: 'TPE', icao: 'RCTP', name: 'Taiwan Taoyuan International', city: 'Taipei', country: 'Taiwan', lat: 25.0797, lon: 121.2342, region: 'apac' },
  { iata: 'AKL', icao: 'NZAA', name: 'Auckland Airport', city: 'Auckland', country: 'New Zealand', lat: -37.0082, lon: 174.7850, region: 'apac' },

  // Middle East & North Africa
  { iata: 'DXB', icao: 'OMDB', name: 'Dubai International', city: 'Dubai', country: 'UAE', lat: 25.2532, lon: 55.3657, region: 'mena' },
  { iata: 'DOH', icao: 'OTHH', name: 'Hamad International', city: 'Doha', country: 'Qatar', lat: 25.2731, lon: 51.6081, region: 'mena' },
  { iata: 'AUH', icao: 'OMAA', name: 'Abu Dhabi International', city: 'Abu Dhabi', country: 'UAE', lat: 24.4330, lon: 54.6511, region: 'mena' },
  { iata: 'RUH', icao: 'OERK', name: 'King Khalid International', city: 'Riyadh', country: 'Saudi Arabia', lat: 24.9576, lon: 46.6988, region: 'mena' },
  { iata: 'JED', icao: 'OEJN', name: 'King Abdulaziz International', city: 'Jeddah', country: 'Saudi Arabia', lat: 21.6796, lon: 39.1565, region: 'mena' },
  { iata: 'CAI', icao: 'HECA', name: 'Cairo International', city: 'Cairo', country: 'Egypt', lat: 30.1219, lon: 31.4056, region: 'mena' },
  { iata: 'TLV', icao: 'LLBG', name: 'Ben Gurion Airport', city: 'Tel Aviv', country: 'Israel', lat: 32.0055, lon: 34.8854, region: 'mena' },
  { iata: 'AMM', icao: 'OJAI', name: 'Queen Alia International', city: 'Amman', country: 'Jordan', lat: 31.7226, lon: 35.9932, region: 'mena' },
  { iata: 'BAH', icao: 'OBBI', name: 'Bahrain International', city: 'Manama', country: 'Bahrain', lat: 26.2708, lon: 50.6336, region: 'mena' },
  { iata: 'KWI', icao: 'OKBK', name: 'Kuwait International', city: 'Kuwait City', country: 'Kuwait', lat: 29.2266, lon: 47.9689, region: 'mena' },
  { iata: 'MCT', icao: 'OOMS', name: 'Muscat International', city: 'Muscat', country: 'Oman', lat: 23.5933, lon: 58.2844, region: 'mena' },
  { iata: 'CMN', icao: 'GMMN', name: 'Mohammed V International', city: 'Casablanca', country: 'Morocco', lat: 33.3675, lon: -7.5898, region: 'mena' },
  { iata: 'ALG', icao: 'DAAG', name: 'Houari Boumediene Airport', city: 'Algiers', country: 'Algeria', lat: 36.6910, lon: 3.2154, region: 'mena' },
  { iata: 'TUN', icao: 'DTTA', name: 'Tunis–Carthage International', city: 'Tunis', country: 'Tunisia', lat: 36.8510, lon: 10.2272, region: 'mena' },

  // Africa
  { iata: 'JNB', icao: 'FAOR', name: 'O.R. Tambo International', city: 'Johannesburg', country: 'South Africa', lat: -26.1392, lon: 28.2460, region: 'africa' },
  { iata: 'CPT', icao: 'FACT', name: 'Cape Town International', city: 'Cape Town', country: 'South Africa', lat: -33.9715, lon: 18.6021, region: 'africa' },
  { iata: 'NBO', icao: 'HKJK', name: 'Jomo Kenyatta International', city: 'Nairobi', country: 'Kenya', lat: -1.3192, lon: 36.9278, region: 'africa' },
  { iata: 'LOS', icao: 'DNMM', name: 'Murtala Muhammed International', city: 'Lagos', country: 'Nigeria', lat: 6.5774, lon: 3.3212, region: 'africa' },
  { iata: 'ADD', icao: 'HAAB', name: 'Bole International', city: 'Addis Ababa', country: 'Ethiopia', lat: 8.9779, lon: 38.7993, region: 'africa' },
  { iata: 'ACC', icao: 'DGAA', name: 'Kotoka International', city: 'Accra', country: 'Ghana', lat: 5.6052, lon: -0.1668, region: 'africa' },
  { iata: 'DAR', icao: 'HTDA', name: 'Julius Nyerere International', city: 'Dar es Salaam', country: 'Tanzania', lat: -6.8781, lon: 39.2026, region: 'africa' },
  { iata: 'MRU', icao: 'FIMP', name: 'Sir Seewoosagur Ramgoolam', city: 'Mauritius', country: 'Mauritius', lat: -20.4302, lon: 57.6836, region: 'africa' },
];

// FAA-monitored airports (subset that works with FAA ASWS API)
export const FAA_AIRPORTS = MONITORED_AIRPORTS.filter(
  (a) => a.country === 'USA'
).map((a) => a.iata);

// Severity thresholds
export const DELAY_SEVERITY_THRESHOLDS = {
  minor: { avgDelayMinutes: 15, delayedPct: 15 },
  moderate: { avgDelayMinutes: 30, delayedPct: 30 },
  major: { avgDelayMinutes: 45, delayedPct: 45 },
  severe: { avgDelayMinutes: 60, delayedPct: 60 },
};
