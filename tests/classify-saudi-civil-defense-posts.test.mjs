// Real Saudi Civil Defense posts through the relay prompt, one post per completion, as
// publishSaudiCivilDefenseAlerts sends them (#11432). That caller pages realtime
// subscribers on `critical` and uses the shared relay prompt, but its own tests stub the
// classifier, so a prompt change could stop it alerting with every other check green.
// The #11432 rule alone (relay-rule-only) labelled the Riyadh tower attack critical in 7
// of 40 passes (main: 39); the shipped prompt's attack-reported-by-the-target example restores it.
// relay-current-batched sends all six posts in one completion, shuffled per pass, as the
// producer does when several posts miss its cache together. The early-warning posts are
// never critical on any prompt: they never paged realtime, and this set records that gap
// rather than gating it. Re-capture both current captures after any relay prompt or model
// change (commands in the fixture's note).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractRelayOpenRouterModel, extractRelayPrompt, promptSha } from '../scripts/lib/classify-eval.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const set = JSON.parse(readFileSync(resolve(root, 'tests/fixtures/classify-saudi-civil-defense-posts.json'), 'utf8'));
const relaySrc = readFileSync(resolve(root, 'scripts/ais-relay.cjs'), 'utf8');
const { MAX_POST_CHARS } = createRequire(import.meta.url)('../scripts/lib/saudi-civil-defense-alerts.cjs');
const CURRENT = ['relay-current', 'relay-current-batched'];
const critical = (name, note) => set.captures[name].labels[note]?.critical ?? 0;

describe('Saudi Civil Defense posts on the relay prompt (#11432)', () => {
  it('pins both current captures to the prompt, model and post clip production sends', () => {
    for (const name of CURRENT) {
      const c = set.captures[name];
      assert.equal(c.promptSha, promptSha(extractRelayPrompt(relaySrc)), name);
      assert.equal(c.model, extractRelayOpenRouterModel(relaySrc), name);
      assert.equal(c.maxChars, MAX_POST_CHARS, name);
      assert.equal(c.passes, 40, name);
      assert.equal(c.batched, name.endsWith('-batched'), name);
      for (const r of set.rows) {
        const asked = Object.values(c.labels[r.note] ?? {}).reduce((a, b) => a + b, 0);
        assert.equal(asked, c.passes, `${name}: ${r.note}`);
        assert.equal(c.labels[r.note].unlabelled ?? 0, 0, `${name}: ${r.note}`);
      }
    }
  });

  it('labels the reported attack critical in at least 36 of 40 passes', () => {
    const [attack] = set.rows.filter((r) => r.judge === 'critical');
    for (const name of CURRENT) assert.ok(critical(name, attack.note) >= 36, `${name} ${critical(name, attack.note)}/40`);
    assert.equal(critical('relay-before', attack.note), 39);
    assert.equal(critical('relay-rule-only', attack.note), 7);
  });

  it('labels no other post critical', () => {
    for (const name of CURRENT) {
      for (const r of set.rows.filter((row) => row.judge !== 'critical')) assert.equal(critical(name, r.note), 0, `${name}: ${r.note}`);
    }
  });
});
