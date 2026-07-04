import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveTechEventsPaging } from '../server/worldmonitor/research/v1/_tech-events-paging.ts';

// list-tech-events documents limit "defaults to 50 when omitted" and days
// "defaults to 90 when omitted", while explicit 0 is still a caller-provided
// value that clamps up to 1. The REST decoder maps omitted int32 query params to
// 0, so handler code passes query-param presence into the shared resolver.
describe('resolveTechEventsPaging', () => {
  it('applies the documented 50/90 defaults when the param is omitted (decoded as 0)', () => {
    assert.deepEqual(
      resolveTechEventsPaging({ limit: 0, days: 0 }, { hasLimit: false, hasDays: false }),
      { limit: 50, days: 90 },
    );
  });

  it('applies the defaults when the param is genuinely undefined', () => {
    assert.deepEqual(resolveTechEventsPaging({}), { limit: 50, days: 90 });
  });

  it('defaults only omitted decoded-zero fields when presence is mixed', () => {
    assert.deepEqual(
      resolveTechEventsPaging({ limit: 0, days: 0 }, { hasLimit: true, hasDays: false }),
      { limit: 1, days: 90 },
    );
  });

  it('clamps explicit 0 values up to 1', () => {
    assert.deepEqual(
      resolveTechEventsPaging({ limit: 0, days: 0 }, { hasLimit: true, hasDays: true }),
      { limit: 1, days: 1 },
    );
  });

  it('passes through in-range explicit values', () => {
    assert.deepEqual(resolveTechEventsPaging({ limit: 25, days: 14 }), { limit: 25, days: 14 });
  });

  it('clamps explicit values above the maximum', () => {
    assert.deepEqual(resolveTechEventsPaging({ limit: 999, days: 999 }), { limit: 200, days: 365 });
  });

  it('keeps minimum-boundary values at 1', () => {
    assert.deepEqual(resolveTechEventsPaging({ limit: 1, days: 1 }), { limit: 1, days: 1 });
  });

  it('clamps explicit values below the minimum to 1', () => {
    assert.deepEqual(resolveTechEventsPaging({ limit: -5, days: -3 }), { limit: 1, days: 1 });
  });
});
