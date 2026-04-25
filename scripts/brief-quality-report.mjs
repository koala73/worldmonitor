#!/usr/bin/env node
// Daily brief-quality dashboard.
//
// Pulls the most recent N replay-log ticks for a (variant, lang,
// sensitivity, date) tuple and computes a single quality_score plus
// the component metrics that produced it. Run daily; watch the trend.
//
// "Are we getting better" loop:
//   1. Run this script, record the quality_score.
//   2. Make a config change (env flip, code merge, threshold tune).
//   3. Wait one cron tick, re-run, compare.
//   4. If quality_score went down, revert.
//
// Metrics computed:
//   - pair_recall_cluster — % of "should-cluster" labeled pairs that
//     end up in the same topic at the active threshold
//   - false_adjacency — % of "should-separate" labeled pairs that end
//     up adjacent (false positive)
//   - cap_truncation_rate — % of qualified stories truncated by the
//     MAX_STORIES_PER_USER cap (computed from production drop logs if
//     supplied via stdin, else estimated as max(0, in - 16)/in from
//     replay record counts)
//   - multi_member_topic_share — % of topics with size > 1
//   - quality_score — composite (recall × 0.6 + (1-false-adj) × 0.3 +
//     multi-member × 0.1)
//
// Usage:
//   node --import tsx/esm scripts/brief-quality-report.mjs                              # today, full:en:all
//   node --import tsx/esm scripts/brief-quality-report.mjs --rule full:en:critical      # specific rule
//   node --import tsx/esm scripts/brief-quality-report.mjs --date 2026-04-24            # specific date
//   node --import tsx/esm scripts/brief-quality-report.mjs --json                       # machine-readable
//
// Pipe production drop logs for accurate cap-truncation:
//   railway logs --service scripts-cron-digest-notifications | grep 'brief filter drops' | \
//     node --import tsx/esm scripts/brief-quality-report.mjs --drop-lines-stdin

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile, getRedisCredentials } from './_seed-utils.mjs';
import { singleLinkCluster } from './lib/brief-dedup-embed.mjs';
import { normalizeForEmbedding } from './lib/brief-embedding.mjs';

loadEnvFile(import.meta.url);

const REPLAY_KEY_PREFIX = 'digest:replay-log:v1';

function parseArgs(argv) {
  const out = {
    date: new Date().toISOString().slice(0, 10),
    rule: 'full:en:all',
    json: false,
    dropLinesStdin: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--date') out.date = argv[++i];
    else if (a === '--rule') out.rule = argv[++i];
    else if (a === '--json') out.json = true;
    else if (a === '--drop-lines-stdin') out.dropLinesStdin = true;
    else if (a === '--help' || a === '-h') {
      console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(0, 38).join('\n'));
      process.exit(0);
    }
  }
  return out;
}

