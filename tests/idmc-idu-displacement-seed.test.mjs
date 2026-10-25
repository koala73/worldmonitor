import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  buildEvents,
  isAllowedHdxUrl,
  normalizeEvents,
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
      row({ id: 'old', displacement_date: '2026-04-23' }),
      row({ id: 'edge', displacement_date: '2026-04-24' }),
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
  const events = (rows) => normalizeEvents(rows, { nowMs: NOW });

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

  it('counts newly reported figures over the last 7 dates by publication date', () => {
    const [sdn] = summarizeCountries(events([
      row({ id: 'late', displacement_date: '2026-08-01', created_at: '2026-10-14T00:00:00Z', figure: '700' }),
      row({ id: 'old', displacement_date: '2026-10-01', created_at: '2026-10-13T23:59:59Z', figure: '300' }),
    ]), { nowMs: NOW });
    assert.equal(sdn.newlyReported7d, 700);
  });

  it('counts a figure published this week for a displacement older than the window, without adding it to the baseline', () => {
    const [sdn] = summarizeCountries(events([
      row({ id: 'ancient', displacement_date: '2025-12-01', created_at: '2026-10-19T00:00:00Z', figure: '40000' }),
    ]), { nowMs: NOW });
    assert.equal(sdn.newlyReported7d, 40000);
    assert.equal(sdn.baselineMonthly, 0);
    assert.equal(sdn.displaced30d, 0);
    assert.equal(sdn.surge, false);
  });

  it('leaves out countries with nothing in the window and nothing newly reported', () => {
    assert.deepEqual(summarizeCountries(events([
      row({ displacement_date: '2025-12-01', created_at: '2026-01-01T00:00:00Z' }),
    ]), { nowMs: NOW }), []);
  });

  it('splits the 30 recent dates from the 150 baseline dates at 2026-09-21', () => {
    const [sdn] = summarizeCountries(events([
      row({ id: 'recent', displacement_date: '2026-09-21', figure: '100' }),
      row({ id: 'baseline', displacement_date: '2026-09-20', figure: '500' }),
      row({ id: 'first', displacement_date: '2026-04-24', figure: '1000' }),
      row({ id: 'outside', displacement_date: '2026-04-23', figure: '99999', created_at: '2026-05-01T00:00:00Z' }),
    ]), { nowMs: NOW });
    assert.equal(sdn.displaced30d, 100);
    assert.equal(sdn.baselineMonthly, 300); // (500 + 1000) / 5 months
  });
});

