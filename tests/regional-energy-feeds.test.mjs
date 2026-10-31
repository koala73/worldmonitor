import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { rootCertificates } from 'node:tls';
import { execFileSync } from 'node:child_process';
import { orderRegionalEnergySections, REGIONAL_ENERGY_LEAD_GROUP_SIZE } from '../scripts/_regional-energy-order.mjs';
import { claimBundleTurn, acknowledgeBundleTurn } from '../scripts/_bundle-turn.mjs';
import { extractBundleSections } from './helpers/bundle-section-parser.mjs';
import { sectionWorstCaseMs, BUNDLE_PREFLIGHT_HEADROOM_MS } from '../scripts/_bundle-runner.mjs';
import { fetchRegionalEnergyFeed, regionalEnergySeedOptions } from '../scripts/_regional-energy-source.mjs';
import feeds from '../scripts/shared/regional-energy-feeds.json' with { type: 'json' };
import { __testing__ as health } from '../api/health.js';
import {
  parsePgcb, parseNiso, parseCammesa, parseEskom, parseOns,
  parseAnpTrade, parseAnpPriceRows, parsePetrobangla, parseGse,
  discoverEskomCsv, discoverGsePdf, discoverPetrobanglaPdf,
  buildFeedSnapshot,
} from '../scripts/lib/regional-energy-feeds.mjs';

const fixture = name => readFileSync(new URL(`./fixtures/regional-energy/${name}`, import.meta.url), 'utf8');
const json = name => JSON.parse(fixture(name));
const point = (rows, metric) => rows.find(r => r.metric === metric);

