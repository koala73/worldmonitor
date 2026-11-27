#!/usr/bin/env node
// Jev against the held-out judged set (#8478): the go/no-go for replacing the relay
// labeller. The arms, thresholds, runs and verdict are frozen in scripts/lib/jev-heldout.mjs.
//
//   node scripts/eval-jev-heldout.mjs                                    # score the captured runs, offline, free
//   node --env-file=.env.local scripts/eval-jev-heldout.mjs --run jev-1  # a paid run; jev-1 and jev-2 are the only ones
//   ... --fixture <judged set> --capture <capture file>                  # other paths
//
// A paid run asks Jev about every held-out Latin title through production's level
// request and transport, then the Noul request, and writes the raw answers to the
// capture. The first run records HEAD as the freeze commit; every run refuses
// uncommitted changes to the frozen files, and a later run refuses a HEAD that does not
// descend from the freeze commit. Scoring reads only a capture of the frozen question
// set, rule and fixture.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JEV_MODEL } from '../shared/jev-classify.js';
import {
  ARMS, FROZEN, JEV_RUNS, PRIMARY_ARM, RELAY_ARM, RELAY_RUNS, SLICES,
  askJev, fixtureSha, latinRows, readCapture, scoreArms, verdict,
} from './lib/jev-heldout.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONCURRENCY = 6;
const USD_PER_M_INPUT = 0.042;
const MAX_UNANSWERED_LEVEL = 0.05;
const FROZEN_FILES = ['scripts/lib/jev-heldout.mjs', 'scripts/eval-jev-heldout.mjs', 'tests/fixtures/classify-judged-headlines-heldout.json'];

const fail = (message) => { console.error(message); process.exit(2); };
const VALUE_FLAGS = ['fixture', 'capture', 'run'];
const argv = process.argv.slice(2);
const args = {};
for (let i = 0; i < argv.length; i++) {
  const name = argv[i].replace(/^--/, '');
  if (!argv[i].startsWith('--') || !VALUE_FLAGS.includes(name)) fail(`unknown argument ${argv[i]}`);
  if (name in args) fail(`--${name} given twice`);
  const value = argv[++i];
  if (value === undefined || value.startsWith('--')) fail(`--${name} needs a value`);
  args[name] = value;
}
const runName = args.run;
const apiKey = (process.env.TYPESAFE_API_KEY || '').trim();
if (runName && !JEV_RUNS.includes(runName)) fail(`--run must be one of ${JEV_RUNS.join(', ')}`);
if (runName && !apiKey) fail('--run needs TYPESAFE_API_KEY (try node --env-file=.env.local)');

