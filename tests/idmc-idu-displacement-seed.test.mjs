import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  buildEvents,
  contentMeta,
  fetchIduDisplacement,
  MAX_MISSING_COUNTRIES,
  MIN_COUNTRIES,
  parseIduCsv,
  summarizeCountries,
  validate,
} from '../scripts/seed-idmc-idu-displacement.mjs';

const NOW = Date.parse('2026-10-20T12:00:00Z');

const HEADER = 'id,country,iso3,latitude,longitude,centroid,role,displacement_type,qualifier,figure,displacement_date,displacement_start_date,displacement_end_date,year,event_id,event_name,event_codes,event_code_types,event_start_date,event_end_date,category,subcategory,type,subtype,old_id,sources,source_url,locations_name,locations_coordinates,locations_accuracy,locations_type,displacement_occurred,created_at,description,link,combined_type';

function row(overrides = {}) {
  return {
    id: '511435',
    country: 'Sudan',
    iso3: 'SDN',
    latitude: '12.14815',
    longitude: '30.79482',
    role: 'Recommended figure',
    displacement_type: 'Disaster',
    qualifier: 'approximately',
    figure: '813',
    displacement_date: '2026-10-01',
    displacement_start_date: '2026-10-01',
    displacement_end_date: '2026-10-01',
    event_id: '80532',
    event_name: 'Sudan: Flood - South Kordofan',
    category: 'Weather related',
    type: 'Flood',
    sources: 'IOM Displacement Tracking Matrix (IOM DTM)',
    locations_name: 'Abu Kershola locality, South Kordofan.',
    locations_accuracy: 'State/Region/Province (ADM1)',
    created_at: '2026-10-15T09:57:41.268376Z',
    ...overrides,
  };
}

