import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JEV_MODEL } from '../shared/jev-classify.js';
import { isAlertLevel } from '../scripts/lib/classify-eval.mjs';
import { FROZEN, latinRows } from '../scripts/lib/jev-heldout.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(join(tmpdir(), 'jev-heldout-cli-'));
let n = 0;
const file = (data) => { const p = join(dir, `f${n++}.json`); writeFileSync(p, typeof data === 'string' ? data : JSON.stringify(data)); return p; };
const fresh = () => join(dir, `f${n++}.json`);

const heldout = JSON.parse(readFileSync(join(root, 'tests/fixtures/classify-judged-headlines-heldout.json'), 'utf8'));
const latin = latinRows(heldout.rows);
const titles = latin.map((r) => r.title);
const alerts = latin.filter((r) => isAlertLevel(r.judge)).length;
const HEAD = 'a'.repeat(40);

const judged = latin.map((r) => ({
  level: { l: r.judge, levelConf: 0.9, pAlert: isAlertLevel(r.judge) ? 0.9 : 0.1 },
  noul: { worsening: 0.9, violence: 0.9, commentary: 0 },
}));
const captureOf = (runs) => file({
  note: 'synthetic', freezeSha: HEAD, questionSetSha: FROZEN.questionSetSha, ruleSha: FROZEN.ruleSha, fixtureSha: FROZEN.fixtureSha,
  model: JEV_MODEL, titles, runs: Object.fromEntries(Object.entries(runs).map(([name, answers]) => [name, { capturedAt: '2026-09-24T00:00:00Z', answers }])),
});

const preload = join(dir, 'stub-fetch.mjs');
writeFileSync(preload, `
import { appendFileSync } from 'node:fs';
globalThis.fetch = async (url, init) => {
  if (process.env.STUB_MARKER) appendFileSync(process.env.STUB_MARKER, 'x');
  const status = Number(process.env.STUB_STATUS || 200);
  const q = JSON.parse(init.body).questions;
  const body = q.l0
    ? { answers: { l0: { type: 'choice', choice: 'high', confidence: 0.9, probabilities: { critical: 0.25, high: 0.5 } } }, usage: { input_tokens: 600 } }
    : { answers: { commentary: { noul: 0.1 }, worsening: { noul: 0.9 }, violence: { noul: 0.8 } }, usage: { input_tokens: 400 } };
  return new Response(JSON.stringify(status === 200 ? body : {}), { status });
};
`);

const cli = (args, env = {}) => spawnSync(process.execPath, ['--import', preload, 'scripts/eval-jev-heldout.mjs', ...args], {
  cwd: root, encoding: 'utf8', env: { ...process.env, TYPESAFE_API_KEY: '', JEV_HELDOUT_TEST_GIT_HEAD: HEAD, ...env },
});
const keyed = (env = {}) => ({ TYPESAFE_API_KEY: 'k', ...env });

describe('eval-jev-heldout offline', () => {
  it('scores both frozen runs and prints the verdict', () => {
    const r = cli(['--capture', captureOf({ 'jev-1': judged, 'jev-2': judged })]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`questions ${FROZEN.questionSetSha}, rule ${FROZEN.ruleSha}, fixture ${FROZEN.fixtureSha}, freeze ${HEAD}`));
    assert.match(r.stdout, new RegExp(`Latin titles ${titles.length} of ${heldout.rows.length}`));
    assert.match(r.stdout, new RegExp(`^jev-veto\\* +jev-2 +full +${alerts} +${alerts} +0 +0 +0 +100 +100 +0$`, 'm'));
    assert.match(r.stdout, /^relay +relay-after +full +39 +35 +4 +6 +0 +85\.4 +89\.7 +-$/m);
    assert.match(r.stdout, /VERDICT jev-veto: GO\n {2}full: pass\n {2}clearCut: pass/);
  });

  it('reports per-arm unanswered titles', () => {
    const answers = judged.map((a, i) => (i < 3 ? { level: null, noul: null } : i === 3 ? { ...a, noul: null } : a));
    const r = cli(['--capture', captureOf({ 'jev-1': answers, 'jev-2': judged })]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^jev-argmax +jev-1 +full .* 3$/m);
    assert.match(r.stdout, /^jev-veto\* +jev-1 +clearCut .* 4$/m);
    assert.match(r.stdout, /^jev-veto\* +jev-2 +full .* 0$/m);
  });

  it('prints INCOMPLETE, not GO or NO-GO, without both frozen runs', () => {
    const r = cli(['--capture', captureOf({ 'jev-1': judged })]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /VERDICT jev-veto: INCOMPLETE\n {2}needs exactly jev-veto runs \[jev-1,jev-2\]/);
    assert.doesNotMatch(r.stdout, /GO/);
  });

  it('prints relay scores and no verdict without a capture', () => {
    const r = cli(['--capture', join(dir, 'none.json')]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /no Jev capture at .*none\.json; no verdict/);
    assert.doesNotMatch(r.stdout, /VERDICT/);
  });

  it('exits 2 on a capture it does not trust', () => {
    const r = cli(['--capture', captureOf({ 'jev-1': judged.map((a, i) => (i === 7 ? { ...a, level: { l: 'severe' } } : a)) })]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /runs\["jev-1"\]\.answers\[7\] has a level/);
  });
});

