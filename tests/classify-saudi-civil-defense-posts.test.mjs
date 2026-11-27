// Real Saudi Civil Defense posts through the relay prompt, one post per completion, as
// publishSaudiCivilDefenseAlerts sends them (#11432). That caller pages realtime
// subscribers on `critical` and uses the shared relay prompt, but its own tests stub the
// classifier, so a prompt change could stop it alerting with every other check green.
// The #11432 rule alone (relay-rule-only) labelled the Riyadh tower attack critical in 11
// of 40 passes; the shipped prompt's attack-reported-by-the-target example restores it.
// The early-warning posts are info on every prompt: they never paged realtime, and this
// set records that gap rather than gating it. Re-capture relay-current after any relay
// prompt or model change (command in the fixture's note).
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
const current = set.captures['relay-current'];
const critical = (note) => current.labels[note]?.critical ?? 0;

describe('Saudi Civil Defense posts on the relay prompt (#11432)', () => {
  it('pins relay-current to the prompt, model and post clip production sends', () => {
    assert.equal(current.promptSha, promptSha(extractRelayPrompt(relaySrc)));
    assert.equal(current.model, extractRelayOpenRouterModel(relaySrc));
    assert.equal(current.maxChars, MAX_POST_CHARS);
    assert.equal(current.passes, 40);
    for (const r of set.rows) {
      const asked = Object.values(current.labels[r.note] ?? {}).reduce((a, b) => a + b, 0);
      assert.equal(asked, current.passes, r.note);
      assert.equal(current.labels[r.note].unlabelled ?? 0, 0, r.note);
    }
  });

  it('labels the reported attack critical in at least 36 of 40 passes', () => {
    const [attack] = set.rows.filter((r) => r.judge === 'critical');
    assert.ok(critical(attack.note) >= 36, `${critical(attack.note)}/40: ${attack.note}`);
    assert.equal(set.captures['relay-before'].labels[attack.note].critical, 40);
    assert.equal(set.captures['relay-rule-only'].labels[attack.note].critical, 11);
  });

  it('labels no other post critical', () => {
    for (const r of set.rows.filter((row) => row.judge !== 'critical')) assert.equal(critical(r.note), 0, r.note);
  });
});
