// Finance/Trading geographic data - exchanges, financial centers, central banks

export interface StockExchange {
  id: string;
  name: string;
  shortName: string;
  city: string;
  country: string;
  lat: number;
  lon: number;
  tier: 'mega' | 'major' | 'emerging';
  marketCap?: number; // in trillions USD
  tradingHours?: string;
  timezone?: string;
  description?: string;
}

export interface FinancialCenter {
  id: string;
  name: string;
  city: string;
  country: string;
  lat: number;
  lon: number;
  type: 'global' | 'regional' | 'offshore';
  gfciRank?: number; // Global Financial Centres Index rank
  specialties?: string[];
  description?: string;
}

export interface CentralBank {
  id: string;
  name: string;
  shortName: string;
  city: string;
  country: string;
  lat: number;
  lon: number;
  type: 'major' | 'regional' | 'supranational';
  currency?: string;
  description?: string;
}

export interface CommodityHub {
  id: string;
  name: string;
  city: string;
  country: string;
  lat: number;
  lon: number;
  type: 'exchange' | 'port' | 'refinery';
  commodities?: string[];
  description?: string;
}

// Major stock exchanges worldwide
export const STOCK_EXCHANGES: StockExchange[] = [
  // Mega exchanges (>$5T market cap)
  { id: 'nyse', name: 'New York Stock Exchange', shortName: 'NYSE', city: 'New York', country: 'US', lat: 40.7069, lon: -74.0113, tier: 'mega', marketCap: 28.0, tradingHours: '09:30-16:00 ET', timezone: 'America/New_York', description: 'Largest stock exchange by market cap' },
  { id: 'nasdaq', name: 'NASDAQ', shortName: 'NASDAQ', city: 'New York', country: 'US', lat: 40.7568, lon: -73.9860, tier: 'mega', marketCap: 24.0, tradingHours: '09:30-16:00 ET', timezone: 'America/New_York', description: 'Tech-heavy electronic exchange' },
  { id: 'sse', name: 'Shanghai Stock Exchange', shortName: 'SSE', city: 'Shanghai', country: 'CN', lat: 31.2333, lon: 121.4865, tier: 'mega', marketCap: 7.4, tradingHours: '09:30-15:00 CST', timezone: 'Asia/Shanghai', description: 'Largest exchange in China' },
  { id: 'euronext', name: 'Euronext', shortName: 'Euronext', city: 'Amsterdam', country: 'NL', lat: 52.3465, lon: 4.8790, tier: 'mega', marketCap: 7.2, tradingHours: '09:00-17:30 CET', timezone: 'Europe/Amsterdam', description: 'Pan-European exchange' },
  { id: 'jpx', name: 'Japan Exchange Group', shortName: 'JPX/TSE', city: 'Tokyo', country: 'JP', lat: 35.6803, lon: 139.7717, tier: 'mega', marketCap: 6.5, tradingHours: '09:00-15:00 JST', timezone: 'Asia/Tokyo', description: 'Tokyo Stock Exchange' },

  // Major exchanges ($1T-$5T)
  { id: 'szse', name: 'Shenzhen Stock Exchange', shortName: 'SZSE', city: 'Shenzhen', country: 'CN', lat: 22.5367, lon: 114.0571, tier: 'major', marketCap: 4.8, tradingHours: '09:30-15:00 CST', timezone: 'Asia/Shanghai', description: 'Tech-oriented Chinese exchange' },
  { id: 'hkex', name: 'Hong Kong Stock Exchange', shortName: 'HKEX', city: 'Hong Kong', country: 'HK', lat: 22.2832, lon: 114.1569, tier: 'major', marketCap: 4.5, tradingHours: '09:30-16:00 HKT', timezone: 'Asia/Hong_Kong', description: 'Gateway to Chinese markets' },
  { id: 'lse', name: 'London Stock Exchange', shortName: 'LSE', city: 'London', country: 'GB', lat: 51.5155, lon: -0.0922, tier: 'major', marketCap: 3.4, tradingHours: '08:00-16:30 GMT', timezone: 'Europe/London', description: 'Europe\'s largest exchange' },
  { id: 'nse-india', name: 'National Stock Exchange of India', shortName: 'NSE', city: 'Mumbai', country: 'IN', lat: 19.0557, lon: 72.8525, tier: 'major', marketCap: 3.6, tradingHours: '09:15-15:30 IST', timezone: 'Asia/Kolkata', description: 'India\'s largest exchange by volume' },
  { id: 'bse-india', name: 'BSE (Bombay Stock Exchange)', shortName: 'BSE', city: 'Mumbai', country: 'IN', lat: 18.9281, lon: 72.8333, tier: 'major', marketCap: 3.4, tradingHours: '09:15-15:30 IST', timezone: 'Asia/Kolkata', description: 'Asia\'s oldest exchange' },
  { id: 'tsx', name: 'Toronto Stock Exchange', shortName: 'TSX', city: 'Toronto', country: 'CA', lat: 43.6489, lon: -79.3818, tier: 'major', marketCap: 2.8, tradingHours: '09:30-16:00 ET', timezone: 'America/Toronto', description: 'Canada\'s largest exchange' },
  { id: 'krx', name: 'Korea Exchange', shortName: 'KRX', city: 'Seoul', country: 'KR', lat: 37.5230, lon: 126.9258, tier: 'major', marketCap: 2.2, tradingHours: '09:00-15:30 KST', timezone: 'Asia/Seoul', description: 'South Korea\'s exchange' },
  { id: 'six', name: 'SIX Swiss Exchange', shortName: 'SIX', city: 'Zurich', country: 'CH', lat: 47.3685, lon: 8.5400, tier: 'major', marketCap: 2.0, tradingHours: '09:00-17:30 CET', timezone: 'Europe/Zurich', description: 'Switzerland\'s primary exchange' },
  { id: 'asx', name: 'Australian Securities Exchange', shortName: 'ASX', city: 'Sydney', country: 'AU', lat: -33.8672, lon: 151.2067, tier: 'major', marketCap: 1.7, tradingHours: '10:00-16:00 AEST', timezone: 'Australia/Sydney', description: 'Australia\'s primary exchange' },
  { id: 'xetra', name: 'Deutsche Börse (Xetra)', shortName: 'Xetra', city: 'Frankfurt', country: 'DE', lat: 50.1110, lon: 8.6804, tier: 'major', marketCap: 2.3, tradingHours: '09:00-17:30 CET', timezone: 'Europe/Berlin', description: 'Germany\'s primary exchange' },
  { id: 'twse', name: 'Taiwan Stock Exchange', shortName: 'TWSE', city: 'Taipei', country: 'TW', lat: 25.0388, lon: 121.5632, tier: 'major', marketCap: 2.0, tradingHours: '09:00-13:30 CST', timezone: 'Asia/Taipei', description: 'Taiwan\'s primary exchange' },

  // Emerging/Regional exchanges
  { id: 'b3', name: 'B3 (Brasil Bolsa Balcão)', shortName: 'B3', city: 'São Paulo', country: 'BR', lat: -23.5486, lon: -46.6341, tier: 'emerging', marketCap: 0.9, tradingHours: '10:00-17:30 BRT', timezone: 'America/Sao_Paulo', description: 'Brazil\'s stock exchange' },
  { id: 'jse', name: 'Johannesburg Stock Exchange', shortName: 'JSE', city: 'Johannesburg', country: 'ZA', lat: -26.1088, lon: 28.0318, tier: 'emerging', marketCap: 1.2, tradingHours: '09:00-17:00 SAST', timezone: 'Africa/Johannesburg', description: 'Africa\'s largest exchange' },
  { id: 'sgx', name: 'Singapore Exchange', shortName: 'SGX', city: 'Singapore', country: 'SG', lat: 1.2794, lon: 103.8498, tier: 'major', marketCap: 0.7, tradingHours: '09:00-17:00 SGT', timezone: 'Asia/Singapore', description: 'Singapore\'s exchange' },
  { id: 'tadawul', name: 'Saudi Exchange (Tadawul)', shortName: 'Tadawul', city: 'Riyadh', country: 'SA', lat: 24.7103, lon: 46.6770, tier: 'emerging', marketCap: 2.9, tradingHours: '10:00-15:00 AST', timezone: 'Asia/Riyadh', description: 'Saudi Arabia\'s exchange' },
  { id: 'idx', name: 'Indonesia Stock Exchange', shortName: 'IDX', city: 'Jakarta', country: 'ID', lat: -6.2293, lon: 106.8130, tier: 'emerging', marketCap: 0.6, tradingHours: '09:00-15:50 WIB', timezone: 'Asia/Jakarta', description: 'Indonesia\'s primary exchange' },
  { id: 'set', name: 'Stock Exchange of Thailand', shortName: 'SET', city: 'Bangkok', country: 'TH', lat: 13.7205, lon: 100.5250, tier: 'emerging', marketCap: 0.5, tradingHours: '10:00-16:30 ICT', timezone: 'Asia/Bangkok', description: 'Thailand\'s exchange' },
  { id: 'bvl', name: 'Bolsa de Valores de Lima', shortName: 'BVL', city: 'Lima', country: 'PE', lat: -12.0483, lon: -77.0258, tier: 'emerging', description: 'Peru\'s stock exchange' },
  { id: 'bmv', name: 'Bolsa Mexicana de Valores', shortName: 'BMV', city: 'Mexico City', country: 'MX', lat: 19.4345, lon: -99.1424, tier: 'emerging', marketCap: 0.5, tradingHours: '08:30-15:00 CT', timezone: 'America/Mexico_City', description: 'Mexico\'s stock exchange' },
  { id: 'moex', name: 'Moscow Exchange', shortName: 'MOEX', city: 'Moscow', country: 'RU', lat: 55.7539, lon: 37.6084, tier: 'emerging', marketCap: 0.6, tradingHours: '09:50-18:50 MSK', timezone: 'Europe/Moscow', description: 'Russia\'s largest exchange' },
  { id: 'nse-nig', name: 'Nigerian Exchange', shortName: 'NGX', city: 'Lagos', country: 'NG', lat: 6.4549, lon: 3.4246, tier: 'emerging', description: 'Nigeria\'s exchange' },
  { id: 'egx', name: 'Egyptian Exchange', shortName: 'EGX', city: 'Cairo', country: 'EG', lat: 30.0492, lon: 31.2340, tier: 'emerging', description: 'Egypt\'s exchange' },
  { id: 'nzx', name: 'New Zealand Exchange', shortName: 'NZX', city: 'Wellington', country: 'NZ', lat: -41.2866, lon: 174.7756, tier: 'emerging', description: 'New Zealand\'s exchange' },
  { id: 'tase', name: 'Tel Aviv Stock Exchange', shortName: 'TASE', city: 'Tel Aviv', country: 'IL', lat: 32.0669, lon: 34.7856, tier: 'emerging', marketCap: 0.3, tradingHours: '09:59-17:15 IST', timezone: 'Asia/Jerusalem', description: 'Israel\'s exchange' },
];