async function redisLrangeAll(url, token, key) {
  const out = [];
  const PAGE = 1000;
  let start = 0;
  while (true) {
    const stop = start + PAGE - 1;
    const res = await fetch(`${url}/lrange/${encodeURIComponent(key)}/${start}/${stop}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`LRANGE failed: HTTP ${res.status}`);
    const body = await res.json();
    const items = Array.isArray(body?.result) ? body.result : [];
    out.push(...items);
    if (items.length < PAGE) break;
    start += PAGE;
  }
  return out;
}

async function redisMget(url, token, keys) {
  if (keys.length === 0) return [];
  const path = keys.map((k) => encodeURIComponent(k)).join('/');
  const res = await fetch(`${url}/mget/${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`MGET failed: HTTP ${res.status}`);
  const body = await res.json();
  return Array.isArray(body?.result) ? body.result : new Array(keys.length).fill(null);
}

function loadLabels() {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const raw = JSON.parse(readFileSync(resolve(__dirname, 'data', 'brief-adjacency-pairs.json'), 'utf8'));
  return (raw.pairs ?? []).map((p) => ({
    a: normalizeForEmbedding(p.title_a),
    b: normalizeForEmbedding(p.title_b),
    expected: p.expected,
  }));
}

async function readStdinDropLines() {
  if (process.stdin.isTTY) return [];
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8').split('\n').filter((l) => l.includes('brief filter drops'));
}

function parseDropLine(line) {
  // [digest] brief filter drops user=X sensitivity=Y variant=Z outcome=W in=N dropped_*=N out=N
  const fields = {};
  for (const m of line.matchAll(/(\w+)=([^\s]+)/g)) fields[m[1]] = m[2];
  return fields;
}

function summariseDropLines(lines) {
  let in_total = 0, out_total = 0, cap_total = 0, samples = 0;
  let shipped = 0, rejected = 0;
  for (const line of lines) {
    const f = parseDropLine(line);
    if (!f.in || !f.out) continue;
    in_total += Number(f.in);
    out_total += Number(f.out);
    cap_total += Number(f.dropped_cap ?? 0);
    samples += 1;
    if (f.outcome === 'shipped') shipped += 1;
    else if (f.outcome === 'rejected') rejected += 1;
  }
  return {
    samples,
    shipped,
    rejected,
    cap_truncation_rate: in_total > 0 ? cap_total / in_total : 0,
    avg_in: samples > 0 ? in_total / samples : 0,
    avg_out: samples > 0 ? out_total / samples : 0,
  };
}

// Mirror production: groupTopicsPostDedup operates on top-N reps after
// the score floor, not the raw 800-rep deduped pool. Read from env so
// a Railway DIGEST_SCORE_MIN / DIGEST_MAX_ITEMS flip stays in sync;
// fall back to documented defaults if env is empty/invalid.
const SCORE_FLOOR_DEFAULT = 63;
const TOP_N_DEFAULT = 30;
const MIN_SURVIVING_REPS = 5;

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
const SCORE_FLOOR = envInt('DIGEST_SCORE_MIN', SCORE_FLOOR_DEFAULT);
const TOP_N = envInt('DIGEST_MAX_ITEMS', TOP_N_DEFAULT);

function scoreReplay({ records, embeddingByHash, labels, threshold }) {
  // Reuse the latest tick's reps as the canonical "today's brief" sample.
  const ticks = new Map();
  for (const r of records) {
    if (!ticks.has(r.briefTickId)) ticks.set(r.briefTickId, []);
    ticks.get(r.briefTickId).push(r);
  }
  const tickIds = [...ticks.keys()].sort();
  const latestTickId = tickIds[tickIds.length - 1];
  if (!latestTickId) return null;
  const allReps = ticks.get(latestTickId).filter((r) => r.isRep);
  if (allReps.length === 0) return null;

  // Apply floor + slice to mirror production.
  const slicedReplay = allReps
    .filter((r) => Number(r.currentScore ?? 0) >= SCORE_FLOOR)
    .sort((a, b) => Number(b.currentScore ?? 0) - Number(a.currentScore ?? 0))
    .slice(0, TOP_N);
  if (slicedReplay.length <= 1) return null;

  // Remap shape: replay uses storyHash/normalizedTitle; brief-dedup
  // expects hash/title. Title carries the normalized form so labels
  // match directly. Filter out reps whose embedding is missing from
  // the cache (transient eviction); skip the tick only if too few
  // reps survive.
  const remapped = slicedReplay.map((r) => ({
    hash: r.storyHash,
    title: r.normalizedTitle,
    currentScore: r.currentScore,
  }));
  const sliced = remapped.filter((r) => Array.isArray(embeddingByHash.get(r.hash)));
  const missingEmbedDrops = remapped.length - sliced.length;
  if (sliced.length < MIN_SURVIVING_REPS) {
    return { error: `only ${sliced.length} reps had cached embeddings (need ≥${MIN_SURVIVING_REPS}); ${missingEmbedDrops} dropped — re-run after cache warm-up` };
  }
  const items = sliced.map((r) => ({ title: r.title, embedding: embeddingByHash.get(r.hash) }));

  // Direct single-link partition matches what production groupTopicsPostDedup does internally.
  const { clusters } = singleLinkCluster(items, { cosineThreshold: threshold, vetoFn: null });

  const topicOfIdx = new Array(sliced.length).fill(-1);
  clusters.forEach((members, tIdx) => { for (const i of members) topicOfIdx[i] = tIdx; });

  const titleToTopic = new Map();
  for (let i = 0; i < sliced.length; i++) titleToTopic.set(sliced[i].title, topicOfIdx[i]);

  const topicCount = clusters.length;
  const sizes = clusters.map((c) => c.length);

  let cluster_total = 0, cluster_hit = 0, separate_total = 0, separate_violation = 0;
  const violations = [];
  for (const lab of labels) {
    const tA = titleToTopic.get(lab.a);
    const tB = titleToTopic.get(lab.b);
    if (tA == null || tB == null) continue;
    const clustered = tA === tB;
    if (lab.expected === 'cluster') {
      cluster_total += 1;
      if (clustered) cluster_hit += 1;
      else violations.push({ kind: 'missed_cluster', a: lab.a, b: lab.b });
    } else {
      separate_total += 1;
      if (clustered) {
        separate_violation += 1;
        violations.push({ kind: 'false_adjacency', a: lab.a, b: lab.b });
      }
    }
  }

  const pair_recall_cluster = cluster_total > 0 ? cluster_hit / cluster_total : 0;
  const false_adjacency = separate_total > 0 ? separate_violation / separate_total : 0;
  const multi_member = sizes.filter((x) => x > 1).length;
  const multi_member_topic_share = topicCount > 0 ? multi_member / topicCount : 0;

  return {
    tick_id: latestTickId,
    rep_count: allReps.length,
    sliced_rep_count: sliced.length,
    missing_embed_drops: missingEmbedDrops,
    score_floor: SCORE_FLOOR,
    top_n: TOP_N,
    topic_count: topicCount,
    multi_member_topics: multi_member,
    multi_member_topic_share,
    pair_recall_cluster,
    false_adjacency,
    cluster_pairs_evaluated: cluster_total,
    separate_pairs_evaluated: separate_total,
    violations,
    quality_score: pair_recall_cluster * 0.6 + (1 - false_adjacency) * 0.3 + multi_member_topic_share * 0.1,
  };
}

function renderReport(out) {
  const L = [];
  L.push(`# Brief Quality Report — ${out.ctx.rule} on ${out.ctx.date}`);
  L.push('');
  L.push(`Active topic threshold: ${out.ctx.threshold} (env DIGEST_DEDUP_TOPIC_THRESHOLD or default 0.45)`);
  L.push(`Replay records: ${out.ctx.recordCount} across ${out.ctx.tickCount} ticks`);
  L.push('');
  if (out.replay?.error) {
    L.push('## Topic-grouping quality (latest tick)');
    L.push('');
    L.push(`⚠️ Could not score: ${out.replay.error}`);
    L.push('');
  } else if (out.replay) {
    L.push('## Topic-grouping quality (latest tick)');
    L.push('');
    L.push(`- **quality_score: ${out.replay.quality_score.toFixed(3)}** (target: ↑ over time)`);
    L.push(`- pair_recall_cluster: ${(out.replay.pair_recall_cluster * 100).toFixed(1)}% (${out.replay.cluster_pairs_evaluated} labeled pairs evaluated)`);
    L.push(`- false_adjacency: ${(out.replay.false_adjacency * 100).toFixed(1)}% (${out.replay.separate_pairs_evaluated} labeled pairs evaluated)`);
    L.push(`- multi_member_topic_share: ${(out.replay.multi_member_topic_share * 100).toFixed(1)}% (${out.replay.multi_member_topics}/${out.replay.topic_count} topics)`);
    L.push(`- topic_count: ${out.replay.topic_count} (from ${out.replay.sliced_rep_count} sliced reps; ${out.replay.rep_count} total in tick; floor=${out.replay.score_floor}, topN=${out.replay.top_n}${out.replay.missing_embed_drops > 0 ? `, ${out.replay.missing_embed_drops} reps dropped on missing embedding` : ''})`);
    if (out.replay.violations?.length > 0) {
      L.push('');
      L.push('  Violations vs labeled pairs:');
      for (const v of out.replay.violations) {
        const arrow = v.kind === 'missed_cluster' ? '✗ should-cluster but separate' : '✗ should-separate but clustered';
        L.push(`    ${arrow}: "${v.a.slice(0, 60)}…" ↔ "${v.b.slice(0, 60)}…"`);
      }
    }
    L.push('');
  }
  if (out.drops) {
    L.push('## Production filter-drop telemetry (from stdin)');
    L.push('');
    L.push(`- samples: ${out.drops.samples} (shipped=${out.drops.shipped}, rejected=${out.drops.rejected})`);
    L.push(`- avg in: ${out.drops.avg_in.toFixed(1)} stories/tick`);
    L.push(`- avg out: ${out.drops.avg_out.toFixed(1)} stories/tick`);
    L.push(`- **cap_truncation_rate: ${(out.drops.cap_truncation_rate * 100).toFixed(1)}%** (target: ↓ after cap bump)`);
    L.push('');
  }
  L.push('## Interpretation');
  L.push('');
  L.push('- Higher `quality_score` and `pair_recall_cluster`, lower `false_adjacency` and `cap_truncation_rate` = better.');
  L.push('- Run before each config change; compare deltas. If a change moves quality_score down, revert.');
  L.push('- Add labeled pairs to `scripts/data/brief-adjacency-pairs.json` whenever a brief surfaces an adjacency outcome that\'s clearly right or clearly wrong.');
  return L.join('\n');
}

async function main() {
  const args = parseArgs(process.argv);
  const { url, token } = getRedisCredentials();
  const replayKey = `${REPLAY_KEY_PREFIX}:${args.rule}:${args.date}`;

  const rawList = await redisLrangeAll(url, token, replayKey);
  const records = rawList.map((s) => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean);
  if (records.length === 0) {
    console.error(`No replay records at ${replayKey}.`);
    process.exit(2);
  }
  const tickIds = new Set(records.map((r) => r.briefTickId));

  // Load embeddings for the latest tick only (the dashboard only scores
  // the latest snapshot — earlier ticks are the sweep harness's job).
  const sortedTickIds = [...tickIds].sort();
  const latestTickId = sortedTickIds[sortedTickIds.length - 1];
  const latestRecords = records.filter((r) => r.briefTickId === latestTickId);
  const reps = latestRecords.filter((r) => r.isRep);
  const cacheKeys = [...new Set(reps.map((r) => r.embeddingCacheKey).filter(Boolean))];
  const CHUNK = 50;
  const embByCacheKey = new Map();
  for (let i = 0; i < cacheKeys.length; i += CHUNK) {
    const chunk = cacheKeys.slice(i, i + CHUNK);
    const vals = await redisMget(url, token, chunk);
    for (let j = 0; j < chunk.length; j++) {
      if (typeof vals[j] !== 'string') continue;
      try { const v = JSON.parse(vals[j]); if (Array.isArray(v)) embByCacheKey.set(chunk[j], v); } catch { /* skip */ }
    }
  }
  const embeddingByHash = new Map();
  for (const r of reps) {
    const v = embByCacheKey.get(r.embeddingCacheKey);
    if (Array.isArray(v)) embeddingByHash.set(r.storyHash, v);
  }

  // Active threshold: read from latest tickConfig, else default 0.45.
  const threshold = latestRecords[0]?.tickConfig?.topicThreshold ?? 0.45;
  const labels = loadLabels();

  // Always call scoreReplay when there are reps. The function itself
  // filters missing embeddings and returns { error: '…' } if too few
  // survive (MIN_SURVIVING_REPS guard); renderReport surfaces that
  // error path with a ⚠️ warning. Gating here on
  // `embeddingByHash.size === reps.length` was defeating the
  // intended graceful-degradation behaviour — Greptile P2 on PR #3390.
  const replay = reps.length > 0
    ? scoreReplay({ records: latestRecords, embeddingByHash, labels, threshold })
    : null;

  const dropLines = args.dropLinesStdin ? await readStdinDropLines() : [];
  const drops = dropLines.length > 0 ? summariseDropLines(dropLines) : null;

  const out = {
    ctx: { rule: args.rule, date: args.date, threshold, recordCount: records.length, tickCount: tickIds.size },
    replay,
    drops,
  };

  if (args.json) {
    console.log(JSON.stringify(out, null, 2));
  } else {
    console.log(renderReport(out));
  }
}

main().catch((err) => {
  console.error(`brief-quality-report: ${err?.stack ?? err?.message ?? String(err)}`);
  process.exit(1);
});
