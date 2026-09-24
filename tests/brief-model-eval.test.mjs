// The email brief's prose model is chosen on scripts/eval-brief-model.mjs runs over the
// pools in tests/fixtures/brief-model-eval.json. This file pins the pass/fail checks to
// the failures they stand for, and pins the shipped model to a captured run, so the model
// cannot change without re-running the eval.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CHECKS, SIGNALS, checkSample, maskDates, parseRawDigest, signalsFor, summarizeRun } from '../scripts/lib/brief-model-eval.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = JSON.parse(readFileSync(resolve(root, 'tests/fixtures/brief-model-eval.json'), 'utf8'));
const sep20 = fixture.pools['sep20-former-president'].stories;

// Verbatim from the 2026-09-20 email (tests/brief-llm.test.mjs keeps the same strings).
const CAPTURED_LEAD =
  'Good morning. Iran has declared its terms for peace, demanding a complete cessation of Saudi-led military operations and the lifting of all sanctions, following an attempted attack on Riyadh that Saudi forces claim to have foiled. This development comes as former President Trump returns to the UN, with the ongoing conflict in the Persian Gulf spreading to critical shipping chokepoints, directly impacting global trade and energy security.';
const CAPTURED_TEASER = 'Former President Trump re-engages with the UN as the Iran conflict intensifies, impacting international relations and global stability.';
const CAPTURED_CARD = 'Former President Trump returned to the UN General Assembly amidst escalating maritime tensions as Iranian-linked attacks on shipping chokepoints intensified globally.';
const GROUNDED_LEAD = 'Good morning. Iran has declared its terms for peace after Saudi forces foiled an attack on Riyadh.';

const digestObj = (lead, teasers = ['Iran outlines peace terms.']) =>
  ({ lead, threads: teasers.map((teaser) => ({ tag: 'Conflict', teaser })), signals: ['Watch Hormuz.'] });
const digest = (...args) => JSON.stringify(digestObj(...args));
const fails = (args) => checkSample(args).fails;

describe('checkSample: digest', () => {
  it('flags the Sep 20 lead for both the qualifier and the stitch', () => {
    assert.deepEqual(fails({ surface: 'digest', raw: digest(CAPTURED_LEAD), output: digestObj(GROUNDED_LEAD), stories: sep20 }), ['status_qualifier', 'stitch']);
  });

  it('flags a qualifier that only appears in a thread teaser', () => {
    assert.deepEqual(fails({ surface: 'digest', raw: digest(GROUNDED_LEAD, [CAPTURED_TEASER]), output: digestObj(GROUNDED_LEAD), stories: sep20 }), ['status_qualifier']);
  });

  it('passes a grounded digest, fenced or not', () => {
    const output = digestObj(GROUNDED_LEAD);
    assert.deepEqual(fails({ surface: 'digest', raw: digest(GROUNDED_LEAD), output, stories: sep20 }), []);
    assert.deepEqual(fails({ surface: 'digest', raw: `\`\`\`json\n${digest(GROUNDED_LEAD)}\n\`\`\``, output, stories: sep20 }), []);
  });

  it('scores the raw text even when production rejected it', () => {
    assert.deepEqual(fails({ surface: 'digest', raw: digest(CAPTURED_LEAD), output: null, stories: sep20 }), ['status_qualifier', 'stitch', 'rejected']);
  });

  it('flags a qualifier that survived into the delivered digest', () => {
    const delivered = digestObj(GROUNDED_LEAD, [CAPTURED_TEASER]);
    assert.deepEqual(fails({ surface: 'digest', raw: digest(GROUNDED_LEAD, [CAPTURED_TEASER]), output: delivered, stories: sep20 }), ['status_qualifier', 'delivered_status_qualifier']);
  });

  it('separates no output from unparseable output', () => {
    assert.deepEqual(fails({ surface: 'digest', raw: null, output: null, stories: sep20 }), ['no_output', 'rejected']);
    assert.deepEqual(fails({ surface: 'digest', raw: 'Iran set terms.', output: null, stories: sep20 }), ['invalid_json', 'rejected']);
    assert.equal(parseRawDigest('{"threads": []}'), null, 'a digest without a string lead is not a digest');
  });
});

describe('checkSample: per-story prose', () => {
  const trumpStory = [sep20[1]];
  const repaired = CAPTURED_CARD.replace(/^Former /, '');

  it('flags the raw Sep 20 story card, and passes the repaired delivery', () => {
    assert.deepEqual(fails({ surface: 'description', raw: CAPTURED_CARD, output: repaired, stories: trumpStory }), ['status_qualifier']);
  });

  it('flags the card when it was delivered unrepaired', () => {
    assert.deepEqual(fails({ surface: 'whyMatters', raw: CAPTURED_CARD, output: CAPTURED_CARD, stories: trumpStory }), ['status_qualifier', 'delivered_status_qualifier']);
  });

  it('grounds a qualifier the story itself carries', () => {
    const story = [{ ...sep20[1], headline: 'Former President Trump Returns to UN' }];
    assert.deepEqual(fails({ surface: 'description', raw: CAPTURED_CARD, output: CAPTURED_CARD, stories: story }), []);
  });
});

