import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  buildOperations,
  contentMeta,
  fetchDtmDisplacement,
  MAX_FLOWS_PER_OPERATION,
  MIN_OPERATIONS,
  resolveAdmin1Point,
  validate,
} from '../scripts/seed-dtm-displacement.mjs';

const POINTS = { SD11: [15.66, 35.87], SD01: [15.6, 32.53], SD15: [14.4, 33.5], CD54: [1.44, 28.93], NG026: [8.51, 8.04], BJ02: [10.63, 1.58] };

function row(overrides = {}) {
  return {
    operation: 'Armed Clashes in Sudan (Overview)',
    admin0Name: 'Sudan',
    admin0Pcode: 'SDN',
    admin1Name: 'Kassala',
    admin1Pcode: 'SD11',
    numPresentIdpInd: 1000,
    reportingDate: '2026-07-31T00:00:00',
    roundNumber: 38,
    displacementReason: 'Conflict',
    idpOriginAdmin1Name: 'Khartoum',
    idpOriginAdmin1Pcode: 'SD01',
    ...overrides,
  };
}

describe('resolveAdmin1Point', () => {
  it('accepts OCHA P-codes and the ISO3-prefixed and padded DTM variants', () => {
    assert.deepEqual(resolveAdmin1Point('SD11', POINTS), [15.66, 35.87]);
    assert.deepEqual(resolveAdmin1Point('COD54', POINTS), [1.44, 28.93]);
    assert.deepEqual(resolveAdmin1Point('NGA026', POINTS), [8.51, 8.04]);
    assert.deepEqual(resolveAdmin1Point('BJ002', POINTS), [10.63, 1.58]);
  });

  it('leaves unknown, placeholder, and empty codes unplaced', () => {
    for (const code of ['TD07', 'Not available', 'Unknown', '', null, undefined]) {
      assert.equal(resolveAdmin1Point(code, POINTS), null, String(code));
    }
  });

  it('ships coordinates for the Sudan regions DTM reports', () => {
    assert.deepEqual(resolveAdmin1Point('SD11'), [15.66, 35.87]);
  });
});

describe('buildOperations', () => {
  it('keeps only the latest round of each operation', () => {
    const [op] = buildOperations([
      row({ reportingDate: '2026-06-30T00:00:00', roundNumber: 37, numPresentIdpInd: 99_999 }),
      row(),
      row({ admin1Name: 'Aj Jazirah', admin1Pcode: 'SD15', numPresentIdpInd: 500 }),
    ], { points: POINTS });
    assert.equal(op.reportingDate, '2026-07-31');
    assert.equal(op.roundNumber, 38);
    assert.equal(op.totalIdps, 1500);
    assert.deepEqual(op.regions.map((r) => [r.pcode, r.idps]), [['SD11', 1000], ['SD15', 500]]);
  });

  it('keeps overlapping operations in one country separate instead of summing them', () => {
    const ops = buildOperations([
      row({ admin0Pcode: 'COD', admin0Name: 'DRC', operation: 'Countrywide monitoring', admin1Pcode: 'COD54', admin1Name: 'Ituri', numPresentIdpInd: 900, idpOriginAdmin1Pcode: 'COD54' }),
      row({ admin0Pcode: 'COD', admin0Name: 'DRC', operation: 'Ituri', admin1Pcode: 'COD54', admin1Name: 'Ituri', numPresentIdpInd: 800, idpOriginAdmin1Pcode: 'COD54' }),
    ], { points: POINTS });
    assert.deepEqual(ops.map((op) => [op.operation, op.totalIdps]), [['Countrywide monitoring', 900], ['Ituri', 800]]);
    assert.deepEqual(ops[0].regions[0].location, { latitude: 1.44, longitude: 28.93 });
  });

  it('builds region-to-region flows and drops same-region and unknown-origin rows', () => {
    const [op] = buildOperations([
      row(),
      row({ numPresentIdpInd: 200 }),
      row({ idpOriginAdmin1Pcode: 'SD11', idpOriginAdmin1Name: 'Kassala', numPresentIdpInd: 300 }),
      row({ idpOriginAdmin1Pcode: 'Not available', idpOriginAdmin1Name: 'Not available', numPresentIdpInd: 400 }),
    ], { points: POINTS });
    assert.equal(op.totalIdps, 1900);
    assert.deepEqual(op.flows, [{
      originPcode: 'SD01',
      originName: 'Khartoum',
      destinationPcode: 'SD11',
      destinationName: 'Kassala',
      idps: 1200,
      originLocation: { latitude: 15.6, longitude: 32.53 },
      destinationLocation: { latitude: 15.66, longitude: 35.87 },
    }]);
  });

  it('caps flows per operation at the largest routes', () => {
    const rows = [];
    for (let i = 0; i < MAX_FLOWS_PER_OPERATION + 5; i++) {
      rows.push(row({ idpOriginAdmin1Pcode: `SD${100 + i}`, numPresentIdpInd: 10 + i }));
    }
    const [op] = buildOperations(rows, { points: POINTS });
    assert.equal(op.flows.length, MAX_FLOWS_PER_OPERATION);
    assert.equal(op.flows[0].idps, 10 + MAX_FLOWS_PER_OPERATION + 4);
  });

  it('groups unreported regions and normalizes reported causes', () => {
    const [op] = buildOperations([
      row({ admin1Pcode: 'Not available', admin1Name: 'Not available', displacementReason: 'Natural Disaster' }),
      row({ displacementReason: 'Natural disaster', numPresentIdpInd: 50 }),
      row({ displacementReason: 'No reason for displacement reported', numPresentIdpInd: 25 }),
    ], { points: POINTS });
    assert.deepEqual(op.regions.map((r) => r.pcode), ['', 'SD11']);
    assert.equal(op.regions[0].name, 'Not specified');
    assert.equal(op.regions[0].location, undefined);
    assert.deepEqual(op.reasons, [{ reason: 'Natural disaster', idps: 1050 }, { reason: 'Not reported', idps: 25 }]);
  });

  it('ignores rows without a usable count or date', () => {
    const ops = buildOperations([
      row({ numPresentIdpInd: null }),
      row({ numPresentIdpInd: -5 }),
      row({ reportingDate: 'n/a' }),
      row({ operation: '' }),
    ], { points: POINTS });
    assert.deepEqual(ops, []);
  });
});