// Major financial centers (GFCI-ranked)
export const FINANCIAL_CENTERS: FinancialCenter[] = [
  // Global financial centers (top tier)
  { id: 'fc-nyc', name: 'New York', city: 'New York', country: 'US', lat: 40.7580, lon: -74.0001, type: 'global', gfciRank: 1, specialties: ['Equities', 'Fixed Income', 'Derivatives', 'Banking'], description: 'World\'s largest financial center' },
  { id: 'fc-london', name: 'London', city: 'London', country: 'GB', lat: 51.5128, lon: -0.0908, type: 'global', gfciRank: 2, specialties: ['FX', 'Insurance', 'Commodities', 'Fintech'], description: 'Europe\'s leading financial hub' },
  { id: 'fc-singapore', name: 'Singapore', city: 'Singapore', country: 'SG', lat: 1.2833, lon: 103.8500, type: 'global', gfciRank: 3, specialties: ['Wealth Management', 'FX', 'Commodities'], description: 'Asia\'s premier financial center' },
  { id: 'fc-hongkong', name: 'Hong Kong', city: 'Hong Kong', country: 'HK', lat: 22.2830, lon: 114.1530, type: 'global', gfciRank: 4, specialties: ['IPOs', 'Equities', 'Wealth Management'], description: 'China gateway financial hub' },
  { id: 'fc-sanfrancisco', name: 'San Francisco', city: 'San Francisco', country: 'US', lat: 37.7940, lon: -122.3999, type: 'global', gfciRank: 5, specialties: ['VC', 'Tech Finance', 'Fintech'], description: 'Tech-finance nexus' },

  // Regional financial centers
  { id: 'fc-tokyo', name: 'Tokyo', city: 'Tokyo', country: 'JP', lat: 35.6762, lon: 139.6503, type: 'regional', gfciRank: 9, specialties: ['Equities', 'Government Bonds'], description: 'Japan\'s financial center' },
  { id: 'fc-shanghai', name: 'Shanghai', city: 'Shanghai', country: 'CN', lat: 31.2304, lon: 121.4737, type: 'regional', gfciRank: 7, specialties: ['A-shares', 'Commodities', 'RMB products'], description: 'China\'s financial hub' },
  { id: 'fc-chicago', name: 'Chicago', city: 'Chicago', country: 'US', lat: 41.8825, lon: -87.6328, type: 'regional', gfciRank: 10, specialties: ['Derivatives', 'Futures', 'Options', 'Commodities'], description: 'Derivatives trading capital' },
  { id: 'fc-zurich', name: 'Zurich', city: 'Zurich', country: 'CH', lat: 47.3686, lon: 8.5391, type: 'regional', gfciRank: 8, specialties: ['Private Banking', 'Wealth Management', 'Insurance'], description: 'Swiss banking center' },
  { id: 'fc-frankfurt', name: 'Frankfurt', city: 'Frankfurt', country: 'DE', lat: 50.1109, lon: 8.6821, type: 'regional', gfciRank: 11, specialties: ['ECB', 'Banking', 'Euro clearing'], description: 'European Central Bank seat' },
  { id: 'fc-sydney', name: 'Sydney', city: 'Sydney', country: 'AU', lat: -33.8688, lon: 151.2093, type: 'regional', gfciRank: 12, specialties: ['Mining Finance', 'Superannuation', 'FX'], description: 'Oceania\'s financial hub' },
  { id: 'fc-dubai', name: 'Dubai / DIFC', city: 'Dubai', country: 'AE', lat: 25.2134, lon: 55.2825, type: 'regional', gfciRank: 13, specialties: ['Islamic Finance', 'Wealth Management', 'Commodities'], description: 'Middle East financial center' },
  { id: 'fc-seoul', name: 'Seoul', city: 'Seoul', country: 'KR', lat: 37.5665, lon: 126.9780, type: 'regional', gfciRank: 6, specialties: ['Equities', 'Tech', 'Fintech'], description: 'South Korean financial hub' },
  { id: 'fc-mumbai', name: 'Mumbai', city: 'Mumbai', country: 'IN', lat: 19.0760, lon: 72.8777, type: 'regional', gfciRank: 15, specialties: ['Equities', 'Derivatives', 'Fintech'], description: 'India\'s financial capital' },
  { id: 'fc-toronto', name: 'Toronto', city: 'Toronto', country: 'CA', lat: 43.6532, lon: -79.3832, type: 'regional', gfciRank: 14, specialties: ['Mining Finance', 'Banking', 'Pensions'], description: 'Canada\'s financial center' },

  // Offshore / specialized centers
  { id: 'fc-cayman', name: 'Cayman Islands', city: 'George Town', country: 'KY', lat: 19.2869, lon: -81.3674, type: 'offshore', specialties: ['Hedge Funds', 'Offshore Banking', 'Captive Insurance'], description: 'Major offshore financial center' },
  { id: 'fc-luxembourg', name: 'Luxembourg', city: 'Luxembourg', country: 'LU', lat: 49.6116, lon: 6.1319, type: 'offshore', gfciRank: 16, specialties: ['Fund Management', 'EU Regulation', 'Green Finance'], description: 'EU fund domiciliation hub' },
  { id: 'fc-bermuda', name: 'Bermuda', city: 'Hamilton', country: 'BM', lat: 32.2949, lon: -64.7820, type: 'offshore', specialties: ['Insurance', 'Reinsurance', 'ILS'], description: 'Insurance/reinsurance capital' },
  { id: 'fc-channelislands', name: 'Channel Islands', city: 'St. Helier', country: 'JE', lat: 49.1868, lon: -2.1091, type: 'offshore', specialties: ['Trusts', 'Private Banking', 'Fund Administration'], description: 'Offshore banking center' },
];

