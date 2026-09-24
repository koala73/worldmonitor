// Pure helpers behind scripts/eval-brief-model.mjs and its tests: the pass/fail checks
// run on each brief output, the tracked signals, and the per-surface summary of a run.
//
// CHECKS are binary and each maps to a failure a shipped brief actually had. They read
// the RAW model text, before the production validators repair or reject it, so a model
// that fabricates stays visible even when the validators save the brief. Two checks read
// what production delivered instead: `rejected` (the reader got the stub) and
// `delivered_status_qualifier` (an invented qualifier reached the reader anyway).
//
// SIGNALS are rough heuristics for failure classes seen in eval output but not yet
// confirmed by error analysis. They are tracked across runs, never gated: expect false
// positives, and read the flagged raw text before acting on a count.
import { createHash } from 'node:crypto';

import { validateNoHallucinatedFacts, validateNoHallucinatedStatusQualifiers } from '../../shared/brief-llm-core.js';
import { LEAD_STITCHING_STEM_RE } from './brief-llm.mjs';

export const SURFACES = ['digest', 'description', 'whyMatters'];

export const CHECKS = {
  // callLLM returned nothing: timeout, HTTP error, empty content or finish_reason=length.
  no_output: 'the transport returned no text',
  // The digest must be a JSON object with a string lead.
  invalid_json: 'the digest is not a JSON object with a string lead',
  // Sep 20: "former President Trump" for a sitting president.
  status_qualifier: 'the raw output adds a tenure qualifier (former, acting, late, ...) the stories do not carry',
  // Sep 20 and May 17: "This development comes as" stapling two stories together.
  stitch: 'the raw digest lead uses a stitching connective',
  // Production discarded the output and shipped the stub.
  rejected: 'production rejected the output',
  // The same qualifier check on what production delivered, after its repairs.
  delivered_status_qualifier: 'the delivered text still carries an invented tenure qualifier',
};

export const SIGNALS = {
  // May 19 "Lebanese President Michel Aoun", eval "UN rights chief Volker Türk": a title
  // and name written from the model's memory. Right today, wrong the day the office changes.
  title_name: 'a titled person whose name the stories do not contain',
  // "since February 2022": a number or date from memory.
  number: 'a number the stories do not contain',
  // "risks a broader regional war": an escalation the source does not claim.
  escalation: 'escalation language the stories do not use',
};

export const promptSha = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16);

// Prompts carry today's date; hash them with it masked so a run's hash only moves when
// the prompt text does.
export const maskDates = (text) => text.replace(/\b\d{4}-\d{2}-\d{2}\b/g, 'YYYY-MM-DD');

export function groundTexts(stories) {
  return stories.map((s) => [s.headline, s.description].filter(Boolean).join(' '));
}

export function parseRawDigest(text) {
  if (typeof text !== 'string') return null;
  const unfenced = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  for (const candidate of [unfenced, unfenced.match(/\{[\s\S]*\}/)?.[0]]) {
    if (!candidate) continue;
    try {
      const obj = JSON.parse(candidate);
      if (obj && typeof obj === 'object' && typeof obj.lead === 'string') return obj;
    } catch { /* try the next candidate */ }
  }
  return null;
}

// Every prose string the reader can see in a digest: lead, thread teasers, signals.
export function digestProse(obj) {
  const threads = Array.isArray(obj.threads) ? obj.threads.map((t) => t?.teaser).filter((t) => typeof t === 'string') : [];
  const signals = Array.isArray(obj.signals) ? obj.signals.filter((s) => typeof s === 'string') : [];
  return [obj.lead, ...threads, ...signals];
}

// The prose of whatever a generator returned: a digest object or a per-story string.
function proseOf(value) {
  if (typeof value === 'string') return [value];
  if (value && typeof value === 'object' && typeof value.lead === 'string') return digestProse(value);
  return [];
}

const hasStatusQualifier = (texts, grounds) =>
  texts.some((t) => !validateNoHallucinatedStatusQualifiers(t, grounds).ok);

