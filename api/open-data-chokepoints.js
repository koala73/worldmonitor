import { readRawJsonFromUpstash } from './_upstash-json.js';

export const config = { runtime: 'edge' };

// Serves the chokepoint status open dataset at /data/v1/chokepoints/* (vercel.json
// rewrites those paths here). scripts/build-open-data-chokepoints.mjs publishes
// the files to these keys every day; README.md and schema.json stay static.
export const OPEN_DATA_CHOKEPOINT_KEYS = Object.freeze({
  index: 'open-data:chokepoints:v1:index',
  dayPrefix: 'open-data:chokepoints:v1:day:',
});

const FILE_RE = /^(latest|\d{4}-\d{2}-\d{2})\.(json|csv)$/;
const CONTENT_TYPES = { json: 'application/json; charset=utf-8', csv: 'text/csv; charset=utf-8' };
const HIT_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'public, max-age=3600',
  'CDN-Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=600',
  'Vercel-CDN-Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=600',
};
// vercel.json gives every /data/v1 path an hour of Vercel-CDN-Cache-Control,
// so misses and errors must set it too or a 404 outlives the next publish.
const MISS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'public, max-age=60',
  'CDN-Cache-Control': 'public, s-maxage=60',
  'Vercel-CDN-Cache-Control': 'public, s-maxage=60',
};
const ERROR_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'no-store',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
  'Retry-After': '60',
};
// The first archived date. A date outside [ARCHIVE_START, today UTC] cannot
// exist, so it is refused without a Redis read: the caller cannot mint
// unbounded distinct misses that each spend a command.
const ARCHIVE_START = '2026-09-10';

function isArchivableDate(date, nowMs) {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) return false;
  return date >= ARCHIVE_START && date <= new Date(nowMs).toISOString().slice(0, 10);
}

const text = (body, status, headers) => new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...headers } });

const readKey = (key) => readRawJsonFromUpstash(key, 3_000, true);

async function readFile(file, nowMs) {
  if (file === 'index.json') {
    const index = await readKey(OPEN_DATA_CHOKEPOINT_KEYS.index);
    return index && { body: `${JSON.stringify(index, null, 2)}\n`, type: CONTENT_TYPES.json };
  }
  const match = FILE_RE.exec(file);
  if (!match) return null;
  let [, date, format] = match;
  if (date === 'latest') {
    date = (await readKey(OPEN_DATA_CHOKEPOINT_KEYS.index))?.latest;
    if (!date) return null;
  } else if (!isArchivableDate(date, nowMs)) {
    return null;
  }
  const day = await readKey(`${OPEN_DATA_CHOKEPOINT_KEYS.dayPrefix}${date}`);
  return day && typeof day[format] === 'string' && { body: day[format], type: CONTENT_TYPES[format] };
}

export default async function handler(req) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return text('Method not allowed\n', 405, { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' });
  }
  const file = new URL(req.url).searchParams.get('file') ?? '';
  let found;
  try {
    found = await readFile(file, Date.now());
  } catch {
    return text('Open data store unavailable, retry shortly\n', 503, ERROR_HEADERS);
  }
  if (!found) return text(`No such file: ${file}\n`, 404, MISS_HEADERS);
  return new Response(req.method === 'HEAD' ? null : found.body, { status: 200, headers: { 'Content-Type': found.type, ...HIT_HEADERS } });
}
