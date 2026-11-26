// Western Balkan grid feeds (#10051): EMS (Serbia), NOS BiH (Bosnia and
// Herzegovina) and MEPSO (North Macedonia). Fixtures are unmodified provider
// responses captured on 2026-11-26 (see tests/fixtures/regional-energy/README.md);
// MEPSO's PDF is stored as its extracted text items.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fetchRegionalEnergyFeed } from '../scripts/_regional-energy-source.mjs';
import feeds from '../scripts/shared/regional-energy-feeds.json' with { type: 'json' };
import {
  localDay, localDayStart, wallClockUtc, emsJson, emsLiveUrl, emsRealisedUrl, parseEmsLive, parseEmsRealised,
  NOSBIH_AJAX_URL, nosbihForm, parseNosbih, MEPSO_HOME_URL, discoverMepsoPdfs, parseMepso,
} from '../scripts/lib/regional-energy-feeds.mjs';

const raw = name => readFileSync(new URL(`./fixtures/regional-energy/${name}`, import.meta.url), 'utf8');
const json = name => JSON.parse(raw(name));
const NOW = Date.parse('2026-11-26T03:11:00Z');
const at = (points, metric, period, area = '') => {
  const hits = points.filter(p => p.metric === metric && p.period === period && p.area === area);
  assert.equal(hits.length, 1, `${metric} ${period} ${area}`);
  return hits[0].value;
};

describe('Central European local days', () => {
  it('starts a day at local midnight in winter and summer time', () => {
    assert.equal(new Date(localDayStart('2026-11-25')).toISOString(), '2026-11-24T23:00:00.000Z');
    assert.equal(new Date(localDayStart('2026-07-01')).toISOString(), '2026-06-30T22:00:00.000Z');
    assert.equal(new Date(localDayStart('2026-03-28')).toISOString(), '2026-03-27T23:00:00.000Z', 'the day before the change is 24 hours');
  });
  it('refuses the 23- and 25-hour days', () => {
    assert.equal(localDayStart('2026-03-29'), null);
    assert.equal(localDayStart('2026-10-25'), null);
  });
  it('drops wall-clock times the change skips or repeats', () => {
    const iso = (day, minutes) => { const t = wallClockUtc(day, minutes); return t === null ? null : new Date(t).toISOString(); };
    assert.equal(iso('2026-03-29', 120), null, '02:00 does not exist in spring');
    assert.equal(iso('2026-03-29', 180), '2026-03-29T01:00:00.000Z');
    assert.equal(iso('2026-10-25', 120), null, '02:00 occurs twice in autumn');
    assert.equal(iso('2026-10-25', 180), '2026-10-25T02:00:00.000Z');
    assert.equal(iso('2026-11-25', 1440), '2026-11-25T23:00:00.000Z', 'midnight ending the day');
  });
  it('names the local calendar day', () => {
    assert.equal(localDay(Date.parse('2026-11-25T22:59:59Z')), '2026-11-25');
    assert.equal(localDay(Date.parse('2026-11-25T23:00:00Z')), '2026-11-26');
  });
});

describe('EMS Serbia hourly load', () => {
  it('reads today\'s operational hours as provisional load from local midnight', () => {
    const points = parseEmsLive(emsJson(raw('ems-live-2026-11-26.json')), '2026-11-26');
    assert.equal(points.length, 3);
    assert.ok(points.every(p => p.metric === 'demand' && p.unit === 'MW' && p.area === 'provisional'));
    assert.equal(at(points, 'demand', '2026-11-25T23:00:00.000Z', 'provisional'), 4605.65);
    assert.equal(at(points, 'demand', '2026-11-26T01:00:00.000Z', 'provisional'), 4060.72);
  });

  it('treats the PHP notice and null of a day without live values as no data', () => {
    assert.match(raw('ems-live-2026-11-25.txt'), /Notice/);
    assert.deepEqual(parseEmsLive(emsJson(raw('ems-live-2026-11-25.txt')), '2026-11-25'), []);
    assert.throws(() => emsJson('<b>Fatal error</b>'), /Invalid EMS response/);
  });

  it('reads only the realised row of a consolidated day, hour 1 to 24', () => {
    const points = parseEmsRealised(emsJson(raw('ems-realised-2026-11-24.json')), '2026-11-24');
    assert.equal(points.length, 24);
    assert.equal(at(points, 'demand', '2026-11-23T23:00:00.000Z'), 4419);
    assert.equal(at(points, 'demand', '2026-11-24T22:00:00.000Z'), 4716);
    assert.ok(points.every(p => p.value > 0), 'the unlabelled signed row is not read');
    assert.deepEqual(parseEmsRealised(emsJson(raw('ems-realised-2026-11-25.json')), '2026-11-25'), [], 'not yet consolidated');
  });

  it('skips the DST change day, whose shifted hour is summed', () => {
    const payload = emsJson(raw('ems-realised-2026-10-25.json'));
    assert.equal(payload[1][0].S03, 6429);
    assert.deepEqual(parseEmsRealised(payload, '2026-10-25'), []);
  });

  it('fails closed on changed rows and implausible load', () => {
    const live = emsJson(raw('ems-live-2026-11-26.json'));
    assert.throws(() => parseEmsLive(live, '2026-11-25'), /Changed EMS live load row/);
    assert.throws(() => parseEmsLive([live[1], live[0]], '2026-11-26'), /Changed EMS live load row/);
    assert.throws(() => parseEmsLive([{ ...live[0], time: '2026-11-26 24:00:00' }], '2026-11-26'), /Changed EMS live load row/);
    assert.throws(() => parseEmsLive([{ ...live[0], value: 99999 }], '2026-11-26'), /Implausible EMS load/);
    const realised = emsJson(raw('ems-realised-2026-11-24.json'));
    const { S24, ...short } = realised[1][0];
    assert.throws(() => parseEmsRealised([realised[0], [short]], '2026-11-24'), /Changed EMS realised load row/);
  });
});