describe('validate and contentMeta', () => {
  it('requires the minimum operation count', () => {
    const ops = Array.from({ length: MIN_OPERATIONS }, () => ({ reportingDate: '2026-07-31' }));
    assert.equal(validate({ operations: ops }), true);
    assert.equal(validate({ operations: ops.slice(1) }), false);
    assert.equal(validate(null), false);
  });

  it('dates content by the newest and oldest operation round', () => {
    const meta = contentMeta({ operations: [{ reportingDate: '2026-07-31' }, { reportingDate: '2025-02-28' }] }, Date.parse('2026-10-07T00:00:00Z'));
    assert.equal(meta.newestItemAt, Date.parse('2026-07-31T00:00:00Z'));
    assert.equal(meta.oldestItemAt, Date.parse('2025-02-28T00:00:00Z'));
  });
});

describe('fetchDtmDisplacement', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  function stub(handler) {
    const calls = [];
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      calls.push({ url, key: init?.headers?.['Ocp-Apim-Subscription-Key'] });
      return handler(url);
    };
    return calls;
  }
  const ok = (result) => Response.json({ result, statusCode: 200, isSuccess: true, errorMessages: [], totalRecordsCount: result.length });

  it('fetches every country from the lookback window with the subscription key', async () => {
    const calls = stub((url) => {
      if (url.pathname.endsWith('/country-list')) return ok([{ admin0Pcode: 'SDN' }, { admin0Pcode: 'ATG' }, { admin0Pcode: '' }]);
      if (url.searchParams.get('Admin0Pcode') === 'ATG') {
        return Response.json({ result: [], statusCode: 204, isSuccess: true, errorMessages: ['No matching data found.'], totalRecordsCount: 0 });
      }
      return ok([row()]);
    });
    const data = await fetchDtmDisplacement({ apiKey: 'test-key', nowMs: Date.parse('2026-10-07T12:00:00Z') });
    assert.equal(data.lookbackFrom, '2025-04-01');
    assert.equal(data.operations.length, 1);
    const admin1 = calls.filter((c) => c.url.pathname.endsWith('/admin1'));
    assert.deepEqual(admin1.map((c) => c.url.searchParams.get('Admin0Pcode')).sort(), ['ATG', 'SDN']);
    assert.ok(admin1.every((c) => c.url.searchParams.get('FromReportingDate') === '2025-04-01'));
    assert.ok(calls.every((c) => c.key === 'test-key'));
  });

  it('fails without a key instead of publishing nothing', async () => {
    await assert.rejects(fetchDtmDisplacement({ apiKey: '' }), /DTM_API_KEY is not set/);
  });

  it('fails fast on a rejected key', async () => {
    const calls = stub(() => Response.json({ statusCode: 401, message: 'Access denied' }, { status: 401 }));
    await assert.rejects(fetchDtmDisplacement({ apiKey: 'bad' }), /HTTP 401/);
    assert.equal(calls.length, 1);
  });

  it('fails when DTM rejects a query instead of dropping the country', async () => {
    stub((url) => {
      if (url.pathname.endsWith('/country-list')) return ok([{ admin0Pcode: 'XXX' }]);
      return Response.json({ result: [], statusCode: 204, isSuccess: false, errorMessages: ['No Country Code found matching your query.'], totalRecordsCount: 0 });
    });
    await assert.rejects(fetchDtmDisplacement({ apiKey: 'k' }), /No Country Code found/);
  });

  it('fails on a truncated page', async () => {
    stub((url) => {
      if (url.pathname.endsWith('/country-list')) return ok([{ admin0Pcode: 'SDN' }]);
      return Response.json({ result: [row()], statusCode: 200, isSuccess: true, errorMessages: [], totalRecordsCount: 5 });
    });
    await assert.rejects(fetchDtmDisplacement({ apiKey: 'k' }), /truncated, 1 of 5 rows/);
  });
});
