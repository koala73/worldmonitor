// Hand-curated from OpenFlights airlines.dat (public domain), ~100 highest-volume carriers.
// To refresh the base map quarterly: node scripts/generate-airline-codes.mjs (script TBD, see issue)
// To correct individual entries immediately: add to OVERRIDE below (takes precedence over GENERATED).
const OVERRIDE: Record<string, { iata: string; name: string }> = {
  // Example: 'XYZ': { iata: 'X2', name: 'Corrected Name' },
};

const GENERATED = new Map<string, { iata: string; name: string }>([
  ['AAL', { iata: 'AA', name: 'American Airlines' }],
  ['AAY', { iata: 'G4', name: 'Allegiant Air' }],
  ['ACA', { iata: 'AC', name: 'Air Canada' }],
  ['ADR', { iata: 'JP', name: 'Adria Airways' }],
  ['AFL', { iata: 'SU', name: 'Aeroflot' }],
  ['AFR', { iata: 'AF', name: 'Air France' }],
  ['AIC', { iata: 'AI', name: 'Air India' }],
  ['AMX', { iata: 'AM', name: 'Aeromexico' }],
  ['ANZ', { iata: 'NZ', name: 'Air New Zealand' }],
  ['ASA', { iata: 'AS', name: 'Alaska Airlines' }],
  ['ASH', { iata: 'YV', name: 'Mesa Airlines' }],
  ['AUA', { iata: 'OS', name: 'Austrian Airlines' }],
  ['AVA', { iata: 'AV', name: 'Avianca' }],
  ['AZA', { iata: 'AZ', name: 'ITA Airways' }],
  ['AZU', { iata: 'AD', name: 'Azul Brazilian Airlines' }],
  ['BAW', { iata: 'BA', name: 'British Airways' }],
  ['BBS', { iata: 'BG', name: 'Biman Bangladesh Airlines' }],
  ['BEL', { iata: 'SN', name: 'Brussels Airlines' }],
  ['BSK', { iata: 'B2', name: 'Belavia' }],
  ['CCA', { iata: 'CA', name: 'Air China' }],
  ['CES', { iata: 'MU', name: 'China Eastern Airlines' }],
  ['CHH', { iata: 'HU', name: 'Hainan Airlines' }],
  ['CPA', { iata: 'CX', name: 'Cathay Pacific' }],
  ['CSN', { iata: 'CZ', name: 'China Southern Airlines' }],
  ['CSO', { iata: 'OK', name: 'Czech Airlines' }],
  ['CTN', { iata: 'OU', name: 'Croatia Airlines' }],
  ['DAL', { iata: 'DL', name: 'Delta Air Lines' }],
  ['DLH', { iata: 'LH', name: 'Lufthansa' }],
  ['EIN', { iata: 'EI', name: 'Aer Lingus' }],
  ['ELY', { iata: 'LY', name: 'El Al' }],
  ['ETD', { iata: 'EY', name: 'Etihad Airways' }],
  ['ETH', { iata: 'ET', name: 'Ethiopian Airlines' }],
  ['EWG', { iata: 'EW', name: 'Eurowings' }],
  ['EZS', { iata: 'DS', name: 'easyJet Switzerland' }],
  ['EZY', { iata: 'U2', name: 'easyJet' }],
  ['FDB', { iata: 'FZ', name: 'flydubai' }],
  ['FFT', { iata: 'F9', name: 'Frontier Airlines' }],
  ['FIN', { iata: 'AY', name: 'Finnair' }],
  ['GFA', { iata: 'GF', name: 'Gulf Air' }],
  ['GLO', { iata: 'G3', name: 'Gol Transportes Aéreos' }],
  ['HAL', { iata: 'HA', name: 'Hawaiian Airlines' }],
  ['HLX', { iata: '5K', name: 'Hi Fly' }],
  ['IBE', { iata: 'IB', name: 'Iberia' }],
  ['IBS', { iata: 'I2', name: 'Iberia Express' }],
  ['IGO', { iata: '6E', name: 'IndiGo' }],
  ['IRM', { iata: 'IR', name: 'Iran Air' }],
  ['JAI', { iata: '9W', name: 'Jet Airways' }],
  ['JAT', { iata: 'JU', name: 'Air Serbia' }],
  ['JBU', { iata: 'B6', name: 'JetBlue' }],
  ['JST', { iata: 'JQ', name: 'Jetstar' }],
  ['KAL', { iata: 'KE', name: 'Korean Air' }],
  ['KLM', { iata: 'KL', name: 'KLM Royal Dutch Airlines' }],
  ['LOT', { iata: 'LO', name: 'LOT Polish Airlines' }],
  ['MAS', { iata: 'MH', name: 'Malaysia Airlines' }],
  ['MSR', { iata: 'MS', name: 'EgyptAir' }],
  ['NAX', { iata: 'DY', name: 'Norwegian Air Shuttle' }],
  ['NKS', { iata: 'NK', name: 'Spirit Airlines' }],
  ['OAL', { iata: 'OA', name: 'Olympic Air' }],
  ['PGA', { iata: 'NI', name: 'Portugália Airlines' }],
  ['PGT', { iata: 'PC', name: 'Pegasus Airlines' }],
  ['PKC', { iata: 'PK', name: 'Pakistan International Airlines' }],
  ['QFA', { iata: 'QF', name: 'Qantas' }],
  ['QTR', { iata: 'QR', name: 'Qatar Airways' }],
  ['RAM', { iata: 'AT', name: 'Royal Air Maroc' }],
  ['ROU', { iata: 'RO', name: 'TAROM' }],
  ['RYR', { iata: 'FR', name: 'Ryanair' }],
  ['SAS', { iata: 'SK', name: 'Scandinavian Airlines' }],
  ['SHY', { iata: 'ZY', name: 'Sky Airlines' }],
  ['SIA', { iata: 'SQ', name: 'Singapore Airlines' }],
  ['SVN', { iata: 'SV', name: 'Saudia' }],
  ['SWA', { iata: 'WN', name: 'Southwest Airlines' }],
  ['SWG', { iata: 'WG', name: 'Sunwing Airlines' }],
  ['WJA', { iata: 'WS', name: 'WestJet' }],
  ['SWR', { iata: 'LX', name: 'Swiss International Air Lines' }],
  ['SXB', { iata: 'S5', name: 'SpiceJet' }],
  ['TAM', { iata: 'LA', name: 'LATAM Airlines' }],
  ['TAP', { iata: 'TP', name: 'TAP Air Portugal' }],
  ['TGW', { iata: 'TR', name: 'Scoot' }],
  ['OMA', { iata: 'WY', name: 'Oman Air' }],
  ['THA', { iata: 'TG', name: 'Thai Airways' }],
  ['THY', { iata: 'TK', name: 'Turkish Airlines' }],
  ['TJK', { iata: '7J', name: 'Tajik Air' }],
  ['TOM', { iata: 'BY', name: 'TUI Airways' }],
  ['TRA', { iata: 'HV', name: 'Transavia' }],
  ['TSC', { iata: 'TS', name: 'Air Transat' }],
  ['TUN', { iata: 'TU', name: 'Tunisair' }],
  ['UAE', { iata: 'EK', name: 'Emirates' }],
  ['UAL', { iata: 'UA', name: 'United Airlines' }],
  ['UZB', { iata: 'HY', name: 'Uzbekistan Airways' }],
  ['VIR', { iata: 'VS', name: 'Virgin Atlantic' }],
  ['VLG', { iata: 'VY', name: 'Vueling' }],
  ['VOI', { iata: 'Y4', name: 'Volaris' }],
  ['VOZ', { iata: 'VA', name: 'Virgin Australia' }],
  ['WIF', { iata: 'WF', name: 'Widerøe' }],
  ['WRF', { iata: 'RB', name: 'Syrian Arab Airlines' }],
  ['WZZ', { iata: 'W6', name: 'Wizz Air' }],
]);