describe('regional energy source observations', () => {
  it('rejects large unterminated HTML without blocking the worker', () => {
    execFileSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { parsePgcb, parseNiso, discoverPetrobanglaPdf } from './scripts/lib/regional-energy-feeds.mjs';
      for (const token of ['<!--', '<', '<table>', '<tr>', '<td>', '<span id="MainContent_lblCurrentDay">']) {
        const html = token.repeat(Math.ceil(1_000_000 / token.length));
        for (const parse of [parsePgcb, parseNiso, discoverPetrobanglaPdf]) assert.throws(() => parse(html));
      }
      assert.throws(() => parsePgcb('<table>Generation(MW)' + 'Gas'.repeat(350_000) + '</table>'));
    `], { cwd: new URL('../', import.meta.url), timeout: 5000 });
  });

  it('runs every regional feed in its own service and gives each a lead turn after persistent timeouts', () => {
    const source = readFileSync(new URL('../scripts/seed-bundle-regional-energy.mjs', import.meta.url), 'utf8');
    const sections = extractBundleSections(source).map(section => ({ ...section, timeoutMs: Number(section.timeoutMsExpr.replaceAll('_', '')) }));
    assert.deepEqual(sections.map(section => section.label), feeds.map(feed => `Regional-Energy-${feed.id}`));
    for (const feed of feeds) {
      const section = sections.find(s => s.label === `Regional-Energy-${feed.id}`);
      assert.equal(section.script, feed.script);
      assert.equal(Number(section.intervalMsExpr), feed.intervalMin * 60_000);
    }
    assert.match(source, /maxBundleMs: 570_000/);
    assert.match(source, /prefetchFreshness: true/);
    assert.match(source, /claimBundleTurn\('regional-energy'\)/);
    assert.match(source, /onTerminalComplete:[\s\S]*acknowledgeBundleTurn\('regional-energy', claim\)/);

    const energy = readFileSync(new URL('../scripts/seed-bundle-energy-sources.mjs', import.meta.url), 'utf8');
    assert.doesNotMatch(energy, /Regional-Energy-|seed-regional-energy-/, 'regional feeds must not ride the daily energy-sources bundle');
    const registry = JSON.parse(readFileSync(new URL('../scripts/railway-services.json', import.meta.url), 'utf8'));
    const service = registry.find(entry => entry.service === 'seed-bundle-regional-energy');
    assert.equal(service?.entry, 'scripts/seed-bundle-regional-energy.mjs');
    assert.equal(service.cronSchedule, '*/15 * * * *');
    assert.equal(registry.find(entry => entry.service === 'seed-bundle-energy-sources').cronSchedule, undefined);
    for (const feed of feeds) assert.ok(service.watchPatterns.includes(`scripts/${feed.script}`));
    // Health tolerates three intervals; the cron must leave room for a late tick.
    assert.ok(Math.min(...feeds.map(feed => feed.intervalMin)) * 3 >= 3 * 15);

    const groups = Math.ceil(sections.length / REGIONAL_ENERGY_LEAD_GROUP_SIZE);
    const ledWithin = new Map(sections.map(section => [section.label, Infinity]));
    for (let turn = 0; turn < 2 * sections.length; turn++) {
      const ordered = orderRegionalEnergySections(sections, turn);
      assert.equal(new Set(ordered).size, sections.length);
      const lead = ordered.slice(0, REGIONAL_ENERGY_LEAD_GROUP_SIZE);
      const worstCase = lead.reduce((total, section) => total + sectionWorstCaseMs(section), BUNDLE_PREFLIGHT_HEADROOM_MS);
      assert.ok(worstCase <= 560_000, `lead group must fit one tick even when every member times out: ${worstCase}`);
      for (const section of lead) ledWithin.set(section.label, Math.min(ledWithin.get(section.label), turn + 1));
    }
    for (const [label, ticks] of ledWithin) assert.ok(ticks <= groups, `${label} first led after ${ticks} ticks; expected at most ${groups}`);
  });

  it('uses its own durable turn and advances it only on terminal acknowledgement', async () => {
    const commands = [];
    const options = {
      credentials: { restUrl: 'https://redis.example', token: 'fixture' },
      token: 'regional-turn',
      fetchImpl: async (_url, init) => {
        commands.push(JSON.parse(init.body));
        return Response.json({ result: commands.length === 1 ? [1, '2'] : 1 });
      },
    };
    const claim = await claimBundleTurn('regional-energy', options);
    assert.deepEqual(claim, { turn: 2, token: 'regional-turn' });
    assert.equal(commands.length, 1);
    assert.deepEqual(commands[0].slice(3, 5), ['bundle:turn:regional-energy', 'bundle:turn:regional-energy:lease']);
    assert.equal(await acknowledgeBundleTurn('regional-energy', claim, options), true);
    assert.deepEqual(commands[1].slice(3, 5), commands[0].slice(3, 5));
  });

  it('reads PGCB fuel columns without hidden demand or load-shedding cells', () => {
    const rows = parsePgcb(fixture('pgcb.html'));
    assert.equal(point(rows, 'generation').value, 15636);
    assert.equal(point(rows, 'generation.gas').value, 4593);
    assert.equal(point(rows, 'imports.india').value, 1972);
    assert.equal(point(rows, 'imports.nepal').value, 38);
    assert.equal(point(rows, 'generation.solar').value, 0);
    assert.equal(rows[0].period, '2026-10-29T13:30:00.000Z');
    assert.equal(point(rows, 'demand'), undefined);
    assert.equal(point(rows, 'load_shedding'), undefined);
  });

  it('reads dated NISO daily energy separately from peak power', () => {
    const rows = parseNiso(fixture('niso.html'));
    assert.equal(point(rows, 'generation.peak').value, 4365.2);
    assert.equal(point(rows, 'generation.peak').unit, 'MW');
    assert.equal(point(rows, 'energy.generated').value, 100068.34);
    assert.equal(point(rows, 'energy.sent_out').unit, 'MWh');
    assert.equal(rows[0].period, '2026-10-28');
    assert.throws(() => parseNiso('<html>maintenance</html>'));
  });

  it('uses observed CAMMESA demand and generation, excluding forecasts', () => {
    const rows = parseCammesa(json('cammesaDemand.json'), json('cammesaGeneration.json'));
    assert.equal(point(rows, 'demand').value, 15407);
    assert.equal(point(rows, 'generation.hydro').value, 7461.8);
    assert.equal(point(rows, 'imports').value, 0);
    assert.equal(rows[0].period, '2026-10-29T03:00:00.000Z');
    const forecasts = parseCammesa([{ fecha: '2026-10-29T23:00:00-0300', demPrevista: 20000 }], json('cammesaGeneration.json'));
    assert.equal(point(forecasts, 'demand'), undefined);
  });

  it('rejects empty, nonnumeric, and incompatible provider data', () => {
    assert.throws(() => parsePgcb('<table><tr><td>1</td></tr></table>'));
    assert.throws(() => parseCammesa([], []));
    assert.throws(() => parseOns('id_subsistema;wrong\nSIN;1'));
    assert.throws(() => parseAnpTrade('ANO;MÊS\n2026;OUT'));
  });

  it('ignores Eskom forecast and zero demand placeholders while retaining renewable night zeroes', () => {
    const rows = parseEskom(fixture('eskomDemandCsv.csv'), fixture('eskomOutageCsv.csv'), fixture('eskomHourly.csv'));
    assert.ok(rows.some(r => r.metric === 'demand' && r.value > 0));
    assert.ok(!rows.some(r => r.metric === 'demand' && r.period.startsWith('2026-10-30')));
    assert.ok(rows.some(r => r.metric === 'generation.solar_pv' && r.value === 0));
    assert.ok(rows.some(r => r.metric === 'outages.unplanned.average' && r.unit === 'MW'));
    const scientific = parseEskom(fixture('eskomDemandCsv.csv'), fixture('eskomOutageCsv.csv'), 'Date Time Hour Beginning,Wind,PV,CSP,Other RE\n2026-10-27 00:00:00,100,3.0000000000000001E-3,0,0');
    assert.equal(point(scientific, 'generation.solar_pv').value, 0.003);
  });

  it('reads ONS national totals without adding subsystem rows again', () => {
    const rows = parseOns(fixture('onsBalanceCsv.csv'));
    assert.equal(point(rows.filter(r => r.period === '2026-10-28T02:00:00.000Z'), 'demand').value, 82744.42);
    assert.ok(rows.every(r => r.area === 'SIN'));
    assert.ok(rows.some(r => r.metric === 'exchange.net' && r.value < 0));
  });

  it('reads ANP monthly trade in cubic metres without mixing products or USD revenue', () => {
    const rows = parseAnpTrade(fixture('anpTradeCsv.csv'));
    assert.ok(rows.some(r => r.metric === 'fuel.imports' && r.value === 1397657.37 && r.period === '2026-05'));
    assert.ok(rows.every(r => r.unit === 'm3' && r.area === 'ÓLEO DIESEL'));
  });

  it('reads national ANP prices with their own reporting week and units', () => {
    const rows = parseAnpPriceRows([
      ['DATA INICIAL', 'DATA FINAL', 'BRASIL', 'PRODUTO', 'NÚMERO DE POSTOS PESQUISADOS', 'UNIDADE DE MEDIDA', 'PREÇO MÉDIO REVENDA'],
      [new Date('2026-10-18'), new Date('2026-10-24'), 'BRASIL', 'GASOLINA COMUM', 4600, 'R$/l', 6.49],
    ]);
    assert.deepEqual(rows, [{ metric: 'fuel.retail_price', period: '2026-10-24', value: 6.49, unit: 'BRL/l', area: 'GASOLINA COMUM' }]);
  });

  it('reads the Petrobangla reporting day and LNG share of total supply', () => {
    const rows = parsePetrobangla(json('petroPdf.json'));
    assert.equal(point(rows, 'gas.supply').value, 2552.8);
    assert.equal(point(rows, 'gas.lng_supply').value, 973.5);
    assert.ok(Math.abs(point(rows, 'gas.lng_share_of_supply').value - 38.1346) < 0.001);
    assert.equal(rows[0].period, '2026-10-28');
  });

  it('preserves GSE blank months and signed cross-border energy with PDF column positions', () => {
    const rows = parseGse(json('gseEnPdf.json'));
    assert.equal(point(rows.filter(r => r.period === '2026-09'), 'energy.generated').value, 1132.73);
    assert.equal(point(rows.filter(r => r.period === '2026-05'), 'energy.thermal'), undefined);
    assert.equal(point(rows.filter(r => r.period === '2026-06'), 'energy.thermal').value, 1.7);
    assert.ok(rows.some(r => r.metric === 'energy.exchange.net' && r.area === 'Turkey' && r.value < 0));
    assert.ok(!rows.some(r => r.period === '2026-10'));
    assert.ok(rows.every(r => r.unit === 'GWh'));
  });

  it('rejects a GSE page that repeats balance labels without quadratic work', () => {
    execFileSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { readFileSync } from 'node:fs';
      import { parseGse } from './scripts/lib/regional-energy-feeds.mjs';
      const items = JSON.parse(readFileSync('tests/fixtures/regional-energy/gseEnPdf.json', 'utf8'));
      for (let i = 0; i < 40_000; i++) items.push({ text: 'Total Generation', x: 10, y: 1000 + i, width: 50 });
      assert.throws(() => parseGse(items), /Changed GSE balance rows/);
    `], { cwd: new URL('../', import.meta.url), timeout: 5000 });
  });
});