// Test-only: JEV_HELDOUT_TEST_GIT_HEAD stands in for `git rev-parse HEAD` with the frozen
// files clean and only that commit as its own ancestor. Never set it for a real run.
const testHead = process.env.JEV_HELDOUT_TEST_GIT_HEAD;
const git = (...gitArgs) => execFileSync('git', gitArgs, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();
const gitHead = () => testHead ?? git('rev-parse', 'HEAD');
const dirtyFrozenFiles = () => (testHead ? '' : git('status', '--porcelain', '--', ...FROZEN_FILES));
const descendsFrom = (sha) => {
  if (testHead) return sha === testHead;
  try { git('merge-base', '--is-ancestor', sha, 'HEAD'); return true; } catch { return false; }
};

const FIXTURE = resolve(root, args.fixture ?? 'tests/fixtures/classify-judged-headlines-heldout.json');
const CAPTURE = resolve(root, args.capture ?? 'tests/fixtures/jev-heldout-runs.json');
if (!existsSync(FIXTURE)) fail(`--fixture not found: ${FIXTURE}`);
const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8'));
const titles = latinRows(fixture.rows).map((r) => r.title);
const load = () => {
  try { return existsSync(CAPTURE) ? readCapture(CAPTURE, fixture) : null; } catch (err) { return fail(err.message); }
};
const capture = load();

if (runName) {
  if (fixtureSha(fixture) !== FROZEN.fixtureSha) fail(`${FIXTURE} is not the frozen held-out set (${fixtureSha(fixture)}, frozen ${FROZEN.fixtureSha})`);
  if (capture?.runs[runName]) fail(`runs["${runName}"] exists in ${CAPTURE}`);
  const dirty = dirtyFrozenFiles();
  if (dirty) fail(`uncommitted changes to the frozen files; commit them first:\n${dirty}`);
  const head = gitHead();
  if (capture && !descendsFrom(capture.freezeSha)) fail(`HEAD ${head} does not descend from the freeze commit ${capture.freezeSha}`);

  const usage = { inputTokens: 0, requests: 0, authRejected: 0 };
  const answers = new Array(titles.length).fill(null);
  let next = 0;
  const startedAt = Date.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (next < titles.length) {
      const i = next++;
      answers[i] = await askJev(titles[i], { apiKey, usage });
    }
  }));
  const noLevel = answers.filter((a) => !a.level).length;
  const noNoul = answers.filter((a) => a.level && !a.noul).length;
  console.log(`${titles.length} titles, ${noLevel} without a level, ${noNoul} more without Nouls, ${usage.requests} requests, ${usage.inputTokens} input tokens ($${(usage.inputTokens * USD_PER_M_INPUT / 1e6).toFixed(4)}), ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  // An unanswered title is production behaviour and scores as the relay's label. A bad
  // key, or unanswered levels past what an outage-free run shows, means the run broke.
  if (usage.authRejected > 0) fail(`refusing to capture: ${usage.authRejected} requests got HTTP 401/403; check TYPESAFE_API_KEY`);
  if (noLevel > titles.length * MAX_UNANSWERED_LEVEL) fail(`refusing to capture: ${noLevel} of ${titles.length} titles have no level, over ${100 * MAX_UNANSWERED_LEVEL}%; re-run`);

  const latest = load();
  if (latest?.runs[runName]) fail(`runs["${runName}"] appeared in ${CAPTURE} during this run`);
  const out = latest ?? {
    note: 'Raw Jev answers on the held-out Latin titles of tests/fixtures/classify-judged-headlines-heldout.json, one entry per title in `titles` order; level or noul null = no valid answer for that request. Score with scripts/eval-jev-heldout.mjs.',
    freezeSha: head,
    questionSetSha: FROZEN.questionSetSha,
    ruleSha: FROZEN.ruleSha,
    fixtureSha: FROZEN.fixtureSha,
    model: JEV_MODEL,
    titles,
    runs: {},
  };
  out.runs[runName] = { capturedAt: new Date().toISOString(), head, answers, usage };
  writeFileSync(`${CAPTURE}.tmp`, `${JSON.stringify(out, null, 1)}\n`);
  renameSync(`${CAPTURE}.tmp`, CAPTURE);
  console.log(`wrote runs["${runName}"] to ${CAPTURE}`);
  process.exit(0);
}

const relayRuns = Object.fromEntries(RELAY_RUNS.map((name) => {
  const run = fixture.runs?.[name];
  if (!run) fail(`${FIXTURE} has no runs["${name}"]`);
  return [name, Object.fromEntries(fixture.rows.map((r, i) => [r.title, run.labels[i]]).filter(([, l]) => l))];
}));
const jevRuns = Object.fromEntries(Object.entries(capture?.runs ?? {}).map(([name, run]) => [name, Object.fromEntries(titles.map((t, i) => [t, run.answers[i]]))]));
const scores = scoreArms(fixture.rows, jevRuns, relayRuns);

const relayMeta = RELAY_RUNS.map((n) => `${n} ${fixture.runs[n].model} prompt ${fixture.runs[n].promptSha}`).join('; ');
console.log(`relay: ${relayMeta}`);
console.log(`jev: ${JEV_MODEL}, questions ${FROZEN.questionSetSha}, rule ${FROZEN.ruleSha}, fixture ${fixtureSha(fixture)}, freeze ${capture?.freezeSha ?? 'none'}`);
console.log(`Latin titles ${titles.length} of ${fixture.rows.length}; a Jev arm's unanswered titles take the paired relay run's label (${JEV_RUNS.map((j, i) => `${j}/${RELAY_RUNS[i]}`).join(', ')})\n`);
const cols = ['arm', 'run', 'slice', 'alerts', 'caught', 'missed', 'false', 'unlabelled', 'precision', 'recall', 'unanswered'];
const table = [cols];
for (const arm of [RELAY_ARM, ...ARMS.map((a) => a.name)]) {
  for (const [run, bySlice] of Object.entries(scores[arm])) {
    for (const slice of SLICES) {
      const s = bySlice[slice];
      table.push([arm === PRIMARY_ARM ? `${arm}*` : arm, run, slice, s.alertLevel, s.alertLevel - s.missed, s.missed, s.falseAlerts, s.unlabelled, s.precisionPct ?? '-', s.recallPct ?? '-', bySlice.unanswered ?? '-'].map(String));
    }
  }
}
const widths = cols.map((_, c) => Math.max(...table.map((r) => r[c].length)));
for (const r of table) console.log(r.map((v, c) => v.padEnd(widths[c])).join('  ').trimEnd());

if (!capture || Object.keys(capture.runs).length === 0) {
  console.log(`\nno Jev capture at ${CAPTURE}; no verdict`);
  process.exit(0);
}
const v = verdict(scores);
if (v.incomplete) {
  console.log(`\nVERDICT ${v.arm}: INCOMPLETE\n  ${v.reason}`);
  process.exit(0);
}
console.log(`\nVERDICT ${v.arm}: ${v.pass ? 'GO' : 'NO-GO'}`);
for (const slice of SLICES) console.log(`  ${slice}: ${v.slices[slice].pass ? 'pass' : v.slices[slice].reasons.join('; ')}`);
