import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { SCORECARD_BLOC_PRESETS, resolveBlocSelection } from '../server/worldmonitor/scorecard/v1/_bloc-presets';

describe('five-factor bloc selection', () => {
  it('pins current official preset membership', () => {
    assert.deepEqual(SCORECARD_BLOC_PRESETS, {
      USMCA: { id: 'USMCA', label: 'USMCA', members: ['CA', 'MX', 'US'] },
      EU27: { id: 'EU27', label: 'European Union', members: ['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE'] },
      BRICS: { id: 'BRICS', label: 'BRICS', members: ['BR', 'RU', 'IN', 'CN', 'ZA', 'SA', 'EG', 'AE', 'ET', 'ID', 'IR'] },
      GCC: { id: 'GCC', label: 'Gulf Cooperation Council', members: ['AE', 'BH', 'KW', 'OM', 'QA', 'SA'] },
      ASEAN: { id: 'ASEAN', label: 'ASEAN', members: ['BN', 'KH', 'ID', 'LA', 'MY', 'MM', 'PH', 'SG', 'TH', 'TL', 'VN'] },
      NATO: { id: 'NATO', label: 'NATO', members: ['AL', 'BE', 'BG', 'CA', 'HR', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IS', 'IT', 'LV', 'LT', 'LU', 'ME', 'NL', 'MK', 'NO', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE', 'TR', 'GB', 'US'] },
    });
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
