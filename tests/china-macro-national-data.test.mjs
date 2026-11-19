import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { extractNbsNationalData } from '../scripts/china-macro/extract-nbs-national-data.mjs';

const directory = new URL('./fixtures/china-macro/nbs-national-data/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('manifest.json', directory), 'utf8'));
const raw = (name) => readFileSync(new URL(name, directory), 'utf8');
const parse = (name, payload = raw(name)) => extractNbsNationalData(payload, {
  retrievedAt: manifest.responses[name].retrievedAt,
});
const money = 'money-202608-202609.json';
const trade = 'trade-202608-202609.json';

function changeCell(mutator) {
  const payload = JSON.parse(raw(trade));
  mutator(payload.data[1].values[0], payload);
  return JSON.stringify(payload);
}

describe('NBS National Data saved-response extraction', () => {
  it('extracts actual monthly M2 growth and the three separately published trade values', () => {
    const m2 = parse(money).candidates.find((row) => row.observationPeriod === '2026-08');
    assert.equal(m2.seriesId, 'pboc_m2_yoy');
    assert.equal(m2.value, 7.5);
    assert.equal(m2.unit, '%');
    const rows = parse(trade).candidates.filter((row) => row.observationPeriod === '2026-08');
    assert.deepEqual(rows.map(({ seriesId, value, unit, periodKind }) => [seriesId, value, unit, periodKind]), [
      ['gacc_exports', 401440.957, 'USD million', 'month'],
      ['gacc_imports', 282355.763, 'USD million', 'month'],
      ['gacc_trade_balance', 119085.194, 'USD million', 'month'],
    ]);
    assert.equal(rows[2].sourceReference.indicatorId, '0123bdd4e85348f28efc74685a4a40e5');
    // A balance is read from its own published cell, not calculated from the
    // export/import cells (which need not reconcile after independent rounding).
    const altered = parse(trade, changeCell((cell) => { cell.value = '401440956'; }));
    assert.equal(altered.candidates.at(-1).value, 119085.194);
  });

  it('retains newer empty cells as null and never silently substitutes August for September', () => {
    for (const name of [money, trade]) {
      const result = parse(name);
      const september = result.candidates.filter((row) => row.observationPeriod === '2026-09');
      assert.equal(september.length, name === money ? 1 : 3);
      for (const row of september) {
        assert.equal(row.value, null);
        assert.equal(row.availability, 'unavailable');
        assert.equal(row.unavailableReason, 'SOURCE_VALUE_MISSING');
      }
      assert.ok(result.candidates.some((row) => row.observationPeriod === '2026-08' && row.value !== null));
    }
  });

  it('keeps the NBS retrieval identity, exact source hash and unknown clocks', () => {
    for (const name of [money, trade]) {
      const result = parse(name);
      assert.equal(result.contentHash, manifest.responses[name].contentHash);
      assert.equal(result.sourceUrl, manifest.endpoint);
      assert.equal(result.source, 'National Bureau of Statistics of China, National Data');
      assert.match(result.attribution, /www\.stats\.gov\.cn/);
      assert.equal(result.canonicalEligible, false);
      assert.deepEqual(result.publication, { status: 'unknown', reason: 'NBS_DATABASE_PUBLICATION_TIME_UNAVAILABLE' });
      assert.deepEqual(result.revision, { status: 'unknown', reason: 'NBS_DATABASE_REVISION_TIME_UNAVAILABLE' });
      assert.equal(result.releaseTime, undefined);
    }
  });

  it('keeps an empty retrieval-month cell without losing prior observations', () => {
    const payload = JSON.parse(raw(trade));
    payload.data[0].code = '202610MM';
    payload.data[0].name = '2026年10月';
    const result = parse(trade, JSON.stringify(payload));
    assert.equal(result.candidates.filter((row) => row.observationPeriod === '2026-10' && row.value === null).length, 3);
    assert.equal(result.candidates.filter((row) => row.observationPeriod === '2026-08' && row.value !== null).length, 3);
    payload.data[0].values[0].value = '0';
    assert.throws(() => parse(trade, JSON.stringify(payload)), /FUTURE_MONTH/);
    payload.data[0].values[0].value = '';
    payload.data[0].code = '202611MM';
    payload.data[0].name = '2026年11月';
    assert.throws(() => parse(trade, JSON.stringify(payload)), /FUTURE_MONTH/);
  });

  it('rejects changed identities, cumulative/stock fields, wrong units and non-national data', () => {
    for (const change of [
      (cell) => { cell._id = 'unreviewed-id'; },
      (cell) => { cell.dp = '21'; },
      (cell) => { cell.catalogid = 'different-table'; },
      (cell) => { cell.du_name = '亿元'; },
      (cell) => { cell.da = '110000000000'; },
      (cell) => { cell.i_showname = '出口总值累计值 (千美元)'; },
    ]) assert.throws(() => parse(trade, changeCell(change)), /INDICATOR_BINDING|UNREVIEWED_INDICATOR/);
  });

  it('rejects malformed numbers, duplicates, bad/future months and unsuccessful envelopes', () => {
    for (const value of [' ', 'NaN', 'Infinity', '1e3', '1,000', '9007199254740992', '-1', '1.5', undefined]) {
      assert.throws(() => parse(trade, changeCell((cell) => { cell.value = value; })), /NUMERIC_VALUE/);
    }
    for (const change of [
      (_, payload) => { payload.success = false; },
      (_, payload) => { payload.state = 50000; },
      (_, payload) => { payload.data[1].values.push(payload.data[1].values[0]); },
      (_, payload) => { payload.data[1].code = '202613MM'; },
      (_, payload) => { payload.data[1].code = '202610MM'; payload.data[1].name = '2026年10月'; },
      (_, payload) => { payload.data[1].name = '2026年9月'; },
    ]) assert.throws(() => parse(trade, changeCell(change)), /INVALID_NBS_NATIONAL_DATA/);
    assert.throws(() => extractNbsNationalData(raw(trade), { retrievedAt: '2026-02-30T00:00:00.000Z' }), /RETRIEVAL_TIME/);
    assert.throws(() => parse(trade, '{}'), /ENVELOPE/);
    assert.throws(() => parse(trade, '<html>Access denied</html>'), /JSON/);
  });

  it('preserves valid zero and signed trade balances, while ignoring unrelated indicators', () => {
    const payload = JSON.parse(raw(trade));
    payload.data[1].values[0].value = '0';
    payload.data[1].values[2].value = '-123';
    payload.data[1].values.push({ _id: 'unrelated', i_showname: '出口总值累计值 (千美元)', value: '999' });
    const rows = parse(trade, JSON.stringify(payload)).candidates.filter((row) => row.observationPeriod === '2026-08');
    assert.equal(rows.length, 3);
    assert.equal(rows[0].value, 0);
    assert.equal(rows[0].availability, 'extracted');
    assert.equal(rows[2].value, -0.123);
  });

  it('runs the real offline CLI on a retained provider response', () => {
    const result = spawnSync(process.execPath, [
      fileURLToPath(new URL('../scripts/china-macro/extract-nbs-national-data.mjs', import.meta.url)),
      fileURLToPath(new URL(trade, directory)),
      manifest.responses[trade].retrievedAt,
    ], { encoding: 'utf8', env: { PATH: process.env.PATH } });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.canonicalEligible, false);
    assert.equal(output.candidates.length, 6);
    assert.equal(output.contentHash, manifest.responses[trade].contentHash);
  });
});
