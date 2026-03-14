#!/usr/bin/env node
/**
 * Seed webcam camera metadata from Windy Webcams API v3.
 * Writes versioned geo+meta keys to Redis for spatial queries.
 *
 * Usage: node scripts/seed-webcams.mjs
 * Env:   WINDY_API_KEY, UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
 */

const WINDY_API_KEY = process.env.WINDY_API_KEY;
if (!WINDY_API_KEY) {
  console.log('WINDY_API_KEY not set — skipping webcam seed');
  process.exit(0);
}

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
if (!REDIS_URL || !REDIS_TOKEN) {
  console.error('Redis credentials not set');
  process.exit(1);
}

const PREFIX = process.env.KEY_PREFIX || '';
const WINDY_BASE = 'https://api.windy.com/webcams/api/v3/webcams';
const PAGE_LIMIT = 50;
const BATCH_SIZE = 500;
const GEO_TTL = 86400;
const MAX_OFFSET = 10000;

// Regional bounding boxes: [S, W, N, E]
const REGIONS = [
  { name: 'Europe West',            bounds: [35, -15, 72, 15] },
  { name: 'Europe East',            bounds: [35, 15, 72, 45] },
  { name: 'Middle East + N.Africa', bounds: [10, 25, 45, 65] },
  { name: 'Asia East',              bounds: [10, 65, 55, 145] },
  { name: 'Asia SE + Oceania',      bounds: [-50, 95, 10, 180] },
  { name: 'Americas North',         bounds: [15, -170, 72, -50] },
  { name: 'Americas South',         bounds: [-60, -90, 15, -30] },
  { name: 'Africa Sub-Saharan',     bounds: [-40, -20, 10, 55] },
];

async function pipelineRequest(commands) {
  const resp = await fetch(`${REDIS_URL}/pipeline`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${REDIS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(commands),
  });
  if (!resp.ok) throw new Error(`Redis pipeline failed: ${resp.status}`);
  return resp.json();
}

async function fetchRegion(bounds, regionName) {
  const [S, W, N, E] = bounds;
  const cameras = [];
  let offset = 0;

  while (offset < MAX_OFFSET) {
    const url = new URL(WINDY_BASE);
    url.searchParams.set('cameraBoundingBox', `${S},${W},${N},${E}`);
    url.searchParams.set('include', 'location,categories');
    url.searchParams.set('limit', String(PAGE_LIMIT));
    url.searchParams.set('offset', String(offset));

    const resp = await fetch(url, {
      headers: { 'x-windy-api-key': WINDY_API_KEY },
    });

    if (!resp.ok) {
      console.warn(`  [${regionName}] API error at offset ${offset}: ${resp.status}`);
      break;
    }

    const data = await resp.json();
    const webcams = data.webcams || [];
    if (webcams.length === 0) break;

    for (const wc of webcams) {
      const loc = wc.location || {};
      const cats = (wc.categories || []).map(c => c.id || c).filter(Boolean);
      cameras.push({
        webcamId: String(wc.webcamId || wc.id),
        title: wc.title || '',
        lat: loc.latitude ?? 0,
        lng: loc.longitude ?? 0,
        category: cats[0] || 'other',
        country: loc.country || '',
        region: loc.region || '',
        status: wc.status || 'active',
      });
    }

    offset += webcams.length;
    if (webcams.length < PAGE_LIMIT) break;
  }

  // Adaptive split: if we hit the 10K cap, split into quadrants
  if (offset >= MAX_OFFSET - 50 && cameras.length >= MAX_OFFSET - 50) {
    console.log(`  [${regionName}] Hit 10K cap, splitting into quadrants...`);
    const midLat = (S + N) / 2;
    const midLon = (W + E) / 2;
    const quadrants = [
      [[S, W, midLat, midLon], `${regionName} SW`],
      [[S, midLon, midLat, E], `${regionName} SE`],
      [[midLat, W, N, midLon], `${regionName} NW`],
      [[midLat, midLon, N, E], `${regionName} NE`],
    ];
    cameras.length = 0;
    for (const [qBounds, qName] of quadrants) {
      const qCameras = await fetchRegion(qBounds, qName);
      cameras.push(...qCameras);
    }
  }

  return cameras;
}

