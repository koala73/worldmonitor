import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeSdmxPeriod } from '../scripts/_seed-utils.mjs';

describe('_seed-utils: normalizeSdmxPeriod', () => {
  it('converts SDMX 3.0 monthly YYYY-MMM to ISO YYYY-MM', () => {
    assert.equal(normalizeSdmxPeriod('2026-M03'), '2026-03');
    assert.equal(normalizeSdmxPeriod('2025-M12'), '2025-12');
    assert.equal(normalizeSdmxPeriod('2024-M01'), '2024-01');
  });

  it('passes annual YYYY through unchanged (WEO/FM)', () => {
    assert.equal(normalizeSdmxPeriod('2024'), '2024');
    assert.equal(normalizeSdmxPeriod('2026'), '2026');
  });

  it('passes daily YYYY-MM-DD through unchanged (ECB)', () => {
    assert.equal(normalizeSdmxPeriod('2024-03-15'), '2024-03-15');
  });

  it('passes quarterly YYYY-Q1..Q4 through unchanged', () => {
    assert.equal(normalizeSdmxPeriod('2024-Q1'), '2024-Q1');
    assert.equal(normalizeSdmxPeriod('2025-Q4'), '2025-Q4');
  });

  it('passes already-normalized YYYY-MM through unchanged', () => {
    assert.equal(normalizeSdmxPeriod('2026-03'), '2026-03');
  });

  it('returns falsy and non-string inputs unchanged', () => {
    assert.equal(normalizeSdmxPeriod(null), null);
    assert.equal(normalizeSdmxPeriod(undefined), undefined);
    assert.equal(normalizeSdmxPeriod(''), '');
  });

  it('only strips the M-prefix on month component, not stray M elsewhere', () => {
    // Defensive — the regex is anchored with `$`, so a malformed period
    // like "M2026-03" or "2026-M03-extra" should not be mutated.
    assert.equal(normalizeSdmxPeriod('M2026-03'), 'M2026-03');
    assert.equal(normalizeSdmxPeriod('2026-M03-extra'), '2026-M03-extra');
  });
});
