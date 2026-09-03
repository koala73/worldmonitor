import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVectorSeries, latestUnemployment } from '../scripts/lib/statcan-wds.mjs';

function parse(values) {
  return parseVectorSeries([{ status: 'SUCCESS', object: {
    vectorId: 123, productId: 456,
    vectorDataPoint: values.map((value, i) => ({ refPer: `2026-0${i + 1}-01`, value })),
  } }], 123);
}

test('missing or malformed observations do not become zero-valued StatCan data', () => {
  for (const value of [null, undefined, '', '  ', false, true, [], [12], {}, NaN, Infinity]) {
    assert.deepEqual(parse([value]).points, []);
  }
});

test('genuine zero and numeric strings remain valid observations', () => {
  assert.deepEqual(parse([0, '0', ' 6.5 ', -2]).points.map(point => point.value), [0, 0, 6.5, -2]);
});

test('a missing latest observation cannot replace the preceding unemployment rate with zero', () => {
  const series = parse([6.5, null]);
  const latest = latestUnemployment(series.points);
  assert.equal(latest.unemploymentPct, 6.5);
  assert.equal(latest.refPer, '2026-01-01');
});
