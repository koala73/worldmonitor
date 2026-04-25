#!/usr/bin/env node
// Offline threshold sweep for the brief topic-grouping pass.
//
// Reads the per-tick replay log captured by writeReplayLog (opt-in via
// DIGEST_DEDUP_REPLAY_LOG=1, key prefix `digest:replay-log:v1:`),
// reconstructs each tick's reps + cached embeddings, re-runs
// groupTopicsPostDedup at multiple cosine thresholds, and scores the
// resulting topic assignments against the labeled adjacency pairs in
// scripts/data/brief-adjacency-pairs.json.
//
// "Are we getting better" output: a markdown table — one row per
// candidate threshold — with pair_recall, false_adjacency, topic_count,
// avg_topic_size, and a composite quality_score. Pick the row with the
// highest quality_score; flip DIGEST_DEDUP_TOPIC_THRESHOLD on Railway
// to that value.
//
// Usage:
//   node --import tsx/esm scripts/sweep-topic-thresholds.mjs                                # today, full:en:all
//   node --import tsx/esm scripts/sweep-topic-thresholds.mjs --date 2026-04-24              # specific date
//   node --import tsx/esm scripts/sweep-topic-thresholds.mjs --rule full:en:critical        # specific rule
//   node --import tsx/esm scripts/sweep-topic-thresholds.mjs --thresholds 0.30,0.35,0.40    # custom sweep
//   node --import tsx/esm scripts/sweep-topic-thresholds.mjs --json > sweep-result.json     # machine-readable

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile, getRedisCredentials } from './_seed-utils.mjs';
import { groupTopicsPostDedup } from './lib/brief-dedup.mjs';
import { singleLinkCluster } from './lib/brief-dedup-embed.mjs';
import { normalizeForEmbedding } from './lib/brief-embedding.mjs';

loadEnvFile(import.meta.url);

// ── CLI args ───────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {
    date: new Date().toISOString().slice(0, 10),
    rule: 'full:en:all',
    thresholds: [0.30, 0.32, 0.35, 0.38, 0.40, 0.42, 0.45],
    json: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--date') out.date = argv[++i];
    else if (a === '--rule') out.rule = argv[++i];
    else if (a === '--thresholds') {
      out.thresholds = argv[++i].split(',').map((x) => Number(x.trim())).filter(Number.isFinite);
    } else if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') {
      console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(0, 23).join('\n'));
      process.exit(0);
    }
  }
  return out;
}

// ── Redis helpers ───────────────────────────────────────────────────────

const REPLAY_KEY_PREFIX = 'digest:replay-log:v1';

async function redisLrangeAll(url, token, key) {
  // Pull entire list. Page size 1000 to keep individual responses bounded.
  const out = [];
  const PAGE = 1000;
  let start = 0;
  while (true) {
    const stop = start + PAGE - 1;
    const res = await fetch(`${url}/lrange/${encodeURIComponent(key)}/${start}/${stop}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      throw new Error(`LRANGE failed: HTTP ${res.status} ${await res.text()}`);
    }
    const body = await res.json();
    const items = Array.isArray(body?.result) ? body.result : [];
    out.push(...items);
    if (items.length < PAGE) break;
    start += PAGE;
  }
  return out;
}

async function redisMget(url, token, keys) {
  // Upstash MGET via REST. Returns array same length as keys; null for missing.
  if (keys.length === 0) return [];
  const path = keys.map((k) => encodeURIComponent(k)).join('/');
  const res = await fetch(`${url}/mget/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`MGET failed: HTTP ${res.status} ${await res.text()}`);
  }
  const body = await res.json();
  return Array.isArray(body?.result) ? body.result : new Array(keys.length).fill(null);
}

// ── Replay record helpers ───────────────────────────────────────────────

function parseReplayRecords(rawList) {
  const recs = [];
  for (const raw of rawList) {
    if (typeof raw !== 'string') continue;
    try {
      const r = JSON.parse(raw);
      if (r && typeof r === 'object' && r.briefTickId) recs.push(r);
    } catch { /* swallow malformed entries */ }
  }
  return recs;
}

function groupByTick(records) {
  const ticks = new Map();
  for (const r of records) {
    if (!ticks.has(r.briefTickId)) ticks.set(r.briefTickId, []);
    ticks.get(r.briefTickId).push(r);
  }
  return ticks;
}

