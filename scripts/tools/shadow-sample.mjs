#!/usr/bin/env node
/**
 * Shadow-archive reader for Phase C/D labelling.
 *
 * During shadow mode the orchestrator writes one archive row per
 * cron tick: the full input story list + both systems' cluster
 * assignments + the enumerated disagreements. This script draws
 * labelling samples from that archive.
 *
 * Two modes:
 *   --mode disagreements --n 50   → Sample A (Disagreement Win-Rate)
 *   --mode population --n 100     → Sample B (Population Precision/Recall)
 *
 * Sample A draws uniformly from the subset of pairs where the two
 * systems disagreed. Sample B draws uniformly from the FULL set of
 * co-occurring pairs (Cartesian within each batch, de-duplicated by
 * unordered pair-of-hashes across batches). Sample B is the honest
 * measure — it catches the "both systems make the same error" class
 * that disagreement-only sampling misses.
 *
 * Output: CSV to stdout (pipe to a file). Columns:
 *   pair_id,batch_ts,a_hash,a_title,b_hash,b_title,jaccard_merged,embed_merged,label
 * `label` is blank; human labeller fills in same_event / different_event.
 *
 * Usage:
 *   UPSTASH_REDIS_REST_URL=... UPSTASH_REDIS_REST_TOKEN=... \
 *     node scripts/tools/shadow-sample.mjs --mode population --n 100 > sample.csv
 */

import { createHash, randomInt } from 'node:crypto';

const SHADOW_SCAN_PATTERN = 'brief:dedup:shadow:v1:*';

function parseArgs(argv) {
  const args = { mode: null, n: 0, seed: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--mode') args.mode = argv[++i];
    else if (argv[i] === '--n') args.n = Number.parseInt(argv[++i], 10);
    else if (argv[i] === '--seed') args.seed = Number.parseInt(argv[++i], 10);
  }
  return args;
}

function envOrDie(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`${name} not set`);
    process.exit(2);
  }
  return v;
}

// Hard allowlist. This tool only READS the shadow archive; any future
// caller that wants DEL/SET/FLUSHDB must add the command here on
// purpose and justify it in review.
const UPSTASH_COMMANDS_ALLOWED = new Set(['SCAN', 'GET', 'EXISTS']);

