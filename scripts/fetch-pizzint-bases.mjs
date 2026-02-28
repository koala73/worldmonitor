/**
 * Fetches ~79,165 military base records from the Polyglobe Supabase REST API,
 * with pagination, retry + exponential backoff, checkpoint/resume, and validation.
 *
 * Run: node scripts/fetch-pizzint-bases.mjs
 *
 * Env: SUPABASE_ANON_KEY (required) — Polyglobe public anon key
 *      SUPABASE_URL       (optional) — defaults to https://qevdnlpgjxpwusesmtpx.supabase.co
 *
 * Reads .env.local at project root for env vars.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// .env.local loader (manual dotenv for ESM)
// ---------------------------------------------------------------------------
function loadEnvLocal() {
  const envPath = path.join(projectRoot, '.env.local');
  if (!existsSync(envPath)) return;
  const lines = readFileSync(envPath, 'utf-8').split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) continue;
    const key = line.slice(0, eqIdx).trim();
    let val = line.slice(eqIdx + 1).trim();
    // Strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  }
}

loadEnvLocal();

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qevdnlpgjxpwusesmtpx.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_ANON_KEY) {
  console.error('ERROR: SUPABASE_ANON_KEY is required.');
  console.error('Set it in .env.local at the project root or export it as an env var.');
  process.exit(1);
}

const PAGE_SIZE = 1000;
const TOTAL_PAGES = 80;
const RATE_LIMIT_MS = 200;
const MAX_RETRIES = 3;
const CHECKPOINT_INTERVAL = 10;
const MIN_EXPECTED_ROWS = 79_000;

const SELECT_COLUMNS = [
  'osm_id', 'name', 'name_en', 'country_iso2', 'source', 'kind', 'branch',
  'status', 'state', 'lat', 'lon', 'cat_airforce', 'cat_naval', 'cat_marines',
  'cat_army', 'cat_nuclear', 'cat_space', 'cat_training', 'wikidata',
  'wiki_title', 'wiki_extract',
].join(',');

const DATA_DIR = path.join(projectRoot, 'scripts', 'data');
const PARTIAL_PATH = path.join(DATA_DIR, 'pizzint-partial.json');
const OUTPUT_PATH = path.join(DATA_DIR, 'pizzint-processed.json');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function ensureDataDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function loadCheckpoint() {
  if (!existsSync(PARTIAL_PATH)) return { pages: {}, rows: [] };
  try {
    const raw = readFileSync(PARTIAL_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return { pages: {}, rows: [] };
  }
}

function saveCheckpoint(state) {
  ensureDataDir();
  writeFileSync(PARTIAL_PATH, JSON.stringify(state));
}

// ---------------------------------------------------------------------------
// Fetch a single page with retry + exponential backoff
// ---------------------------------------------------------------------------
async function fetchPage(pageIndex) {
  const rangeStart = pageIndex * PAGE_SIZE;
  const rangeEnd = rangeStart + PAGE_SIZE - 1;
  const url = `${SUPABASE_URL}/rest/v1/military_bases?select=${SELECT_COLUMNS}`;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
          Range: `${rangeStart}-${rangeEnd}`,
          Prefer: 'count=exact',
          'Content-Type': 'application/json',
        },
      });

      if (!res.ok && res.status !== 206) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }

      const contentRange = res.headers.get('content-range');
      const data = await res.json();
      return { data, contentRange };
    } catch (err) {
      const backoff = Math.pow(2, attempt - 1) * 1000;
      console.warn(`  Page ${pageIndex} attempt ${attempt}/${MAX_RETRIES} failed: ${err.message}`);
      if (attempt === MAX_RETRIES) throw err;
      console.warn(`  Retrying in ${backoff}ms...`);
      await sleep(backoff);
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  ensureDataDir();

  console.log('fetch-pizzint-bases');
  console.log(`  Supabase URL: ${SUPABASE_URL}`);
  console.log(`  Page size: ${PAGE_SIZE}, max pages: ${TOTAL_PAGES}`);
  console.log('');

  // Load checkpoint
  const checkpoint = loadCheckpoint();
  const fetchedPages = checkpoint.pages || {};
  let allRows = checkpoint.rows || [];
  const resumedCount = Object.keys(fetchedPages).length;

  if (resumedCount > 0) {
    console.log(`Resuming from checkpoint: ${resumedCount} pages already fetched (${allRows.length} rows)`);
  }

  let totalCount = null;
  let emptyPages = 0;

  for (let page = 0; page < TOTAL_PAGES; page++) {
    // Skip already-fetched pages
    if (fetchedPages[page]) {
      continue;
    }

    try {
      const { data, contentRange } = await fetchPage(page);

      // Parse total from content-range header (e.g., "0-999/79165")
      if (contentRange && totalCount === null) {
        const match = contentRange.match(/\/(\d+)/);
        if (match) {
          totalCount = parseInt(match[1], 10);
          console.log(`  Total records reported by API: ${totalCount}`);
        }
      }

      if (!data || data.length === 0) {
        emptyPages++;
        console.log(`  Page ${page}: empty (${emptyPages} consecutive empty pages)`);
        if (emptyPages >= 3) {
          console.log('  3 consecutive empty pages — assuming end of data.');
          break;
        }
        continue;
      }

      emptyPages = 0;
      allRows = allRows.concat(data);
      fetchedPages[page] = true;

      const rangeStart = page * PAGE_SIZE;
      const rangeEnd = rangeStart + data.length - 1;
      console.log(`  Page ${page}: fetched ${data.length} rows (range ${rangeStart}-${rangeEnd}, total so far: ${allRows.length})`);

      // Checkpoint every N pages
      if ((Object.keys(fetchedPages).length) % CHECKPOINT_INTERVAL === 0) {
        saveCheckpoint({ pages: fetchedPages, rows: allRows });
        console.log(`  -> Checkpoint saved (${allRows.length} rows)`);
      }

      // Stop early if we have all rows
      if (totalCount && allRows.length >= totalCount) {
        console.log(`  Reached total count (${totalCount}). Stopping.`);
        break;
      }
    } catch (err) {
      console.error(`  FATAL: Page ${page} failed after ${MAX_RETRIES} retries: ${err.message}`);
      saveCheckpoint({ pages: fetchedPages, rows: allRows });
      console.error(`  Checkpoint saved. Re-run to resume from page ${page}.`);
      process.exit(1);
    }

    await sleep(RATE_LIMIT_MS);
  }

  // Final checkpoint
  saveCheckpoint({ pages: fetchedPages, rows: allRows });

  // ---------------------------------------------------------------------------
  // Validation
  // ---------------------------------------------------------------------------
  console.log('');
  console.log('Validation');

  let nullCoordCount = 0;
  const validRows = [];

  for (const row of allRows) {
    if (row.lat == null || row.lon == null || !Number.isFinite(row.lat) || !Number.isFinite(row.lon)) {
      nullCoordCount++;
      if (nullCoordCount <= 20) {
        console.warn(`  Skipping row with null coords: osm_id=${row.osm_id}, name=${row.name}`);
      }
      continue;
    }
    validRows.push(row);
  }

  if (nullCoordCount > 20) {
    console.warn(`  ... and ${nullCoordCount - 20} more rows with null lat/lon`);
  }

  console.log(`  Total fetched:       ${allRows.length}`);
  console.log(`  Null lat/lon skipped: ${nullCoordCount}`);
  console.log(`  Valid rows:          ${validRows.length}`);

  if (validRows.length < MIN_EXPECTED_ROWS) {
    console.warn(`  WARNING: Valid row count (${validRows.length}) is below expected minimum (${MIN_EXPECTED_ROWS}).`);
  } else {
    console.log(`  Row count OK (>= ${MIN_EXPECTED_ROWS})`);
  }

  // ---------------------------------------------------------------------------
  // Output
  // ---------------------------------------------------------------------------
  writeFileSync(OUTPUT_PATH, JSON.stringify(validRows));
  const sizeMB = (Buffer.byteLength(JSON.stringify(validRows)) / 1024 / 1024).toFixed(1);
  console.log('');
  console.log(`Output: ${OUTPUT_PATH} (${validRows.length} entries, ${sizeMB} MB)`);
  console.log('Done.');
}

main();
