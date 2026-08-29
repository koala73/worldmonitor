import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { SCORECARD_BLOC_PRESETS, resolveBlocSelection } from '../server/worldmonitor/scorecard/v1/_bloc-presets';

describe('five-factor bloc selection', () => {
  it('pins current official preset membership', () => {
    assert.deepEqual(SCORECARD_BLOC_PRESETS.USMCA.members, ['CA', 'MX', 'US']);
    assert.equal(SCORECARD_BLOC_PRESETS.EU27.members.length, 27);
    assert.equal(SCORECARD_BLOC_PRESETS.BRICS.members.length, 11);
    assert.ok(SCORECARD_BLOC_PRESETS.BRICS.members.includes('SA'));
    assert.deepEqual(SCORECARD_BLOC_PRESETS.GCC.members, ['AE', 'BH', 'KW', 'OM', 'QA', 'SA']);
    assert.equal(SCORECARD_BLOC_PRESETS.ASEAN.members.length, 11);
    assert.ok(SCORECARD_BLOC_PRESETS.ASEAN.members.includes('TL'));
    assert.equal(SCORECARD_BLOC_PRESETS.NATO.members.length, 32);
    assert.ok(SCORECARD_BLOC_PRESETS.NATO.members.includes('SE'));
  });

  it('accepts exactly one preset or custom member list', () => {
    assert.deepEqual(resolveBlocSelection({ preset: 'USMCA', members: [] }), SCORECARD_BLOC_PRESETS.USMCA);
    assert.deepEqual(resolveBlocSelection({ preset: '', members: ['US', 'CA'] }), {
      id: 'custom:CA-US',
      label: 'CA + US',
      members: ['CA', 'US'],
    });
    assert.throws(() => resolveBlocSelection({ preset: 'USMCA', members: ['US', 'CA'] }), /exactly one/);
    assert.throws(() => resolveBlocSelection({ preset: '', members: [] }), /exactly one/);
  });

  it('rejects duplicate, lowercase, unknown, undersized, and oversized custom blocs', () => {
    assert.throws(() => resolveBlocSelection({ preset: '', members: ['US', 'US'] }), /unique/);
    assert.throws(() => resolveBlocSelection({ preset: '', members: ['us', 'CA'] }), /uppercase ISO-2/);
    assert.throws(() => resolveBlocSelection({ preset: '', members: ['US', 'XX'] }), /rankable/);
    assert.throws(() => resolveBlocSelection({ preset: '', members: ['US'] }), /2-30/);
    assert.throws(() => resolveBlocSelection({ preset: '', members: Array.from({ length: 31 }, (_, index) => `X${index}`) }), /2-30/);
  });

  it('rejects unknown preset names', () => {
    assert.throws(() => resolveBlocSelection({ preset: 'G7', members: [] }), /Unknown scorecard bloc preset/);
  });
});