async function upstash(command, ...params) {
  if (!UPSTASH_COMMANDS_ALLOWED.has(command)) {
    throw new Error(
      `shadow-sample upstash helper refuses command ${command}; allowed: ${[...UPSTASH_COMMANDS_ALLOWED].join(', ')}`,
    );
  }
  const url = envOrDie('UPSTASH_REDIS_REST_URL');
  const token = envOrDie('UPSTASH_REDIS_REST_TOKEN');
  const path = [command, ...params].map(encodeURIComponent).join('/');
  const resp = await fetch(`${url}/${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'User-Agent': 'worldmonitor-shadow-sample/1.0',
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!resp.ok) {
    throw new Error(`Upstash ${command} returned HTTP ${resp.status}`);
  }
  const body = await resp.json();
  return body.result;
}

async function scanAllKeys(pattern) {
  const keys = [];
  let cursor = '0';
  do {
    const result = await upstash('SCAN', cursor, 'MATCH', pattern, 'COUNT', '500');
    if (!Array.isArray(result) || result.length < 2) break;
    cursor = String(result[0]);
    const batch = Array.isArray(result[1]) ? result[1] : [];
    for (const k of batch) keys.push(k);
  } while (cursor !== '0');
  return keys;
}

async function readArchive(key) {
  const raw = await upstash('GET', key);
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function unorderedPairKey(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * Pure helper: enumerate pairs across a list of shadow archives and
 * dedupe by unordered pair of story hashes. Returns a Map keyed by
 * pair-key with a representative `{batchTs, aHash, bHash, aTitle,
 * bTitle, embedMerged, jaccardMerged}` record.
 *
 * CRITICAL: the mode filter runs BEFORE the dedup check. An earlier
 * implementation added every seen pair to a Set first and then
 * filtered by agreement, so a pair that agreed in batch X and
 * disagreed in batch Y would silently drop the disagreeing
 * occurrence if SCAN returned X first. Sample A was biased by scan
 * order. The fix: in `--mode disagreements`, skip agreeing pairs
 * BEFORE they take the dedup slot, so any later disagreement can
 * still register.
 *
 * Exported for regression testing.
 *
 * @param {Array<object>} archives  parsed shadow-batch bodies
 * @param {'disagreements' | 'population'} mode
 */
export function enumeratePairs(archives, mode) {
  const pairRecords = new Map();
  for (const archive of archives) {
    if (!archive) continue;
    const storyIds = Array.isArray(archive.storyIds) ? archive.storyIds : [];
    const titles = Array.isArray(archive.normalizedTitles) ? archive.normalizedTitles : [];
    const embedClusters = Array.isArray(archive.embeddingClusters) ? archive.embeddingClusters : [];
    const jaccardClusters = Array.isArray(archive.jaccardClusters) ? archive.jaccardClusters : [];
    const embedIdxOf = new Map();
    const jaccardIdxOf = new Map();
    for (let c = 0; c < embedClusters.length; c++) {
      for (const h of embedClusters[c]) embedIdxOf.set(h, c);
    }
    for (let c = 0; c < jaccardClusters.length; c++) {
      for (const h of jaccardClusters[c]) jaccardIdxOf.set(h, c);
    }
    const titleByHash = new Map();
    for (let i = 0; i < storyIds.length; i++) titleByHash.set(storyIds[i], titles[i] ?? '');

    for (let i = 0; i < storyIds.length; i++) {
      for (let j = i + 1; j < storyIds.length; j++) {
        const a = storyIds[i];
        const b = storyIds[j];
        const em = embedIdxOf.get(a) === embedIdxOf.get(b);
        const jm = jaccardIdxOf.get(a) === jaccardIdxOf.get(b);
        if (mode === 'disagreements' && em === jm) continue;
        const pk = unorderedPairKey(a, b);
        if (pairRecords.has(pk)) continue;
        pairRecords.set(pk, {
          batchTs: archive.timestamp,
          aHash: a,
          bHash: b,
          aTitle: titleByHash.get(a) ?? '',
          bTitle: titleByHash.get(b) ?? '',
          embedMerged: em,
          jaccardMerged: jm,
        });
      }
    }
  }
  return pairRecords;
}

function csvEscape(s) {
  if (s == null) return '';
  const str = String(s);
  if (/[",\n\r]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

function writeCsv(rows) {
  process.stdout.write(
    'pair_id,batch_ts,a_hash,a_title,b_hash,b_title,jaccard_merged,embed_merged,label\n',
  );
  for (const r of rows) {
    const pid = createHash('sha1').update(`${r.batchTs}|${r.aHash}|${r.bHash}`).digest('hex').slice(0, 12);
    process.stdout.write(
      [
        pid,
        r.batchTs,
        r.aHash,
        csvEscape(r.aTitle),
        r.bHash,
        csvEscape(r.bTitle),
        r.jaccardMerged ? '1' : '0',
        r.embedMerged ? '1' : '0',
        '',
      ].join(',') + '\n',
    );
  }
}

function drawUniform(items, n, rand) {
  if (items.length <= n) return items.slice();
  const indices = new Set();
  while (indices.size < n) indices.add(rand(items.length));
  return [...indices].sort((a, b) => a - b).map((i) => items[i]);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode !== 'disagreements' && args.mode !== 'population') {
    console.error('usage: shadow-sample.mjs --mode disagreements|population --n N [--seed S]');
    process.exit(2);
  }
  if (!Number.isInteger(args.n) || args.n <= 0) {
    console.error('--n must be a positive integer');
    process.exit(2);
  }
  const rand = args.seed != null
    ? (() => {
        let s = args.seed >>> 0;
        return (max) => {
          s = (s * 1103515245 + 12345) & 0x7fffffff;
          return s % max;
        };
      })()
    : (max) => randomInt(0, max);

  console.error(`[shadow-sample] scanning ${SHADOW_SCAN_PATTERN} ...`);
  const keys = await scanAllKeys(SHADOW_SCAN_PATTERN);
  console.error(`[shadow-sample] found ${keys.length} archived batches`);

  const archives = [];
  for (const key of keys) {
    const archive = await readArchive(key);
    if (archive) archives.push(archive);
  }

  const allPairs = [...enumeratePairs(archives, args.mode).values()];
  console.error(
    `[shadow-sample] ${args.mode}: enumerated ${allPairs.length} candidate pair(s); drawing ${Math.min(args.n, allPairs.length)} uniformly at random`,
  );
  const drawn = drawUniform(allPairs, args.n, rand);
  writeCsv(drawn);
}

// Run only when invoked directly; allow tests to import
// `enumeratePairs` without triggering the CLI scan. Matches the
// isMain guard pattern documented in AGENTS.md.
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    console.error('[shadow-sample] failed:', err?.stack ?? err);
    process.exit(1);
  });
}