describe('NOS BiH hourly production and consumption', () => {
  it('reads actual production and consumption, placing hour-ending labels at their start', () => {
    const points = parseNosbih(json('nosbih-2026-11-24.json'), '2026-11-24');
    assert.equal(points.length, 48);
    assert.equal(at(points, 'generation', '2026-11-23T23:00:00.000Z'), 1497.87, '01:00 is the first hour');
    assert.equal(at(points, 'demand', '2026-11-23T23:00:00.000Z'), 1254.24);
    assert.equal(at(points, 'demand', '2026-11-24T22:00:00.000Z'), 1468.67, '00:00 is the last hour');
    assert.ok(!points.some(p => p.value === 1530), 'planned production is not read');
  });

  it('publishes only the hours already metered today', () => {
    const points = parseNosbih(json('nosbih-2026-11-26.json'), '2026-11-26');
    assert.equal(points.length, 6);
    assert.equal(at(points, 'generation', '2026-11-26T01:00:00.000Z'), 1856.37);
  });

  it('places DST change days by their wall-clock labels, dropping the repeated hour', () => {
    // Spring: 23 rows, "02:00" absent; "03:00" ends at 03:00 CEST.
    const spring = parseNosbih(json('nosbih-2026-03-29.json'), '2026-03-29');
    assert.equal(spring.length, 46);
    assert.equal(at(spring, 'generation', '2026-03-28T23:00:00.000Z'), 1671.3);
    assert.equal(at(spring, 'generation', '2026-03-29T00:00:00.000Z'), 1658.02, 'the "03:00" row follows directly');
    assert.equal(at(spring, 'generation', '2026-03-29T21:00:00.000Z'), 1647.27, '"00:00" is the last hour');
    // Autumn: the provider prints 23 rows for a 25-hour day; "02:00" ends twice and is dropped.
    const autumn = parseNosbih(json('nosbih-2026-10-25.json'), '2026-10-25');
    assert.equal(autumn.length, 44);
    assert.equal(at(autumn, 'generation', '2026-10-24T22:00:00.000Z'), 1304.63);
    assert.ok(!autumn.some(p => p.value === 1162.29), 'the ambiguous 02:00 row');
    assert.equal(at(autumn, 'generation', '2026-10-25T21:00:00.000Z'), 1409.11);
  });

  it('fails closed on a changed table', () => {
    const dst = json('nosbih-2026-10-25.json');
    assert.throws(() => parseNosbih({ ...dst, success: false }, '2026-10-25'), /Invalid NOS BiH response/);
    const day = json('nosbih-2026-11-24.json');
    assert.throws(() => parseNosbih({ ...day, data: day.data.replace('Actual consumption', 'Consumption') }, '2026-11-24'), /Changed NOS BiH production columns/);
    assert.throws(() => parseNosbih({ ...day, data: day.data.replace('>05:00<', '>02:00<') }, '2026-11-24'), /Changed NOS BiH hour row/);
    assert.throws(() => parseNosbih({ ...day, data: day.data.replace('1497.87', '99999') }, '2026-11-24'), /Implausible NOS BiH load/);
    const without = (data, labels) => labels.reduce((d, l) => d.replace(new RegExp(`<tr>\\s*<td class="production-time">${l}[\\s\\S]*?</tr>`), ''), data);
    assert.equal(parseNosbih({ ...day, data: without(day.data, ['00:00']) }, '2026-11-24').length, 46, 'a 23-row table is a DST day shape');
    assert.throws(() => parseNosbih({ ...day, data: without(day.data, ['23:00', '00:00']) }, '2026-11-24'), /Changed NOS BiH hours/);
  });
});

