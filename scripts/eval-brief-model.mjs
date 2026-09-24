#!/usr/bin/env node
// Measure the email brief's prose model on the story pools in
// tests/fixtures/brief-model-eval.json. Each pool is a brief that shipped a known failure.
//
//   node scripts/eval-brief-model.mjs                                   # report captured runs, offline, free
//   node --env-file=.env.local scripts/eval-brief-model.mjs --live      # the model production ships
//   ... --live --model deepseek/deepseek-v4-flash                       # any OpenRouter model
//   ... --live --capture <name> --note "why this run exists"            # --force to replace a run
//   ... --live --digests 12 --stories 2                                 # samples per pool / per story
//
// A live run calls the production generators (generateDigestProse, generateStoryDescription,
// and the generateWhyMatters fallback) with their real prompts, parsers, validators and
// deadlines, through the real scripts/lib/llm-chain.cjs transport. Only the cache is
// stubbed. The raw text of every call is scored pass/fail per check in
// scripts/lib/brief-model-eval.mjs, and kept in the captured run for error analysis.
// A default run (12 digests per pool, 2 samples per story) costs cents.
import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = resolve(root, 'tests/fixtures/brief-model-eval.json');
const CONCURRENCY = 4;

const VALUE_FLAGS = ['model', 'capture', 'note', 'digests', 'stories'];
const BOOL_FLAGS = ['live', 'force'];
const argv = process.argv.slice(2);
// Checked before any request: a flag read as another flag's value would burn a paid run.
for (let i = 0; i < argv.length; i++) {
  const name = argv[i].replace(/^--/, '');
  if (!argv[i].startsWith('--') || ![...VALUE_FLAGS, ...BOOL_FLAGS].includes(name)) throw new Error(`unknown argument ${argv[i]}`);
  if (BOOL_FLAGS.includes(name)) continue;
  const value = argv[++i];
  if (value === undefined || value.startsWith('--')) throw new Error(`--${name} needs a value`);
}
const arg = (name) => { const i = argv.indexOf(`--${name}`); return i < 0 ? undefined : argv[i + 1]; };
const live = argv.includes('--live');
const capture = arg('capture');
const positiveInt = (name, fallback) => {
  const raw = arg(name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--${name} must be a positive integer`);
  return n;
};
const digestsPerPool = positiveInt('digests', 12);
const samplesPerStory = positiveInt('stories', 2);
if (!live && (capture || arg('model') || arg('digests') || arg('stories'))) throw new Error('--model, --capture, --digests and --stories need --live');

const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8'));
if (capture && fixture.runs[capture] && !argv.includes('--force')) throw new Error(`runs["${capture}"] exists; pass --force to replace it`);

function printRun(name, run, CHECKS, SIGNALS) {
  console.log(`\n${name}  (${run.model}, prompts ${run.promptSha})${run.note ? `  ${run.note}` : ''}`);
  for (const [surface, s] of Object.entries(run.summary)) {
    const fails = Object.entries(s.fails).filter(([, n]) => n > 0).map(([c, n]) => `${c} ${n}`).join(', ') || 'none';
    const providers = Object.entries(s.providers).map(([p, n]) => `${p} ${n}`).join(', ') || 'n/a';
    const signals = Object.entries(s.signals ?? {}).filter(([, n]) => n > 0).map(([c, n]) => `${c} ${n}`).join(', ') || 'none';
    console.log(`  ${surface.padEnd(11)} delivered ${s.delivered}/${s.n} (content rejects ${s.rejectedWithOutput})  fails: ${fails}  signals: ${signals}  p50 ${s.p50Ms}ms p95 ${s.p95Ms}ms max ${s.maxMs}ms  $${s.costUsd}  served by ${providers}`);
  }
  if (CHECKS) console.log(`  checks: ${Object.entries(CHECKS).map(([c, d]) => `${c} = ${d}`).join('; ')}`);
  if (SIGNALS) console.log(`  signals (tracked, not gated): ${Object.entries(SIGNALS).map(([c, d]) => `${c} = ${d}`).join('; ')}`);
}

if (!live) {
  const { CHECKS, SIGNALS } = await import('./lib/brief-model-eval.mjs');
  const runs = Object.entries(fixture.runs);
  if (runs.length === 0) console.log('no captured runs; pass --live to measure');
  runs.forEach(([name, run], i) => (i === runs.length - 1 ? printRun(name, run, CHECKS, SIGNALS) : printRun(name, run)));
  process.exit(0);
}

if (!(process.env.OPENROUTER_API_KEY || '').trim()) throw new Error('OPENROUTER_API_KEY is not set (try node --env-file=.env.local)');
// An eval must not write llm_call rows into production telemetry.
delete process.env.USAGE_TELEMETRY;

// The brief reads its model once, at import. Read the shipped default out of source so
// a run without --model measures exactly what production sends.
const briefSrc = readFileSync(resolve(root, 'scripts/lib/brief-llm.mjs'), 'utf8');
const shippedModel = briefSrc.match(/^const BRIEF_LLM_OPENROUTER_MODEL = process\.env\.BRIEF_LLM_OPENROUTER_MODEL \|\| '([^']+)';/m)?.[1];
if (!shippedModel) throw new Error('could not read the default BRIEF_LLM_OPENROUTER_MODEL from scripts/lib/brief-llm.mjs');
const model = arg('model') ?? shippedModel;
process.env.BRIEF_LLM_OPENROUTER_MODEL = model;

// Tag every OpenRouter request with the sample that made it, so the serving provider,
// finish reason, latency and cost land on the right row under concurrency.
const sampleContext = new AsyncLocalStorage();
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const sample = sampleContext.getStore();
  if (!sample || !String(url).includes('openrouter.ai')) return realFetch(url, init);
  const t0 = Date.now();
  try {
    const resp = await realFetch(url, init);
    sample.status = resp.status;
    // Time the whole body, not the headers: OpenRouter can send 200 headers early and
    // the transport's deadline still fires while the body is in flight.
    const body = await resp.clone().text().catch((err) => {
      sample.status = err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'timeout' : 'body_error';
      return null;
    });
    sample.ms = Date.now() - t0;
    if (resp.ok && body !== null) {
      let json = null;
      try { json = JSON.parse(body); } catch { sample.status = 'invalid_body'; }
      sample.provider = json?.provider ?? null;
      sample.finishReason = json?.choices?.[0]?.finish_reason ?? null;
      sample.costUsd = json?.usage?.cost ?? 0;
    }
    return resp;
  } catch (err) {
    sample.ms = Date.now() - t0;
    sample.status = err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'timeout' : 'fetch_error';
    throw err;
  }
};

const require = createRequire(import.meta.url);
const { callLLM } = require('./lib/llm-chain.cjs');
const brief = await import('./lib/brief-llm.mjs');
const { checkSample, maskDates, promptSha, summarizeRun, CHECKS, SIGNALS } = await import('./lib/brief-model-eval.mjs');

const canary = fixture.pools[Object.keys(fixture.pools)[0]].stories;
const prompts = [
  brief.buildDigestPrompt(canary, 'high', { greeting: 'Good morning', todayIso: '2000-01-01' }),
  brief.buildStoryDescriptionPrompt(canary[0]),
  brief.buildWhyMattersPrompt(canary[0]),
];
const runPromptSha = promptSha(maskDates(JSON.stringify(prompts)));

const noCache = { cacheGet: async () => null, cacheSet: async () => {} };

// One job per sample. The digest runs the personalised email path (greeting, no profile),
// the shape that shipped the Sep 20 lead.
const jobs = [];
for (const [pool, { date, stories }] of Object.entries(fixture.pools)) {
  for (let i = 0; i < digestsPerPool; i++) {
    jobs.push({ surface: 'digest', pool, stories, run: (deps) => brief.generateDigestProse('brief-model-eval', stories, 'high', deps, { greeting: 'Good morning', profile: null, todayIso: date }) });
  }
  for (const story of stories) {
    for (let i = 0; i < samplesPerStory; i++) {
      jobs.push({ surface: 'description', pool, story: story.hash, stories: [story], run: (deps) => brief.generateStoryDescription(story, deps) });
      jobs.push({ surface: 'whyMatters', pool, story: story.hash, stories: [story], run: (deps) => brief.generateWhyMatters(story, deps) });
    }
  }
}

const samples = [];
const startedAt = Date.now();
let next = 0;
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (next < jobs.length) {
    const index = next++;
    const job = jobs[index];
    const sample = { index, surface: job.surface, pool: job.pool, ...(job.story ? { story: job.story } : {}) };
    let raw = null;
    const deps = {
      ...noCache,
      callLLM: async (system, user, opts) => {
        raw = await callLLM(system, user, opts);
        return raw;
      },
    };
    const output = await sampleContext.run(sample, () => job.run(deps).catch(() => null));
    Object.assign(sample, checkSample({ surface: job.surface, raw, output, stories: job.stories }));
    sample.raw = raw;
    sample.output = output ?? null;
    samples.push(sample);
    process.stdout.write('.');
  }
}));

// Job order, so a re-capture diffs cleanly.
samples.sort((a, b) => a.index - b.index);
for (const s of samples) delete s.index;

const captured = `captured ${new Date().toISOString().slice(0, 10)}`;
const run = {
  model,
  promptSha: runPromptSha,
  note: arg('note') ? `${arg('note')} (${captured})` : captured,
  digestsPerPool,
  samplesPerStory,
  summary: summarizeRun(samples),
  samples,
};
console.log('');
printRun(capture || 'live run', run, CHECKS, SIGNALS);
const cost = samples.reduce((s, r) => s + (r.costUsd ?? 0), 0);
console.log(`\n${((Date.now() - startedAt) / 1000).toFixed(1)}s, $${cost.toFixed(4)}, ${samples.length} calls`);

if (capture) {
  // A few no_output rows are real behaviour (production would ship the stub). Most rows
  // failing means the run broke: a bad key, a rate limit, a blocked model.
  const dead = samples.filter((s) => s.fails.includes('no_output') && s.status !== 'timeout').length;
  if (dead > samples.length * 0.2) throw new Error(`refusing to capture: ${dead}/${samples.length} calls returned no output without timing out; re-run`);
  if (!existsSync(FIXTURE)) throw new Error(`fixture vanished: ${FIXTURE}`);
  fixture.runs[capture] = run;
  writeFileSync(FIXTURE, `${JSON.stringify(fixture, null, 1)}\n`);
  console.log(`wrote runs["${capture}"] to ${FIXTURE}`);
}