describe('source discovery and publication boundary', () => {
  it('activates each health probe only after publication and freshness writes', async t => {
    const savedEnv = { ...process.env }, savedFetch = globalThis.fetch;
    t.after(() => {
      globalThis.fetch = savedFetch;
      for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
      Object.assign(process.env, savedEnv);
    });
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
    const calls = [];
    globalThis.fetch = async (_url, options) => {
      calls.push(JSON.parse(options.body));
      return Response.json({ result: 'OK' });
    };
    for (const feed of feeds) {
      const name = 'regionalEnergy' + feed.id[0].toUpperCase() + feed.id.slice(1);
      const config = health.SEED_META[name];
      assert.equal(health.STANDALONE_KEYS[name], `energy:regional:${feed.id}:v1`);
      assert.ok(health.ON_DEMAND_KEYS.has(name));
      assert.equal(health.ACTIVATION_MARKERS[name], config.activationKey);
      assert.equal(config.maxStaleMin, feed.intervalMin * 3);
      assert.equal(config.maxContentAgeMin, feed.maxContentAgeMin);
      assert.equal(config.cutover.activationKey, config.activationKey);
      assert.equal(config.cutover.issue, 9842);
      const options = regionalEnergySeedOptions(feed.id);
      assert.equal(options.afterPublish, undefined);
      assert.equal(calls.length, feeds.indexOf(feed));
      await options.afterFreshness();
      assert.deepEqual(calls.at(-1), ['SET', config.activationKey, '1']);
    }
  });
  it('rejects unapproved redirects and provider failures before parsing', async () => {
    for (const response of [new Response('', { status: 503 }), new Response('', {
      status: 302, headers: { location: 'http://127.0.0.1/private' },
    }), new Response('maintenance', { status: 200 }), new Response('', {
      headers: { 'content-length': '25000001' },
    })]) {
      let calls = 0;
      await assert.rejects(fetchRegionalEnergyFeed('pgcb', { fetchFn: async () => { calls++; return response; } }));
      assert.equal(calls, 1);
    }
  });

  it('pins Bangladesh intermediates and verifies issuer signatures against standard roots', () => {
    const fingerprints = {
      pgcb: '58:F0:F7:56:75:8E:93:FB:0B:6B:17:A3:6A:38:50:47:5D:68:BC:0D:6C:99:CB:E2:2A:1B:18:35:1C:89:FF:1F',
      petrobangla: '8C:54:C3:34:B6:6B:A4:E4:26:77:2A:F4:A3:F9:13:6C:19:A1:AE:C7:29:FD:B2:8C:53:5C:07:A5:A4:EF:22:E0',
    };
    for (const [id, fingerprint] of Object.entries(fingerprints)) {
      const issuer = new X509Certificate(readFileSync(new URL(`../scripts/data/regional-energy/${id}-issuer.pem`, import.meta.url)));
      assert.equal(issuer.fingerprint256, fingerprint);
      assert.equal(issuer.ca, true);
      assert.ok(rootCertificates.some(pem => {
        const root = new X509Certificate(pem);
        return issuer.checkIssued(root) && issuer.verify(root.publicKey);
      }));
    }
  });
  it('selects Eskom CSV attachments by exact title, not monthly folders or image results', () => {
    assert.equal(discoverEskomCsv([
      { title: { rendered: 'Hourly_Generation' }, source_url: 'https://www.eskom.co.za/dataportal/wp-content/uploads/2026/11/Hourly_Generation.csv' },
      { title: { rendered: 'Hourly_Generation' }, source_url: 'https://www.eskom.co.za/image.jpg' },
    ], 'Hourly_Generation'), 'https://www.eskom.co.za/dataportal/wp-content/uploads/2026/11/Hourly_Generation.csv');
    assert.throws(() => discoverEskomCsv([{ title: { rendered: 'Hourly_Generation' }, source_url: 'https://evil.example/a.csv' }], 'Hourly_Generation'));
  });

  it('discovers updated GSE reports and Petrobangla daily report links', () => {
    assert.equal(discoverGsePdf({ data: { contents: [{ files: [
      { name: '2025', path: 'https://admin.gse.com.ge/storage/old.pdf' },
      { name: '2026', path: 'https://admin.gse.com.ge/storage/current.pdf' },
    ] }] } }), 'https://admin.gse.com.ge/storage/current.pdf');
    assert.equal(discoverPetrobanglaPdf('<tr><td>দৈনিক-গ্যাস-ইনটেক-অফটেক-প্রতিবেদন</td><td><a href="https://objectstorage.ap-dcc-gazipur-1.oraclecloud15.com/n/x/b/V2Ministry/o/office-petrobangla/latest.pdf">PDF</a></td></tr>'), 'https://objectstorage.ap-dcc-gazipur-1.oraclecloud15.com/n/x/b/V2Ministry/o/office-petrobangla/latest.pdf');
  });

  it('does not replace source dates with fetch time and rejects future or invalid observations', () => {
    const p = { metric: 'demand', period: '2026-10-28T12:00:00.000Z', value: 0, unit: 'MW', area: '' };
    const data = buildFeedSnapshot('pgcb', [p], 'https://erp.powergrid.gov.bd/w/generations/view_generations', Date.parse('2026-10-29T12:00:00Z'));
    assert.equal(data.observedAt, p.period);
    assert.equal(data.fetchedAt, '2026-10-29T12:00:00.000Z');
    for (const invalid of [{ ...p, value: NaN }, { ...p, period: '2099-01-01' }, { ...p, period: '2026-02-30' }]) {
      assert.throws(() => buildFeedSnapshot('pgcb', [invalid], data.dataUrl, Date.parse('2026-10-29')));
    }
    assert.throws(() => buildFeedSnapshot('pgcb', [], data.dataUrl));
  });
});