function csv(rows) {
  const columns = HEADER.split(',');
  const cell = (value) => {
    const s = String(value ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [HEADER, ...rows.map((r) => columns.map((c) => cell(r[c])).join(','))].join('\n');
}

describe('parseIduCsv', () => {
  it('reads quoted fields that hold commas and line breaks', () => {
    const [parsed] = parseIduCsv(csv([row({ event_name: 'Sudan: "Flood", Kordofan\nupdate' })]));
    assert.equal(parsed.event_name, 'Sudan: "Flood", Kordofan\nupdate');
    assert.equal(parsed.figure, '813');
  });

  it('reads a file that starts with a byte-order mark', () => {
    const [parsed] = parseIduCsv(String.fromCharCode(0xfeff) + csv([row()]));
    assert.equal(parsed.id, '511435');
  });

  it('rejects a file whose columns changed', () => {
    assert.throws(() => parseIduCsv('id,country,figure\n1,Sudan,5'), /missing columns: iso3/);
  });
});

describe('buildEvents', () => {
  it('counts recommended figures and drops triangulation rows of the same displacement', () => {
    const events = buildEvents([row(), row({ id: '2', role: 'Triangulation', figure: '900' })], { nowMs: NOW });
    assert.deepEqual(events.map((e) => e.id), ['511435']);
    assert.deepEqual(events[0].location, { latitude: 12.14815, longitude: 30.79482 });
    assert.equal(events[0].createdAt, '2026-10-15');
  });

  it('keeps the last 180 days only, because the files reach back to 2025', () => {
    const events = buildEvents([
      row({ id: 'old', displacement_date: '2026-04-22' }),
      row({ id: 'edge', displacement_date: '2026-04-23' }),
      row({ id: 'future', displacement_date: '2026-10-21' }),
    ], { nowMs: NOW });
    assert.deepEqual(events.map((e) => e.id), ['edge']);
  });

  it('skips rows without a positive figure or a country code, and omits an unusable point', () => {
    const events = buildEvents([
      row({ id: 'zero', figure: '0' }),
      row({ id: 'nan', figure: 'n/a' }),
      row({ id: 'noiso', iso3: '' }),
      row({ id: 'nopoint', latitude: '', longitude: '' }),
    ], { nowMs: NOW });
    assert.deepEqual(events.map((e) => e.id), ['nopoint']);
    assert.equal(events[0].location, undefined);
  });

  it('sorts newest displacement first, then largest', () => {
    const events = buildEvents([
      row({ id: 'a', displacement_date: '2026-09-01', figure: '10' }),
      row({ id: 'b', displacement_date: '2026-10-01', figure: '5' }),
      row({ id: 'c', displacement_date: '2026-10-01', figure: '50' }),
    ], { nowMs: NOW });
    assert.deepEqual(events.map((e) => e.id), ['c', 'b', 'a']);
  });
});

describe('summarizeCountries', () => {
  const events = (rows) => buildEvents(rows, { nowMs: NOW });

  it('flags a surge when the last 30 days reach three times the monthly baseline', () => {
    // Baseline: 15,000 over the 150 days before the window = 3,000 a month.
    const [sdn] = summarizeCountries(events([
      row({ id: 'base', displacement_date: '2026-06-01', figure: '15000' }),
      row({ id: 'conflict', displacement_date: '2026-10-05', figure: '6000', displacement_type: 'Conflict' }),
      row({ id: 'flood', displacement_date: '2026-10-10', figure: '3000' }),
    ]), { nowMs: NOW });
    assert.equal(sdn.baselineMonthly, 3000);
    assert.equal(sdn.displaced30d, 9000);
    assert.equal(sdn.conflict30d, 6000);
    assert.equal(sdn.disaster30d, 3000);
    assert.equal(sdn.events30d, 2);
    assert.equal(sdn.latestDisplacementDate, '2026-10-10');
    assert.equal(sdn.surge, true);
  });

  it('does not flag a country whose recent figure is under three times its baseline', () => {
    const [sdn] = summarizeCountries(events([
      row({ id: 'base', displacement_date: '2026-06-01', figure: '15001' }),
      row({ id: 'recent', displacement_date: '2026-10-05', figure: '9000' }),
    ]), { nowMs: NOW });
    assert.equal(sdn.surge, false);
  });

  it('does not flag small numbers even with no baseline', () => {
    const [sdn] = summarizeCountries(events([row({ figure: '4999' })]), { nowMs: NOW });
    assert.equal(sdn.baselineMonthly, 0);
    assert.equal(sdn.surge, false);
  });

  it('counts newly reported figures by publication date, whatever the displacement date', () => {
    const [sdn] = summarizeCountries(events([
      row({ id: 'late', displacement_date: '2026-08-01', created_at: '2026-10-14T00:00:00Z', figure: '700' }),
      row({ id: 'old', displacement_date: '2026-10-01', created_at: '2026-10-12T00:00:00Z', figure: '300' }),
    ]), { nowMs: NOW });
    assert.equal(sdn.newlyReported7d, 700);
  });
});

describe('validate and contentMeta', () => {
  it('requires the minimum country count', () => {
    const countries = (n) => Array.from({ length: n }, (_, i) => ({ countryCode: `C${i}` }));
    assert.equal(validate({ events: [], countries: countries(MIN_COUNTRIES) }), true);
    assert.equal(validate({ events: [], countries: countries(MIN_COUNTRIES - 1) }), false);
    assert.equal(validate(null), false);
  });

  it('dates content by publication', () => {
    const meta = contentMeta({ events: [{ createdAt: '2026-10-19' }, { createdAt: '2026-05-01' }] }, NOW);
    assert.equal(meta.newestItemAt, Date.parse('2026-10-19'));
    assert.equal(meta.oldestItemAt, Date.parse('2026-05-01'));
  });
});

describe('fetchIduDisplacement', () => {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  afterEach(() => { globalThis.fetch = originalFetch; console.warn = originalWarn; });

  const pkg = (iso3, url = `https://hdx.test/${iso3}.csv`) => ({
    name: `${iso3}-idmc-idu-events`,
    resources: url ? [{ format: 'CSV', url }] : [],
  });

  function stub(packages, files, { count = packages.length } = {}) {
    const calls = [];
    globalThis.fetch = async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('package_search')) return Response.json({ success: true, result: { count, results: packages } });
      if (url in files) return files[url] instanceof Response ? files[url] : new Response(files[url]);
      return new Response('missing', { status: 404 });
    };
    return calls;
  }

  it('reads every IDU dataset of the IDMC organisation and ignores its other datasets', async () => {
    const calls = stub(
      [pkg('sdn'), pkg('afg'), { name: 'idmc-idp-data-sdn', resources: [{ format: 'CSV', url: 'https://hdx.test/idp.csv' }] }],
      {
        'https://hdx.test/sdn.csv': csv([row()]),
        'https://hdx.test/afg.csv': csv([row({ id: '9', iso3: 'AFG', country: 'Afghanistan' })]),
      },
    );
    const data = await fetchIduDisplacement({ nowMs: NOW });
    const search = new URL(calls[0]);
    assert.equal(search.searchParams.get('fq'), 'organization:international-displacement-monitoring-centre-idmc');
    assert.ok(!calls.includes('https://hdx.test/idp.csv'));
    assert.deepEqual(data.countries.map((c) => c.countryCode).sort(), ['AFG', 'SDN']);
    assert.equal(data.windowFrom, '2026-04-23');
    assert.deepEqual(data.missingCountries, []);
  });

  it('fails when HDX truncates the dataset listing', async () => {
    stub([pkg('sdn')], {}, { count: 1001 });
    await assert.rejects(fetchIduDisplacement({ nowMs: NOW }), /truncated: 1 of 1001/);
  });

  it(`skips up to ${MAX_MISSING_COUNTRIES} unreadable country files and reports them`, async () => {
    console.warn = () => {};
    stub(
      [pkg('sdn'), pkg('afg', null), pkg('eth'), pkg('yem')],
      {
        'https://hdx.test/sdn.csv': csv([row()]),
        'https://hdx.test/eth.csv': 'id,country\n1,Ethiopia',
      },
    );
    const data = await fetchIduDisplacement({ nowMs: NOW });
    assert.deepEqual(data.missingCountries, ['AFG', 'ETH', 'YEM']);
    assert.equal(data.events.length, 1);
  });

  it('fails the run when more country files are unreadable than that', async () => {
    console.warn = () => {};
    stub([pkg('sdn', null), pkg('afg', null), pkg('eth', null), pkg('yem', null)], {});
    await assert.rejects(fetchIduDisplacement({ nowMs: NOW }), /4 of 4 country files failed \(AFG, ETH, SDN, YEM\)/);
  });
});
