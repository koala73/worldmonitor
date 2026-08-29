const MAX_ARTICLES = 5;

function cleanText(value, maxLength = 180) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function safeHttpUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
  } catch {
    return null;
  }
}

/** Normalize a Nominatim reverse-geocode response into cockpit-sized place context. */
export function normalizeRegionalPlace(payload) {
  const address = payload?.address || {};
  const locality = cleanText(
    address.city || address.town || address.village || address.municipality
      || address.hamlet || address.county,
    90,
  );
  const region = cleanText(address.state || address.region || address.county, 90);
  const country = cleanText(address.country, 90);
  const label = [locality, region].filter((value, index, values) => value && values.indexOf(value) === index)
    .join(', ') || country || cleanText(payload?.display_name, 120);
  if (!label) return null;
  return {
    label,
    locality: locality || null,
    region: region || null,
    country: country || null,
    countryCode: cleanText(address.country_code, 4).toUpperCase() || null,
  };
}

/** Normalize and deduplicate GDELT ArticleList output without trusting article HTML. */
export function normalizeRegionalArticles(payload, limit = MAX_ARTICLES) {
  const rows = Array.isArray(payload?.articles) ? payload.articles : [];
  const seen = new Set();
  const articles = [];
  for (const row of rows) {
    const url = safeHttpUrl(row?.url || row?.url_mobile);
    const title = cleanText(row?.title, 180);
    if (!url || !title) continue;
    const signature = `${title.toLowerCase()}|${new URL(url).hostname}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    const rawDate = cleanText(row?.seendate, 32);
    const compactDate = /^(\d{8})T(\d{6})Z$/.exec(rawDate);
    const publishedAt = compactDate
      ? `${compactDate[1].slice(0, 4)}-${compactDate[1].slice(4, 6)}-${compactDate[1].slice(6, 8)}T${compactDate[2].slice(0, 2)}:${compactDate[2].slice(2, 4)}:${compactDate[2].slice(4, 6)}Z`
      : Number.isNaN(Date.parse(rawDate)) ? null : new Date(rawDate).toISOString();
    articles.push({
      title,
      url,
      domain: cleanText(row?.domain || new URL(url).hostname.replace(/^www\./, ''), 80),
      publishedAt,
      sourceCountry: cleanText(row?.sourcecountry, 60) || null,
    });
    if (articles.length >= Math.max(1, Math.min(MAX_ARTICLES, limit))) break;
  }
  return articles;
}

/** Normalize Open-Meteo current conditions into a small source-stamped record. */
export function normalizeRegionalWeather(payload) {
  const current = payload?.current;
  if (!current || !Number.isFinite(Number(current.temperature_2m))) return null;
  const numberOrNull = (value) => {
    if (value === null || value === undefined || value === '') return null;
    return Number.isFinite(Number(value)) ? Number(value) : null;
  };
  // Open-Meteo reports zone-naive timestamps ("2026-08-17T00:15") that are UTC,
  // but JS parses zoneless date-times as LOCAL — pin them to UTC explicitly.
  const observedRaw = typeof current.time === 'string' && !/(?:[zZ]|[+-]\d\d:?\d\d)$/.test(current.time)
    ? `${current.time}Z`
    : current.time;
  return {
    observedAt: Number.isNaN(Date.parse(observedRaw)) ? null : new Date(observedRaw).toISOString(),
    temperatureC: numberOrNull(current.temperature_2m),
    apparentTemperatureC: numberOrNull(current.apparent_temperature),
    precipitationMm: numberOrNull(current.precipitation),
    cloudCoverPct: numberOrNull(current.cloud_cover),
    windKph: numberOrNull(current.wind_speed_10m),
    windDirectionDeg: numberOrNull(current.wind_direction_10m),
    visibilityM: numberOrNull(current.visibility),
    weatherCode: numberOrNull(current.weather_code),
  };
}

/** Translate the WMO weather code used by Open-Meteo into concise cockpit copy. */
export function weatherCodeLabel(code) {
  const value = Number(code);
  if (!Number.isFinite(value)) return 'CONDITIONS UNKNOWN';
  if (value === 0) return 'CLEAR';
  if ([1, 2].includes(value)) return 'PARTLY CLOUDY';
  if (value === 3) return 'OVERCAST';
  if ([45, 48].includes(value)) return 'FOG';
  if (value >= 51 && value <= 57) return 'DRIZZLE';
  if (value >= 61 && value <= 67) return 'RAIN';
  if (value >= 71 && value <= 77) return 'SNOW';
  if (value >= 80 && value <= 82) return 'RAIN SHOWERS';
  if (value >= 85 && value <= 86) return 'SNOW SHOWERS';
  if (value >= 95) return 'THUNDERSTORM';
  return 'MIXED CONDITIONS';
}

/** Great-circle distance used to avoid refetching a regional brief every animation frame. */
export function regionalDistanceM(from, to) {
  if (![from?.latitude, from?.longitude, to?.latitude, to?.longitude].every(Number.isFinite)) {
    return Infinity;
  }
  const phi1 = from.latitude * Math.PI / 180;
  const phi2 = to.latitude * Math.PI / 180;
  const deltaPhi = (to.latitude - from.latitude) * Math.PI / 180;
  const deltaLambda = (to.longitude - from.longitude) * Math.PI / 180;
  const a = Math.sin(deltaPhi / 2) ** 2
    + Math.cos(phi1) * Math.cos(phi2) * Math.sin(deltaLambda / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Fetch a bounded regional brief through the same-origin dev/preview proxy. */
export async function fetchRegionalBrief(latitude, longitude, { signal } = {}) {
  if (![latitude, longitude].every(Number.isFinite)) throw new Error('Valid coordinates are required');
  const params = new URLSearchParams({ latitude: latitude.toFixed(5), longitude: longitude.toFixed(5) });
  const response = await fetch(`/api/gev/regional-brief?${params}`, { signal });
  if (!response.ok) throw new Error(`Regional brief unavailable (${response.status})`);
  return response.json();
}