describe('isAllowedHdxUrl', () => {
  it('accepts HDX and its S3 file store over https', () => {
    assert.equal(isAllowedHdxUrl('https://data.humdata.org/dataset/x/resource/y/download/sdn_idmc_idu_events.csv'), true);
    assert.equal(isAllowedHdxUrl('https://s3.us-east-1.amazonaws.com/hdx-production-filestore/resources/y/sdn.csv?Signature=z'), true);
  });

  it('refuses other hosts, schemes, ports, credentials and buckets', () => {
    for (const url of [
      'http://data.humdata.org/x.csv',
      'https://data.humdata.org:8443/x.csv',
      'https://user:pw@data.humdata.org/x.csv',
      'https://data.humdata.org.evil.test/x.csv',
      'https://169.254.169.254/latest/meta-data/',
      'https://localhost/x.csv',
      'https://s3.us-east-1.amazonaws.com/other-bucket/x.csv',
      'file:///etc/passwd',
      '',
      undefined,
    ]) {
      assert.equal(isAllowedHdxUrl(url), false, String(url));
    }
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

  const pkg = (iso3, url = `https://data.humdata.org/dl/${iso3}.csv`) => ({
    name: `${iso3}-idmc-idu-events`,
    resources: url ? [{ format: 'CSV', url }] : [],
  });

  function stub(packages, files, { count = packages.length } = {}) {
    const calls = [];
    globalThis.fetch = async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('package_search')) return Response.json({ success: true, result: { count, results: packages } });
      if (url in files) {
        const file = typeof files[url] === 'function' ? files[url]() : files[url];
        return file instanceof Response ? file : new Response(file);
      }
      return new Response('missing', { status: 404 });
    };
    return calls;
  }
  const redirect = (location) => () => new Response(null, { status: 302, headers: { location } });

  it('reads every IDU dataset of the IDMC organisation and ignores its other datasets', async () => {
    const calls = stub(
      [pkg('sdn'), pkg('afg'), { name: 'idmc-idp-data-sdn', resources: [{ format: 'CSV', url: 'https://data.humdata.org/dl/idp.csv' }] }],
      {
        'https://data.humdata.org/dl/sdn.csv': csv([row()]),
        'https://data.humdata.org/dl/afg.csv': csv([row({ id: '9', iso3: 'AFG', country: 'Afghanistan' })]),
      },
    );
    const data = await fetchIduDisplacement({ nowMs: NOW });
    const search = new URL(calls[0]);
    assert.equal(search.searchParams.get('fq'), 'organization:international-displacement-monitoring-centre-idmc');
    assert.ok(!calls.includes('https://data.humdata.org/dl/idp.csv'));
    assert.deepEqual(data.countries.map((c) => c.countryCode).sort(), ['AFG', 'SDN']);
    assert.equal(data.windowFrom, '2026-04-24');
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
        'https://data.humdata.org/dl/sdn.csv': csv([row()]),
        'https://data.humdata.org/dl/eth.csv': 'id,country\n1,Ethiopia',
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

  it('follows the download redirect to the HDX file store', async () => {
    const s3 = 'https://s3.us-east-1.amazonaws.com/hdx-production-filestore/resources/r/sdn.csv?Signature=s';
    const calls = stub([pkg('sdn')], {
      'https://data.humdata.org/dl/sdn.csv': redirect(s3),
      [s3]: csv([row()]),
    });
    const data = await fetchIduDisplacement({ nowMs: NOW });
    assert.equal(data.events.length, 1);
    assert.ok(calls.includes(s3));
  });

  it('never requests a resource URL or redirect target outside HDX', async () => {
    console.warn = () => {};
    const calls = stub([pkg('sdn'), pkg('afg', 'http://169.254.169.254/latest/meta-data/')], {
      'https://data.humdata.org/dl/sdn.csv': redirect('http://10.0.0.5/internal'),
    });
    const data = await fetchIduDisplacement({ nowMs: NOW });
    assert.deepEqual(data.missingCountries, ['AFG', 'SDN']);
    assert.ok(calls.every((url) => url.startsWith('https://data.humdata.org/')), calls.join(' '));
  });

  it('picks the first HDX-hosted CSV when a dataset also lists an off-site one', async () => {
    stub([{
      name: 'sdn-idmc-idu-events',
      resources: [
        { format: 'CSV', url: 'https://mirror.example.org/sdn.csv' },
        { format: 'CSV', url: 'https://data.humdata.org/dl/sdn.csv' },
      ],
    }], { 'https://data.humdata.org/dl/sdn.csv': csv([row()]) });
    const data = await fetchIduDisplacement({ nowMs: NOW });
    assert.deepEqual(data.missingCountries, []);
    assert.equal(data.events.length, 1);
  });

  it('retries a download whose body breaks mid-stream', async () => {
    const previousDelay = process.env.WM_SEED_RETRY_DELAY_MS;
    process.env.WM_SEED_RETRY_DELAY_MS = '0';
    console.warn = () => {};
    let attempts = 0;
    try {
      stub([pkg('sdn')], {
        'https://data.humdata.org/dl/sdn.csv': () => {
          attempts += 1;
          if (attempts > 1) return csv([row()]);
          return new Response(new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('id,country'));
              controller.error(new Error('socket hang up'));
            },
          }));
        },
      });
      const data = await fetchIduDisplacement({ nowMs: NOW });
      assert.equal(attempts, 2);
      assert.equal(data.events.length, 1);
      assert.deepEqual(data.missingCountries, []);
    } finally {
      if (previousDelay === undefined) delete process.env.WM_SEED_RETRY_DELAY_MS;
      else process.env.WM_SEED_RETRY_DELAY_MS = previousDelay;
    }
  });
});
