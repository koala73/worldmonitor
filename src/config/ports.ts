export type PortType = 'container' | 'oil' | 'lng' | 'naval' | 'mixed' | 'bulk';

export interface Port {
  id: string;
  name: string;
  lat: number;
  lon: number;
  country: string;
  type: PortType;
  rank?: number;
  note: string;
}

export const PORTS: Port[] = [
  // Top Container Ports
  { id: 'shanghai', name: 'Port of Shanghai', lat: 31.23, lon: 121.47, country: 'China', type: 'container', rank: 1, note: "World's busiest container port. 47M+ TEU." },
  { id: 'singapore', name: 'Port of Singapore', lat: 1.26, lon: 103.84, country: 'Singapore', type: 'mixed', rank: 2, note: 'Major transshipment hub. Malacca Strait gateway. 37M+ TEU.' },
  { id: 'ningbo', name: 'Ningbo-Zhoushan', lat: 29.87, lon: 121.55, country: 'China', type: 'mixed', rank: 3, note: 'Largest cargo throughput globally. 33M+ TEU.' },
  { id: 'shenzhen', name: 'Port of Shenzhen', lat: 22.52, lon: 114.05, country: 'China', type: 'container', rank: 4, note: 'South China gateway. Yantian terminal. 30M+ TEU.' },
  { id: 'guangzhou', name: 'Port of Guangzhou', lat: 23.08, lon: 113.24, country: 'China', type: 'mixed', rank: 5, note: 'Pearl River Delta. Nansha terminal. 24M+ TEU.' },
  { id: 'qingdao', name: 'Port of Qingdao', lat: 36.07, lon: 120.31, country: 'China', type: 'mixed', rank: 6, note: 'North China hub. PLA Navy North Sea Fleet nearby.' },
  { id: 'busan', name: 'Port of Busan', lat: 35.10, lon: 129.04, country: 'South Korea', type: 'container', rank: 7, note: 'Northeast Asia transshipment hub. 22M+ TEU.' },
  { id: 'tianjin', name: 'Port of Tianjin', lat: 38.99, lon: 117.70, country: 'China', type: 'mixed', rank: 8, note: "Beijing's maritime gateway. 21M+ TEU." },
  { id: 'hong_kong', name: 'Port of Hong Kong', lat: 22.29, lon: 114.15, country: 'China (SAR)', type: 'container', rank: 9, note: 'Historic transshipment hub. 16M+ TEU.' },
  { id: 'rotterdam', name: 'Port of Rotterdam', lat: 51.90, lon: 4.50, country: 'Netherlands', type: 'mixed', rank: 10, note: "Europe's largest port. Gateway to EU. 14M+ TEU." },
  { id: 'jebel_ali', name: 'Jebel Ali (Dubai)', lat: 25.01, lon: 55.06, country: 'UAE', type: 'container', rank: 11, note: "Middle East's largest port. DP World hub. 14M+ TEU." },
  { id: 'antwerp', name: 'Port of Antwerp-Bruges', lat: 51.26, lon: 4.40, country: 'Belgium', type: 'mixed', rank: 12, note: "Europe's second largest. Petrochemicals hub. 13M+ TEU." },
  { id: 'klang', name: 'Port Klang', lat: 3.00, lon: 101.39, country: 'Malaysia', type: 'container', rank: 13, note: 'Malacca Strait. Westports terminal. 13M+ TEU.' },
  { id: 'xiamen', name: 'Port of Xiamen', lat: 24.45, lon: 118.08, country: 'China', type: 'container', rank: 14, note: 'Taiwan Strait. Strategic location. 12M+ TEU.' },
  { id: 'kaohsiung', name: 'Port of Kaohsiung', lat: 22.61, lon: 120.28, country: 'Taiwan', type: 'container', rank: 15, note: "Taiwan's largest port. Semiconductor exports. 9M+ TEU." },
  { id: 'los_angeles', name: 'Port of Los Angeles', lat: 33.73, lon: -118.26, country: 'USA', type: 'container', rank: 16, note: 'Western Hemisphere busiest. US-Asia trade gateway. 9M+ TEU.' },
  { id: 'long_beach', name: 'Port of Long Beach', lat: 33.75, lon: -118.20, country: 'USA', type: 'container', rank: 17, note: 'Handles 40% of US container imports with LA. 8M+ TEU.' },
  { id: 'tanjung_pelepas', name: 'Tanjung Pelepas', lat: 1.37, lon: 103.55, country: 'Malaysia', type: 'container', rank: 18, note: 'Maersk hub. Singapore competitor. 11M+ TEU.' },
  { id: 'hamburg', name: 'Port of Hamburg', lat: 53.54, lon: 9.99, country: 'Germany', type: 'container', rank: 19, note: "Germany's largest. North Sea-Baltic connector. 8M+ TEU." },
  { id: 'laem_chabang', name: 'Laem Chabang', lat: 13.08, lon: 100.88, country: 'Thailand', type: 'container', rank: 20, note: "Thailand's main port. EEC hub. 8M+ TEU." },
  { id: 'new_york_nj', name: 'Port of NY/NJ', lat: 40.67, lon: -74.04, country: 'USA', type: 'container', rank: 21, note: 'US East Coast largest. Newark/Elizabeth terminals. 9M+ TEU.' },
  { id: 'piraeus', name: 'Port of Piraeus', lat: 37.94, lon: 23.65, country: 'Greece', type: 'container', rank: 25, note: "COSCO-operated. China's Mediterranean gateway. 5M+ TEU." },

  // Critical Oil/LNG Terminals
  { id: 'ras_tanura', name: 'Ras Tanura', lat: 26.64, lon: 50.16, country: 'Saudi Arabia', type: 'oil', note: "World's largest offshore oil terminal. Saudi Aramco. 6.5M+ bpd." },
  { id: 'fujairah', name: 'Port of Fujairah', lat: 25.12, lon: 56.35, country: 'UAE', type: 'oil', note: 'Major bunkering hub. Hormuz bypass. Outside Persian Gulf.' },
  { id: 'kharg_island', name: 'Kharg Island', lat: 29.23, lon: 50.31, country: 'Iran', type: 'oil', note: "Iran's main oil export terminal. 90%+ of oil exports." },
  { id: 'ras_laffan', name: 'Ras Laffan', lat: 25.93, lon: 51.54, country: 'Qatar', type: 'lng', note: "World's largest LNG export facility. 77M+ tonnes/year." },
  { id: 'houston', name: 'Port of Houston', lat: 29.73, lon: -95.02, country: 'USA', type: 'mixed', note: 'US oil/petrochemical hub. 2nd busiest US port by tonnage.' },
  { id: 'sabine_pass', name: 'Sabine Pass LNG', lat: 29.73, lon: -93.87, country: 'USA', type: 'lng', note: 'Largest US LNG export terminal. Cheniere Energy.' },
  { id: 'novorossiysk', name: 'Novorossiysk', lat: 44.72, lon: 37.77, country: 'Russia', type: 'oil', note: "Russia's largest Black Sea port. CPC terminal. 140M+ tonnes/year." },
  { id: 'primorsk', name: 'Primorsk', lat: 60.35, lon: 28.62, country: 'Russia', type: 'oil', note: "Baltic Sea oil terminal. Russia's largest oil port." },

  // Strategic Chokepoint Ports
  { id: 'port_said', name: 'Port Said', lat: 31.26, lon: 32.30, country: 'Egypt', type: 'mixed', note: 'Suez Canal northern entrance. 12% of global trade.' },
  { id: 'suez_port', name: 'Port of Suez', lat: 29.97, lon: 32.55, country: 'Egypt', type: 'mixed', note: 'Suez Canal southern terminus. Red Sea access.' },
  { id: 'gibraltar', name: 'Port of Gibraltar', lat: 36.14, lon: -5.35, country: 'UK (Gibraltar)', type: 'naval', note: 'Mediterranean-Atlantic gateway. UK naval base.' },
  { id: 'djibouti', name: 'Port of Djibouti', lat: 11.59, lon: 43.15, country: 'Djibouti', type: 'mixed', note: 'Bab el-Mandeb gateway. Chinese + US military bases.' },
  { id: 'aden', name: 'Port of Aden', lat: 12.79, lon: 45.03, country: 'Yemen', type: 'mixed', note: 'Red Sea strategic port. Houthi conflict area.' },
  { id: 'hodeidah', name: 'Port of Hodeidah', lat: 14.80, lon: 42.95, country: 'Yemen', type: 'bulk', note: "Yemen's main humanitarian port. Houthi-controlled." },
  { id: 'bandar_abbas', name: 'Bandar Abbas', lat: 27.18, lon: 56.28, country: 'Iran', type: 'mixed', note: "Iran's largest container port. Hormuz Strait." },
  { id: 'colon', name: 'Port of Colon', lat: 9.35, lon: -79.90, country: 'Panama', type: 'container', note: 'Panama Canal Atlantic side. Major transshipment.' },
  { id: 'balboa', name: 'Port of Balboa', lat: 8.95, lon: -79.56, country: 'Panama', type: 'container', note: 'Panama Canal Pacific terminus. Americas hub.' },
  { id: 'algeciras', name: 'Port of Algeciras', lat: 36.13, lon: -5.43, country: 'Spain', type: 'container', note: 'Gibraltar Strait. Maersk transshipment hub. 5M+ TEU.' },

  // Strategic Naval Ports
  { id: 'zhanjiang', name: 'Zhanjiang', lat: 21.20, lon: 110.40, country: 'China', type: 'naval', note: 'PLA Navy South Sea Fleet HQ. Carrier base.' },
  { id: 'yulin', name: 'Yulin Naval Base', lat: 18.23, lon: 109.52, country: 'China', type: 'naval', note: 'Hainan Island. Nuclear submarine base. SCS control.' },
  { id: 'vladivostok', name: 'Port of Vladivostok', lat: 43.12, lon: 131.88, country: 'Russia', type: 'naval', note: 'Russian Pacific Fleet HQ. Trans-Siberian terminus.' },
  { id: 'murmansk', name: 'Port of Murmansk', lat: 68.97, lon: 33.05, country: 'Russia', type: 'naval', note: 'Arctic ice-free port. Northern Fleet base.' },
  { id: 'gwadar', name: 'Gwadar', lat: 25.12, lon: 62.33, country: 'Pakistan', type: 'mixed', note: 'Chinese CPEC port. Strategic PLA Navy interest.' },
  { id: 'hambantota', name: 'Hambantota', lat: 6.12, lon: 81.12, country: 'Sri Lanka', type: 'mixed', note: 'Chinese 99-year lease. Indian Ocean strategic.' },
  { id: 'chabahar', name: 'Chabahar', lat: 25.30, lon: 60.60, country: 'Iran', type: 'mixed', note: 'India-developed port. Hormuz bypass. Afghanistan access.' },

  // Major Regional Ports
  { id: 'colombo', name: 'Port of Colombo', lat: 6.94, lon: 79.84, country: 'Sri Lanka', type: 'container', note: 'Indian Ocean transshipment hub. 7M+ TEU.' },
  { id: 'yokohama', name: 'Port of Yokohama', lat: 35.44, lon: 139.64, country: 'Japan', type: 'container', note: "Tokyo Bay. Japan's 2nd largest. US 7th Fleet logistics." },
  { id: 'nagoya', name: 'Port of Nagoya', lat: 35.05, lon: 136.88, country: 'Japan', type: 'mixed', note: "Japan's largest by cargo. Toyota/auto exports." },
  { id: 'felixstowe', name: 'Port of Felixstowe', lat: 51.95, lon: 1.33, country: 'UK', type: 'container', note: "UK's busiest container port. 4M+ TEU." },
  { id: 'le_havre', name: 'Port of Le Havre', lat: 49.48, lon: 0.11, country: 'France', type: 'container', note: "France's largest container port. Paris gateway." },
  { id: 'savannah', name: 'Port of Savannah', lat: 32.08, lon: -81.09, country: 'USA', type: 'container', note: 'Fastest growing US port. 5M+ TEU.' },
  { id: 'norfolk', name: 'Port of Virginia', lat: 36.95, lon: -76.33, country: 'USA', type: 'mixed', note: 'Adjacent to Norfolk Naval Base. 3M+ TEU.' },
  { id: 'santos', name: 'Port of Santos', lat: -23.95, lon: -46.30, country: 'Brazil', type: 'mixed', note: "Latin America's busiest port. Sao Paulo gateway." },
  { id: 'manzanillo', name: 'Port of Manzanillo', lat: 19.05, lon: -104.32, country: 'Mexico', type: 'container', note: "Mexico's busiest port. Pacific gateway. USMCA trade corridor." },
  { id: 'lazaro_cardenas', name: 'Lazaro Cardenas', lat: 17.94, lon: -102.18, country: 'Mexico', type: 'mixed', note: "Mexico's 2nd largest. Asia-Mexico deep-water. Cartel smuggling route." },
  { id: 'veracruz', name: 'Port of Veracruz', lat: 19.20, lon: -96.13, country: 'Mexico', type: 'mixed', note: "Largest Gulf of Mexico port in Mexico. US-Mexico trade hub." },
  { id: 'karachi', name: 'Port of Karachi', lat: 24.84, lon: 67.00, country: 'Pakistan', type: 'mixed', note: "Pakistan's largest port. Naval HQ. 2M+ TEU." },
  { id: 'nhava_sheva', name: 'Nhava Sheva (JNPT)', lat: 18.95, lon: 72.95, country: 'India', type: 'container', note: "India's busiest container port. Mumbai gateway. 6M+ TEU." },
  { id: 'chennai', name: 'Port of Chennai', lat: 13.10, lon: 80.29, country: 'India', type: 'container', note: "India's 2nd largest. Auto industry. Bay of Bengal." },
  { id: 'mundra', name: 'Mundra Port', lat: 22.73, lon: 69.72, country: 'India', type: 'mixed', note: "India's largest private port. Adani Group." },
];

export function getPortsByType(type: PortType): Port[] {
  return PORTS.filter(p => p.type === type);
}

export function getTopContainerPorts(limit = 20): Port[] {
  return PORTS.filter(p => p.rank != null).sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999)).slice(0, limit);
}
