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
import { singleLinkCluster } from './lib/brief-dedup-embed.mjs';
import { normalizeForEmbedding } from './lib/brief-embedding.mjs';

loadEnvFile(import.meta.url);

// ── CLI args ───────────────────────────────────────────────────────────

// Resolve floor + cap + topN from production env, falling back to
// documented defaults. CLI flags override env. The replay log's
// tickConfig does not currently capture these (see PR #3390 follow-up
// to add scoreFloor/topN/maxStoriesPerUser to the writer's record);
// until then, env is the most-faithful source.
const SCORE_FLOOR_DEFAULT = 63;     // matches production DIGEST_SCORE_MIN
const TOP_N_DEFAULT = 30;           // matches production DIGEST_MAX_ITEMS
// Default 12 — matches production MAX_STORIES_PER_USER. PR #3389 kept
// the historical default after sweep evidence showed cap=16 hurts
// visible_quality at threshold 0.45. Override locally with
// DIGEST_MAX_STORIES_PER_USER env var or `--cap N` flag.
const MAX_STORIES_DEFAULT = 12;

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseArgs(argv) {
  const out = {
    date: new Date().toISOString().slice(0, 10),
    rule: 'full:en:all',
    thresholds: [0.30, 0.32, 0.35, 0.38, 0.40, 0.42, 0.45],
    scoreFloor: envInt('DIGEST_SCORE_MIN', SCORE_FLOOR_DEFAULT),
    topN: envInt('DIGEST_MAX_ITEMS', TOP_N_DEFAULT),
    maxStoriesPerUser: envInt('DIGEST_MAX_STORIES_PER_USER', MAX_STORIES_DEFAULT),
    json: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--date') out.date = argv[++i];
    else if (a === '--rule') out.rule = argv[++i];
    else if (a === '--thresholds') {
      out.thresholds = argv[++i].split(',').map((x) => Number(x.trim())).filter(Number.isFinite);
    } else if (a === '--score-floor') out.scoreFloor = Number(argv[++i]);
    else if (a === '--top-n') out.topN = Number(argv[++i]);
    else if (a === '--max-stories' || a === '--cap') out.maxStoriesPerUser = Number(argv[++i]);
    else if (a === '--json') out.json = true;
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
const MIN_SURVIVING_REPS = 5;  // skip ticks with fewer hydrated reps

function scoreOneTick({ reps, embeddingByHash, labels, thresholds, scoreFloor, topN, maxStoriesPerUser, missingEmbedReporter }) {
  // Apply production-equivalent floor + slice so the sweep reflects
  // what topic-grouping actually sees in prod, not the 800-rep raw pool.
  const floored = reps.filter((r) => Number(r.currentScore ?? 0) >= scoreFloor);
  const slicedReplay = [...floored]
    .sort((a, b) => Number(b.currentScore ?? 0) - Number(a.currentScore ?? 0))
    .slice(0, topN);
  if (slicedReplay.length <= 1) {
    return thresholds.map((t) => ({ threshold: t, topic_count: slicedReplay.length, sizes: [], pair_results: [], pair_results_visible: [] }));
  }

  // Remap replay-record shape (storyHash, normalizedTitle, …) to the
  // shape brief-dedup expects (hash, title, currentScore). Filter out
  // reps whose embedding is missing from the cache (transient eviction
  // or a rep written before the cache was populated). Skip the tick
  // entirely if too few reps survive.
  const remapped = slicedReplay.map((r) => ({
    hash: r.storyHash,
    title: r.normalizedTitle,
    currentScore: r.currentScore,
  }));
  const survivors = remapped.filter((r) => Array.isArray(embeddingByHash.get(r.hash)));
  const dropped = remapped.length - survivors.length;
  if (dropped > 0 && missingEmbedReporter) missingEmbedReporter(dropped);
  if (survivors.length < MIN_SURVIVING_REPS) return null;
  const sliced = survivors;

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
    // singleLinkCluster IS the partition algorithm groupTopicsPostDedup
    // uses internally (scripts/lib/brief-dedup.mjs:336 — clusterFn
    // defaults to singleLinkCluster). No second pass needed; we get
    // the same partition production would compute, faithfully.

    // Reproduce groupTopicsPostDedup's ordering so we can answer the
    // cap-related question: which members survive the post-cluster
    // top-N truncation? Order = topics by (size DESC, max-score DESC),
    // members within a topic by (score DESC). Tiebreaks are
    // deterministic by input order — close enough for evaluation.
    const topicMaxScore = clusters.map((members) =>
      Math.max(...members.map((i) => Number(sliced[i].currentScore ?? 0))),
    );
    const topicOrder = [...clusters.keys()].sort((a, b) => {
      if (sizes[a] !== sizes[b]) return sizes[b] - sizes[a];
      return topicMaxScore[b] - topicMaxScore[a];
    });
    const orderedIdx = [];
    for (const tIdx of topicOrder) {
      const members = [...clusters[tIdx]].sort(
        (a, b) => Number(sliced[b].currentScore ?? 0) - Number(sliced[a].currentScore ?? 0),
      );
      orderedIdx.push(...members);
    }
    const visibleIdxSet = new Set(orderedIdx.slice(0, maxStoriesPerUser));
    // Title → sliced index, for visibility lookup
    const titleToIdx = new Map();
    for (let i = 0; i < sliced.length; i++) titleToIdx.set(sliced[i].title, i);

    const pair_results = [];
    const pair_results_visible = [];
    for (const lab of labels) {
      const tA = titleToTopic.get(lab.a);
      const tB = titleToTopic.get(lab.b);
      if (tA == null || tB == null) continue; // pair not present in this tick
      const clustered = tA === tB;
      pair_results.push({ expected: lab.expected, clustered });

      // Visible-window evaluation: did BOTH labeled stories survive
      // the post-cluster top-N truncation? This is what users actually
      // see. Drives the cap-bump validation question (PR #3389):
      // does bumping cap=12 → 16 cause more cluster-pairs to land
      // visibly adjacent?
      const iA = titleToIdx.get(lab.a);
      const iB = titleToIdx.get(lab.b);
      if (visibleIdxSet.has(iA) && visibleIdxSet.has(iB)) {
        pair_results_visible.push({ expected: lab.expected, clustered });
      }
    }

    out.push({
      threshold,
      topic_count: topicCount,
      sizes: [...sizes].sort((a, b) => b - a),
      pair_results,
      pair_results_visible,
      visible_count: Math.min(orderedIdx.length, maxStoriesPerUser),
    });
  }
  return out;
}


// ── Aggregation across ticks ────────────────────────────────────────────

function aggregateByThreshold(perTickRows, thresholds) {
  const summary = new Map();
  for (const t of thresholds) summary.set(t, {
    threshold: t,
    ticks: 0,
    avg_topic_count: 0,
    avg_max_topic_size: 0,
    avg_visible_count: 0,
    multi_member_topic_share: 0,
    pair_recall_cluster: 0,            // partition-only (whole tick)
    false_adjacency: 0,                 // partition-only (whole tick)
    pair_recall_visible: 0,             // both members visible AND clustered
    false_adjacency_visible: 0,         // both members visible AND clustered (separate-labeled)
    quality_score: 0,
    visible_quality_score: 0,
    samples: 0,
    visible_samples: 0,
  });
  for (const tickRows of perTickRows) {
    if (!tickRows) continue;
    for (const row of tickRows) {
      const s = summary.get(row.threshold);
      if (!s) continue;
      s.ticks += 1;
      s.avg_topic_count += row.topic_count;
      s.avg_max_topic_size += row.sizes[0] ?? 0;
      s.avg_visible_count += row.visible_count ?? 0;
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
      for (const p of (row.pair_results_visible ?? [])) {
        if (p.expected === 'cluster') {
          s.pair_recall_visible += p.clustered ? 1 : 0;
          s._cluster_total_visible = (s._cluster_total_visible ?? 0) + 1;
        } else {
          s.false_adjacency_visible += p.clustered ? 1 : 0;
          s._separate_total_visible = (s._separate_total_visible ?? 0) + 1;
        }
        s.visible_samples += 1;
      }
    }
  }
  for (const s of summary.values()) {
    if (s.ticks === 0) continue;
    s.avg_topic_count /= s.ticks;
    s.avg_max_topic_size /= s.ticks;
    s.avg_visible_count /= s.ticks;
    s.multi_member_topic_share /= s.ticks;
    s.pair_recall_cluster = (s._cluster_total ?? 0) > 0 ? s.pair_recall_cluster / s._cluster_total : 0;
    s.false_adjacency = (s._separate_total ?? 0) > 0 ? s.false_adjacency / s._separate_total : 0;
    s.pair_recall_visible = (s._cluster_total_visible ?? 0) > 0 ? s.pair_recall_visible / s._cluster_total_visible : 0;
    s.false_adjacency_visible = (s._separate_total_visible ?? 0) > 0 ? s.false_adjacency_visible / s._separate_total_visible : 0;
    // Composite: weight visible recall (what users actually see),
    // penalise visible false adjacency, small bonus for multi-member
    // share. The visible variant is the deployment metric — it answers
    // "does this config produce a better brief?" rather than "does it
    // produce a better partition?"
    s.quality_score = (
      s.pair_recall_cluster * 0.6
      + (1 - s.false_adjacency) * 0.3
      + s.multi_member_topic_share * 0.1
    );
    s.visible_quality_score = (
      s.pair_recall_visible * 0.6
      + (1 - s.false_adjacency_visible) * 0.3
      + s.multi_member_topic_share * 0.1
    );
    delete s._cluster_total;
    delete s._separate_total;
    delete s._cluster_total_visible;
    delete s._separate_total_visible;
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
  lines.push(`Production-equivalent slice: scoreFloor=${ctx.scoreFloor}, topN=${ctx.topN}, maxStoriesPerUser (cap)=${ctx.maxStoriesPerUser}`);
  if (ctx.missingEmbedDrops > 0) {
    lines.push(`Reps dropped due to missing cached embeddings: ${ctx.missingEmbedDrops} (across all ticks)`);
  }
  lines.push('');
  lines.push('Visible-window metrics measure what ends up in the user-visible top-N brief AFTER cap-truncation.');
  lines.push('Partition metrics measure cluster correctness ignoring the cap.');
  lines.push('');
  lines.push('| threshold | visible_quality | visible_recall | visible_false_adj | partition_quality | partition_recall | partition_false_adj | avg_topics | multi_share | visible_samples / partition_samples |');
  lines.push('|-----------|-----------------|----------------|-------------------|-------------------|------------------|---------------------|------------|-------------|-------------------------------------|');
  // Compute the GLOBAL best in a first pass so the ⭐ marker only
  // tags one row. The previous one-pass approach starred every row
  // that was the running best at the time it was rendered (Greptile
  // P1 on PR #3390).
  let best = null;
  for (const r of rows) {
    if (r.ticks === 0) continue;
    if (best == null || r.visible_quality_score > best.visible_quality_score) best = r;
  }
  for (const r of rows) {
    if (r.ticks === 0) continue;
    const star = (r === best) ? ' ⭐' : '';
    lines.push(
      `| ${r.threshold.toFixed(2)} `
      + `| ${r.visible_quality_score.toFixed(3)}${star} `
      + `| ${(r.pair_recall_visible * 100).toFixed(1)}% `
      + `| ${(r.false_adjacency_visible * 100).toFixed(1)}% `
      + `| ${r.quality_score.toFixed(3)} `
      + `| ${(r.pair_recall_cluster * 100).toFixed(1)}% `
      + `| ${(r.false_adjacency * 100).toFixed(1)}% `
      + `| ${r.avg_topic_count.toFixed(1)} `
      + `| ${(r.multi_member_topic_share * 100).toFixed(1)}% `
      + `| ${r.visible_samples} / ${r.samples} |`,
    );
  }
  if (best) {
    lines.push('');
    lines.push(`**Recommended threshold: ${best.threshold.toFixed(2)}** (visible_quality=${best.visible_quality_score.toFixed(3)}, visible_recall=${(best.pair_recall_visible*100).toFixed(1)}%, visible_false_adj=${(best.false_adjacency_visible*100).toFixed(1)}%)`);
    lines.push('');
    lines.push(`Apply via Railway env on the **scripts-cron-digest-notifications** service:`);
    lines.push(`  \`DIGEST_DEDUP_TOPIC_THRESHOLD=${best.threshold.toFixed(2)}\``);
    lines.push('');
    lines.push('To compare cap values, re-run with `--cap 12` and `--cap 16`. The `visible_*` columns will diverge if cap-truncation is materially affecting topic adjacency.');
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

  // Score each tick at all thresholds. Reps with missing embeddings
  // are filtered inside scoreOneTick (D fix); a tick is skipped only
  // if too few reps survive (< MIN_SURVIVING_REPS).
  const perTick = [];
  let evaluable = 0;
  let missingEmbedDrops = 0;
  const reportMissing = (n) => { missingEmbedDrops += n; };
  for (const tickRecs of ticks.values()) {
    const reps = tickRecs.filter((r) => r.isRep);
    if (reps.length === 0) { perTick.push(null); continue; }
    const embeddingByHash = new Map();
    for (const r of reps) {
      const vec = embeddingByCacheKey.get(r.embeddingCacheKey);
      if (Array.isArray(vec)) embeddingByHash.set(r.storyHash, vec);
    }
    const tickRows = scoreOneTick({
      reps,
      embeddingByHash,
      labels,
      thresholds: args.thresholds,
      scoreFloor: args.scoreFloor,
      topN: args.topN,
      maxStoriesPerUser: args.maxStoriesPerUser,
      missingEmbedReporter: reportMissing,
    });
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
    scoreFloor: args.scoreFloor,
    topN: args.topN,
    maxStoriesPerUser: args.maxStoriesPerUser,
    missingEmbedDrops,
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