const TITLED_NAME_RE =
  /\b(?:President|Vice President|Prime Minister|Premier|Chancellor|Minister|Secretary(?: of State)?|Senator|Governor|chief|Ambassador|envoy|Speaker|King|Queen|Pope|Supreme Leader|General|Admiral|Director)\s+(\p{Lu}[\p{L}’'-]+(?:\s+\p{Lu}[\p{L}’'-]+){0,2})/gu;
const ESCALATION_RE =
  /\b(?:regional war|wider war|broader (?:regional )?(?:war|conflict)|all-out war|world war|catastroph\w*|collaps\w*|ignit\w*|engulf\w*|unravel\w*|spiral\w*)/i;

const wordsOf = (text) => new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean));

export function signalsFor(texts, stories) {
  const grounds = groundTexts(stories);
  const groundJoined = grounds.join(' ');
  const groundWords = wordsOf(groundJoined);
  const joined = texts.join(' ');
  const signals = [];
  for (const m of joined.matchAll(TITLED_NAME_RE)) {
    const nameWords = m[1].replace(/[’']s$/, '').toLowerCase().split(/\s+/);
    if (nameWords.some((w) => !groundWords.has(w))) { signals.push('title_name'); break; }
  }
  if (texts.some((t) => !validateNoHallucinatedFacts(t, groundJoined).ok)) signals.push('number');
  if (ESCALATION_RE.test(joined) && !ESCALATION_RE.test(groundJoined)) signals.push('escalation');
  return signals;
}

// surface: 'digest' | 'description' | 'whyMatters'
// raw: the text callLLM returned (null when it returned nothing)
// output: what the production generator returned (null = the reader got the stub)
// stories: the digest's pool, or the one story a description/whyMatters was written for
// Returns { fails: CHECKS keys, signals: SIGNALS keys }.
export function checkSample({ surface, raw, output, stories }) {
  const fails = [];
  const grounds = groundTexts(stories);
  let rawProse = [];
  if (raw == null) fails.push('no_output');
  else if (surface === 'digest') {
    const obj = parseRawDigest(raw);
    if (!obj) fails.push('invalid_json');
    else {
      rawProse = digestProse(obj);
      if (hasStatusQualifier(rawProse, grounds)) fails.push('status_qualifier');
      if (LEAD_STITCHING_STEM_RE.test(obj.lead)) fails.push('stitch');
    }
  } else {
    rawProse = [raw];
    if (hasStatusQualifier(rawProse, grounds)) fails.push('status_qualifier');
  }
  if (output == null) fails.push('rejected');
  else if (hasStatusQualifier(proseOf(output), grounds)) fails.push('delivered_status_qualifier');
  return { fails, signals: rawProse.length ? signalsFor(rawProse, stories) : [] };
}

const quantile = (sorted, q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : null);

// samples: [{ surface, pool, fails, signals, ms, provider, costUsd }]
export function summarizeRun(samples) {
  const out = {};
  for (const surface of SURFACES) {
    const rows = samples.filter((s) => s.surface === surface);
    if (rows.length === 0) continue;
    const failCounts = Object.fromEntries(Object.keys(CHECKS).map((c) => [c, rows.filter((r) => r.fails.includes(c)).length]));
    const signalCounts = Object.fromEntries(Object.keys(SIGNALS).map((c) => [c, rows.filter((r) => r.signals?.includes(c)).length]));
    const ms = rows.map((r) => r.ms).filter((m) => typeof m === 'number').sort((a, b) => a - b);
    const providers = {};
    for (const r of rows) if (r.provider) providers[r.provider] = (providers[r.provider] ?? 0) + 1;
    out[surface] = {
      n: rows.length,
      delivered: rows.length - failCounts.rejected,
      // Output the model produced that production threw away: a content failure. The rest
      // of `rejected` is no_output, which is transport latency and comes in bursts.
      rejectedWithOutput: rows.filter((r) => r.fails.includes('rejected') && !r.fails.includes('no_output')).length,
      fails: failCounts,
      signals: signalCounts,
      p50Ms: quantile(ms, 0.5),
      p95Ms: quantile(ms, 0.95),
      maxMs: ms.length ? ms[ms.length - 1] : null,
      providers,
      costUsd: +rows.reduce((sum, r) => sum + (r.costUsd ?? 0), 0).toFixed(5),
    };
  }
  return out;
}