describe('MEPSO North Macedonia daily energy report', () => {
  const items = json('mepso-items-2026-11-23.json');
  const edit = (from, to) => items.map(i => (i.text === from ? { ...i, text: to } : i));

  it('finds the daily reports newest first, with or without a space before .pdf', () => {
    const reports = discoverMepsoPdfs(raw('mepso-home.html'));
    assert.equal(reports.length, 10);
    assert.deepEqual(reports.slice(0, 2).map(r => r.day), ['2026-11-23', '2026-11-22']);
    assert.ok(reports[0].url.startsWith('https://www.mepso.com.mk/files/mk/dnevni/'));
    assert.ok(reports.some(r => r.day === '2026-11-17'), 'the "17.11.2026 .pdf" link');
    assert.throws(() => discoverMepsoPdfs('<a href="/files/mk/mesecni/x.pdf">'), /Missing MEPSO daily report/);
    assert.throws(() => discoverMepsoPdfs(`<a href="/files/mk/dnevni/Info 24.11.2026.pdf">\n${raw('mepso-home.html')}`), /Changed MEPSO daily report link/, 'a renamed newest report is not skipped silently');
  });

  it('publishes daily output by source, delivered energy and net cross-border flow in MWh', () => {
    const points = parseMepso(items, '2026-11-23');
    const value = metric => at(points, metric, '2026-11-23');
    assert.ok(points.every(p => p.unit === 'MWh'));
    assert.equal(value('energy.hydro'), 2100);
    assert.equal(value('energy.thermal'), 4543.5);
    assert.equal(value('energy.gas'), 4691.4);
    assert.equal(value('energy.wind'), 1924.6);
    assert.equal(value('energy.solar'), 231.9);
    assert.equal(value('energy.consumed'), 19255.6);
    assert.equal(value('energy.exchange.net'), 5295, '15,150.5 in less 9,855.5 out');
    assert.equal(points.length, 7);
  });

  it('fails closed when a row does not add up, the balance breaks or the layout changes', () => {
    assert.throws(() => parseMepso(edit('2.100,0', '2.200,0'), '2026-11-23'), /MEPSO row ВКУПНО ХЕЦ does not add up/);
    assert.throws(() => parseMepso(edit('19.255,6', '9.255,6').map(i => (i.text === '721,2' ? { ...i, text: '-9.278,8' } : i)), '2026-11-23'), /energy balance does not add up/);
    assert.throws(() => parseMepso(edit('ВКУПНО ГАС', 'ГАС'), '2026-11-23'), /Changed MEPSO row ВКУПНО ГАС/);
    assert.throws(() => parseMepso(edit('4.543,5', '4543.5'), '2026-11-23'), /Changed MEPSO figure/);
    assert.throws(() => parseMepso(edit('13:00', '13:30'), '2026-11-23'), /Changed MEPSO hour columns/);
    assert.throws(() => parseMepso(items, '2026-11-22'), /does not match its link/);
    assert.throws(() => parseMepso(edit('23.11.2026', '25.10.2026'), '2026-10-25'), /covers a DST change day/);
  });
});

