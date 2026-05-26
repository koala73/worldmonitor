#!/usr/bin/env node
// Human-vs-model score calibration tool for shadow:score-log:v1.
//
// Two modes:
//   1. SAMPLE (default): pulls a stratified sample across score bands and writes a
//      blank rating sheet you fill in by hand.
//        node scripts/shadow-score-rank.mjs sample [N_PER_BAND=20]
//      -> shadow-score-report/rating-sheet.tsv   (open in Sheets/Excel, fill "human")
//      -> shadow-score-report/rating-sheet.md    (markdown version for readers)
//
//   2. SCORE: reads the filled sheet back and produces a calibration report:
//      correlation, per-band mean human score, miscalibrated examples, and
//      recommended critical/high/MIN thresholds based on what you rated ≥X.
//        node scripts/shadow-score-rank.mjs score [path=shadow-score-report/rating-sheet.tsv]
//      -> shadow-score-report/calibration.txt
//
// Rating scale (put in the `human` column, blank = skip):
//   0  noise / clickbait / not newsworthy
//   1  low  — interesting but routine
//   2  medium — notable, worth a feed item
//   3  high — worth a push notification to engaged users
//   4  critical — must-send, wakes someone up

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const OUT = resolve(process.cwd(), 'shadow-score-report');
const SHEET_TSV = resolve(OUT, 'rating-sheet.tsv');
const SHEET_MD = resolve(OUT, 'rating-sheet.md');
const EVENTS_JSON = resolve(OUT, 'events.json');

