#!/usr/bin/env node

import { loadEnvFile, CHROME_UA, runSeed } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const BASE = 'https://www.submarinecablemap.com/api/v3';
const CANONICAL_KEY = 'infrastructure:submarine-cables:v1';
const CACHE_TTL = 7 * 24 * 3600; // 7 days — cable infra changes slowly

// Strategic cable list — TeleGeography slugs organized by region.
// Find slugs at: https://www.submarinecablemap.com/api/v3/cable/all.json
const CABLE_REGIONS = [
  {
    label: 'TRANS-ATLANTIC',
    ids: [
      'marea', 'grace-hopper', 'havfrueaec-2', 'dunant', 'amitie',
      'atlantic-crossing-1-ac-1', 'apollo', 'nuvem', 'flag-atlantic-1-fa-1',
      'tata-tgn-atlantic-south', 'tata-tgn-western-europe',
    ],
  },
  {
    label: 'TRANS-PACIFIC',
    ids: [
      'faster', 'southern-cross-cable-network-sccn', 'curie',
      'trans-pacific-express-tpe-cable-system', 'new-cross-pacific-ncp-cable-system',
      'pacific-light-cable-network-plcn', 'jupiter', 'unityeac-pacific',
      'pacific-crossing-1-pc-1', 'topaz', 'echo', 'southern-cross-next', 'hawaiki',
    ],
  },
  {
    label: 'ASIA-EUROPE',
    ids: [
      'seamewe-6', 'seamewe-4', 'seamewe-5', 'asia-africa-europe-1-aae-1',
      'imewe', 'europe-india-gateway-eig', 'peace-cable',
      'seacomtata-tgn-eurasia', 'te-northtgn-eurasiaseacomalexandrosmedex',
    ],
  },
  {
    label: 'AFRICA',
    ids: [
      '2africa', 'west-africa-cable-system-wacs', 'eastern-africa-submarine-system-eassy',
      'equiano', 'africa-coast-to-europe-ace', 'mainone', 'safe', 'sat-3wasc',
      'the-east-african-marine-system-teams', 'lower-indian-ocean-network-lion',
      'djibouti-africa-regional-express-1-dare-1',
    ],
  },
  {
    label: 'AMERICAS',
    ids: [
      'south-america-1-sam-1', 'ellalink', 'brusa', 'monet', 'seabras-1',
      'firmina', 'south-atlantic-cable-system-sacs', 'south-atlantic-inter-link-sail',
      'arcos', 'america-movil-submarine-cable-system-1-amx-1', 'globenet', 'malbec',
    ],
  },
  {
    label: 'ASIA-PACIFIC',
    ids: [
      'asia-pacific-gateway-apg', 'indigo-west', 'southeast-asia-japan-cable-sjc',
      'asia-america-gateway-aag-cable-system', 'southeast-asia-japan-cable-2-sjc2',
      'asia-direct-cable-adc', 'bifrost', 'apricot', 'apcn-2',
      'australia-japan-cable-ajc', 'australia-singapore-cable-asc',
      'japan-guam-australia-south-jga-s', 'sea-us', 'india-asia-xpress-iax', 'raman',
    ],
  },
  {
    label: 'ARCTIC / EUROPE',
    ids: [
      'farice-1', 'c-lion1', 'no-uk', 'havhingstennorth-sea-connect-nsc',
      'danice', 'greenland-connect', 'shefa-2', 'baltica',
    ],
  },
  {
    label: 'MIDDLE EAST',
    ids: [
      'falcon', 'tata-tgn-gulf', 'fiber-optic-gulf-fog', 'omranepeg',
      'gulf-bridge-international-cable-systemmiddle-east-north-africa-cable-system-gbicsmena',
    ],
  },
  {
    label: 'HYPERSCALER / STRATEGIC',
    ids: ['project-waterworth', 'blue'],
  },
];

