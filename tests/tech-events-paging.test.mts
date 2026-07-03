import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveTechEventsPaging } from '../server/worldmonitor/research/v1/_tech-events-paging.ts';

// list-tech-events documents `limit` "defaults to 50 when omitted" and `days`
// "defaults to 90 when omitted". The REST decoder maps an omitted query param to
// 0 (Number(params.get("limit") ?? "0")), so the handler receives 0 — not
// undefined — for an omitted param. The paging resolver must honor the documented
// defaults for that decoded-0 case (mirrors seismology `|| 500` / BLS `>0 ? : 60`).
describe('resolveTechEventsPaging', () => {
  it('applies the documented 50/90 defaults when the param is omitted (decoded as 0)', () => {
    assert.deepEqual(resolveTechEventsPaging({ limit: 0, days: 0 }), { limit: 50, days: 90 });
  });

  it('applies the defaults when the param is genuinely undefined', () => {
    assert.deepEqual(resolveTechEventsPaging({}), { limit: 50, days: 90 });
  });

  it('passes through in-range explicit values', () => {
    assert.deepEqual(resolveTechEventsPaging({ limit: 25, days: 14 }), { limit: 25, days: 14 });
  });

  it('clamps explicit values above the maximum', () => {
    assert.deepEqual(resolveTechEventsPaging({ limit: 999, days: 999 }), { limit: 200, days: 365 });
  });

  it('clamps explicit values below the minimum to 1', () => {
    assert.deepEqual(resolveTechEventsPaging({ limit: 1, days: 1 }), { limit: 1, days: 1 });
  });
});
