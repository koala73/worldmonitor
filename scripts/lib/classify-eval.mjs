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