async function seedGeo(geoKey, cameras) {
  for (let i = 0; i < cameras.length; i += BATCH_SIZE) {
    const batch = cameras.slice(i, i + BATCH_SIZE);
    const args = [];
    for (const c of batch) {
      args.push(String(c.lng), String(c.lat), c.webcamId);
    }
    await pipelineRequest([['GEOADD', geoKey, ...args]]);
  }
}

async function seedMeta(metaKey, cameras) {
  for (let i = 0; i < cameras.length; i += BATCH_SIZE) {
    const batch = cameras.slice(i, i + BATCH_SIZE);
    const args = [];
    for (const c of batch) {
      const { webcamId, ...meta } = c;
      args.push(webcamId, JSON.stringify(meta));
    }
    await pipelineRequest([['HSET', metaKey, ...args]]);
  }
}

async function main() {
  console.log('seed-webcams: starting...');

  const allCameras = [];
  for (const { name, bounds } of REGIONS) {
    console.log(`  Fetching ${name}...`);
    const cameras = await fetchRegion(bounds, name);
    console.log(`  ${name}: ${cameras.length} cameras`);
    allCameras.push(...cameras);
  }

  // Deduplicate by webcamId
  const seen = new Set();
  const unique = [];
  for (const c of allCameras) {
    if (!seen.has(c.webcamId)) {
      seen.add(c.webcamId);
      unique.push(c);
    }
  }
  console.log(`  Total unique: ${unique.length}`);

  if (unique.length === 0) {
    console.log('seed-webcams: no cameras found, skipping');
    return;
  }

  // Versioned write
  const version = Date.now();
  const geoKey = `${PREFIX}webcam:cameras:geo:${version}`;
  const metaKey = `${PREFIX}webcam:cameras:meta:${version}`;
  const activeKey = `${PREFIX}webcam:cameras:active`;

  console.log(`  Writing geo index (${unique.length} entries)...`);
  await seedGeo(geoKey, unique);

  console.log(`  Writing metadata...`);
  await seedMeta(metaKey, unique);

  // Set TTL on data keys
  await pipelineRequest([
    ['EXPIRE', geoKey, String(GEO_TTL)],
    ['EXPIRE', metaKey, String(GEO_TTL)],
  ]);

  // Atomic pointer swap
  const oldVersion = await pipelineRequest([['GET', activeKey]]);
  await pipelineRequest([['SET', activeKey, String(version)]]);
  // Set TTL on active pointer AFTER the SET — 30h outlives the 24h data keys
  await pipelineRequest([
    ['EXPIRE', activeKey, String(GEO_TTL + 21600)],  // 30h — outlives data keys
  ]);
  console.log(`  Activated version ${version}`);

  // Clean up old version
  const prev = oldVersion?.[0]?.result;
  if (prev && String(prev) !== String(version)) {
    await pipelineRequest([
      ['DEL', `${PREFIX}webcam:cameras:geo:${prev}`],
      ['DEL', `${PREFIX}webcam:cameras:meta:${prev}`],
    ]);
    console.log(`  Cleaned up old version ${prev}`);
  }

  const seedMetaKey = `${PREFIX}seed-meta:webcam:cameras:geo`;
  const seedMeta = JSON.stringify({ fetchedAt: Date.now(), recordCount: unique.length });
  await pipelineRequest([['SET', seedMetaKey, seedMeta, 'EX', '604800']]);

  console.log(`seed-webcams: done (${unique.length} cameras seeded)`);
}

main().then(() => {
  process.exit(0);
}).catch(err => {
  console.error('seed-webcams: fatal error:', err.message);
  process.exit(1);
});
