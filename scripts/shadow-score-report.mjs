#!/usr/bin/env node
// Extract shadow:score-log (defaults to v2; override via SHADOW_SCORE_KEY) from
// Upstash and write a review bundle to ./shadow-score-report/. Parses both v2
// JSON members and legacy v1 string members.
// Usage: node scripts/shadow-score-report.mjs
// Env:   UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN (reads .env.local if present)
//        SHADOW_SCORE_KEY=shadow:score-log:v1 to read pre-PR #3069 data

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// v2 is the post-fix key (JSON members). v1 is the legacy key (compact strings).
// Override with SHADOW_SCORE_KEY=shadow:score-log:v1 to read pre-fix data.
const KEY = process.env.SHADOW_SCORE_KEY || 'shadow:score-log:v2';
const OUT = resolve(process.cwd(), 'shadow-score-report');
const GATE_MIN = 40;     // current IMPORTANCE_SCORE_MIN default
const HIGH = 65;         // current shouldNotify "high" sensitivity threshold
const CRITICAL = 85;     // current shouldNotify "critical" sensitivity threshold

function loadEnv() {
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) return;
  const envPath = resolve(process.cwd(), '.env.local');
  if (!existsSync(envPath)) return;
  // Only hydrate the two Upstash creds we actually need — don't bulk-import
  // every uppercase var from .env.local into this process.
  const NEEDED = new Set(['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN']);
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]+)"?\s*$/);
    if (m && NEEDED.has(m[1]) && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

async function redis(cmd) {
  const res = await fetch(`${process.env.UPSTASH_REDIS_REST_URL}/${cmd.join('/')}`, {
    headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` },
  });
  if (!res.ok) throw new Error(`${cmd[0]} ${res.status}: ${await res.text()}`);
  return (await res.json()).result;
}

function parseMember(m) {
  // v2 (JSON) format: {"ts":..., "importanceScore":..., "severity":..., "eventType":..., "title":..., ...}
  if (m.startsWith('{')) {
    try {
      const r = JSON.parse(m);
      return {
        ts: Number(r.ts),
        score: Number.isFinite(r.importanceScore) ? Number(r.importanceScore) : null,
        eventType: r.eventType ?? '',
        title: r.title ?? '',
        severity: r.severity ?? null,
        source: r.source ?? null,
        corroborationCount: r.corroborationCount ?? null,
        variant: r.variant ?? null,
        publishedAt: r.publishedAt ?? null,
        raw: m,
      };
    } catch {
      return { ts: NaN, score: null, eventType: '', title: '', raw: m };
    }
  }
  // v1 legacy format: "<ts>:score=<n>:<eventType>:<titlePrefix>"
  const ts = Number(m.split(':', 1)[0]);
  const s = m.match(/score=(\d+)/);
  const rest = m.slice(m.indexOf(':') + 1);
  const afterScore = rest.replace(/^score=\d+:/, '');
  const colon = afterScore.indexOf(':');
  const eventType = colon === -1 ? afterScore : afterScore.slice(0, colon);
  const title = colon === -1 ? '' : afterScore.slice(colon + 1);
  return { ts, score: s ? Number(s[1]) : null, eventType, title, raw: m };
}

function histogram(scores, bucket = 10) {
  const h = {};
  for (const s of scores) {
    const b = Math.floor(s / bucket) * bucket;
    h[b] = (h[b] ?? 0) + 1;
  }
  return h;
}

function pct(n, total) { return total ? ((n / total) * 100).toFixed(1) + '%' : '0%'; }

function summary(events) {
  const scores = events.map(e => e.score).filter(n => Number.isFinite(n));
  scores.sort((a, b) => a - b);
  const total = scores.length;
  const p = (q) => scores[Math.min(total - 1, Math.floor(q * total))];
  const mean = total ? (scores.reduce((a, b) => a + b, 0) / total).toFixed(1) : '0';

  const byDay = {};
  for (const e of events) {
    const d = new Date(e.ts).toISOString().slice(0, 10);
    byDay[d] = (byDay[d] ?? 0) + 1;
  }
  const byType = {};
  for (const e of events) byType[e.eventType] = (byType[e.eventType] ?? 0) + 1;

  const hist = histogram(scores, 10);

  const gates = {
    [`below_${GATE_MIN}_dropped`]: scores.filter(s => s < GATE_MIN).length,
    [`gte_${GATE_MIN}_passes_MIN`]: scores.filter(s => s >= GATE_MIN).length,
    [`gte_${HIGH}_fires_high`]: scores.filter(s => s >= HIGH).length,
    [`gte_${CRITICAL}_fires_critical`]: scores.filter(s => s >= CRITICAL).length,
  };

  // Dup detection: same score+title within 1s
  const seen = new Map();
  let dupes = 0;
  for (const e of events) {
    const k = `${e.score}|${e.title}`;
    const prev = seen.get(k);
    if (prev != null && Math.abs(e.ts - prev) < 1000) dupes++;
    seen.set(k, e.ts);
  }

  return { total, mean, p50: p(0.5), p75: p(0.75), p90: p(0.9), p95: p(0.95), p99: p(0.99), min: scores[0], max: scores[total - 1], hist, gates, byDay, byType, dupesLikely: dupes };
}

function renderReport(s, events) {
  const lines = [];
  const push = (...a) => lines.push(a.join(''));
  push('# shadow:score-log:v1 report');
  push(`generated: ${new Date().toISOString()}`);
  push(`key:       ${KEY}`);
  push(`window:    ~7d rolling (ZREMRANGEBYSCORE on each write)`);
  if (KEY.endsWith(':v1')) push('WARNING:   v1 contains pre-fix stale scores; use v2 for final threshold choice');
  push('');
  push('## Totals');
  push(`events:    ${s.total}`);
  push(`mean:      ${s.mean}`);
  push(`min/max:   ${s.min} / ${s.max}`);
  push(`p50/75/90/95/99: ${s.p50} / ${s.p75} / ${s.p90} / ${s.p95} / ${s.p99}`);
  push(`dup pairs (same score+title <1s apart): ${s.dupesLikely}  ${s.dupesLikely > s.total * 0.3 ? '⚠ likely double-log bug (notification-relay.cjs:684)' : ''}`);
  push('');
  push('## Score histogram (10-point buckets)');
  for (const k of Object.keys(s.hist).map(Number).sort((a, b) => a - b)) {
    const bar = '█'.repeat(Math.round((s.hist[k] / s.total) * 60));
    push(`${String(k).padStart(3)}-${String(k + 9).padStart(3)}: ${String(s.hist[k]).padStart(5)}  ${pct(s.hist[k], s.total).padStart(6)}  ${bar}`);
  }
  push('');
  push('## Gate simulation (what current thresholds would do)');
  for (const [k, v] of Object.entries(s.gates)) push(`${k.padEnd(30)} ${String(v).padStart(6)}  ${pct(v, s.total)}`);
  push('');
  push('## Per day');
  for (const d of Object.keys(s.byDay).sort()) push(`${d}  ${s.byDay[d]}`);
  push('');
  push('## Per event type');
  for (const t of Object.keys(s.byType).sort()) push(`${t.padEnd(20)} ${s.byType[t]}`);
  push('');
  push('## Recommended recalibration (data-driven)');
  push(`critical  (top ~1%):  >= ${s.p99}`);
  push(`high      (top ~10%): >= ${s.p90}`);
  push(`MIN       (top ~50%): >= ${s.p50}`);
  return lines.join('\n') + '\n';
}

function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

(async () => {
  loadEnv();
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    console.error('Missing UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN');
    process.exit(1);
  }
  console.log(`Fetching ${KEY} ...`);
  // Bounded fetch: cap at 20k members to stay under Upstash's 10MB REST
  // response cap even if the rolling 7-day prune falls behind. 20k × ~300B
  // JSON ≈ 6MB. If this limit is hit, the 7-day TTL prune is broken —
  // warn so the operator investigates instead of silently analyzing a
  // partial slice.
  const FETCH_CAP = 20000;
  const members = await redis(['zrange', KEY, '0', String(FETCH_CAP - 1)]);
  if (!Array.isArray(members)) { console.error('Unexpected response', members); process.exit(1); }
  if (members.length === FETCH_CAP) {
    console.warn(`  WARNING: fetched ${FETCH_CAP} members (cap reached).`);
    console.warn(`  Rolling 7-day TTL prune may be stalled; investigate ZCARD ${KEY}.`);
  }
  console.log(`  ${members.length} members`);

  const events = members.map(parseMember).filter(e => Number.isFinite(e.ts) && e.score != null);
  events.sort((a, b) => a.ts - b.ts);

  mkdirSync(OUT, { recursive: true });

  // 1. Human report
  const s = summary(events);
  writeFileSync(resolve(OUT, 'report.txt'), renderReport(s, events));

  // 2. Full CSV (everything)
  const csv = ['timestamp_ms,iso,score,eventType,title'];
  for (const e of events) csv.push([e.ts, new Date(e.ts).toISOString(), e.score, e.eventType, e.title].map(csvEscape).join(','));
  writeFileSync(resolve(OUT, 'events.csv'), csv.join('\n') + '\n');

  // 3. Top 100 scored (for eyeball sanity-check: do high scores look like real critical news?)
  const top = [...events].sort((a, b) => b.score - a.score).slice(0, 100);
  writeFileSync(resolve(OUT, 'top-100.txt'),
    top.map(e => `${String(e.score).padStart(3)}  ${new Date(e.ts).toISOString()}  ${e.title}`).join('\n') + '\n');

  // 4. Near-gate items (35-45): the band where the MIN=40 gate actually makes/breaks decisions
  const near = events.filter(e => e.score >= 35 && e.score <= 45).slice(-100);
  writeFileSync(resolve(OUT, 'near-gate-35-45.txt'),
    near.map(e => `${String(e.score).padStart(3)}  ${new Date(e.ts).toISOString()}  ${e.title}`).join('\n') + '\n');

  // 5. Raw JSON for programmatic re-analysis
  writeFileSync(resolve(OUT, 'events.json'), JSON.stringify(events, null, 2));

  console.log(`\nWrote to ${OUT}/`);
  for (const f of ['report.txt', 'events.csv', 'top-100.txt', 'near-gate-35-45.txt', 'events.json']) console.log(`  ${f}`);
  console.log('\n--- report.txt preview ---');
  console.log(renderReport(s, events).split('\n').slice(0, 40).join('\n'));
})().catch(err => { console.error(err); process.exit(1); });