// ── Pair labels ─────────────────────────────────────────────────────────

function loadLabeledPairs() {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const path = resolve(__dirname, 'data', 'brief-adjacency-pairs.json');
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  return Array.isArray(raw?.pairs) ? raw.pairs : [];
}

// Apply normalizeForEmbedding to each label so titles match what was
// actually embedded in the replay log.
function indexLabelsByNormalizedTitle(pairs) {
  const out = [];
  for (const p of pairs) {
    if (!p.title_a || !p.title_b) continue;
    out.push({
      a: normalizeForEmbedding(p.title_a),
      b: normalizeForEmbedding(p.title_b),
      expected: p.expected,
      rationale: p.rationale,
      source_brief: p.source_brief,
    });
  }
  return out;
}

// ── Threshold scoring ───────────────────────────────────────────────────

// Mirror the production slice: groupTopicsPostDedup runs on the
// top-DIGEST_MAX_ITEMS reps by score, NOT the full deduped set.
// scripts/seed-digest-notifications.mjs:479 — `deduped.slice(0, 30)`.
const SCORE_FLOOR_DEFAULT = 63;  // matches production DIGEST_SCORE_MIN
const TOP_N_DEFAULT = 30;        // matches production DIGEST_MAX_ITEMS

function scoreOneTick({ reps, embeddingByHash, labels, thresholds, scoreFloor = SCORE_FLOOR_DEFAULT, topN = TOP_N_DEFAULT }) {
  // Apply production-equivalent floor + slice so the sweep reflects
  // what topic-grouping actually sees in prod, not the 800-rep raw pool.
  const floored = reps.filter((r) => Number(r.currentScore ?? 0) >= scoreFloor);
  const slicedReplay = [...floored]
    .sort((a, b) => Number(b.currentScore ?? 0) - Number(a.currentScore ?? 0))
    .slice(0, topN);
  if (slicedReplay.length <= 1) {
    return thresholds.map((t) => ({ threshold: t, topic_count: slicedReplay.length, sizes: [], pair_results: [] }));
  }

  // Remap replay-record shape (storyHash, normalizedTitle, …) to the
  // shape groupTopicsPostDedup expects (hash, title, currentScore).
  // The function looks up embeddings via `rep.hash`, so the storyHash
  // value MUST land on the `hash` field — not `storyHash`.
  const sliced = slicedReplay.map((r) => ({
    hash: r.storyHash,
    title: r.normalizedTitle,
    currentScore: r.currentScore,
    _replay: r,
  }));
  const items = sliced.map((r) => ({ title: r.title, embedding: embeddingByHash.get(r.hash) }));
  if (items.some((it) => !Array.isArray(it.embedding))) return null;

  const out = [];
  for (const threshold of thresholds) {
    // Run the same single-link cluster groupTopicsPostDedup uses
    // internally. We compute the partition directly so the
    // topic-membership labels are byte-identical to what production
    // would produce at this threshold (no leader-only approximation).
    const items = sliced.map((r) => ({
      title: r.title,
      embedding: embeddingByHash.get(r.hash),
    }));
    const { clusters } = singleLinkCluster(items, { cosineThreshold: threshold, vetoFn: null });

    // Map sliced index → topicId
    const topicOfIdx = new Array(sliced.length).fill(-1);
    clusters.forEach((members, tIdx) => {
      for (const i of members) topicOfIdx[i] = tIdx;
    });

    // Title → topic membership for label scoring
    const titleToTopic = new Map();
    for (let i = 0; i < sliced.length; i++) titleToTopic.set(sliced[i].title, topicOfIdx[i]);

    const topicCount = clusters.length;
    const sizes = clusters.map((c) => c.length);

    // Also call groupTopicsPostDedup so the table reflects errors
    // surfaced by the production code path (not just the clustering).
    const cfg = { topicGroupingEnabled: true, topicThreshold: threshold };
    const result = groupTopicsPostDedup(sliced, cfg, embeddingByHash);
    if (result.error) {
      out.push({ threshold, topic_count: topicCount, sizes, pair_results: [], error: result.error.message });
      continue;
    }
    const pair_results = [];
    for (const lab of labels) {
      const tA = titleToTopic.get(lab.a);
      const tB = titleToTopic.get(lab.b);
      if (tA == null || tB == null) continue; // pair not present in this tick
      const clustered = tA === tB;
      const correct = (lab.expected === 'cluster') === clustered;
      pair_results.push({ expected: lab.expected, clustered, correct });
    }

    out.push({
      threshold,
      topic_count: topicCount,
      sizes: [...sizes].sort((a, b) => b - a),
      pair_results,
    });
  }
  return out;
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ── Aggregation across ticks ────────────────────────────────────────────

function aggregateByThreshold(perTickRows, thresholds) {
  const summary = new Map();
  for (const t of thresholds) summary.set(t, {
    threshold: t,
    ticks: 0,
    avg_topic_count: 0,
    avg_max_topic_size: 0,
    multi_member_topic_share: 0,
    pair_recall_cluster: 0,        // tp / (tp + fn) on cluster-expected pairs
    false_adjacency: 0,             // fp / (fp + tn) on separate-expected pairs
    quality_score: 0,
    samples: 0,
  });
  for (const tickRows of perTickRows) {
    if (!tickRows) continue;
    for (const row of tickRows) {
      const s = summary.get(row.threshold);
      if (!s) continue;
      s.ticks += 1;
      s.avg_topic_count += row.topic_count;
      s.avg_max_topic_size += row.sizes[0] ?? 0;
      const multiMember = row.sizes.filter((x) => x > 1).length;
      s.multi_member_topic_share += row.topic_count > 0 ? multiMember / row.topic_count : 0;
      for (const p of row.pair_results) {
        if (p.expected === 'cluster') {
          s.pair_recall_cluster += p.clustered ? 1 : 0;
          s._cluster_total = (s._cluster_total ?? 0) + 1;
        } else {
          s.false_adjacency += p.clustered ? 1 : 0;
          s._separate_total = (s._separate_total ?? 0) + 1;
        }
        s.samples += 1;
      }
    }
  }
  for (const s of summary.values()) {
    if (s.ticks === 0) continue;
    s.avg_topic_count /= s.ticks;
    s.avg_max_topic_size /= s.ticks;
    s.multi_member_topic_share /= s.ticks;
    s.pair_recall_cluster = (s._cluster_total ?? 0) > 0 ? s.pair_recall_cluster / s._cluster_total : 0;
    s.false_adjacency = (s._separate_total ?? 0) > 0 ? s.false_adjacency / s._separate_total : 0;
    // Composite: weight recall (the win), penalise false adjacency,
    // small bonus for multi-member share. Tuneable; current weights
    // mirror the plan's recommendation in §"Solution 2 — Step 2a".
    s.quality_score = (
      s.pair_recall_cluster * 0.6
      + (1 - s.false_adjacency) * 0.3
      + s.multi_member_topic_share * 0.1
    );
    delete s._cluster_total;
    delete s._separate_total;
  }
  return [...summary.values()].sort((a, b) => a.threshold - b.threshold);
}

// ── Output formatters ───────────────────────────────────────────────────

function renderMarkdownTable(rows, ctx) {
  const lines = [];
  lines.push(`# Brief topic-threshold sweep — ${ctx.rule} on ${ctx.date}`);
  lines.push('');
  lines.push(`Replay records: ${ctx.recordCount}, ticks: ${ctx.tickCount}, evaluable ticks: ${ctx.evaluableTicks}`);
  lines.push(`Labeled pairs loaded: ${ctx.labelCount} (${ctx.clusterLabels} cluster, ${ctx.separateLabels} separate)`);
  lines.push('');
  lines.push('| threshold | quality_score | pair_recall | false_adjacency | avg_topics | avg_max_size | multi_member_share | samples |');
  lines.push('|-----------|---------------|-------------|-----------------|------------|--------------|--------------------|---------|');
  let best = null;
  for (const r of rows) {
    if (r.ticks === 0) continue;
    let star = '';
    if (best == null || r.quality_score > best.quality_score) {
      best = r;
      star = ' ⭐';
    }
    lines.push(
      `| ${r.threshold.toFixed(2)} `
      + `| ${r.quality_score.toFixed(3)}${star} `
      + `| ${(r.pair_recall_cluster * 100).toFixed(1)}% `
      + `| ${(r.false_adjacency * 100).toFixed(1)}% `
      + `| ${r.avg_topic_count.toFixed(1)} `
      + `| ${r.avg_max_topic_size.toFixed(1)} `
      + `| ${(r.multi_member_topic_share * 100).toFixed(1)}% `
      + `| ${r.samples} |`,
    );
  }
  if (best) {
    lines.push('');
    lines.push(`**Recommended threshold: ${best.threshold.toFixed(2)}** (quality=${best.quality_score.toFixed(3)}, recall=${(best.pair_recall_cluster*100).toFixed(1)}%, false-adj=${(best.false_adjacency*100).toFixed(1)}%)`);
    lines.push('');
    lines.push(`Apply via Railway env: \`DIGEST_DEDUP_TOPIC_THRESHOLD=${best.threshold.toFixed(2)}\` on the digest-notifications service.`);
  }
  return lines.join('\n');
}

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv);
  const { url, token } = getRedisCredentials();
  const replayKey = `${REPLAY_KEY_PREFIX}:${args.rule}:${args.date}`;

  const rawList = await redisLrangeAll(url, token, replayKey);
  const records = parseReplayRecords(rawList);
  if (records.length === 0) {
    console.error(`No replay records at ${replayKey}. Is DIGEST_DEDUP_REPLAY_LOG=1 set on Railway?`);
    process.exit(2);
  }

  const ticks = groupByTick(records);

  // For each tick: reps = records where isRep===true. Hydrate embeddings
  // via MGET on embeddingCacheKey.
  const allCacheKeys = new Set();
  for (const tickRecs of ticks.values()) {
    for (const r of tickRecs) {
      if (r.isRep && r.embeddingCacheKey) allCacheKeys.add(r.embeddingCacheKey);
    }
  }
  const cacheKeyList = [...allCacheKeys];
  // Chunk MGET to keep URL length sane (Upstash REST has practical caps).
  const CHUNK = 50;
  const embeddingByCacheKey = new Map();
  for (let i = 0; i < cacheKeyList.length; i += CHUNK) {
    const chunk = cacheKeyList.slice(i, i + CHUNK);
    const vals = await redisMget(url, token, chunk);
    for (let j = 0; j < chunk.length; j++) {
      if (typeof vals[j] !== 'string') continue;
      try {
        const vec = JSON.parse(vals[j]);
        if (Array.isArray(vec) && vec.length > 0) embeddingByCacheKey.set(chunk[j], vec);
      } catch { /* skip malformed */ }
    }
  }

  const labels = indexLabelsByNormalizedTitle(loadLabeledPairs());
  const clusterLabels = labels.filter((l) => l.expected === 'cluster').length;
  const separateLabels = labels.length - clusterLabels;

  // Score each tick at all thresholds.
  const perTick = [];
  let evaluable = 0;
  for (const tickRecs of ticks.values()) {
    const reps = tickRecs.filter((r) => r.isRep);
    if (reps.length === 0) { perTick.push(null); continue; }
    const embeddingByHash = new Map();
    for (const r of reps) {
      const vec = embeddingByCacheKey.get(r.embeddingCacheKey);
      if (Array.isArray(vec)) embeddingByHash.set(r.storyHash, vec);
    }
    if (embeddingByHash.size !== reps.length) { perTick.push(null); continue; }
    const tickRows = scoreOneTick({ reps, embeddingByHash, labels, thresholds: args.thresholds });
    if (tickRows) {
      perTick.push(tickRows);
      evaluable += 1;
    } else {
      perTick.push(null);
    }
  }

  const rows = aggregateByThreshold(perTick, args.thresholds);
  const ctx = {
    rule: args.rule,
    date: args.date,
    recordCount: records.length,
    tickCount: ticks.size,
    evaluableTicks: evaluable,
    labelCount: labels.length,
    clusterLabels,
    separateLabels,
  };

  if (args.json) {
    console.log(JSON.stringify({ ctx, rows }, null, 2));
  } else {
    console.log(renderMarkdownTable(rows, ctx));
  }
}

main().catch((err) => {
  console.error(`sweep-topic-thresholds: ${err?.stack ?? err?.message ?? String(err)}`);
  process.exit(1);
});