// Major central banks
export const CENTRAL_BANKS: CentralBank[] = [
  { id: 'fed', name: 'Federal Reserve', shortName: 'Fed', city: 'Washington D.C.', country: 'US', lat: 38.8928, lon: -77.0455, type: 'major', currency: 'USD', description: 'US central bank, global reserve currency issuer' },
  { id: 'ecb', name: 'European Central Bank', shortName: 'ECB', city: 'Frankfurt', country: 'DE', lat: 50.1096, lon: 8.7033, type: 'supranational', currency: 'EUR', description: 'Eurozone monetary authority' },
  { id: 'boj', name: 'Bank of Japan', shortName: 'BoJ', city: 'Tokyo', country: 'JP', lat: 35.6867, lon: 139.7635, type: 'major', currency: 'JPY', description: 'Japan\'s central bank' },
  { id: 'boe', name: 'Bank of England', shortName: 'BoE', city: 'London', country: 'GB', lat: 51.5142, lon: -0.0882, type: 'major', currency: 'GBP', description: 'UK\'s central bank' },
  { id: 'pboc', name: 'People\'s Bank of China', shortName: 'PBoC', city: 'Beijing', country: 'CN', lat: 39.9064, lon: 116.4038, type: 'major', currency: 'CNY', description: 'China\'s central bank' },
  { id: 'snb', name: 'Swiss National Bank', shortName: 'SNB', city: 'Bern', country: 'CH', lat: 46.9482, lon: 7.4476, type: 'major', currency: 'CHF', description: 'Switzerland\'s central bank' },
  { id: 'rba', name: 'Reserve Bank of Australia', shortName: 'RBA', city: 'Sydney', country: 'AU', lat: -33.8627, lon: 151.2111, type: 'major', currency: 'AUD', description: 'Australia\'s central bank' },
  { id: 'boc', name: 'Bank of Canada', shortName: 'BoC', city: 'Ottawa', country: 'CA', lat: 45.4230, lon: -75.7010, type: 'major', currency: 'CAD', description: 'Canada\'s central bank' },
  { id: 'rbi', name: 'Reserve Bank of India', shortName: 'RBI', city: 'Mumbai', country: 'IN', lat: 18.9323, lon: 72.8338, type: 'major', currency: 'INR', description: 'India\'s central bank' },
  { id: 'bok', name: 'Bank of Korea', shortName: 'BoK', city: 'Seoul', country: 'KR', lat: 37.5604, lon: 126.9814, type: 'major', currency: 'KRW', description: 'South Korea\'s central bank' },
  { id: 'bcb', name: 'Banco Central do Brasil', shortName: 'BCB', city: 'Brasília', country: 'BR', lat: -15.7839, lon: -47.8829, type: 'regional', currency: 'BRL', description: 'Brazil\'s central bank' },
  { id: 'sama', name: 'Saudi Central Bank', shortName: 'SAMA', city: 'Riyadh', country: 'SA', lat: 24.6938, lon: 46.6850, type: 'regional', currency: 'SAR', description: 'Saudi Arabia\'s central bank' },
  { id: 'bis', name: 'Bank for International Settlements', shortName: 'BIS', city: 'Basel', country: 'CH', lat: 47.5585, lon: 7.5866, type: 'supranational', description: 'Central bank of central banks' },
  { id: 'imf', name: 'International Monetary Fund', shortName: 'IMF', city: 'Washington D.C.', country: 'US', lat: 38.8987, lon: -77.0425, type: 'supranational', description: 'Global financial stability institution' },
];

