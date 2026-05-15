/**
 * `GET /api/intel-news/v1/refresh` — cron-only endpoint.
 *
 * # Pivot rationale (May 2026)
 *
 * GDELT's DOC API became globally throttled — even a single one-keyword
 * query returns HTTP 429 ("Please limit requests to one every 5 seconds")
 * on the *first* request from any IP. Verified with curl from both
 * Vercel egress and a residential IP: same behavior. The DOC path is
 * unusable for our cadence.
 *
 * Replacement: GDELT publishes its full Global Knowledge Graph (GKG)
 * as 15-minute TSV dumps at http://data.gdeltproject.org/gdeltv2/.
 * These are static-CDN files with no rate limit. Each batch is
 * ~7 MB gzipped (~40 MB uncompressed) and contains every article
 * GDELT ingested in that window (typically 10-30k articles).
 *
 * # Pipeline
 *
 *   1. Fetch lastupdate.txt → URL of latest gkg.csv.zip
 *   2. Download + adm-zip extract
 *   3. Split lines, split fields by TAB (27 columns per GKG 2.1 spec)
 *   4. Extract <PAGE_TITLE> from each row's V2EXTRASXML field (col 26)
 *   5. Match title against each topic's pre-compiled regex; bucket
 *   6. Within-topic title-normalized dedup → collapses syndicated wires
 *   7. Merge into per-topic Redis accumulator (7-day rolling, link-deduped)
 *
 * Schema-identical to the previous DOC-API ingestion (`IntelNewsItem`),
 * so the read endpoint (`list-headlines.ts`) and iOS client need no changes.
 *
 * # Trade-offs vs old DOC API
 *
 *   + Zero rate-limit pressure (static CDN files, not API)
 *   + One download per cron run instead of 10 paced calls (~10s vs ~55s)
 *   + Get richer metadata (themes/locations/orgs available in GKG for
 *     future classifier improvements)
 *   - Title-only matching — DOC API was full-text. Articles whose
 *     headline doesn't mention the topic word will be missed. In
 *     practice, headlines carry most topical signal.
 *
 * # Optional backfill
 *
 *   GET /api/intel-news/v1/refresh?backfill=N
 *
 * Walks N batches back from the latest (15 min apart). Use
 * `?backfill=96` once after deploy to bootstrap a 24-hour window
 * into the accumulators. Same auth as the regular cron.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import AdmZip from 'adm-zip';

export const config = {
  // 300 s = Pro-plan ceiling. Cron normally uses ~1 s for a single batch;
  // the headroom matters for `?backfill=96` (24 h bootstrap, ~85 s) and
  // any future widening of the per-run scope. Vercel bills wall-clock,
  // so the higher cap costs nothing for normal cron firings.
  maxDuration: 300,
};

// ─────────────────────────────────────────────────────────────────────────────
// Topics — kept in sync with server/intel-news/v1/_topics.ts. Term lists are
// the same boolean queries we used to send to the DOC API, compiled into
// case-insensitive word-boundary regexes for headline matching.
// ─────────────────────────────────────────────────────────────────────────────

interface IntelTopic {
  id: string;
  label: string;
  titlePattern: RegExp;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildPattern(terms: string[]): RegExp {
  return new RegExp(`\\b(?:${terms.map(escapeRegex).join('|')})\\b`, 'i');
}

const INTEL_TOPICS: IntelTopic[] = [
  {
    id: 'conflict',
    label: 'CONFLICT',
    titlePattern: buildPattern([
      'armed conflict', 'airstrike', 'air strike', 'drone strike',
      'missile strike', 'missile attack', 'rocket attack', 'shelling',
      'artillery', 'ground assault', 'firefight', 'armed clash',
      'ceasefire', 'civilian casualties', 'war crime', 'insurgent',
      'militant', 'Hezbollah', 'Hamas', 'Houthi', 'offensive', 'military strike',
    ]),
  },
  {
    id: 'cyber',
    label: 'CYBER',
    titlePattern: buildPattern([
      'cyberattack', 'cyber attack', 'cybersecurity', 'ransomware', 'hacking',
      'hacker', 'data breach', 'security breach', 'data leak', 'phishing',
      'malware', 'zero-day', 'DDoS', 'APT', 'supply chain attack',
      'denial of service', 'hacked', 'exploit',
    ]),
  },
  {
    id: 'military',
    label: 'MILITARY',
    titlePattern: buildPattern([
      'armed forces', 'Pentagon', 'missile strike', 'drone strike', 'airstrike',
      'air strike', 'troop deployment', 'military exercise', 'naval exercise',
      'military operation', 'military aid', 'ceasefire', 'fighter jet',
      'ground forces', 'missile launch', 'war crime', 'military base',
      'defense ministry', 'joint exercise',
    ]),
  },
  {
    id: 'nuclear',
    label: 'NUCLEAR',
    titlePattern: buildPattern([
      'nuclear weapon', 'nuclear program', 'nuclear test', 'nuclear deal',
      'nuclear power', 'nuclear plant', 'nuclear reactor', 'nuclear missile',
      'nuclear arsenal', 'nuclear threat', 'nuclear talks', 'uranium',
      'uranium enrichment', 'plutonium', 'IAEA', 'atomic bomb', 'atomic energy',
      'non-proliferation', 'nuclear inspection',
    ]),
  },
  {
    id: 'sanctions',
    label: 'SANCTIONS',
    titlePattern: buildPattern([
      'sanctions', 'sanctioned', 'embargo', 'OFAC', 'export controls',
      'tariff', 'tariffs', 'trade war', 'frozen assets', 'blacklisted',
      'asset freeze', 'trade restriction', 'economic pressure',
      'secondary sanctions', 'sanctions package', 'sanctions list',
      'designated entity',
    ]),
  },
  {
    id: 'intelligence',
    label: 'INTELLIGENCE',
    titlePattern: buildPattern([
      'espionage', 'spy', 'CIA', 'MI6', 'Mossad', 'FSB', 'FBI',
      'intelligence agency', 'intelligence officer', 'intelligence service',
      'covert', 'surveillance', 'wiretap', 'classified document', 'informant',
      'intelligence leak', 'counterintelligence', 'double agent',
      'national security', 'defector',
    ]),
  },
  {
    id: 'maritime',
    label: 'MARITIME',
    titlePattern: buildPattern([
      'warship', 'naval blockade', 'naval base', 'naval drill', 'naval ship',
      'piracy', 'Strait of Hormuz', 'South China Sea', 'Suez Canal',
      'shipping lane', 'oil tanker', 'freighter', 'submarine', 'coast guard',
      'Bab al-Mandeb', 'Red Sea attack', 'naval patrol',
      'freedom of navigation', 'maritime security',
    ]),
  },
  {
    id: 'business',
    label: 'BUSINESS',
    titlePattern: buildPattern([
      'earnings', 'IPO', 'stock market', 'interest rate', 'Federal Reserve',
      'central bank', 'merger', 'acquisition', 'layoffs', 'quarterly results',
      'Wall Street', 'Nasdaq', 'Dow Jones', 'inflation', 'recession', 'GDP',
      'earnings report', 'stock price', 'market crash', 'rate cut', 'rate hike',
      'trade deal', 'corporate profits',
    ]),
  },
  {
    id: 'scitech',
    label: 'SCI & TECH',
    titlePattern: buildPattern([
      'artificial intelligence', 'machine learning', 'semiconductor', 'microchip',
      'quantum computing', 'biotech', 'vaccine', 'clinical trial', 'space launch',
      'rocket', 'satellite', 'renewable energy', 'nuclear fusion',
      'electric vehicle', 'robotics', 'startup', 'venture capital', 'AI model',
      'drug approval', 'FDA approval', 'genome editing', 'scientific breakthrough',
    ]),
  },
  {
    id: 'entertainment',
    label: 'ENTERTAINMENT',
    titlePattern: buildPattern([
      'box office', 'streaming', 'Hollywood', 'Netflix', 'film festival',
      'music album', 'concert', 'Spotify', 'video game', 'Oscars', 'Grammys',
      'TV series', 'film premiere', 'celebrity', 'movie release', 'song release',
      'music video', 'Emmy Awards', 'Cannes Film', 'album release', 'world tour',
      'film studio',
    ]),
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const LASTUPDATE_URL = 'http://data.gdeltproject.org/gdeltv2/lastupdate.txt';
const GKG_FETCH_TIMEOUT_MS = 30_000;
// Soft ceiling — leaves ~10 s of headroom under the 300 s `maxDuration` for
// the final Redis writes and JSON response. Bumping `maxDuration` without
// bumping this would silently cap backfill runs.
const BUDGET_MS = 290_000;

const ACCUMULATOR_RETENTION_MS = 3 * 24 * 60 * 60 * 1000; // 3-day project max
const ACCUMULATOR_TTL_S = 3 * 24 * 60 * 60;               // 3-day project max
const ACCUMULATOR_MAX_ITEMS = 500;

// GKG 2.1 column indices (per GDELT codebook). Only the ones we use:
const COL_DATE = 1;          // V2.1DATE          yyyymmddhhmmss
const COL_DOMAIN = 3;        // V2SOURCECOMMONNAME
const COL_URL = 4;           // V2DOCUMENTIDENTIFIER
const COL_TONE = 15;         // V1.5TONE          comma-separated
const COL_EXTRAS = 26;       // V2EXTRASXML       contains <PAGE_TITLE>

// ─────────────────────────────────────────────────────────────────────────────
// Wire shape — must match server/intel-news/v1/list-headlines.ts so accumulator
// reads/writes are interoperable with the read endpoint.
// ─────────────────────────────────────────────────────────────────────────────

interface IntelNewsItem {
  source: string;
  title: string;
  link: string;
  publishedAt: number;
  isAlert: boolean;
  topic: string;
  tone: number | null;
  sources?: Array<{ source: string; title: string; link: string; publishedAt: number }>;
  /** AI-generated summary, populated by enrich.ts cron after refresh. */
  summary?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Upstash Redis REST helpers — inlined to keep the cron self-contained.
