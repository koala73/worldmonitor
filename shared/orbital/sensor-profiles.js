// Hand-curated from each operator's own documentation; every row cites it.
// Bump SENSOR_INVENTORY_VERSION whenever a row is added, removed or changed.
export const SENSOR_INVENTORY_VERSION = '2026-11-13.1';

export const SENSOR_CATEGORIES = Object.freeze([
  'open-optical',
  'open-radar',
  'weather-polar',
  'commercial-optical',
  'commercial-radar',
  'military',
  'crewed-station',
  'geostationary',
]);

export const SENSOR_PROFILES = Object.freeze([
  {
    id: 'sentinel-2',
    family: 'Sentinel-2',
    operator: 'ESA / Copernicus',
    category: 'open-optical',
    noradIds: [40697, 42063, 60989],
    namePatterns: ['^SENTINEL-2[A-Z]$'],
    footprint: { kind: 'nadir-swath', swathKm: 290 },
    coverage: 'land-coast',
    archiveWaitHours: 24,
    sources: ['https://sentiwiki.copernicus.eu/web/s2-mission'],
  },
  {
    id: 'sentinel-1',
    family: 'Sentinel-1',
    operator: 'ESA / Copernicus',
    category: 'open-radar',
    noradIds: [39634, 62261, 66315],
    namePatterns: ['^SENTINEL-1[AC-Z]$'],
    footprint: { kind: 'side-looking', side: 'right', incidenceDeg: [29.1, 46.0] },
    coverage: 'land-coast',
    archiveWaitHours: 24,
    sources: [
      'https://sentiwiki.copernicus.eu/web/s1-mission',
      'https://sentiwiki.copernicus.eu/web/s1-products',
    ],
  },
  {
    id: 'landsat',
    family: 'Landsat',
    operator: 'USGS / NASA',
    category: 'open-optical',
    noradIds: [39084, 49260],
    namePatterns: ['^LANDSAT (8|9)$'],
    footprint: { kind: 'nadir-swath', swathKm: 185 },
    coverage: 'land-coast',
    archiveWaitHours: 72,
    sources: [
      'https://www.usgs.gov/landsat-missions/landsat-8',
      'https://www.usgs.gov/landsat-missions/landsat-9',
    ],
  },
  {
    id: 'modis',
    family: 'Terra and Aqua MODIS',
    operator: 'NASA',
    category: 'weather-polar',
    noradIds: [25994, 27424],
    namePatterns: ['^TERRA$', '^AQUA$'],
    footprint: { kind: 'nadir-swath', swathKm: 2330 },
    coverage: 'global',
    dailyMosaic: true,
    sources: ['https://terra.nasa.gov/about/terra-instruments/modis'],
  },
  {
    id: 'capella',
    family: 'Capella',
    operator: 'Capella Space',
    category: 'commercial-radar',
    noradIds: [57693, 59444, 60419, 60544, 64583, 65318, 67384, 67385, 68485, 101118, 101131],
    namePatterns: ['^CAPELLA-\\d+'],
    footprint: { kind: 'steerable', lookAngleDeg: [15, 50] },
    coverage: 'global',
    sources: ['https://www.capellaspace.com/earth-observation/'],
  },
  {
    id: 'yaogan',
    family: 'Yaogan',
    operator: 'People\'s Republic of China',
    category: 'military',
    noradIds: [],
    namePatterns: ['^YAOGAN-\\d+( \\d+)?$'],
    footprint: { kind: 'steerable', lookAngleDeg: [0, 45], assumed: true },
    coverage: 'global',
    sources: ['https://www.cnsa.gov.cn/english/'],
  },
  {
    id: 'iss',
    family: 'International Space Station',
    operator: 'NASA and partners',
    category: 'crewed-station',
    noradIds: [25544],
    namePatterns: ['^ISS \\(ZARYA\\)$'],
    footprint: { kind: 'horizon', minElevationDeg: 10 },
    coverage: 'global',
    sources: ['https://www.nasa.gov/international-space-station/space-station-facts-and-figures/'],
  },
  {
    id: 'goes',
    family: 'GOES-R',
    operator: 'NOAA',
    category: 'geostationary',
    noradIds: [60133, 51850],
    namePatterns: ['^GOES (18|19)$'],
    footprint: { kind: 'full-disk' },
    coverage: 'global',
    sources: ['https://www.goes-r.gov/mission/mission.html'],
  },
  {
    id: 'himawari',
    family: 'Himawari',
    operator: 'Japan Meteorological Agency',
    category: 'geostationary',
    noradIds: [41836],
    namePatterns: ['^HIMAWARI-9$'],
    footprint: { kind: 'full-disk' },
    coverage: 'global',
    sources: ['https://www.data.jma.go.jp/mscweb/en/himawari89/space_segment/spsg_ahi.html'],
  },
  {
    id: 'meteosat-third-generation',
    family: 'Meteosat Third Generation',
    operator: 'EUMETSAT',
    category: 'geostationary',
    noradIds: [54743],
    namePatterns: ['^METEOSAT-12'],
    footprint: { kind: 'full-disk' },
    coverage: 'global',
    sources: ['https://www.eumetsat.int/meteosat-third-generation'],
  },
]);

const BY_NORAD_ID = new Map(SENSOR_PROFILES.flatMap((profile) => profile.noradIds.map((id) => [id, profile])));
const BY_NAME = SENSOR_PROFILES.flatMap((profile) => profile.namePatterns.map((pattern) => [new RegExp(pattern), profile]));

export function matchSensorProfile(noradId, name) {
  const byId = BY_NORAD_ID.get(Number(noradId));
  if (byId) return byId;
  const normalized = String(name ?? '').trim().toUpperCase();
  return BY_NAME.find(([pattern]) => pattern.test(normalized))?.[1] ?? null;
}