// Commodity trading hubs
export const COMMODITY_HUBS: CommodityHub[] = [
  { id: 'cme', name: 'CME Group (CBOT/NYMEX/COMEX)', city: 'Chicago', country: 'US', lat: 41.8822, lon: -87.6324, type: 'exchange', commodities: ['Crude Oil', 'Natural Gas', 'Gold', 'Corn', 'Soybeans', 'Wheat'], description: 'World\'s largest derivatives exchange' },
  { id: 'ice', name: 'ICE (Intercontinental Exchange)', city: 'Atlanta', country: 'US', lat: 33.7628, lon: -84.3874, type: 'exchange', commodities: ['Brent Crude', 'Natural Gas', 'Cotton', 'Sugar', 'Coffee'], description: 'Global commodity and financial exchange' },
  { id: 'lme', name: 'London Metal Exchange', city: 'London', country: 'GB', lat: 51.5128, lon: -0.0802, type: 'exchange', commodities: ['Copper', 'Aluminum', 'Zinc', 'Nickel', 'Tin', 'Lead'], description: 'World\'s center for metals trading' },
  { id: 'shfe', name: 'Shanghai Futures Exchange', city: 'Shanghai', country: 'CN', lat: 31.2358, lon: 121.4842, type: 'exchange', commodities: ['Copper', 'Steel Rebar', 'Gold', 'Crude Oil'], description: 'China\'s major commodity exchange' },
  { id: 'dce', name: 'Dalian Commodity Exchange', city: 'Dalian', country: 'CN', lat: 38.9140, lon: 121.6147, type: 'exchange', commodities: ['Iron Ore', 'Soybeans', 'Palm Oil', 'Corn'], description: 'Key agricultural & metals exchange' },
  { id: 'tocom', name: 'Tokyo Commodity Exchange', city: 'Tokyo', country: 'JP', lat: 35.6800, lon: 139.7750, type: 'exchange', commodities: ['Rubber', 'Gold', 'Platinum', 'Crude Oil'], description: 'Japan\'s commodity derivatives market' },
  { id: 'dgcx', name: 'Dubai Gold & Commodities Exchange', city: 'Dubai', country: 'AE', lat: 25.2214, lon: 55.2728, type: 'exchange', commodities: ['Gold', 'Currencies', 'Hydrocarbons'], description: 'Middle East commodity exchange' },
  { id: 'mcx', name: 'Multi Commodity Exchange', city: 'Mumbai', country: 'IN', lat: 19.0536, lon: 72.8582, type: 'exchange', commodities: ['Gold', 'Silver', 'Crude Oil', 'Natural Gas'], description: 'India\'s largest commodity exchange' },
  { id: 'rotterdam', name: 'Port of Rotterdam', city: 'Rotterdam', country: 'NL', lat: 51.9025, lon: 4.4717, type: 'port', commodities: ['Crude Oil', 'LNG', 'Coal', 'Iron Ore'], description: 'Europe\'s largest port, key energy hub' },
  { id: 'houston', name: 'Houston Energy Corridor', city: 'Houston', country: 'US', lat: 29.7765, lon: -95.4469, type: 'refinery', commodities: ['Crude Oil', 'Natural Gas', 'Petrochemicals'], description: 'World\'s energy capital' },
];