describe('Balkan grid feeds through the regional source', () => {
  const ua = options => assert.match(options.headers['User-Agent'], /^WorldMonitor\/1\.0/);

  it('registers the three feeds', () => {
    assert.deepEqual(['ems', 'nosbih', 'mepso'].map(id => feeds.find(f => f.id === id)?.countryCode), ['RS', 'BA', 'MK']);
  });

  it('EMS reads today live and the newest consolidated day before it', async () => {
    const served = {
      [emsLiveUrl('2026-11-26')]: raw('ems-live-2026-11-26.json'),
      [emsRealisedUrl('2026-11-25')]: raw('ems-realised-2026-11-25.json'),
      [emsRealisedUrl('2026-11-24')]: raw('ems-realised-2026-11-24.json'),
    };
    const calls = [];
    const fetchFn = async (url, options) => {
      ua(options);
      calls.push(url);
      if (!(url in served)) throw new Error(`unexpected request ${url}`);
      return new Response(served[url], { headers: { 'content-type': 'text/html; charset=UTF-8' } });
    };
    const data = await fetchRegionalEnergyFeed('ems', { fetchFn, nowMs: NOW });
    assert.deepEqual(calls, Object.keys(served));
    assert.equal(data.observations.filter(p => p.area === 'provisional').length, 3);
    assert.equal(data.observations.filter(p => p.area === '').length, 8, 'the snapshot keeps each series\' newest eight hours');
    assert.equal(data.observedAt, '2026-11-26T01:00:00.000Z');
  });

  it('EMS still publishes after local midnight, before today has a metered hour', async () => {
    // 00:30 local on 26 November: no live hours yet, 25 November not consolidated.
    const served = {
      [emsLiveUrl('2026-11-26')]: raw('ems-live-2026-11-25.txt'),
      [emsRealisedUrl('2026-11-25')]: raw('ems-realised-2026-11-25.json'),
      [emsRealisedUrl('2026-11-24')]: raw('ems-realised-2026-11-24.json'),
    };
    const fetchFn = async url => new Response(served[url] ?? 'unexpected', { status: url in served ? 200 : 500 });
    const data = await fetchRegionalEnergyFeed('ems', { fetchFn, nowMs: Date.parse('2026-11-25T23:30:00Z') });
    assert.equal(data.observations.length, 8);
    assert.ok(data.observations.every(p => p.area === ''));
    assert.equal(data.observedAt, '2026-11-24T22:00:00.000Z');
  });

  it('NOS BiH posts yesterday and today with Connection: close', async () => {
    const forms = [];
    const fetchFn = async (url, options) => {
      ua(options);
      assert.equal(url, NOSBIH_AJAX_URL);
      assert.equal(options.method, 'POST');
      assert.equal(options.headers.Connection, 'close', 'the server only ends a body by closing the connection');
      forms.push(options.body);
      const day = options.body === nosbihForm('2026-11-26') ? '2026-11-26' : '2026-11-25';
      return new Response(raw(day === '2026-11-26' ? 'nosbih-2026-11-26.json' : 'nosbih-2026-11-24.json').replaceAll('24.11.2026', '25.11.2026'));
    };
    // Yesterday's fixture is 24 November's table served for 25 November.
    const data = await fetchRegionalEnergyFeed('nosbih', { fetchFn, nowMs: NOW });
    assert.deepEqual(forms, [nosbihForm('2026-11-25'), nosbihForm('2026-11-26')]);
    assert.equal(decodeURIComponent(forms[1]), 'action=production&production=date=26.11.2026.');
    assert.equal(data.observedAt, '2026-11-26T01:00:00.000Z');
    assert.equal(data.observations.length, 16);
  });

  it('MEPSO reads the newest report and steps past a DST change day', async () => {
    const items = json('mepso-items-2026-11-23.json');
    const read = [];
    const serve = home => async (url, options) => {
      ua(options);
      read.push(decodeURIComponent(url));
      return new Response(url === MEPSO_HOME_URL ? home : 'pdf');
    };
    const dated = day => items.map(i => (i.text === '23.11.2026' ? { ...i, text: day } : i));
    const pdfReader = (bytes, url) => (decodeURIComponent(url).includes('25.10.2026') ? dated('25.10.2026') : items);
    const plain = await fetchRegionalEnergyFeed('mepso', { fetchFn: serve(raw('mepso-home.html')), nowMs: NOW, pdfReader });
    assert.equal(plain.observedAt, '2026-11-23T00:00:00.000Z');
    assert.equal(read.length, 2, 'home page and the newest report');

    // A DST-change report listed first is skipped for the next one.
    read.length = 0;
    const home = ['25.10.2026', '24.10.2026 '].map(day => `<a href="/files/mk/dnevni/Информација за ${day}.pdf">x</a>`).join('\n');
    const stepped = await fetchRegionalEnergyFeed('mepso', { fetchFn: serve(home), nowMs: NOW, pdfReader: (bytes, url) => dated(decodeURIComponent(url).match(/(\d{2}\.\d{2}\.2026)/)[1]) });
    assert.equal(stepped.observedAt, '2026-10-24T00:00:00.000Z');
    assert.equal(read.length, 3, 'home page, the DST report and the one before it');
    assert.equal(stepped.observations.length, 7);
    await assert.rejects(fetchRegionalEnergyFeed('mepso', { fetchFn: serve(raw('mepso-home.html')), nowMs: NOW, pdfReader: () => dated('22.11.2026') }), /does not match its link/, 'other faults are not skipped');
  });
});
