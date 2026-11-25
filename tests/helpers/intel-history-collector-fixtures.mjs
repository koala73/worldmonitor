// One upstream item per intel-history collector added in #11245, shaped like
// the live canonical payload each writer hands to afterPublish (sampled from
// production Redis on 2026-11-24, values shortened). Shared by the builder
// tests and the wiring contract tests so both exercise the same rows.

export const UCDP_EVENT = {
  id: '647991',
  dateStart: Date.parse('2026-10-31T00:00:00Z'),
  dateEnd: Date.parse('2026-10-31T00:00:00Z'),
  location: { latitude: 13.1, longitude: 39.6 },
  country: 'Ethiopia',
  hasPreciseLocation: true,
  locationName: 'Wichale town',
  sideA: 'Government of Ethiopia',
  sideB: 'EPFAS',
  deathsBest: 200,
  deathsLow: 200,
  deathsHigh: 210,
  violenceType: 'UCDP_VIOLENCE_TYPE_STATE_BASED',
  sourceOriginal: 'MVON',
};

export const UNREST_GDELT_EVENT = {
  id: 'gdelt-bulk-38.90--77.04-1795540500000',
  title: 'Washington, Washington, United States (123 reports)',
  summary: 'Unverified media signal. This location is mentioned in unrest-related articles; a local event is not verified.',
  eventType: 'UNREST_EVENT_TYPE_UNSPECIFIED',
  country: 'United States',
  location: { latitude: 38.9, longitude: -77.04 },
  occurredAt: Date.parse('2026-11-24T12:35:00Z'),
  sources: ['GDELT'],
  sourceType: 'UNREST_SOURCE_TYPE_GDELT',
  sourceUrls: ['https://www.example.com/unrelated-keyword-match'],
};

export const UNREST_ACLED_EVENT = {
  id: 'acled-CHL1234',
  title: 'Students march against tuition increases in Santiago',
  summary: 'Around 2,000 students marched to the education ministry.',
  eventType: 'UNREST_EVENT_TYPE_PROTEST',
  country: 'Chile',
  location: { latitude: -33.45, longitude: -70.66 },
  occurredAt: Date.parse('2026-11-20T00:00:00Z'),
  sourceType: 'UNREST_SOURCE_TYPE_ACLED',
  sourceUrls: ['https://www.example.cl/marcha'],
};

export const CYBER_C2_THREAT = {
  id: 'c2intel:47.115.221.177',
  type: 'CYBER_THREAT_TYPE_C2_SERVER',
  source: 'CYBER_THREAT_SOURCE_C2INTEL',
  indicator: '47.115.221.177',
  indicatorType: 'CYBER_THREAT_INDICATOR_TYPE_IP',
  country: 'CN',
  severity: 'CRITICALITY_LEVEL_HIGH',
  malwareFamily: 'Cobaltstrike',
  tags: ['c2', 'cobaltstrike'],
  firstSeenAt: Date.parse('2026-11-24T08:40:53Z'),
  lastSeenAt: 0,
};

export const CYBER_MALWARE_HOST = {
  id: 'abuseipdb:35.206.145.105',
  type: 'CYBER_THREAT_TYPE_MALWARE_HOST',
  source: 'CYBER_THREAT_SOURCE_ABUSEIPDB',
  indicator: '35.206.145.105',
  indicatorType: 'CYBER_THREAT_INDICATOR_TYPE_IP',
  country: 'BE',
  severity: 'CRITICALITY_LEVEL_CRITICAL',
  malwareFamily: '',
  tags: ['score:100'],
  firstSeenAt: Date.parse('2026-11-24T05:23:28Z'),
  lastSeenAt: 0,
};

export const PORTWATCH_DISRUPTION = {
  eventId: 10000004,
  eventType: 'OT',
  eventName: 'HORMUZ-26',
  alertLevel: 'RED',
  country: '',
  fromDate: '2026-03-01',
  toDate: null,
  active: true,
  severityText: '',
  lat: 26.29685,
  lon: 56.85985,
  affectedPorts: ['chokepoint6'],
  affectedPortCount: 1,
};

export const EARTHQUAKE = {
  id: 'us6000ud6z',
  place: '93 km WSW of Puerto Madero, Mexico',
  magnitude: 5.2,
  depthKm: 35,
  location: { latitude: 14.4, longitude: -93.1 },
  occurredAt: Date.parse('2026-11-24T10:31:44Z'),
  sourceUrl: 'https://earthquake.usgs.gov/earthquakes/eventpage/us6000ud6z',
  source: 'usgs',
};

export const NATURAL_EVENT = {
  id: 'gdacs-DR-1027450',
  title: '🟠 Drought in Kenya, Somalia',
  description: 'Drought in Kenya, Somalia - Medium impact for agricultural drought in 1435673 km2',
  category: 'drought',
  lat: 6.5,
  lon: 39.5,
  date: Date.parse('2026-05-21T00:00:00Z'),
  sourceUrl: 'https://www.gdacs.org/report.aspx?eventid=1027450&episodeid=14&eventtype=DR',
  sourceName: 'GDACS',
};

export const AVIATION_ALERT = {
  id: 'avstack-MEX',
  iata: 'MEX',
  icao: 'MMMX',
  name: 'Mexico City International',
  city: 'Mexico City',
  country: 'Mexico',
  delayType: 'FLIGHT_DELAY_TYPE_GENERAL',
  severity: 'FLIGHT_DELAY_SEVERITY_MAJOR',
  avgDelayMinutes: 38,
  delayedFlightsPct: 60,
  cancelledFlights: 0,
  totalFlights: 78,
  reason: 'Avg 38min delay, 60% delayed',
  source: 'FLIGHT_DELAY_SOURCE_AVIATIONSTACK',
  updatedAt: Date.parse('2026-11-24T13:04:19Z'),
};