const AIRLINES = new Map<string, { iata: string; name: string }>(GENERATED);
for (const [key, val] of Object.entries(OVERRIDE)) {
  AIRLINES.set(key, val);
}

/**
 * Parse an ICAO-style callsign into prefix and numeric suffix.
 * Normalizes whitespace and case. Returns null for non-standard formats.
 */
export function parseCallsign(cs: string): { prefix: string; number: string } | null {
  const trimmed = cs.trim().toUpperCase();
  const m = trimmed.match(/^([A-Z]{2,4})(\d.*)$/);
  if (!m) return null;
  return { prefix: m[1] ?? '', number: m[2] ?? '' };
}

/**
 * Look up IATA code and airline name by ICAO 3-letter prefix.
 * Returns undefined for unknown or military callsigns.
 */
export function icaoToIata(icaoPrefix: string): { iata: string; name: string } | undefined {
  return AIRLINES.get(icaoPrefix.toUpperCase());
}

/**
 * Convert an ICAO callsign (e.g. "UAE528") to its IATA equivalent (e.g. "EK528").
 * Returns null if the prefix is unknown (military, charter, etc.).
 */
export function toIataCallsign(cs: string): { callsign: string; name: string } | null {
  const p = parseCallsign(cs);
  if (!p) return null;
  const a = icaoToIata(p.prefix);
  if (!a) return null;
  return { callsign: a.iata + p.number, name: a.name };
}
