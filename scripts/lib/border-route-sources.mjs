import { dailyRoute, monthlyRoute, parseUkDaily, parseUkOds, parseCbp } from './border-route-arrivals.mjs';
import { parseFrontex, parsePanama } from './border-authorized-reports.mjs';
import { withRetry } from '../_seed-utils.mjs';
import { getOptionalUpstashCreds, upstashCommand } from '../_upstash-rest.mjs';

const UK = 'https://www.gov.uk';
const UK_PATH = '/government/publications/migrants-detected-crossing-the-english-channel-in-small-boats';
const CBP = 'https://www.cbp.gov';
const USER_AGENT = 'WorldMonitor/1.0 (+https://worldmonitor.app)';

export const BORDER_SOURCES = {
  uk: { name: 'UK Home Office', url: `${UK}${UK_PATH}`, license: 'Open Government Licence v3.0', licenseUrl: 'https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/', maxContentAgeMin: 7.5 * 1440 },
  cbp: { name: 'US Customs and Border Protection', url: `${CBP}/document/stats/nationwide-encounters`, license: 'US public domain', licenseUrl: `${CBP}/site-policy-notices/copyright-notice`, maxContentAgeMin: 75 * 1440 },
  frontex: { name: 'Frontex', url: 'https://www.frontex.europa.eu/what-we-do/monitoring-and-risk-analysis/migratory-map/', license: 'Used with permission', licenseUrl: 'https://www.frontex.europa.eu/legal-disclaimer/', maxContentAgeMin: 75 * 1440 },
  panama: { name: 'Panama Servicio Nacional de Migración', url: 'https://www.migracion.gob.pa/estadisticas/', license: 'Used with permission', licenseUrl: 'https://www.migracion.gob.pa/estadisticas/', maxContentAgeMin: 75 * 1440 },
};

async function request(url, format = 'text') {
  return withRetry(async () => {
    const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: format === 'json' ? 'application/json' : '*/*' }, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`border source HTTP ${response.status}`);
    if (Number(response.headers.get('content-length')) > 15_000_000) throw new Error('border source exceeds size budget');
    const reader = response.body?.getReader();
    if (!reader) throw new Error('border source body missing');
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 15_000_000) throw new Error('border source exceeds size budget');
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return format === 'bytes' ? bytes : format === 'json' ? JSON.parse(new TextDecoder().decode(bytes)) : new TextDecoder().decode(bytes);
  }, 1, 1000);
}

export async function fetchUk() {
  const [page, daily] = await Promise.all([request(`${UK}/api/content${UK_PATH}`, 'json'), request(`${UK}/api/content${UK_PATH}/migrants-detected-crossing-the-english-channel-in-small-boats-last-7-days`, 'json')]);
  const attachment = page?.details?.attachments?.find(a => /^https:\/\/assets\.publishing\.service\.gov\.uk\/[^?#]+\.ods$/.test(a.url));
  if (!attachment) throw new Error('Home Office ODS attachment missing');
  const history = parseUkOds(await request(attachment.url, 'bytes'));
  const recent = parseUkDaily(daily?.details?.body ?? '');
  return { routes: [{ id: 'english-channel', name: 'English Channel small-boat arrivals', kind: 'arrival', measure: 'daily', countryCode: 'GB', latitude: 51.13, longitude: 1.31, ...dailyRoute([...history, ...recent]) }] };
}

export async function fetchCbp() {
  const html = await request(BORDER_SOURCES.cbp.url);
  const links = [...new Set([...html.matchAll(/href="([^"\s]+\.csv)"/g)].map(m => m[1]))];
  const files = links.filter(p => /^\/sites\/default\/files\/\d{4}-\d{2}\/nationwide-encounters-[\w-]+-aor(?:_\d+)?\.csv$/.test(p)).sort().reverse();
  if (!files.length) throw new Error('CBP area-of-responsibility CSV missing');
  const points = parseCbp(await request(`${CBP}${files[0]}`));
  return { routes: [{ id: 'us-southwest-border', name: 'US southwest land border encounters', kind: 'encounter', measure: 'monthly', countryCode: 'US', latitude: 31.5, longitude: -109.5, ...monthlyRoute(points) }] };
}

export async function fetchFrontex() {
  const html = await request(BORDER_SOURCES.frontex.url);
  const files = [...html.matchAll(/href=["']([^"']+Monthly_detections_of_IBC_\d{4}_\d{2}_\d{2}\.xlsx)["']/gi)]
    .map(m => new URL(m[1], BORDER_SOURCES.frontex.url))
    .filter(url => url.origin === 'https://www.frontex.europa.eu' && /^\/assets\/Migratory_routes\/\d{4}\//.test(url.pathname))
    .sort((a, b) => b.pathname.localeCompare(a.pathname));
  if (!files.length) throw new Error('Frontex monthly workbook missing');
  return { routes: await parseFrontex(await request(files[0].href, 'bytes')) };
}

export async function fetchPanama() {
  const html = await request(BORDER_SOURCES.panama.url);
  const files = [...html.matchAll(/<a\b[^>]*href=["']([^"']+IRREGULARES[-_]POR[-_]DARIEN[^"']*\.pdf)["'][^>]*>/gi)]
    .map(m => ({ url: new URL(m[1], BORDER_SOURCES.panama.url), year: Number(m[0].match(/Dari.n\s+(20\d{2})/i)?.[1]) }))
    .filter(file => file.url.origin === 'https://www.migracion.gob.pa' && file.url.pathname.startsWith('/wp-content/uploads/') && Number.isInteger(file.year))
    .sort((a, b) => b.year - a.year || b.url.pathname.localeCompare(a.url.pathname));
  if (!files.length) throw new Error('Panama Darién report missing');
  const routes = await parsePanama(await request(files[0].url.href, 'bytes'));
  if (routes.some(route => Number(route.asOf.slice(0, 4)) !== files[0].year)) throw new Error('Panama report year differs from source page');
  return { routes };
}

export const FETCHERS = { uk: fetchUk, cbp: fetchCbp, frontex: fetchFrontex, panama: fetchPanama };

export function routeSeedOptions(id) {
  const source = BORDER_SOURCES[id];
  return {
    validateFn: data => Array.isArray(data?.routes) && data.routes.length > 0 && data.routes.every(route =>
      typeof route.id === 'string' && route.id.length > 0 && (/^[A-Z]{2}$/.test(route.countryCode) || id === 'frontex' && route.countryCode === '')
      && Number.isSafeInteger(route.latestCount) && route.latestCount >= 0
      && /^\d{4}-\d{2}-\d{2}$/.test(route.asOf) && Date.parse(route.asOf) <= Date.now()),
    declareRecords: data => data.routes.length,
    ttlSeconds: 3 * 86400, maxStaleMin: 2880, maxContentAgeMin: source.maxContentAgeMin,
    sourceVersion: 'border-routes-v1', schemaVersion: 1, emptyDataIsFailure: true,
    contentMeta: data => {
      const clocks = data.routes.map(r => Date.parse(r.asOf));
      return { newestItemAt: Math.max(...clocks), oldestItemAt: Math.min(...clocks) };
    },
    afterPublish: async () => {
      const creds = getOptionalUpstashCreds();
      if (creds) await upstashCommand(creds, ['SET', `seed-activated:displacement:border-${id}`, '1']);
    },
  };
}

export async function fetchBorderSource(id) {
  return {
    ...await FETCHERS[id](), source: BORDER_SOURCES[id].name, sourceUrl: BORDER_SOURCES[id].url,
    license: BORDER_SOURCES[id].license, licenseUrl: BORDER_SOURCES[id].licenseUrl,
  };
}