// ─────────────────────────────────────────────────────────────────────────────

function getRedisCreds(): { url: string; token: string } | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return { url, token };
}

async function redisGet<T>(key: string): Promise<T | null> {
  const creds = getRedisCreds();
  if (!creds) return null;
  try {
    const resp = await fetch(`${creds.url}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${creds.token}` },
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { result: string | null };
    if (!data.result) return null;
    try { return JSON.parse(data.result) as T; } catch { return null; }
  } catch {
    return null;
  }
}

async function redisSet(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  const creds = getRedisCreds();
  if (!creds) return;
  try {
    const resp = await fetch(`${creds.url}/set/${encodeURIComponent(key)}?EX=${ttlSeconds}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${creds.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(value),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      console.warn(`[intel-news:refresh] redis SET failed for "${key}":`, body.slice(0, 150));
    }
  } catch (err) {
    console.warn(`[intel-news:refresh] redis SET threw for "${key}":`, (err as Error).message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Conflict-archive (GDELT bucket) — see server/conflict-archive/v1/_store.ts
// for the canonical schema. We write the GDELT slot here directly; enrich.ts
// later fills in summary + region + country + lat/lng.
// ─────────────────────────────────────────────────────────────────────────────

const CONFLICT_ARCHIVE_GDELT_KEY = 'conflict:archive:v1:gdelt';
const CONFLICT_ARCHIVE_RETENTION_MS = 3 * 24 * 60 * 60 * 1000; // 3-day project max
const CONFLICT_ARCHIVE_TTL_S = Math.floor(CONFLICT_ARCHIVE_RETENTION_MS / 1000);
const CONFLICT_ARCHIVE_MAX_ITEMS = 1_000;

/** Match `ConflictArchiveItem` in server/conflict-archive/v1/_store.ts. */
interface ConflictArchiveItem {
  id: string;
  source: string;
  title: string;
  link: string;
  publishedAt: number;
  isAlert: boolean;
  summary: string | null;
  location: { latitude: number; longitude: number } | null;
  locationName: string | null;
  country: string | null;
  region?: string | null;
  sources: Array<{ source: string; title: string; link: string; publishedAt: number }> | null;
  origin: 'live-news' | 'gdelt';
}

/** Idempotent merge into the conflict-archive (GDELT bucket). Existing items
 *  with the same id are kept (preserving any enrichment they've already
 *  accumulated); new items are added; the array is filtered to retention,
 *  sorted newest-first, capped, and written back. */
async function mergeIntoConflictArchive(freshItems: ConflictArchiveItem[]): Promise<{
  added: number;
  archiveSize: number;
}> {
  if (freshItems.length === 0) return { added: 0, archiveSize: 0 };

  const cutoff = Date.now() - CONFLICT_ARCHIVE_RETENTION_MS;
  const existing = await redisGet<ConflictArchiveItem[]>(CONFLICT_ARCHIVE_GDELT_KEY);
  const existingById = new Map<string, ConflictArchiveItem>();
  if (Array.isArray(existing)) {
    for (const it of existing) {
      if (it && typeof it.id === 'string' && typeof it.publishedAt === 'number') {
        existingById.set(it.id, it);
      }
    }
  }

  let added = 0;
  // Critical: when an id already exists, KEEP the existing entry (which may
  // already have summary / country / location populated by enrich) rather
  // than overwriting with the fresh-from-GDELT item that has those fields
  // null. Same idempotency guarantee as the per-topic accumulator.
  const byId = new Map<string, ConflictArchiveItem>(existingById);
  for (const fresh of freshItems) {
    if (!fresh.id || !fresh.link) continue;
    if (existingById.has(fresh.id)) {
      // Optional refresh of `sources` field — fresh GDELT may have picked
      // up additional outlets. Preserve enrichment but update sources.
      const prior = existingById.get(fresh.id)!;
      byId.set(fresh.id, {
        ...prior,
        sources: fresh.sources ?? prior.sources,
      });
    } else {
      byId.set(fresh.id, fresh);
      added++;
    }
  }

  const merged = [...byId.values()]
    .filter((it) => it.publishedAt >= cutoff)
    .sort((a, b) => b.publishedAt - a.publishedAt)
    .slice(0, CONFLICT_ARCHIVE_MAX_ITEMS);

  await redisSet(CONFLICT_ARCHIVE_GDELT_KEY, merged, CONFLICT_ARCHIVE_TTL_S);
  return { added, archiveSize: merged.length };
}

// ─────────────────────────────────────────────────────────────────────────────
// GKG fetch + parse
// ─────────────────────────────────────────────────────────────────────────────

/** Read the 320-byte index file and return the URL of the latest gkg.csv.zip. */
async function fetchLatestGkgUrl(): Promise<string | null> {
  try {
    const resp = await fetch(LASTUPDATE_URL, {
      signal: AbortSignal.timeout(GKG_FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) {
      console.warn(`[intel-news:refresh] lastupdate.txt HTTP ${resp.status}`);
      return null;
    }
    const txt = await resp.text();
    // Format: each line is "<size> <md5> <url>" — three lines for export,
    // mentions, gkg respectively.
    for (const line of txt.split('\n')) {
      const parts = line.trim().split(/\s+/);
      const url = parts[2];
      if (url && url.endsWith('.gkg.csv.zip')) return url;
    }
    return null;
  } catch (err) {
    console.warn(`[intel-news:refresh] lastupdate.txt fetch threw: ${(err as Error).message}`);
    return null;
  }
}

/** Download the .zip and return its inner CSV as utf-8 text, or null on failure. */
async function downloadGkgCsv(url: string): Promise<string | null> {
  try {
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(GKG_FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) {
      console.warn(`[intel-news:refresh] GKG fetch HTTP ${resp.status}: ${url}`);
      return null;
    }
    const ab = await resp.arrayBuffer();
    const zip = new AdmZip(Buffer.from(ab));
    const entries = zip.getEntries();
    if (entries.length === 0) {
      console.warn(`[intel-news:refresh] GKG zip empty: ${url}`);
      return null;
    }
    // GDELT batches always contain a single .csv inside.
    const first = entries[0];
    if (!first) return null;
    return first.getData().toString('utf8');
  } catch (err) {
    console.warn(`[intel-news:refresh] GKG download/unzip threw for ${url}: ${(err as Error).message}`);
    return null;
  }
}

function parseGkgDate(s: string): number {
  if (!s || s.length < 14) return 0;
  const yr = s.slice(0, 4);
  const mo = s.slice(4, 6);
  const dy = s.slice(6, 8);
  const hh = s.slice(8, 10);
  const mm = s.slice(10, 12);
  const ss = s.slice(12, 14);
  const t = Date.parse(`${yr}-${mo}-${dy}T${hh}:${mm}:${ss}Z`);
  return Number.isFinite(t) ? t : 0;
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => {
      const code = parseInt(n, 10);
      return Number.isFinite(code) ? String.fromCharCode(code) : '';
    });
}

/** Pull <PAGE_TITLE>...</PAGE_TITLE> out of a row's V2EXTRASXML blob. */
function extractTitle(extrasXml: string): string | null {
  if (!extrasXml) return null;
  const m = /<PAGE_TITLE>([^<]+)<\/PAGE_TITLE>/.exec(extrasXml);
  if (!m || !m[1]) return null;
  const decoded = decodeHtmlEntities(m[1]).trim();
  if (decoded.length < 5) return null;
  return decoded;
}

function normalizeTitle(t: string): string {
  return t.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
}

interface ParsedRow {
  date: number;
  domain: string;
  url: string;
  tone: number | null;
  title: string;
}

function parseGkgRow(line: string): ParsedRow | null {
  if (!line) return null;
  const fields = line.split('\t');
  if (fields.length < 27) return null;

  const url = (fields[COL_URL] ?? '').trim();
  const domain = (fields[COL_DOMAIN] ?? '').trim();
  if (!url || !domain) return null;

  const title = extractTitle(fields[COL_EXTRAS] ?? '');
  if (!title) return null;

  const date = parseGkgDate(fields[COL_DATE] ?? '');
  const toneFirst = (fields[COL_TONE] ?? '').split(',')[0] ?? '';
  const toneNum = parseFloat(toneFirst);
  const tone = Number.isFinite(toneNum) ? toneNum : null;

  return { date, domain, url, tone, title };
}

// ─────────────────────────────────────────────────────────────────────────────
// Topic bucketing + within-topic dedup
// ─────────────────────────────────────────────────────────────────────────────

function bucketByTopic(rows: ParsedRow[]): Map<string, IntelNewsItem[]> {
  // First pass: assign each row to every matching topic (a row can land
  // in more than one — e.g. a "drone strike on nuclear plant" headline
  // hits both military and nuclear, which is the right behavior).
  const raw = new Map<string, IntelNewsItem[]>();
  for (const t of INTEL_TOPICS) raw.set(t.id, []);

  for (const row of rows) {
    for (const topic of INTEL_TOPICS) {
      if (topic.titlePattern.test(row.title)) {
        const bucket = raw.get(topic.id);
        if (!bucket) continue;
        bucket.push({
          source: row.domain,
          title: row.title,
          link: row.url,
          publishedAt: row.date,
          isAlert: false,
          topic: topic.id,
          tone: row.tone,
        });
      }
    }
  }

  // Second pass: per-topic title-normalized dedup. Same syndicated wire
  // story collapsed to one canonical with sources[] populated.
  const deduped = new Map<string, IntelNewsItem[]>();
  for (const [topicId, items] of raw) {
    const groups = new Map<string, IntelNewsItem[]>();
    for (const item of items) {
      const k = normalizeTitle(item.title);
      if (!k) continue;
      const group = groups.get(k) ?? [];
      group.push(item);
      groups.set(k, group);
    }
    const result: IntelNewsItem[] = [];
    for (const group of groups.values()) {
      group.sort((a, b) => b.publishedAt - a.publishedAt);
      const canonical = group[0];
      if (!canonical) continue;
      if (group.length > 1) {
        canonical.sources = group.map((g) => ({
          source: g.source,
          title: g.title,
          link: g.link,
          publishedAt: g.publishedAt,
        }));
      }
      result.push(canonical);
    }
    result.sort((a, b) => b.publishedAt - a.publishedAt);
    deduped.set(topicId, result);
  }
  return deduped;
}

// ─────────────────────────────────────────────────────────────────────────────
// Accumulator merge — same Redis key as the previous DOC-API ingestion, so
// the read endpoint and iOS client are unchanged.
// ─────────────────────────────────────────────────────────────────────────────

interface MergeResult {
  /** Total items in the accumulator after merge (post-retention, post-cap). */
  accumulatorSize: number;
  /** Count of links that didn't exist in the accumulator before this merge. */
  added: number;
}

async function mergeIntoAccumulator(topicId: string, freshItems: IntelNewsItem[]): Promise<MergeResult> {
  const key = `intel-news:topic:v6:${topicId}:accumulator`;
  const cutoff = Date.now() - ACCUMULATOR_RETENTION_MS;

  const existing = await redisGet<IntelNewsItem[]>(key);
  const existingByLink = new Map<string, IntelNewsItem>();
  if (Array.isArray(existing)) {
    for (const item of existing) {
      if (item && typeof item.link === 'string' && item.link) existingByLink.set(item.link, item);
    }
  }

  // Count "really new" — links not seen before in the accumulator. This is
  // the metric that matters for enrichment cost: anything already in
  // existingByLink is either already summarized or will be picked up by
  // enrich on its own (which scans for items missing `summary`).
  let added = 0;

  // Important: when an item's link already exists, KEEP the existing entry
  // (which may already have a `summary` from a previous enrichment run)
  // rather than overwriting with the fresh GKG entry which has no summary.
  // We do still update tone/sources from fresh data — those can change
  // as more outlets report the same wire — but preserve `summary`.
  const byLink = new Map<string, IntelNewsItem>(existingByLink);
  for (const fresh of freshItems) {
    if (!fresh || typeof fresh.link !== 'string' || !fresh.link) continue;
    const prior = existingByLink.get(fresh.link);
    if (prior) {
      // Merge fresh metadata onto prior; preserve summary.
      byLink.set(fresh.link, {
        ...fresh,
        summary: prior.summary,
      });
    } else {
      byLink.set(fresh.link, fresh);
      added++;
    }
  }

  const merged = [...byLink.values()]
    .filter((it) => typeof it.publishedAt === 'number' && it.publishedAt >= cutoff)
    .sort((a, b) => b.publishedAt - a.publishedAt)
    .slice(0, ACCUMULATOR_MAX_ITEMS);

  await redisSet(key, merged, ACCUMULATOR_TTL_S);
  return { accumulatorSize: merged.length, added };
}

// ─────────────────────────────────────────────────────────────────────────────
// Process a single batch URL end-to-end
// ─────────────────────────────────────────────────────────────────────────────

interface BatchResult {
  rows: number;
  withTitles: number;
  perTopic: Record<string, {
    matched: number;
    afterDedup: number;
    /** Items whose link was not in the accumulator before this merge. */
    newlyAdded: number;
    accumulatorSize: number;
  }>;
}

async function processBatch(gkgUrl: string): Promise<BatchResult | null> {
  const tDownload = Date.now();
  const csv = await downloadGkgCsv(gkgUrl);
  if (!csv) return null;
  console.log(
    `[intel-news:refresh] ${gkgUrl.split('/').pop()} downloaded+unzipped in ` +
    `${Date.now() - tDownload}ms · ${(csv.length / 1024 / 1024).toFixed(1)}MB`,
  );

  const tParse = Date.now();
  const lines = csv.split('\n');
  const parsedRows: ParsedRow[] = [];
  for (const line of lines) {
    const row = parseGkgRow(line);
    if (row) parsedRows.push(row);
  }
  console.log(
    `[intel-news:refresh] parsed ${lines.length} lines, ` +
    `${parsedRows.length} with titles in ${Date.now() - tParse}ms`,
  );

  const tBucket = Date.now();
  const buckets = bucketByTopic(parsedRows);
  const matchedBefore = new Map<string, number>();
  // We've already deduped inside bucketByTopic, but we want to log raw
  // match counts too — recompute from rows.
  for (const t of INTEL_TOPICS) {
    let n = 0;
    for (const r of parsedRows) if (t.titlePattern.test(r.title)) n++;
    matchedBefore.set(t.id, n);
  }
  console.log(`[intel-news:refresh] bucketed in ${Date.now() - tBucket}ms`);

  // Merge each non-empty bucket into Redis.
  //
  // Special case: the `conflict` topic does NOT go into the per-topic
  // accumulator. Instead it goes to `conflict:archive:v1:gdelt` (30-day
  // retention, link-based id) so the iOS CONFLICT chip + map pin layer
  // can read it directly. The enrich cron picks up archive items and
  // fills in summary / region / country / lat-lng.
  const perTopic: BatchResult['perTopic'] = {};
  for (const topic of INTEL_TOPICS) {
    const items = buckets.get(topic.id) ?? [];
    const matched = matchedBefore.get(topic.id) ?? 0;
    if (items.length === 0) {
      perTopic[topic.id] = { matched, afterDedup: 0, newlyAdded: 0, accumulatorSize: 0 };
      continue;
    }

    if (topic.id === 'conflict') {
      // Translate to ConflictArchiveItem shape (link as id, fields the iOS
      // map / chip code already consumes) and write to the archive.
      const archiveItems: ConflictArchiveItem[] = items.map((it) => ({
        id: it.link,
        source: it.source,
        title: it.title,
        link: it.link,
        publishedAt: it.publishedAt,
        isAlert: false,
        summary: null,
        location: null,
        locationName: null,
        country: null,
        region: null,
        sources: it.sources ?? null,
        origin: 'gdelt',
      }));
      const merge = await mergeIntoConflictArchive(archiveItems);
      perTopic[topic.id] = {
        matched,
        afterDedup: items.length,
        newlyAdded: merge.added,
        accumulatorSize: merge.archiveSize,
      };
      console.log(
        `[intel-news:refresh] ${topic.id}: ${matched} matched → ${items.length} after dedup → ` +
        `+${merge.added} new → ${merge.archiveSize} in conflict-archive (gdelt)`,
      );
      continue;
    }

    const merge = await mergeIntoAccumulator(topic.id, items);
    perTopic[topic.id] = {
      matched,
      afterDedup: items.length,
      newlyAdded: merge.added,
      accumulatorSize: merge.accumulatorSize,
    };
    console.log(
      `[intel-news:refresh] ${topic.id}: ${matched} matched → ${items.length} after dedup → ` +
      `+${merge.added} new → ${merge.accumulatorSize} in accumulator`,
    );
  }

  return { rows: lines.length, withTitles: parsedRows.length, perTopic };
}

// ─────────────────────────────────────────────────────────────────────────────
// Top-level refresh — single batch by default, multi-batch backfill on demand
// ─────────────────────────────────────────────────────────────────────────────

interface RefreshResult {
  batches: number;
  durationMs: number;
  totals: Record<string, {
    matched: number;
    afterDedup: number;
    newlyAdded: number;
    accumulatorSize: number;
  }>;
  /** Sum of `newlyAdded` across all topics — useful as a sanity-check log signal. */
  totalNewlyAdded: number;
}

/** Walk back N batches (15 min apart) from a yyyymmddhhmmss timestamp. */
function generateBackfillUrls(latestUrl: string, count: number): string[] {
  const m = /\/(\d{14})\.gkg\.csv\.zip$/.exec(latestUrl);
  if (!m || !m[1]) return [latestUrl];

  const ts = m[1];
  const yy = parseInt(ts.slice(0, 4), 10);
  const mo = parseInt(ts.slice(4, 6), 10);
  const dy = parseInt(ts.slice(6, 8), 10);
  const hh = parseInt(ts.slice(8, 10), 10);
  const mm = parseInt(ts.slice(10, 12), 10);
  const baseTime = Date.UTC(yy, mo - 1, dy, hh, mm);

  const urls: string[] = [];
  for (let i = 0; i < count; i++) {
    const t = baseTime - i * 15 * 60 * 1000;
    const d = new Date(t);
    const stamp =
      `${d.getUTCFullYear()}` +
      `${String(d.getUTCMonth() + 1).padStart(2, '0')}` +
      `${String(d.getUTCDate()).padStart(2, '0')}` +
      `${String(d.getUTCHours()).padStart(2, '0')}` +
      `${String(d.getUTCMinutes()).padStart(2, '0')}00`;
    urls.push(`http://data.gdeltproject.org/gdeltv2/${stamp}.gkg.csv.zip`);
  }
  return urls;
}

async function refreshIntelNews(backfill: number): Promise<RefreshResult> {
  const start = Date.now();
  const latestUrl = await fetchLatestGkgUrl();
  if (!latestUrl) throw new Error('failed to read lastupdate.txt');

  const urls = backfill <= 1 ? [latestUrl] : generateBackfillUrls(latestUrl, backfill);
  console.log(`[intel-news:refresh] processing ${urls.length} batch(es) (backfill=${backfill})`);

  const totals: RefreshResult['totals'] = {};
  let batchesDone = 0;

  for (const url of urls) {
    if (Date.now() - start > BUDGET_MS) {
      console.log(
        `[intel-news:refresh] budget exhausted at ${Date.now() - start}ms, ` +
        `stopping after ${batchesDone}/${urls.length}`,
      );
      break;
    }
    try {
      const result = await processBatch(url);
      if (!result) continue;
      batchesDone++;
      for (const [tid, stats] of Object.entries(result.perTopic)) {
        const prev = totals[tid] ?? { matched: 0, afterDedup: 0, newlyAdded: 0, accumulatorSize: 0 };
        totals[tid] = {
          matched: prev.matched + stats.matched,
          afterDedup: prev.afterDedup + stats.afterDedup,
          newlyAdded: prev.newlyAdded + stats.newlyAdded,
          // Accumulator size is post-merge — we want the LATEST seen, not summed.
          accumulatorSize: stats.accumulatorSize,
        };
      }
    } catch (err) {
      console.warn(`[intel-news:refresh] batch ${url} threw: ${(err as Error).message}`);
    }
  }

  const totalNewlyAdded = Object.values(totals).reduce((s, t) => s + t.newlyAdded, 0);
  const durationMs = Date.now() - start;
  console.log(
    `[intel-news:refresh] GKG ingestion done in ${durationMs}ms · ` +
    `${batchesDone}/${urls.length} batches · ${totalNewlyAdded} newly-added items`,
  );
  return { batches: batchesDone, durationMs, totals, totalNewlyAdded };
}

// Enrichment is a SEPARATE cron (`/api/intel-news/v1/enrich`, scheduled at
// 5/20/35/50 past the hour in vercel.json). That cron reads each topic's
// accumulator, finds items missing `summary`, runs Gemini → Claude
// fallback, and writes summaries back. Refresh and enrich are
// independent crons because the previous "refresh chains into enrich"
// pattern hit Vercel's Deployment Protection on the function-to-function
// HTTP call. Independent crons sidestep the platform issue entirely
// while preserving the same end-state: fresh items get summarized within
// ~5 minutes of being added.

// ─────────────────────────────────────────────────────────────────────────────
// Auth + handler
// ─────────────────────────────────────────────────────────────────────────────

function isAuthorizedCron(req: IncomingMessage): boolean {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = (req.headers.authorization ?? '') as string;
    if (auth === `Bearer ${secret}`) return true;
  }
  const ua = ((req.headers['user-agent'] ?? '') as string).toLowerCase();
  if (ua.includes('vercel-cron')) return true;
  return false;
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

  if (req.method !== 'GET') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  if (!isAuthorizedCron(req)) {
    res.statusCode = 403;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Forbidden — cron-only endpoint' }));
    return;
  }

  // Parse ?backfill=N — clamps to [1, 96] (24 h max).
  const urlObj = new URL(req.url ?? '/', 'http://localhost');
  const backfillRaw = urlObj.searchParams.get('backfill');
  const backfill = backfillRaw
    ? Math.max(1, Math.min(96, parseInt(backfillRaw, 10) || 1))
    : 1;

  try {
    const result = await refreshIntelNews(backfill);

    // Refresh's responsibility ends at writing the accumulator. The
    // separate `enrich` cron (5/20/35/50 past the hour) picks up items
    // missing `summary` on its next firing — typically within 5 min of
    // refresh adding them.
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(result));
  } catch (err) {
    console.error('[intel-news:refresh] handler failed:', err instanceof Error ? err.message : err);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Internal error' }));
  }
}
