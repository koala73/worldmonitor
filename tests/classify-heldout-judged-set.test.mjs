// The held-out judged set for headline classification.
//
// tests/fixtures/classify-judged-headlines.json is a TUNING set: the #8341 prompt block
// was written after reading its misses. This file's 222 headlines were judged after the
// model and prompt were fixed, so they are the out-of-sample check. These tests keep it
// honest: disjoint from the tuning set, pinned to the prompt production sends, and
// scoreable offline. They do not assert a score is "good"; the numbers are the record.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extractRelayOpenRouterModel,
  extractRelayPrompt,
  extractRpcOpenRouterModel,
  extractRpcPrompt,
  isAlertLevel,
  promptSha,
  scoreAlertLabels,
} from '../scripts/lib/classify-eval.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HELDOUT = 'tests/fixtures/classify-judged-headlines-heldout.json';
const load = (p) => JSON.parse(readFileSync(resolve(root, p), 'utf8'));
const heldout = load(HELDOUT);
const tuning = load('tests/fixtures/classify-judged-headlines.json');
const relaySrc = readFileSync(resolve(root, 'scripts/ais-relay.cjs'), 'utf8');
const rpcSrc = readFileSync(resolve(root, 'server/worldmonitor/intelligence/v1/classify-event.ts'), 'utf8');
const LEVELS = ['critical', 'high', 'medium', 'low', 'info'];

const score = (name) => {
  const run = heldout.runs[name];
  return scoreAlertLabels(heldout.rows, Object.fromEntries(heldout.rows.map((r, i) => [r.title, run.labels[i]]).filter(([, l]) => l)));
};

describe('held-out judged set', () => {
  it('shares no headline with the tuning set, and repeats none', () => {
    const tuned = new Set(tuning.rows.map((r) => r.title));
    assert.deepEqual(heldout.rows.filter((r) => tuned.has(r.title)).map((r) => r.title), []);
    assert.equal(new Set(heldout.rows.map((r) => r.title)).size, heldout.rows.length);
  });

  it('is well formed: a valid judge level per row, one label slot per row per run', () => {
    assert.ok(heldout.rows.length >= 200);
    for (const r of heldout.rows) {
      assert.ok(LEVELS.includes(r.judge), r.title);
      assert.equal(typeof r.borderline, 'boolean');
    }
    for (const [name, run] of Object.entries(heldout.runs)) {
      assert.equal(run.labels.length, heldout.rows.length, name);
      for (const l of run.labels) assert.ok(l === null || LEVELS.includes(l), `${name}: ${l}`);
    }
  });

  it('its "after" runs are the model and prompt production sends today', () => {
    // If this reds, the prompt or model changed: re-capture the held-out runs too
    // (`--fixture ${HELDOUT} --path relay|rpc --capture <name> --force`), or the
    // out-of-sample numbers describe a classifier that no longer ships.
    for (const name of ['relay-after', 'relay-after-rerun']) {
      assert.equal(heldout.runs[name].promptSha, promptSha(extractRelayPrompt(relaySrc)), name);
      assert.equal(heldout.runs[name].model, extractRelayOpenRouterModel(relaySrc), name);
    }
    assert.equal(heldout.runs['rpc-after'].promptSha, promptSha(extractRpcPrompt(rpcSrc)));
    assert.equal(heldout.runs['rpc-after'].model, extractRpcOpenRouterModel(rpcSrc));
  });

  it('records what #8341 bought and what it cost, out of sample', () => {
    const alertLevel = heldout.rows.filter((r) => isAlertLevel(r.judge)).length;
    assert.equal(alertLevel, 41);
    const pick = (s) => ({ missed: s.missed, falseAlerts: s.falseAlerts });
    assert.deepEqual(pick(score('relay-before')), { missed: 2, falseAlerts: 20 });
    assert.deepEqual(pick(score('relay-after')), { missed: 4, falseAlerts: 6 });
    assert.deepEqual(pick(score('relay-after-rerun')), { missed: 5, falseAlerts: 6 });
    assert.deepEqual(pick(score('rpc-before')), { missed: 0, falseAlerts: 58 });
    assert.deepEqual(pick(score('rpc-after')), { missed: 3, falseAlerts: 12 });
    // The old relay model returned no valid label for 11 titles; production skips those.
    assert.equal(score('relay-before').unlabelled, 11);
    assert.equal(score('relay-after').unlabelled, 0);
  });
});

describe('eval-classify-labels --fixture', () => {
  const run = (...args) => spawnSync(process.execPath, ['scripts/eval-classify-labels.mjs', ...args], {
    cwd: root, encoding: 'utf8', env: { ...process.env, OPENROUTER_API_KEY: '' },
  });

  it('scores the held-out fixture offline, with no API key', () => {
    const r = run('--fixture', HELDOUT);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /relay-after-rerun/);
    assert.match(r.stdout, /"falseAlerts":6/);
    assert.doesNotMatch(r.stdout, /relay-prompt-only/, 'must not fall back to the tuning fixture');
  });

  it('refuses a fixture path that does not exist, before any request', () => {
    const r = run('--fixture', 'tests/fixtures/no-such-file.json');
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /no-such-file\.json/);
  });
});