const COUNTRY_CODES = {
  'Afghanistan': 'AF', 'Albania': 'AL', 'Algeria': 'DZ', 'Angola': 'AO', 'Argentina': 'AR',
  'Australia': 'AU', 'Austria': 'AT', 'Bahrain': 'BH', 'Bangladesh': 'BD', 'Belgium': 'BE',
  'Belize': 'BZ', 'Benin': 'BJ', 'Bermuda': 'BM', 'Brazil': 'BR', 'Brunei': 'BN',
  'Bulgaria': 'BG', 'Cameroon': 'CM', 'Canada': 'CA', 'Cayman Islands': 'KY',
  'Chile': 'CL', 'China': 'CN', 'Colombia': 'CO', 'Comoros': 'KM',
  'Costa Rica': 'CR', 'Croatia': 'HR', 'Cuba': 'CU', "Côte d'Ivoire": 'CI', 'Cyprus': 'CY',
  'Czech Republic': 'CZ', 'Democratic Republic of the Congo': 'CD', 'Denmark': 'DK',
  'Djibouti': 'DJ', 'Dominican Republic': 'DO', 'Ecuador': 'EC', 'Egypt': 'EG',
  'El Salvador': 'SV', 'Equatorial Guinea': 'GQ', 'Eritrea': 'ER', 'Estonia': 'EE',
  'Ethiopia': 'ET', 'Faroe Islands': 'FO', 'Fiji': 'FJ', 'Finland': 'FI', 'France': 'FR',
  'French Polynesia': 'PF', 'Gabon': 'GA', 'Gambia': 'GM', 'Georgia': 'GE', 'Germany': 'DE',
  'Ghana': 'GH', 'Greece': 'GR', 'Greenland': 'GL', 'Guam': 'GU', 'Guatemala': 'GT',
  'Guinea': 'GN', 'Guinea-Bissau': 'GW', 'Guyana': 'GY', 'Haiti': 'HT', 'Honduras': 'HN',
  'Hong Kong': 'HK', 'Hungary': 'HU', 'Iceland': 'IS', 'India': 'IN', 'Indonesia': 'ID',
  'Iran': 'IR', 'Iraq': 'IQ', 'Ireland': 'IE', 'Israel': 'IL', 'Italy': 'IT',
  'Jamaica': 'JM', 'Japan': 'JP', 'Jordan': 'JO', 'Kenya': 'KE', 'Kuwait': 'KW',
  'Latvia': 'LV', 'Lebanon': 'LB', 'Liberia': 'LR', 'Libya': 'LY', 'Lithuania': 'LT',
  'Madagascar': 'MG', 'Malaysia': 'MY', 'Maldives': 'MV', 'Malta': 'MT', 'Mauritania': 'MR',
  'Mauritius': 'MU', 'Mexico': 'MX', 'Monaco': 'MC', 'Morocco': 'MA', 'Mozambique': 'MZ',
  'Myanmar': 'MM', 'Namibia': 'NA', 'Netherlands': 'NL', 'New Zealand': 'NZ',
  'Nicaragua': 'NI', 'Niger': 'NE', 'Nigeria': 'NG', 'Norway': 'NO', 'Oman': 'OM',
  'Pakistan': 'PK', 'Panama': 'PA', 'Papua New Guinea': 'PG', 'Peru': 'PE',
  'Philippines': 'PH', 'Poland': 'PL', 'Portugal': 'PT', 'Puerto Rico': 'PR',
  'Qatar': 'QA', 'Republic of the Congo': 'CG', 'Romania': 'RO', 'Russia': 'RU',
  'Réunion': 'RE', 'São Tomé and Príncipe': 'ST', 'Saudi Arabia': 'SA', 'Senegal': 'SN',
  'Shetland Islands': 'GB', 'Sierra Leone': 'SL', 'Singapore': 'SG', 'Somalia': 'SO',
  'South Africa': 'ZA', 'South Korea': 'KR', 'Spain': 'ES', 'Sri Lanka': 'LK',
  'Sudan': 'SD', 'Suriname': 'SR', 'Sweden': 'SE', 'Taiwan': 'TW', 'Tanzania': 'TZ',
  'Thailand': 'TH', 'Togo': 'TG', 'Trinidad and Tobago': 'TT', 'Tunisia': 'TN',
  'Turkey': 'TR', 'Turkmenistan': 'TM', 'Uganda': 'UG', 'Ukraine': 'UA',
  'United Arab Emirates': 'AE', 'United Kingdom': 'GB', 'United States': 'US',
  'Uruguay': 'UY', 'Venezuela': 'VE', 'Vietnam': 'VN', 'Yemen': 'YE',
  'American Samoa': 'AS', 'Bahamas': 'BS', 'Cambodia': 'KH', 'Cape Verde': 'CV',
  'Christmas Island': 'CX', 'Congo, Dem. Rep.': 'CD', 'Congo, Rep.': 'CG',
  'Curaçao': 'CW', 'French Guiana': 'GF', 'Gibraltar': 'GI', 'Kiribati': 'KI',
  'Micronesia': 'FM', 'Palau': 'PW', 'Sao Tome and Principe': 'ST',
  'Saint Helena, Ascension and Tristan da Cunha': 'SH', 'Seychelles': 'SC',
  'Tokelau': 'TK', 'Tonga': 'TO', 'Turks and Caicos Islands': 'TC',
};

