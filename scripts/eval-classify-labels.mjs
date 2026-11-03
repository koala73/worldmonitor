#!/usr/bin/env node
// Re-measure headline threat classification against the blind-judged set in
// tests/fixtures/classify-judged-headlines.json. Read-only: no Redis, no cache writes.
//
//   node scripts/eval-classify-labels.mjs                      # score the captured runs, offline, free
//   node --env-file=.env.local scripts/eval-classify-labels.mjs --path relay          # live run, print scores
//   node --env-file=.env.local scripts/eval-classify-labels.mjs --path rpc --capture rpc-after
//   ... --model deepseek/deepseek-v4-flash                     # try another OpenRouter model
//   ... --capture <name> --note "why this run exists"          # --force to replace an existing run
//   ... --fixture tests/fixtures/classify-judged-headlines-heldout.json   # the HELD-OUT set: score it, never tune on it
//
// The prompt and the model are read out of the source files, so a live run measures
// what production sends. A live run over all 413 titles costs about $0.01 (relay,
// 50 titles per completion) or $0.03 (rpc, one title per completion).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extractRelayOpenRouterModel, extractRelayPrompt, extractRpcOpenRouterModel, extractRpcPrompt,
  promptSha, scoreAlertLabels,
} from './lib/classify-eval.mjs';
import { OPENROUTER_PROVIDER_ROUTING } from './_llm-model-timeouts.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_FIXTURE = 'tests/fixtures/classify-judged-headlines.json';
const LEVELS = ['critical', 'high', 'medium', 'low', 'info'];
const CATEGORIES = [
  'conflict', 'protest', 'disaster', 'diplomatic', 'economic', 'terrorism', 'cyber',
  'health', 'environmental', 'military', 'crime', 'infrastructure', 'tech', 'general',
];
const RELAY_CHUNK = 50;
const RPC_CONCURRENCY = 8;
// Production's per-attempt deadlines: the relay provider entry's `timeout`, and the Flash
// completion cap callLlm applies to the RPC. A slower answer is a fallback there, so it
// must not count as a label here.
const ATTEMPT_TIMEOUT_MS = { relay: 30_000, rpc: 15_000 };

const VALUE_FLAGS = ['path', 'capture', 'model', 'note', 'fixture'];
const argv = process.argv.slice(2);
// Every flag but --force takes a value. Checked up front: a live run costs money, and a
// flag read as another flag's value would otherwise burn one and write nothing (or junk).
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--force') continue;
  const name = argv[i].replace(/^--/, '');
  if (!argv[i].startsWith('--') || !VALUE_FLAGS.includes(name)) throw new Error(`unknown argument ${argv[i]}`);
  const value = argv[++i];
  if (value === undefined || value.startsWith('--')) throw new Error(`--${name} needs a value`);
}
const arg = (name) => { const i = argv.indexOf(`--${name}`); return i < 0 ? undefined : argv[i + 1]; };
const path = arg('path');
const capture = arg('capture');
const force = argv.includes('--force');
if (path && path !== 'relay' && path !== 'rpc') throw new Error('--path must be relay or rpc');
if (capture && !path) throw new Error('--capture needs --path');

// --fixture picks the judged set: the tuning set by default, or the held-out set
// (tests/fixtures/classify-judged-headlines-heldout.json), whose titles were judged after
// the prompt was fixed. Checked before any request, like the other arguments.
const FIXTURE = resolve(root, arg('fixture') ?? DEFAULT_FIXTURE);
if (!existsSync(FIXTURE)) throw new Error(`--fixture not found: ${FIXTURE}`);
const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8'));
// `relay-before` / `rpc-before` cannot be reproduced from this checkout (the prompt is read
// from source), so an existing run is never replaced by accident.
if (capture && fixture.runs[capture] && !force) throw new Error(`runs["${capture}"] exists; pass --force to replace it`);
const clearCut = fixture.rows.filter((r) => !r.borderline);
const labelsOf = (labels) => Object.fromEntries(fixture.rows.map((r, i) => [r.title, labels[i]]).filter(([, l]) => l));

function report(name, run) {
  const labels = labelsOf(run.labels);
  console.log(`\n${name}  (${run.path}, ${run.model}, prompt ${run.promptSha})${run.note ? `  ${run.note}` : ''}`);
  console.log('  all titles      ', JSON.stringify(scoreAlertLabels(fixture.rows, labels)));
  console.log('  clear-cut titles', JSON.stringify(scoreAlertLabels(clearCut, labels)));
}

if (!path) {
  for (const [name, run] of Object.entries(fixture.runs)) report(name, run);
  process.exit(0);
}

