// Pure helpers behind scripts/eval-classify-labels.mjs and its tests: read the two
// headline-classification prompts and their OpenRouter model straight out of the
// source files (so the eval can never drift from what production sends), and score a
// set of labels against blind-judged levels.
import { createHash } from 'node:crypto';

export const ALERT_LEVELS = ['critical', 'high'];
export const isAlertLevel = (level) => ALERT_LEVELS.includes(level);

function mustMatch(src, re, what) {
  const m = src.match(re);
  if (!m) throw new Error(`classify-eval: could not find ${what}`);
  return m[1];
}

// A prompt is hashed and sent as source text, so it must BE the text production sends:
// an interpolated template would pin (and send) a literal `${...}`.
function staticTemplate(text, what) {
  if (text.includes('${')) throw new Error(`classify-eval: ${what} is interpolated; the eval can only read a static template literal`);
  return text;
}

// scripts/ais-relay.cjs — the batch prompt (50 titles per completion).
export function extractRelayPrompt(relaySrc) {
  return staticTemplate(mustMatch(relaySrc, /const CLASSIFY_SYSTEM_PROMPT = `([\s\S]*?)`;/, 'CLASSIFY_SYSTEM_PROMPT'), 'CLASSIFY_SYSTEM_PROMPT');
}

// Reads ONLY the `openrouter` entry, comments stripped. A model held in a constant, or
// missing, throws rather than falling through to a later provider's literal: this value
// is what `--capture` sends and records, so a wrong read would pin itself.
export function extractRelayOpenRouterModel(relaySrc) {
  const list = mustMatch(relaySrc, /const CLASSIFY_LLM_PROVIDERS = \[([\s\S]*?)\n\];/, 'CLASSIFY_LLM_PROVIDERS');
  const entries = list.split(/(?=\{\s*\n\s*name: ')/).filter((e) => /^\{\s*\n\s*name: 'openrouter',/.test(e));
  if (entries.length !== 1) throw new Error(`classify-eval: expected one openrouter classify provider, found ${entries.length}`);
  const code = entries[0].replace(/\/\/[^\n]*/g, '');
  return mustMatch(code, /\n\s*model: '([^']+)',/, "a quoted model on the relay's openrouter classify provider");
}

// server/worldmonitor/intelligence/v1/classify-event.ts — one title per completion.
export function extractRpcPrompt(rpcSrc) {
  return staticTemplate(mustMatch(rpcSrc, /const systemPrompt = `([\s\S]*?)`;/, 'classify-event systemPrompt'), 'classify-event systemPrompt');
}

export function extractRpcOpenRouterModel(rpcSrc) {
  return mustMatch(rpcSrc, /^const CLASSIFY_OPENROUTER_MODEL = '([^']+)';/m, 'CLASSIFY_OPENROUTER_MODEL');
}

// The block both prompts must carry verbatim, delimited by its first and last line.
export function extractHighBoundaryBlock(prompt) {
  return mustMatch(prompt, /(Do not under-rate "high"\.[\s\S]*?not for the event itself\.)/, 'the "high" boundary block');
}

export const promptSha = (prompt) => createHash('sha256').update(prompt).digest('hex').slice(0, 16);

// rows: [{ title, judge, borderline }]; labels: { [title]: level }. A title the model
// returned no valid label for is skipped by production, so nobody is alerted: a real
// alert among them is a MISS, and is also reported on its own as `unlabelledAlerts`.
// Exact-level accuracy is over labelled titles only.
export function scoreAlertLabels(rows, labels) {
  const scored = rows.filter((r) => typeof labels[r.title] === 'string');
  const truth = rows.filter((r) => isAlertLevel(r.judge));
  const flagged = scored.filter((r) => isAlertLevel(labels[r.title]));
  const caught = flagged.filter((r) => isAlertLevel(r.judge)).length;
  const exact = scored.filter((r) => labels[r.title] === r.judge).length;
  return {
    titles: scored.length,
    unlabelled: rows.length - scored.length,
    unlabelledAlerts: truth.filter((r) => typeof labels[r.title] !== 'string').length,
    alertLevel: truth.length,
    missed: truth.length - caught,
    falseAlerts: flagged.length - caught,
    recallPct: truth.length ? +(100 * caught / truth.length).toFixed(1) : null,
    precisionPct: flagged.length ? +(100 * caught / flagged.length).toFixed(1) : null,
    exactLevelPct: scored.length ? +(100 * exact / scored.length).toFixed(1) : null,
  };
}

// The critical/high boundary at production's small batch size (#10976). The relay asks
// only for cache misses, so most completions carry far fewer than 50 titles, and a prompt
// can hold at 50 and slip at 5. Each completion here is one judged boundary headline among
// four tuning headlines, at a random position, as a cache-miss batch is a boundary story
// among general news. The held-out set is never used: a gate is something prompts are tuned on.
export const BATCH_BOUNDARY_SOURCES = {
  boundary: ['tests/fixtures/classify-judged-statements.json', 'tests/fixtures/classify-judged-shipping-energy.json'],
  fill: 'tests/fixtures/classify-judged-headlines.json',
};

// readFixture(path) returns a parsed judged fixture. A title in two sources throws: its
// per-title counts would be ambiguous.
export function buildBatchBoundaryRows(readFixture) {
  const pick = (r, role) => ({ title: r.title, judge: r.judge, borderline: r.borderline === true, role });
  const boundary = BATCH_BOUNDARY_SOURCES.boundary.flatMap((p) => readFixture(p).rows.map((r) => pick(r, 'boundary')));
  const fill = readFixture(BATCH_BOUNDARY_SOURCES.fill).rows.map((r) => pick(r, 'fill'));
  const rows = [...boundary, ...fill];
  if (new Set(rows.map((r) => r.title)).size !== rows.length) throw new Error('classify-eval: a title appears in two batch-boundary sources');
  return { boundary, fill, rows };
}

export const batchBoundaryRowsSha = (rows) => createHash('sha256')
  .update(JSON.stringify(rows.map((r) => [r.title, r.judge, r.borderline, r.role]))).digest('hex').slice(0, 16);

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled(items, rand) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// One pass asks every boundary row once, each beside chunk - 1 fill rows no other batch in
// the pass gets, at a random position. Deterministic in (seed, pass).
export function planBatchBoundaryPass({ boundary, fill }, { seed, pass, chunk }) {
  if (boundary.length * (chunk - 1) > fill.length) throw new Error('classify-eval: not enough fill rows for one pass');
  const rand = mulberry32(Math.imul(seed, 0x9e3779b1) + pass);
  const fills = shuffled(fill, rand);
  return shuffled(boundary, rand).map((row, b) => {
    const batch = fills.slice(b * (chunk - 1), (b + 1) * (chunk - 1));
    batch.splice(Math.floor(rand() * chunk), 0, row);
    return batch;
  });
}

// The gate's count: `critical` on any row judged below critical, borderline rows included.
// A borderline high labelled critical still pages users on a story the judge called high.
export const isFalseCritical = (row, level) => level === 'critical' && row.judge !== 'critical';

const LEVEL_KEYS = ['critical', 'high', 'medium', 'low', 'info'];
const unlabelledOf = (c) => c.asked - LEVEL_KEYS.reduce((n, k) => n + (c[k] ?? 0), 0);

// Boundary rows that were not asked once per pass, or went unlabelled more than maxPerRow
// times. A skipped boundary row cannot be a false critical, so skips would lower the count
// for free; the capture writer and the gate both refuse a capture that lists any.
export function incompleteBoundaryRows(boundary, capture, { passes, maxPerRow }) {
  return boundary.flatMap((r) => {
    const c = capture.labels[r.title];
    if (c?.asked !== passes) return [`asked ${c?.asked ?? 0} of ${passes}: ${r.title}`];
    const n = unlabelledOf(c);
    return n > maxPerRow ? [`unlabelled ${n} of ${passes}: ${r.title}`] : [];
  });
}

// capture.labels: { [title]: { asked, critical?, high?, medium?, low?, info? } }, summed
// over every pass. A title asked but given no valid label is unlabelled: production skips it.
// falseCritical is the gate's count; the borderline split is reported beside it.
export function scoreBatchBoundary(rows, capture) {
  const s = { asked: 0, unlabelled: 0, falseCritical: 0, borderlineFalseCritical: 0, clearCriticalAsked: 0, clearCriticalKept: 0, falseCriticalTitles: [] };
  for (const r of rows) {
    const c = capture.labels[r.title];
    if (!c) continue;
    const critical = c.critical ?? 0;
    s.asked += c.asked;
    s.unlabelled += unlabelledOf(c);
    if (isFalseCritical(r, 'critical')) {
      s.falseCritical += critical;
      if (r.borderline) s.borderlineFalseCritical += critical;
      if (critical) s.falseCriticalTitles.push(`${critical}/${c.asked}${r.borderline ? ' (borderline)' : ''} ${r.title}`);
    } else if (!r.borderline) {
      s.clearCriticalAsked += c.asked;
      s.clearCriticalKept += critical;
    }
  }
  return s;
}