// Escape markdown specials so a crafted RSS title can't render as formatting,
// embed `[label](javascript:...)` links, or break the table layout.
function escapeMd(s) {
  return String(s ?? '').replace(/[\\\[\]()<>|*_`~]/g, (ch) => '\\' + ch);
}

const BANDS = [
  { label: '00-19', lo: 0,  hi: 19 },
  { label: '20-29', lo: 20, hi: 29 },
  { label: '30-39', lo: 30, hi: 39 },
  { label: '40-49', lo: 40, hi: 49 },
  { label: '50-59', lo: 50, hi: 59 },
  { label: '60-69', lo: 60, hi: 69 },
  { label: '70-79', lo: 70, hi: 79 },
  { label: '80+',   lo: 80, hi: 999 },
];

function loadEvents() {
  if (!existsSync(EVENTS_JSON)) {
    console.error(`Missing ${EVENTS_JSON}. Run scripts/shadow-score-report.mjs first.`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(EVENTS_JSON, 'utf8'));
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function dedupe(events) {
  // Collapse legacy double-log (same score+title within 1s); keep earliest.
  // No-op on v2 data — the dup write was removed before v2 started.
  const seen = new Map();
  const out = [];
  for (const e of events.slice().sort((a, b) => a.ts - b.ts)) {
    const k = `${e.score}|${e.title}`;
    const prev = seen.get(k);
    if (prev != null && Math.abs(e.ts - prev) < 1000) continue;
    seen.set(k, e.ts);
    out.push(e);
  }
  return out;
}

function doSample(perBand) {
  const events = dedupe(loadEvents());
  mkdirSync(OUT, { recursive: true });

  const sampled = [];
  for (const b of BANDS) {
    const inBand = shuffle(events.filter(e => e.score >= b.lo && e.score <= b.hi));
    const pick = inBand.slice(0, perBand);
    for (const e of pick) sampled.push({ ...e, band: b.label });
  }

  // Randomize order so the rater doesn't see bands grouped (prevents anchoring).
  const shuffled = shuffle(sampled);

  // TSV sheet for Excel/Sheets
  const tsv = ['id\tscore\thuman\tnotes\tevent_type\ttitle\tband_hidden\tiso'];
  shuffled.forEach((e, i) => {
    tsv.push([
      `S${String(i + 1).padStart(3, '0')}`,
      e.score,
      '',                // human (fill 0-4)
      '',                // notes
      e.eventType,
      e.title.replace(/\t/g, ' ').replace(/\n/g, ' '),
      e.band,
      new Date(e.ts).toISOString(),
    ].join('\t'));
  });
  writeFileSync(SHEET_TSV, tsv.join('\n') + '\n');

  // Markdown version (blind to model score — easier to rate without anchoring)
  const md = [
    '# Rating sheet — blind mode',
    '',
    'Rate each headline 0–4 (write in your notes app, then transfer to rating-sheet.tsv):',
    '',
    '- **0** noise / clickbait / not newsworthy',
    '- **1** low — interesting but routine',
    '- **2** medium — notable, worth a feed item',
    '- **3** high — worth a push notification to engaged users',
    '- **4** critical — must-send, wakes someone up',
    '',
    'Model scores are hidden below; see TSV for full data.',
    '',
    '| id | title | your rating (0–4) |',
    '|----|-------|--------------------|',
    ...shuffled.map((e, i) => `| S${String(i + 1).padStart(3, '0')} | ${escapeMd(e.title)} | |`),
  ];
  writeFileSync(SHEET_MD, md.join('\n') + '\n');

  console.log(`Sampled ${shuffled.length} items (${perBand} per band × ${BANDS.length} bands).`);
  console.log(`\nOpen one of:`);
  console.log(`  ${SHEET_TSV}  (fill the "human" column with 0-4)`);
  console.log(`  ${SHEET_MD}   (blind mode, fill ratings elsewhere)`);
  console.log(`\nWhen done:  node scripts/shadow-score-rank.mjs score`);
}

function parseTsv(path) {
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
  const header = lines.shift().split('\t');
  const idx = (k) => header.indexOf(k);
  return lines.map(l => {
    const c = l.split('\t');
    return {
      id: c[idx('id')],
      score: Number(c[idx('score')]),
      human: c[idx('human')] === '' ? null : Number(c[idx('human')]),
      notes: c[idx('notes')] ?? '',
      eventType: c[idx('event_type')] ?? '',
      title: c[idx('title')] ?? '',
      band: c[idx('band_hidden')] ?? '',
    };
  });
}

function pearson(xs, ys) {
  const n = xs.length;
  if (n < 2) return NaN;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    num += dx * dy; dx2 += dx * dx; dy2 += dy * dy;
  }
  return num / Math.sqrt(dx2 * dy2);
}

function spearman(xs, ys) {
  const rank = (arr) => {
    const sorted = arr.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
    const r = new Array(arr.length);
    for (let i = 0; i < sorted.length;) {
      let j = i;
      while (j + 1 < sorted.length && sorted[j + 1].v === sorted[i].v) j++;
      const avg = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) r[sorted[k].i] = avg;
      i = j + 1;
    }
    return r;
  };
  return pearson(rank(xs), rank(ys));
}

function doScore(path) {
  const rows = parseTsv(path).filter(r => r.human != null && Number.isFinite(r.human) && Number.isFinite(r.score));
  if (rows.length < 10) {
    console.error(`Only ${rows.length} rated rows — rate more before scoring.`);
    process.exit(1);
  }

  const modelScores = rows.map(r => r.score);
  const human = rows.map(r => r.human);

  const lines = [];
  const push = (...a) => lines.push(a.join(''));

  push('# Calibration report: model importanceScore vs human rating');
  push(`generated:   ${new Date().toISOString()}`);
  push(`rated items: ${rows.length}`);
  push('');
  push('## Correlation');
  push(`Pearson (0 = unrelated, 1 = perfect): ${pearson(modelScores, human).toFixed(3)}`);
  push(`Spearman (rank order):                ${spearman(modelScores, human).toFixed(3)}`);
  push('');
  push('## Model-score band vs human rating');
  push('band    n   mean_human   stdev   human_dist(0/1/2/3/4)');
  for (const b of BANDS) {
    const inBand = rows.filter(r => r.score >= b.lo && r.score <= b.hi);
    if (!inBand.length) continue;
    const h = inBand.map(r => r.human);
    const mean = h.reduce((a, c) => a + c, 0) / h.length;
    const sd = Math.sqrt(h.reduce((a, c) => a + (c - mean) ** 2, 0) / h.length);
    const dist = [0, 1, 2, 3, 4].map(v => h.filter(x => x === v).length).join('/');
    push(`${b.label.padEnd(6)} ${String(inBand.length).padStart(3)}   ${mean.toFixed(2).padStart(5)}       ${sd.toFixed(2).padStart(5)}   ${dist}`);
  }
  push('');
  push('## Miscalibrated items (|band_mean − human| ≥ 2)');
  push('These are where the model and you disagree most. Use them to diagnose the formula.');
  push('');
  for (const b of BANDS) {
    const inBand = rows.filter(r => r.score >= b.lo && r.score <= b.hi);
    if (!inBand.length) continue;
    const mean = inBand.reduce((a, r) => a + r.human, 0) / inBand.length;
    const expected = Math.round(mean);
    const bad = inBand.filter(r => Math.abs(r.human - expected) >= 2)
      .sort((a, c) => Math.abs(c.human - expected) - Math.abs(a.human - expected));
    for (const r of bad.slice(0, 10)) push(`  [${b.label}] model=${r.score} human=${r.human}  ${r.title}${r.notes ? `  // ${r.notes}` : ''}`);
  }
  push('');
  push('## Recommended thresholds (from your ratings)');
  push('Interpretation: for each human tier, the minimum model score that captures ≥80% of items you rated at that tier or higher.');
  const cutoff = (humanMin) => {
    const kept = rows.filter(r => r.human >= humanMin);
    if (!kept.length) return null;
    const scores = kept.map(r => r.score).sort((a, b) => a - b);
    // 80% capture => 20th percentile of that human tier's model scores
    return scores[Math.floor(scores.length * 0.2)];
  };
  push(`MIN       (human ≥ 2, medium+):    ${cutoff(2) ?? 'n/a'}`);
  push(`high      (human ≥ 3, high+):      ${cutoff(3) ?? 'n/a'}`);
  push(`critical  (human = 4, critical):   ${cutoff(4) ?? 'n/a'}`);
  push('');
  push('## False-positive / false-negative at current thresholds');
  const tp = (modelCut, humanCut) => rows.filter(r => r.score >= modelCut && r.human >= humanCut).length;
  const fp = (modelCut, humanCut) => rows.filter(r => r.score >= modelCut && r.human <  humanCut).length;
  const fn = (modelCut, humanCut) => rows.filter(r => r.score <  modelCut && r.human >= humanCut).length;
  for (const [name, mc, hc] of [['MIN=40/med+', 40, 2], ['high=65/high+', 65, 3], ['critical=85/crit', 85, 4]]) {
    push(`${name.padEnd(18)} TP=${tp(mc, hc)}  FP=${fp(mc, hc)}  FN=${fn(mc, hc)}`);
  }

  writeFileSync(resolve(OUT, 'calibration.txt'), lines.join('\n') + '\n');
  console.log(`Wrote ${resolve(OUT, 'calibration.txt')}`);
  console.log('\n--- preview ---');
  console.log(lines.slice(0, 30).join('\n'));
}

const [, , cmd = 'sample', arg] = process.argv;
if (cmd === 'sample') doSample(Number(arg) || 20);
else if (cmd === 'score') doScore(arg ? resolve(arg) : SHEET_TSV);
else { console.error('Usage: shadow-score-rank.mjs [sample N | score path]'); process.exit(1); }
