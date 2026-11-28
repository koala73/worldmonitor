// A statement about a critical event is not the event. On 2026-11-21 IRNA's
// "Iran's seven conditions basis for reopening Strait of Hormuz, negotiations:
// Araghchi" was labelled critical and went out as a realtime alert: the
// prompt's "strait/waterway closures" trigger fired on a negotiating position.
// The set holds terms, threats and warnings (judged high) next to the events
// themselves, including events a party reports ("X says it struck ..."), which
// should stay critical; the tests below pin how many each path keeps. Author-judged,
// not blind. These tests pin the captured
// runs to the prompt and model production sends.
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
const set = JSON.parse(readFileSync(resolve(root, 'tests/fixtures/classify-judged-statements.json'), 'utf8'));
const relaySrc = readFileSync(resolve(root, 'scripts/ais-relay.cjs'), 'utf8');
const rpcSrc = readFileSync(resolve(root, 'server/worldmonitor/intelligence/v1/classify-event.ts'), 'utf8');

const statements = set.rows.map((r, i) => [r, i]).filter(([r]) => r.judge !== 'critical');
const events = set.rows.map((r, i) => [r, i]).filter(([r]) => r.judge === 'critical');
const criticalStatements = (name) => statements.filter(([, i]) => set.runs[name].labels[i] === 'critical').map(([r]) => r.title);
const keptEvents = (name) => events.filter(([, i]) => set.runs[name].labels[i] === 'critical').map(([r]) => r.title);

describe('statement versus event label set', () => {
  it('is well formed', () => {
    assert.equal(new Set(set.rows.map((r) => r.title)).size, set.rows.length);
    assert.ok(statements.length >= 10 && events.length >= 10);
    for (const [name, run] of Object.entries(set.runs)) assert.equal(run.labels.length, set.rows.length, name);
  });

  it('main\'s prompt labelled statements critical on both paths', () => {
    assert.ok(criticalStatements('relay-before').length >= 5, criticalStatements('relay-before').join('\n'));
    assert.ok(criticalStatements('rpc-before').length >= 5, criticalStatements('rpc-before').join('\n'));
  });

  it('the current prompt labels no statement critical', () => {
    for (const name of ['relay-after', 'relay-after-rerun', 'rpc-after']) assert.deepEqual(criticalStatements(name), [], name);
  });

  it('the current prompt keeps every event the old prompt called critical', () => {
    for (const [before, afters] of [['relay-before', ['relay-after', 'relay-after-rerun']], ['rpc-before', ['rpc-after']]]) {
      for (const after of afters) {
        const lost = keptEvents(before).filter((t) => !keptEvents(after).includes(t));
        assert.deepEqual(lost, [], `${after} vs ${before}`);
      }
    }
    // Main's relay prompt labelled three attacks a party reports as high. Since #11432 the
    // relay prompt says a report that it happened is critical whoever reports it, and the
    // relay keeps every event.
    assert.equal(keptEvents('rpc-after').length, events.length);
    for (const name of ['relay-after', 'relay-after-rerun']) assert.equal(keptEvents(name).length, events.length, name);
  });

  it('its runs are the prompt and model production sends today', () => {
    // If this reds, re-capture the "after" runs (see the fixture note) and review them.
    for (const name of ['relay-after', 'relay-after-rerun']) {
      assert.equal(set.runs[name].promptSha, promptSha(extractRelayPrompt(relaySrc)), name);
      assert.equal(set.runs[name].model, extractRelayOpenRouterModel(relaySrc), name);
    }
    assert.equal(set.runs['rpc-after'].promptSha, promptSha(extractRpcPrompt(rpcSrc)));
    assert.equal(set.runs['rpc-after'].model, extractRpcOpenRouterModel(rpcSrc));
  });
});
