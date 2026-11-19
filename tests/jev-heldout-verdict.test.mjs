// The #8478 go/no-go as captured: two jev-1.13.0 runs on the held-out set against the
// #8341 relay. Scored offline from tests/fixtures/jev-heldout-runs.json; no key needed.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { status, stdout, stderr } = spawnSync(process.execPath, ['scripts/eval-jev-heldout.mjs'], { cwd: root, encoding: 'utf8' });
const row = (arm, run, slice) => stdout.split('\n').find((l) => l.split(/\s+/).slice(0, 3).join(' ') === `${arm} ${run} ${slice}`)?.split(/\s+/);

describe('Jev held-out verdict (#8478)', () => {
  it('scores the committed capture with the frozen rule', () => {
    assert.equal(status, 0, stderr);
    assert.match(stdout, /freeze fbbcf491dfd767506af7550f0ad69e712cb26c26/);
  });

  it('is NO-GO on both slices', () => {
    assert.match(stdout, /VERDICT jev-veto: NO-GO/);
    assert.match(stdout, /full: worst jev-veto precision 67\.9% is not above best relay 85\.4%; worst jev-veto run missed 20, worst relay run 5/);
    assert.match(stdout, /clearCut: worst jev-veto precision 92\.9% is below worst relay 100\.0%; worst jev-veto run missed 13, worst relay run 1/);
  });

  it('pins missed and false alerts per arm and run on the full set', () => {
    const expected = {
      'jev-argmax jev-1': [6, 19], 'jev-argmax jev-2': [5, 19],
      'jev-v1 jev-1': [14, 10], 'jev-v1 jev-2': [14, 10],
      'jev-veto* jev-1': [20, 9], 'jev-veto* jev-2': [20, 9],
    };
    for (const [key, [missed, falseAlerts]] of Object.entries(expected)) {
      const r = row(...key.split(' '), 'full');
      assert.ok(r, `${key} row missing`);
      assert.deepEqual([Number(r[5]), Number(r[6]), Number(r[10])], [missed, falseAlerts, 0], key);
    }
  });
});
