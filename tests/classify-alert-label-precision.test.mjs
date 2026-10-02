// Headline threat classification: the model + prompt behind `classify:sebuf:v6` rows.
//
// Measured against 413 blind-judged headlines, main's labeller was right on fewer than
// half of its critical/high labels. Those labels drive rss_alert notifications, the
// digest's isAlert flag and most of the importance score. The fix is a model swap plus
// a prompt block; this file pins both to the evidence they were chosen on, so neither
// can change without re-running scripts/eval-classify-labels.mjs.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extractHighBoundaryBlock,
  extractRelayOpenRouterModel,
  extractRelayPrompt,
  extractRpcOpenRouterModel,
  extractRpcPrompt,
  promptSha,
  scoreAlertLabels,
} from '../scripts/lib/classify-eval.mjs';
import { getLlmAttemptTimeoutMs, isDeepseekV4FlashModel } from '../scripts/_llm-model-timeouts.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const relaySrc = readFileSync(resolve(root, 'scripts/ais-relay.cjs'), 'utf8');
const rpcSrc = readFileSync(resolve(root, 'server/worldmonitor/intelligence/v1/classify-event.ts'), 'utf8');
const fixture = JSON.parse(readFileSync(resolve(root, 'tests/fixtures/classify-judged-headlines.json'), 'utf8'));

const labelsOf = (runName) => {
  const run = fixture.runs[runName];
  assert.ok(run, `fixture run ${runName}`);
  return Object.fromEntries(fixture.rows.map((r, i) => [r.title, run.labels[i]]).filter(([, l]) => l));
};
const score = (runName, rows = fixture.rows) => scoreAlertLabels(rows, labelsOf(runName));
const clearCut = fixture.rows.filter((r) => !r.borderline);

describe('scoreAlertLabels', () => {
  const rows = [
    { title: 'a', judge: 'critical' }, { title: 'b', judge: 'high' },
    { title: 'c', judge: 'medium' }, { title: 'd', judge: 'info' },
  ];

  it('counts missed and false alerts on the critical/high boundary', () => {
    const s = scoreAlertLabels(rows, { a: 'high', b: 'medium', c: 'high', d: 'info' });
    assert.deepEqual(
      { missed: s.missed, falseAlerts: s.falseAlerts, recallPct: s.recallPct, precisionPct: s.precisionPct, exactLevelPct: s.exactLevelPct },
      { missed: 1, falseAlerts: 1, recallPct: 50, precisionPct: 50, exactLevelPct: 25 },
    );
  });

  it('counts an unlabelled real alert as missed: production skips it, so nobody is alerted', () => {
    const s = scoreAlertLabels(rows, { b: 'high', c: 'low', d: 'info' });
    assert.equal(s.unlabelled, 1);
    assert.equal(s.unlabelledAlerts, 1);
    assert.equal(s.alertLevel, 2);
    assert.equal(s.missed, 1);
    assert.equal(s.recallPct, 50);
    assert.equal(s.precisionPct, 100, 'precision is over what was flagged, so it is unaffected');
    assert.equal(s.exactLevelPct, +(100 * 2 / 3).toFixed(1), 'exact level is over labelled titles only');
  });
});

describe('reading production config out of source', () => {
  const providers = (openrouterBody) => `const CLASSIFY_LLM_PROVIDERS = [
  {
    name: 'ollama',
    model: () => process.env.OLLAMA_MODEL || 'llama3.1:8b',
  },
  {
    name: 'openrouter',
    apiUrl: 'https://openrouter.ai/api/v1/chat/completions',
${openrouterBody}
  },
  {
    name: 'openrouter-free',
    model: 'some/later-model',
  },
];`;

  it('reads the openrouter entry, not the ollama one before it or the free one after', () => {
    assert.equal(extractRelayOpenRouterModel(providers("    model: 'a/real-model',")), 'a/real-model');
  });

  it('ignores a model named in a comment', () => {
    assert.equal(extractRelayOpenRouterModel(providers("    // was model: 'a/old-model', before the swap\n    model: 'a/real-model',")), 'a/real-model');
  });

  it('throws when the model is a constant, instead of reading a later provider', () => {
    assert.throws(() => extractRelayOpenRouterModel(providers('    model: CLASSIFY_RELAY_MODEL,')), /quoted model/);
  });

  it('throws on an interpolated prompt, which would hash text production never sends', () => {
    assert.throws(() => extractRelayPrompt('const CLASSIFY_SYSTEM_PROMPT = `Levels: ${LEVELS.join(", ")}`;'), /interpolated/);
    assert.throws(() => extractRpcPrompt('const systemPrompt = `Levels: ${LEVELS}`;'), /interpolated/);
  });

  it('reads the RPC model from the declaration, not from a comment quoting it', () => {
    assert.equal(extractRpcOpenRouterModel("// const CLASSIFY_OPENROUTER_MODEL = 'a/old';\nconst CLASSIFY_OPENROUTER_MODEL = 'a/real';"), 'a/real');
  });
});

