// The classifier's critical/high boundary on attacks on shipping and energy
// infrastructure (#10976). Realtime news alerts go out for `critical` only, so a
// vessel attack labelled `high` reaches nobody: the Reuters ADNOC wording on
// 2026-11-18 was one. These tests pin the captured runs to the prompt and model
// production sends, so a prompt or model change reds here until the set is
// re-captured, and they record how many judged-critical attacks each path keeps.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extractRelayOpenRouterModel,
  extractRelayPrompt,
  extractRpcOpenRouterModel,
  extractRpcPrompt,
  promptSha,
} from '../scripts/lib/classify-eval.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = 'tests/fixtures/classify-judged-shipping-energy.json';
const set = JSON.parse(readFileSync(resolve(root, FIXTURE), 'utf8'));
const relaySrc = readFileSync(resolve(root, 'scripts/ais-relay.cjs'), 'utf8');
const rpcSrc = readFileSync(resolve(root, 'server/worldmonitor/intelligence/v1/classify-event.ts'), 'utf8');
const LEVELS = ['critical', 'high', 'medium', 'low', 'info'];

function criticalBoundary(name) {
  const labels = set.runs[name].labels;
  const clearCritical = set.rows.map((r, i) => [r, labels[i]]).filter(([r]) => r.judge === 'critical' && !r.borderline);
  return {
    keptCritical: clearCritical.filter(([, l]) => l === 'critical').length,
    clearCritical: clearCritical.length,
    falseCritical: set.rows.filter((r, i) => r.judge !== 'critical' && labels[i] === 'critical').length,
  };
}

describe('shipping and energy attack label set', () => {
  it('is well formed', () => {
    assert.equal(new Set(set.rows.map((r) => r.title)).size, set.rows.length);
    for (const r of set.rows) assert.ok(LEVELS.includes(r.judge) && typeof r.borderline === 'boolean', r.title);
    for (const [name, run] of Object.entries(set.runs)) {
      assert.equal(run.labels.length, set.rows.length, name);
      run.labels.forEach((label, i) => assert.ok(LEVELS.includes(label), `${name}: no label for ${set.rows[i].title}`));
    }
  });

  it('its runs are the prompt and model production sends today', () => {
    // If this reds, re-capture: node scripts/eval-classify-labels.mjs --fixture
    // tests/fixtures/classify-judged-shipping-energy.json --path relay|rpc --capture <run> --force
    // Then review the changed labels against the judged rows, and update the
    // boundary counts and the Reuters expectation below for the changes you accept.
    for (const name of ['relay-after', 'relay-after-rerun']) {
      assert.equal(set.runs[name].promptSha, promptSha(extractRelayPrompt(relaySrc)), name);
      assert.equal(set.runs[name].model, extractRelayOpenRouterModel(relaySrc), name);
    }
    assert.equal(set.runs['rpc-after'].promptSha, promptSha(extractRpcPrompt(rpcSrc)));
    assert.equal(set.runs['rpc-after'].model, extractRpcOpenRouterModel(rpcSrc));
  });

  it('records the critical/high boundary per path', () => {
    assert.deepEqual(criticalBoundary('relay-after'), { keptCritical: 9, clearCritical: 13, falseCritical: 2 });
    assert.deepEqual(criticalBoundary('relay-after-rerun'), { keptCritical: 7, clearCritical: 13, falseCritical: 1 });
    assert.deepEqual(criticalBoundary('rpc-after'), { keptCritical: 13, clearCritical: 13, falseCritical: 4 });
  });

  it('records that the Reuters ADNOC wording is labelled high on the relay and critical on the RPC', () => {
    const i = set.rows.findIndex((r) => r.title.includes('one crew member missing after attack on its vessel in Hormuz'));
    assert.equal(set.rows[i].judge, 'critical');
    for (const name of ['relay-after', 'relay-after-rerun']) assert.equal(set.runs[name].labels[i], 'high', name);
    assert.equal(set.runs['rpc-after'].labels[i], 'critical');
  });
});
