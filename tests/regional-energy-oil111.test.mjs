// Taiwan MOEA Energy Administration oil111 county surveys (#10113). Fixtures are
// the unmodified responses of 2026-11-26 (week 2026-11-15 to 21; LPG month
// 2026-11); expected means were computed from them independently (see
// tests/fixtures/regional-energy/README.md).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fetchRegionalEnergyFeed } from '../scripts/_regional-energy-source.mjs';
import feeds from '../scripts/shared/regional-energy-feeds.json' with { type: 'json' };
import { OIL111_REQUESTS, parseOil111Survey } from '../scripts/lib/regional-fuel-feeds.mjs';

const FILES = { 'Unleaded 92': '92', 'Unleaded 95': '95', 'Unleaded 98': '98', 'Super diesel': 'diesel', 'LPG 20 kg cylinder': 'lpg' };
const fixture = request => JSON.parse(readFileSync(new URL(`./fixtures/regional-energy/oil111-${FILES[request.product]}.json`, import.meta.url), 'utf8'));
const NOW = Date.parse('2026-11-26T06:00:00Z');
const [U92, , U98, , LPG] = OIL111_REQUESTS;
const at = (points, area) => {
  const hits = points.filter(p => p.area === area);
  assert.equal(hits.length, 1, area);
  return hits[0];
};

describe('Taiwan oil111 county surveys', () => {
  it('publishes the station-weighted national and county means for the survey week', () => {
    const points = parseOil111Survey(fixture(U92), U92, NOW);
    assert.ok(points.every(p => p.metric === 'fuel.retail_price' && p.unit === 'TWD/l' && p.period === '2026-11-21'));
    assert.equal(at(points, 'Unleaded 92').value, 31.11);
    assert.equal(at(points, 'Unleaded 92; Taipei City').value, 31.2);
    assert.equal(at(points, 'Unleaded 92; Penghu County').value, 29.7, 'offshore group only');
    // Kinmen and Lienchiang survey no 92 stations: omitted, not zero.
    assert.equal(points.filter(p => /Kinmen|Lienchiang/.test(p.area)).length, 0);
    assert.equal(points.length, 21);
  });

  it('weights a county across plain, offshore and mountain groups by surveyed stations', () => {
    const payload = fixture(U98);
    const row = payload.data.gasoline.find(r => r.City === '臺北市');
    Object.assign(row, { Aavg: 30, Asnum: 3, Bavg: 40, Bsnum: 1, Cavg: null, Csnum: 0 });
    assert.equal(at(parseOil111Survey(payload, U98, NOW), 'Unleaded 98; Taipei City').value, 32.5);
  });

  it('dates the monthly LPG survey to its month and prices it per 20 kg cylinder', () => {
    const points = parseOil111Survey(fixture(LPG), LPG, NOW);
    assert.ok(points.every(p => p.unit === 'TWD/20kg' && p.period === '2026-11-01'));
    assert.equal(at(points, 'LPG 20 kg cylinder').value, 768.01);
    assert.equal(at(points, 'LPG 20 kg cylinder; Taipei City').value, 844);
    assert.equal(at(points, 'LPG 20 kg cylinder; Lienchiang County').value, 1000);
  });

  it('fails closed on changed titles, weeks, counties or groups, future surveys and thin samples', () => {
    const changed = mutate => { const p = fixture(U92); mutate(p); return () => parseOil111Survey(p, U92, NOW); };
    assert.throws(changed(p => { p.data.title = '各縣市95無鉛汽油週均價'; }), /Changed oil111 Unleaded 92 survey/);
    assert.throws(changed(p => { p.res = '02'; }), /Changed oil111/);
    assert.throws(changed(p => { p.data.start = '2026/11/15 ~ 2026/11/22'; }), /Changed oil111 Unleaded 92 week/);
    assert.throws(changed(p => { p.data.gasoline[0].City = '台北'; }), /Changed oil111 county/);
    assert.throws(changed(p => { p.data.gasoline[0].SurDate = '2026/11/08 ~ 2026/11/14'; }), /Changed oil111 Unleaded 92 survey/);
    assert.throws(changed(p => { p.data.gasoline[0].Asnum = 1.5; }), /Changed oil111 survey groups/);
    assert.throws(changed(p => { p.data.gasoline[0].Aavg = 310; }), /Implausible oil111 price/);
    // A dropped count field is a changed response, not an empty group.
    assert.throws(changed(p => { delete p.data.Bnum; }), /Changed oil111 survey groups/);
    assert.throws(changed(p => { delete p.data.gasoline[0].Asnum; }), /Changed oil111 survey groups/);
    // Each counted group is checked before weighting: -10 and 40 would average to a plausible 35.
    assert.throws(changed(p => { Object.assign(p.data.gasoline[0], { Aavg: -10, Asnum: 1, Bavg: 40, Bsnum: 9, Cavg: null, Csnum: 0 }); }), /Implausible oil111 price/);
    assert.throws(changed(p => { p.data.gasoline.push({ ...p.data.gasoline[0] }); }), /Duplicate oil111 county/);
    assert.throws(changed(p => { p.data.gasoline.forEach((r, i) => { if (i > 13) for (const g of 'ABC') r[`${g}snum`] = 0; }); }), /Incomplete oil111 Unleaded 92 county survey/);
    assert.throws(() => parseOil111Survey(fixture(U92), U92, Date.parse('2026-11-20T00:00:00Z')), /Future oil111/);
    assert.throws(() => parseOil111Survey(fixture(LPG), LPG, Date.parse('2026-10-31T15:00:00Z')), /Future oil111/);
    assert.equal(parseOil111Survey(fixture(LPG), LPG, Date.parse('2026-10-31T16:00:00Z')).length, 23, 'already 1 November in Taipei');
  });

  it('posts each survey form to oil111 and builds one snapshot', async () => {
    const feed = feeds.find(f => f.id === 'oil111');
    assert.equal(feed.countryCode, 'TW');
    const calls = [];
    const fetchFn = async (url, options) => {
      assert.match(options.headers['User-Agent'], /^WorldMonitor\/1\.0/);
      assert.equal(options.method, 'POST');
      const request = OIL111_REQUESTS.find(r => r.url === url && r.form === options.body);
      if (!request) throw new Error(`unexpected request ${url} ${options.body}`);
      calls.push(request.product);
      return new Response(JSON.stringify(fixture(request)));
    };
    const data = await fetchRegionalEnergyFeed('oil111', { fetchFn, nowMs: NOW });
    assert.deepEqual(calls, Object.keys(FILES));
    assert.equal(data.sourceId, 'oil111');
    assert.equal(data.observations.length, 21 + 23 + 21 + 23 + 23);
    assert.equal(at(data.observations, 'Super diesel').value, 29.74);
    assert.equal(at(data.observations, 'Unleaded 95').value, 32.54);
  });
});