describe('signalsFor (tracked, not gated)', () => {
  const sudan = [{ headline: 'Armed drones leading cause of civilian death in Sudan war: UN rights chief' }];
  const trump = [sep20[1]];

  it('flags a titled name the story does not contain', () => {
    assert.deepEqual(signalsFor(['UN rights chief Volker Türk reported the drone toll.'], sudan), ['title_name']);
  });

  it('does not flag a titled name the story contains, possessive included', () => {
    assert.deepEqual(signalsFor(['President Trump’s return to the UN drew scrutiny.'], trump), []);
  });

  it('flags a number the story does not contain', () => {
    assert.deepEqual(signalsFor(['The violence has run since February 2022.'], sep20.slice(2)), ['number']);
  });

  it('flags escalation language the story does not use', () => {
    assert.deepEqual(signalsFor(['The move risks a broader regional war.'], trump), ['escalation']);
    const story = [{ headline: 'Analysts warn of a broader regional war after strikes' }];
    assert.deepEqual(signalsFor(['The move risks a broader regional war.'], story), []);
  });
});

describe('summarizeRun', () => {
  it('counts deliveries, per-check failures, signals, latency and serving providers per surface', () => {
    const s = summarizeRun([
      { surface: 'digest', fails: [], signals: ['escalation'], ms: 100, provider: 'A', costUsd: 0.001 },
      { surface: 'digest', fails: ['stitch'], signals: [], ms: 300, provider: 'A', costUsd: 0.001 },
      { surface: 'digest', fails: ['no_output', 'rejected'], signals: [], ms: 15000, provider: null },
      { surface: 'description', fails: [], signals: [], ms: 50, provider: 'B' },
    ]);
    assert.equal(s.digest.n, 3);
    assert.equal(s.digest.delivered, 2);
    assert.equal(s.digest.rejectedWithOutput, 0);
    assert.equal(s.digest.fails.stitch, 1);
    assert.equal(s.digest.fails.no_output, 1);
    assert.equal(s.digest.signals.escalation, 1);
    assert.equal(s.digest.p50Ms, 300);
    assert.equal(s.digest.maxMs, 15000);
    assert.deepEqual(s.digest.providers, { A: 2 });
    assert.equal(s.digest.costUsd, 0.002);
    assert.equal(s.description.n, 1);
    assert.equal(s.whyMatters, undefined);
  });
});

it('maskDates hides the date line so the prompt hash moves only with the prompt', () => {
  assert.equal(maskDates('Today is 2026-09-23. Stories from 2026-09-20.'), 'Today is YYYY-MM-DD. Stories from YYYY-MM-DD.');
});

describe('the shipped brief model has a clean captured run', () => {
  const briefSrc = readFileSync(resolve(root, 'scripts/lib/brief-llm.mjs'), 'utf8');
  const shipped = briefSrc.match(/^const BRIEF_LLM_OPENROUTER_MODEL = process\.env\.BRIEF_LLM_OPENROUTER_MODEL \|\| '([^']+)';/m)?.[1];

  it('reads the default model out of source', () => {
    assert.ok(shipped, 'BRIEF_LLM_OPENROUTER_MODEL default not found; scripts/eval-brief-model.mjs reads it the same way');
  });

  const runs = Object.entries(fixture.runs).filter(([, r]) => r.model === shipped);
  const samples = runs.flatMap(([, r]) => r.samples);

  it('was measured', () => {
    assert.ok(runs.length > 0, `no run in tests/fixtures/brief-model-eval.json for ${shipped}; capture one with scripts/eval-brief-model.mjs --live --capture`);
  });

  // A run captured before a check existed passes that check vacuously. Every run the
  // gate reads must carry every current check and signal.
  it('every run was scored by the current checker', () => {
    for (const [name, run] of runs) {
      for (const [surface, s] of Object.entries(run.summary)) {
        assert.deepEqual(Object.keys(s.fails).sort(), Object.keys(CHECKS).sort(), `${name} ${surface}: re-capture with the current checker`);
        assert.deepEqual(Object.keys(s.signals ?? {}).sort(), Object.keys(SIGNALS).sort(), `${name} ${surface}: re-capture with the current checker`);
      }
    }
  });

  // Fabrication is gated per sample, on every run, on what production delivered: one
  // shipped "former President" is the incident. The raw rate is tracked, not gated,
  // because the validators repair it (digest: sentence drop; whyMatters: qualifier drop).
  it('no run delivered a fabricated tenure qualifier to a reader', () => {
    const leaked = samples.filter((x) => x.fails.includes('delivered_status_qualifier'));
    assert.deepEqual(leaked.map((x) => `${x.surface}: ${JSON.stringify(x.output)}`), []);
  });

  // Delivery is pooled across the model's runs: a 5% bar on 24 digests is one sample.
  // Only output production threw away counts. no_output is transport latency, which
  // comes in provider-side bursts one run cannot measure (the first Gemini capture hit
  // one); that needs llm_call telemetry from the digest cron (#8440).
  for (const surface of ['digest', 'description', 'whyMatters']) {
    it(`${surface}: production rejects at most 5% of the prose the model produced`, () => {
      const rows = samples.filter((x) => x.surface === surface && !x.fails.includes('no_output'));
      const rejected = rows.filter((x) => x.fails.includes('rejected')).length;
      assert.ok(rows.length >= 20, `${surface}: only ${rows.length} samples with output`);
      assert.ok(rejected / rows.length <= 0.05, `${surface}: ${rejected}/${rows.length} rejected`);
    });
  }
});