const apiKey = (process.env.OPENROUTER_API_KEY || '').trim();
if (!apiKey) throw new Error('OPENROUTER_API_KEY is not set (try node --env-file=.env.local)');
const relaySrc = readFileSync(resolve(root, 'scripts/ais-relay.cjs'), 'utf8');
const rpcSrc = readFileSync(resolve(root, 'server/worldmonitor/intelligence/v1/classify-event.ts'), 'utf8');
const prompt = path === 'relay' ? extractRelayPrompt(relaySrc) : extractRpcPrompt(rpcSrc);
const model = arg('model') || (path === 'relay' ? extractRelayOpenRouterModel(relaySrc) : extractRpcOpenRouterModel(rpcSrc));
const usage = { usd: 0, failedRequests: 0 };

async function complete(userContent, maxTokens) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://worldmonitor.app', 'X-Title': 'World Monitor', 'User-Agent': 'WorldMonitor-Eval/1.0' },
        body: JSON.stringify({
          model,
          messages: [{ role: 'system', content: prompt }, { role: 'user', content: userContent }],
          temperature: 0,
          max_tokens: maxTokens,
          reasoning: { enabled: false },
          provider: OPENROUTER_PROVIDER_ROUTING,
        }),
        signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS[path]),
      });
      if (resp.ok) {
        const json = await resp.json();
        usage.usd += json.usage?.cost ?? 0;
        return json.choices?.[0]?.message?.content ?? '';
      }
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
  }
  usage.failedRequests++;
  return '';
}

// Mirrors classifyFetchLlmSingle in scripts/ais-relay.cjs: same sanitising, same budget.
async function runRelay() {
  const out = new Array(fixture.rows.length).fill(null);
  for (let base = 0; base < fixture.rows.length; base += RELAY_CHUNK) {
    const chunk = fixture.rows.slice(base, base + RELAY_CHUNK);
    const lines = chunk.map((r, i) => `${i}|${r.title.replace(/[\n\r]/g, ' ').replace(/\|/g, '/').slice(0, 200).trim()}`);
    const content = await complete(lines.join('\n'), chunk.length * 40);
    let entries = [];
    try { entries = JSON.parse(content.match(/\[[\s\S]*\]/)?.[0] ?? '[]'); } catch { /* counted as unlabelled */ }
    // As seedClassifyForVariant: the first entry per index wins, and an entry needs a valid
    // level AND category to be cached at all.
    for (const e of entries) {
      if (!Number.isInteger(e?.i) || !chunk[e.i] || out[base + e.i] !== null) continue;
      if (LEVELS.includes(e.l) && CATEGORIES.includes(e.c)) out[base + e.i] = e.l;
    }
  }
  return out;
}

// Mirrors classifyEvent in classify-event.ts: one title, max_tokens 200, 500-char clip.
async function runRpc() {
  const out = new Array(fixture.rows.length).fill(null);
  let next = 0;
  await Promise.all(Array.from({ length: RPC_CONCURRENCY }, async () => {
    while (next < fixture.rows.length) {
      const i = next++;
      const content = await complete(fixture.rows[i].title.slice(0, 500), 200);
      try {
        const { level, category } = JSON.parse(content.match(/\{[\s\S]*\}/)?.[0] ?? '{}');
        if (LEVELS.includes(level) && CATEGORIES.includes(category)) out[i] = level;
      } catch { /* counted as unlabelled */ }
    }
  }));
  return out;
}

const startedAt = Date.now();
const labels = path === 'relay' ? await runRelay() : await runRpc();
const captured = `captured ${new Date().toISOString().slice(0, 10)}`;
const run = { path, model, promptSha: promptSha(prompt), note: arg('note') ? `${arg('note')} (${captured})` : captured, labels };
report(capture || 'live run', run);
console.log(`\n${((Date.now() - startedAt) / 1000).toFixed(1)}s, $${usage.usd.toFixed(4)}, ${usage.failedRequests} failed requests`);

if (capture) {
  // A few unlabelled titles are real behaviour (the model returned an invalid level or
  // category, which production skips) and are scored as `unlabelled`. Many means the run
  // itself broke: a failed chunk, a rate limit, a blocked provider.
  const unlabelled = labels.filter((l) => l === null).length;
  if (usage.failedRequests > 0 || unlabelled > labels.length * 0.05) {
    throw new Error(`refusing to capture: ${unlabelled} unlabelled titles, ${usage.failedRequests} failed requests; re-run`);
  }
  fixture.runs[capture] = run;
  writeFileSync(FIXTURE, `${JSON.stringify(fixture, null, 1)}\n`);
  console.log(`wrote runs["${capture}"] to ${FIXTURE}`);
}