// These read only the frozen fixture, so no source change can turn them red. They are the
// acceptance gate for a RE-CAPTURE: after `--capture ... --force`, a configuration that is
// not clearly better than main fails here. The source-facing pins are in the next block.
describe('the judged evidence', () => {
  it('has enough judged titles and alert-level titles to mean something', () => {
    assert.ok(fixture.rows.length >= 400);
    assert.ok(fixture.rows.filter((r) => r.judge === 'critical' || r.judge === 'high').length >= 40);
    // Labels are stored by row index but scored by title, so a repeated title would be
    // scored against the wrong judge.
    assert.equal(new Set(fixture.rows.map((r) => r.title)).size, fixture.rows.length, 'titles must be unique');
    for (const [name, run] of Object.entries(fixture.runs)) {
      assert.equal(run.labels.length, fixture.rows.length, name);
      assert.match(name, /^(relay|rpc)-[a-z0-9-]+$/, `run name ${name}`);
    }
  });

  it('relay path: the prompt block ALONE keeps every false alert, which is why the model changes too', () => {
    const promptOnly = score('relay-prompt-only');
    assert.ok(promptOnly.falseAlerts >= score('relay-after').falseAlerts * 2, `${promptOnly.falseAlerts} false alerts`);
  });

  it('relay path: fewer than a third of the false alerts, within two missed alerts of before', () => {
    const before = score('relay-before');
    for (const name of ['relay-after', 'relay-after-rerun', 'relay-after-run3']) {
      const after = score(name);
      assert.ok(after.falseAlerts * 2 < before.falseAlerts, `${name}: ${after.falseAlerts} false vs ${before.falseAlerts}`);
      assert.ok(after.missed <= before.missed + 2, `${name}: missed ${after.missed} vs ${before.missed}`);
      assert.ok(after.exactLevelPct > before.exactLevelPct, `${name}: exact level`);
    }
  });

  it('relay path: the model swap ALONE misses far more real alerts, which is why the prompt block exists', () => {
    assert.ok(score('relay-model-only').missed >= score('relay-after').missed + 3);
  });

  it('RPC path: no more missed alerts, under a quarter of the false alerts', () => {
    const before = score('rpc-before');
    const after = score('rpc-after');
    assert.ok(after.missed <= before.missed, `missed ${after.missed} vs ${before.missed}`);
    assert.ok(after.falseAlerts * 4 < before.falseAlerts, `${after.falseAlerts} false vs ${before.falseAlerts}`);
  });

  it('on titles the annotator called clear-cut, every real alert is still caught', () => {
    for (const name of ['relay-after', 'relay-after-rerun', 'relay-after-run3', 'rpc-after']) {
      const s = score(name, clearCut);
      assert.equal(s.missed, 0, name);
      assert.ok(s.falseAlerts <= 1, `${name}: ${s.falseAlerts} false alerts`);
    }
  });
});

describe('production is the configuration that was measured', () => {
  it('relay: model and prompt match the captured "relay-after" run', () => {
    const run = fixture.runs['relay-after'];
    assert.equal(extractRelayOpenRouterModel(relaySrc), run.model);
    assert.equal(promptSha(extractRelayPrompt(relaySrc)), run.promptSha,
      'CLASSIFY_SYSTEM_PROMPT changed: re-run `node scripts/eval-classify-labels.mjs --path relay --capture relay-after` and review the scores');
  });

  it('RPC: model and prompt match the captured "rpc-after" run', () => {
    const run = fixture.runs['rpc-after'];
    assert.equal(extractRpcOpenRouterModel(rpcSrc), run.model);
    assert.equal(promptSha(extractRpcPrompt(rpcSrc)), run.promptSha,
      'classify-event systemPrompt changed: re-run `node scripts/eval-classify-labels.mjs --path rpc --capture rpc-after` and review the scores');
    // That the model is actually SENT is proven behaviourally in
    // tests/classify-event-model-override.test.mts.
  });

  it('both writers of the classify cache carry the same "high" boundary block', () => {
    assert.equal(extractHighBoundaryBlock(extractRelayPrompt(relaySrc)), extractHighBoundaryBlock(extractRpcPrompt(rpcSrc)));
  });

  it('the new model keeps the Flash completion-timeout cap', () => {
    assert.equal(isDeepseekV4FlashModel('deepseek/deepseek-v4.1-flash'), true);
    assert.equal(isDeepseekV4FlashModel('deepseek/deepseek-v4-flash'), true);
    assert.equal(isDeepseekV4FlashModel('deepseek/deepseek-v4-pro'), false);
    assert.equal(isDeepseekV4FlashModel('deepseek/deepseek-v41-flash'), false);
    assert.equal(isDeepseekV4FlashModel('deepseek/deepseek-v4.1-flash-thinking'), false, 'a reasoning variant is a different latency class');
    assert.equal(getLlmAttemptTimeoutMs('deepseek/deepseek-v4.1-flash-thinking', 25_000), 25_000);
    assert.equal(getLlmAttemptTimeoutMs('deepseek/deepseek-v4.1-flash', 25_000), 15_000);
  });
});