function r1(n) { return Math.round(n * 10) / 10; }
function r2(n) { return Math.round(n * 100) / 100; }

function simplifyRoute(coords) {
  if (!coords || coords.length === 0) return [];
  if (coords.length <= 6) return coords.map(c => [r1(c[0]), r1(c[1])]);
  const result = [];
  const step = Math.max(1, Math.floor(coords.length / 5));
  for (let i = 0; i < coords.length; i += step) {
    result.push([r1(coords[i][0]), r1(coords[i][1])]);
  }
  const last = coords[coords.length - 1];
  const lastR = [r1(last[0]), r1(last[1])];
  const prev = result[result.length - 1];
  if (prev[0] !== lastR[0] || prev[1] !== lastR[1]) result.push(lastR);
  return result;
}

function slugToId(slug) { return slug.replace(/-/g, '_'); }

const _warnedCountries = new Set();
function getCountryCode(countryName) {
  if (!countryName) return 'XX';
  const code = COUNTRY_CODES[countryName];
  if (code) return code;
  if (!_warnedCountries.has(countryName)) {
    _warnedCountries.add(countryName);
    console.warn(`  Unknown country "${countryName}" — add to COUNTRY_CODES`);
  }
  return countryName.slice(0, 2).toUpperCase();
}

async function fetchSubmarineCables() {
  const allIds = CABLE_REGIONS.flatMap(r => r.ids);
  console.log(`  Fetching ${allIds.length} strategic cables from TeleGeography...`);

  // Bulk endpoints
  const cableGeoResp = await fetch(`${BASE}/cable/cable-geo.json`, {
    headers: { 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(30_000),
  });
  if (!cableGeoResp.ok) throw new Error(`cable-geo.json: HTTP ${cableGeoResp.status}`);
  const cableGeo = await cableGeoResp.json();

  const allIdSet = new Set(allIds);
  const routeMap = new Map();
  for (const feat of cableGeo.features) {
    const id = feat.properties?.id;
    if (id) {
      const stripped = id.replace(/-\d+$/, '');
      const baseId = allIdSet.has(stripped) ? stripped : id;
      if (!routeMap.has(baseId)) routeMap.set(baseId, []);
      if (feat.geometry?.type === 'MultiLineString') {
        for (const segment of feat.geometry.coordinates) {
          routeMap.get(baseId).push(...segment);
        }
      }
    }
  }
  console.log(`  ${routeMap.size} cable routes`);

  const lpGeoResp = await fetch(`${BASE}/landing-point/landing-point-geo.json`, {
    headers: { 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(30_000),
  });
  if (!lpGeoResp.ok) throw new Error(`landing-point-geo.json: HTTP ${lpGeoResp.status}`);
  const lpGeo = await lpGeoResp.json();

  const lpCoords = new Map();
  for (const feat of lpGeo.features) {
    const id = feat.properties?.id;
    if (id && feat.geometry?.coordinates) {
      lpCoords.set(id, {
        lon: feat.geometry.coordinates[0],
        lat: feat.geometry.coordinates[1],
        name: feat.properties.name,
      });
    }
  }
  console.log(`  ${lpCoords.size} landing points`);

  // Fetch individual cable details in batches of 5
  const cables = [];
  const failed = [];

  for (let i = 0; i < allIds.length; i += 5) {
    const batch = allIds.slice(i, i + 5);
    const results = await Promise.all(batch.map(async (id) => {
      const resp = await fetch(`${BASE}/cable/${id}.json`, {
        headers: { 'User-Agent': CHROME_UA },
        signal: AbortSignal.timeout(15_000),
      });
      if (!resp.ok) { failed.push(id); return null; }
      return { id, data: await resp.json() };
    }));

    for (const result of results) {
      if (!result) continue;
      const { id, data } = result;

      let points = simplifyRoute(routeMap.get(id) || []);
      const landingPoints = [];

      if (data.landing_points) {
        for (const lp of data.landing_points) {
          const coords = lpCoords.get(lp.id);
          if (coords) {
            landingPoints.push({
              country: getCountryCode(lp.country || coords.name?.split(',').pop()?.trim() || ''),
              countryName: lp.country || '',
              city: (coords.name || lp.name || 'Unknown').split(',')[0].trim(),
              lat: r2(coords.lat),
              lon: r2(coords.lon),
            });
          }
        }
      }

      if (points.length === 0 && landingPoints.length >= 2) {
        points = landingPoints.map(lp => [r1(lp.lon), r1(lp.lat)]);
      }

      const countries = [...new Set(landingPoints.map(lp => lp.country))];
      const share = countries.length > 0 ? Math.min(Math.round(100 / countries.length) / 100, 0.30) : 0;

      // Find which region this cable belongs to
      const region = CABLE_REGIONS.find(r => r.ids.includes(id))?.label || '';

      cables.push({
        id: slugToId(id),
        name: data.name,
        points,
        major: true,
        rfsYear: data.rfs_year ?? null,
        owners: Array.isArray(data.owners) ? data.owners : (typeof data.owners === 'string' ? data.owners.split(',').map(s => s.trim()).filter(Boolean) : []),
        landingPoints,
        countriesServed: countries.map(cc => ({
          country: cc,
          capacityShare: share,
          isRedundant: true,
        })),
        region,
      });
    }

    if (i + 5 < allIds.length) await new Promise(r => setTimeout(r, 150));
  }

  console.log(`  Fetched ${cables.length}/${allIds.length} cables`);
  if (failed.length) console.warn('  Failed:', failed.join(', '));

  // Collision check
  const seenIds = new Map();
  for (const cable of cables) {
    if (seenIds.has(cable.id)) {
      throw new Error(`ID collision: '${cable.id}' from '${seenIds.get(cable.id)}' and current`);
    }
    seenIds.set(cable.id, cable.name);
  }

  return { cables, fetchedAt: Date.now(), source: 'TeleGeography Submarine Cable Map' };
}

function validate(data) {
  const allCount = CABLE_REGIONS.reduce((s, r) => s + r.ids.length, 0);
  return data?.cables?.length >= Math.floor(allCount * 0.9);
}

export function declareRecords(data) {
  return data?.cables?.length ?? 0;
}

runSeed('infrastructure', 'submarine-cables', CANONICAL_KEY, fetchSubmarineCables, {
  validateFn: validate,
  ttlSeconds: CACHE_TTL,
  sourceVersion: 'telegeography-v3',
  declareRecords,
  schemaVersion: 1,
  maxStaleMin: 25200,
}).catch((err) => {
  const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : ''; console.error('FATAL:', (err.message || err) + _cause);
  process.exit(1);
});