describe('eval-jev-heldout arguments', () => {
  it('refuses an unknown, valueless or repeated flag', () => {
    assert.match(cli(['--force']).stderr, /unknown argument --force/);
    assert.match(cli(['--freeze-sha', HEAD]).stderr, /unknown argument --freeze-sha/);
    assert.match(cli(['--run']).stderr, /--run needs a value/);
    const twice = cli(['--run', 'jev-1', '--run', 'jev-2'], keyed());
    assert.equal(twice.status, 2);
    assert.match(twice.stderr, /--run given twice/);
  });
});

describe('eval-jev-heldout --run', () => {
  const refuses = (args, env, pattern) => {
    const marker = fresh();
    const r = cli(args, { STUB_MARKER: marker, ...env });
    assert.equal(r.status, 2, r.stdout);
    assert.match(r.stderr, pattern);
    assert.equal(existsSync(marker), false, 'no request was sent');
  };

  it('exits 2 before any request', () => {
    const existing = captureOf({ 'jev-1': judged });
    refuses(['--capture', existing, '--run', 'jev-2'], {}, /TYPESAFE_API_KEY/);
    refuses(['--capture', fresh(), '--run', 'jev-3'], keyed(), /--run must be one of jev-1, jev-2/);
    refuses(['--capture', existing, '--run', 'jev-1'], keyed(), /runs\["jev-1"\] exists/);
    refuses(['--capture', existing, '--run', 'jev-2'], keyed({ JEV_HELDOUT_TEST_GIT_HEAD: 'b'.repeat(40) }), /does not descend from the freeze commit a{40}/);
    const relabelled = structuredClone(heldout);
    relabelled.rows[0].judge = relabelled.rows[0].judge === 'info' ? 'low' : 'info';
    refuses(['--fixture', file(relabelled), '--capture', fresh(), '--run', 'jev-1'], keyed(), /is not the frozen held-out set/);
  });

  it('writes each run under the freeze commit and a later offline score reads them', () => {
    const out = fresh();
    const first = cli(['--capture', out, '--run', 'jev-1'], keyed());
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, new RegExp(`${titles.length} titles, 0 without a level, 0 more without Nouls, ${2 * titles.length} requests, ${1000 * titles.length} input tokens`));
    const written = JSON.parse(readFileSync(out, 'utf8'));
    assert.deepEqual(
      [written.freezeSha, written.questionSetSha, written.ruleSha, written.fixtureSha, written.model, written.titles],
      [HEAD, FROZEN.questionSetSha, FROZEN.ruleSha, FROZEN.fixtureSha, JEV_MODEL, titles],
    );
    assert.deepEqual(written.runs['jev-1'].answers[0], {
      level: { l: 'high', levelConf: 0.9, pAlert: 0.75 }, noul: { commentary: 0.1, worsening: 0.9, violence: 0.8 },
    });
    assert.equal(written.runs['jev-1'].head, HEAD);
    assert.equal(existsSync(`${out}.tmp`), false);
    const second = cli(['--capture', out, '--run', 'jev-2'], keyed());
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(out, 'utf8')).runs), ['jev-1', 'jev-2']);
    const scored = cli(['--capture', out]);
    assert.equal(scored.status, 0, scored.stderr);
    assert.match(scored.stdout, /VERDICT jev-veto: NO-GO/);
  });

  it('refuses to capture on HTTP 401 or when too many titles have no level', () => {
    const unauthorised = fresh();
    const r401 = cli(['--capture', unauthorised, '--run', 'jev-1'], keyed({ STUB_STATUS: '401' }));
    assert.equal(r401.status, 2);
    assert.match(r401.stderr, /requests got HTTP 401\/403; check TYPESAFE_API_KEY/);
    assert.equal(existsSync(unauthorised), false);
    const down = fresh();
    const r500 = cli(['--capture', down, '--run', 'jev-1'], keyed({ STUB_STATUS: '500' }));
    assert.equal(r500.status, 2);
    assert.match(r500.stderr, new RegExp(`${titles.length} of ${titles.length} titles have no level, over 5%`));
    assert.equal(existsSync(down), false);
  });
});
