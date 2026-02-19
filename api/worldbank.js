// World Bank API proxy (Web API handler for Edge + sidecar compatibility)
import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';

export const config = {
  runtime: 'edge',
};

const TECH_INDICATORS = {
  'IT.NET.USER.ZS': 'Internet Users (% of population)',
  'IT.CEL.SETS.P2': 'Mobile Subscriptions (per 100 people)',
  'IT.NET.BBND.P2': 'Fixed Broadband Subscriptions (per 100 people)',
  'IT.NET.SECR.P6': 'Secure Internet Servers (per million people)',
  'GB.XPD.RSDV.GD.ZS': 'R&D Expenditure (% of GDP)',
  'IP.PAT.RESD': 'Patent Applications (residents)',
  'IP.PAT.NRES': 'Patent Applications (non-residents)',
  'IP.TMK.TOTL': 'Trademark Applications',
  'TX.VAL.TECH.MF.ZS': 'High-Tech Exports (% of manufactured exports)',
  'BX.GSR.CCIS.ZS': 'ICT Service Exports (% of service exports)',
  'TM.VAL.ICTG.ZS.UN': 'ICT Goods Imports (% of total goods imports)',
  'SE.TER.ENRR': 'Tertiary Education Enrollment (%)',
  'SE.XPD.TOTL.GD.ZS': 'Education Expenditure (% of GDP)',
  'NY.GDP.MKTP.KD.ZG': 'GDP Growth (annual %)',
  'NY.GDP.PCAP.CD': 'GDP per Capita (current US$)',
  'NE.EXP.GNFS.ZS': 'Exports of Goods & Services (% of GDP)',
};

const TECH_COUNTRIES = [
  'USA', 'CHN', 'JPN', 'DEU', 'KOR', 'GBR', 'IND', 'ISR', 'SGP', 'TWN',
  'FRA', 'CAN', 'SWE', 'NLD', 'CHE', 'FIN', 'IRL', 'AUS', 'BRA', 'IDN',
  'ARE', 'SAU', 'QAT', 'BHR', 'EGY', 'TUR',
  'MYS', 'THA', 'VNM', 'PHL',
  'ESP', 'ITA', 'POL', 'CZE', 'DNK', 'NOR', 'AUT', 'BEL', 'PRT', 'EST',
  'MEX', 'ARG', 'CHL', 'COL',
  'ZAF', 'NGA', 'KEN',
];

export default async function handler(request) {
  const CORS = getCorsHeaders(request);
  if (isDisallowedOrigin(request)) {
    return new Response(JSON.stringify({ error: 'Origin not allowed' }), { status: 403, headers: CORS });
  }

  function json(data, status = 200, extra = {}) {
    return new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json', ...CORS, ...extra },
    });
  }

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  const url = new URL(request.url);
  const indicator = url.searchParams.get('indicator');
  const country = url.searchParams.get('country');
  const countries = url.searchParams.get('countries');
  const years = url.searchParams.get('years') || '5';
  const action = url.searchParams.get('action');

  if (action === 'indicators') {
    return json({ indicators: TECH_INDICATORS, defaultCountries: TECH_COUNTRIES }, 200, { 'Cache-Control': 'public, max-age=86400, s-maxage=86400, stale-while-revalidate=3600' });
  }

  if (!indicator) {
    return json({ error: 'Missing indicator parameter', availableIndicators: Object.keys(TECH_INDICATORS) }, 400);
  }

  try {
    let countryList = country || countries || TECH_COUNTRIES.join(';');
    if (countries) {
      countryList = countries.split(',').join(';');
    }

    const currentYear = new Date().getFullYear();
    const startYear = currentYear - parseInt(years);

    const wbUrl = `https://api.worldbank.org/v2/country/${countryList}/indicator/${indicator}?format=json&date=${startYear}:${currentYear}&per_page=1000`;

    const response = await fetch(wbUrl, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (compatible; IntelHQ/1.0; +https://intelhq.io)',
      },
    });

    if (!response.ok) {
      throw new Error(`World Bank API error: ${response.status}`);
    }

    const data = await response.json();

    if (!data || !Array.isArray(data) || data.length < 2 || !data[1]) {
      return json({
        indicator,
        indicatorName: TECH_INDICATORS[indicator] || indicator,
        metadata: { page: 1, pages: 1, total: 0 },
        byCountry: {},
        latestByCountry: {},
        timeSeries: [],
      }, 200, { 'Cache-Control': 'public, max-age=3600, s-maxage=3600, stale-while-revalidate=600' });
    }

    const [metadata, records] = data;

    const transformed = {
      indicator,
      indicatorName: TECH_INDICATORS[indicator] || (records[0]?.indicator?.value || indicator),
      metadata: { page: metadata.page, pages: metadata.pages, total: metadata.total },
      byCountry: {},
      latestByCountry: {},
      timeSeries: [],
    };

    for (const record of records || []) {
      const countryCode = record.countryiso3code || record.country?.id;
      const countryName = record.country?.value;
      const year = record.date;
      const value = record.value;

      if (!countryCode || value === null) continue;

      if (!transformed.byCountry[countryCode]) {
        transformed.byCountry[countryCode] = { code: countryCode, name: countryName, values: [] };
      }
      transformed.byCountry[countryCode].values.push({ year, value });

      if (!transformed.latestByCountry[countryCode] || year > transformed.latestByCountry[countryCode].year) {
        transformed.latestByCountry[countryCode] = { code: countryCode, name: countryName, year, value };
      }

      transformed.timeSeries.push({ countryCode, countryName, year, value });
    }

    for (const c of Object.values(transformed.byCountry)) {
      c.values.sort((a, b) => a.year - b.year);
    }

    transformed.timeSeries.sort((a, b) => b.year - a.year || a.countryCode.localeCompare(b.countryCode));

    return json(transformed, 200, { 'Cache-Control': 'public, max-age=3600, s-maxage=3600, stale-while-revalidate=600' });
  } catch (error) {
    return json({ error: error.message, indicator }, 500);
  }
}
