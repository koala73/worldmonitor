import { initTestI18n } from './helpers/i18n.mts';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDecisionBriefOutput, renderDecisionBrief } from '@/components/CountryBriefOutput';
import { buildDecisionBrief, buildCommodityBrief } from '@/utils/decision-brief';
import type { DecisionBriefCapture, DecisionBriefSelection } from '@/types/decision-brief';

import { computeEnergyShockScenario } from '../../server/worldmonitor/intelligence/v1/compute-energy-shock';

const redis = vi.hoisted(() => new Map<string, unknown>());
vi.mock('../../server/_shared/redis', () => ({
  getCachedJson: async (key: string) => redis.get(key) ?? null,
  readCachedJson: async (key: string) => redis.has(key) ? {status:'hit',value:redis.get(key)} : {status:'miss'},
  setCachedJsonIfAbsent: async (key: string, value: unknown) => { if (redis.has(key)) return false; redis.set(key, value); return true; },
  setCachedJson: async (key: string, value: unknown) => { redis.set(key, value); return true; },
  getLargeRawJson: async (key: string) => redis.get(key) ?? null,
  logCacheReadError: () => {},
}));

beforeAll(initTestI18n);

const selection: DecisionBriefSelection = { countryCode: 'DE', countryName: 'Germany', chokepointId: 'hormuz_strait', fuelMode: 'gas', baselinePct: 50, comparisonPct: 100 };
function snapshot(missing = false) {
  const captures = [50, 100].map((disruptionPct, i) => ({ retrievedAt: '2026-09-10T10:00:00Z', response: {
    countryCode: 'DE', chokepointId: 'hormuz_strait', disruptionPct,
    gasSensitivity: missing ? undefined : { dataAvailable: true, lngImportsTj: 41318, totalDemandTj: 467224, lngDisruptionTj: [6197.7, 12395.4][i], deficitPct: [1.3, 2.7][i], modelBasis: 'assumed_route_sensitivity', dataMonth: '2026-05', dataSource: 'JODI' },
  } })) as [DecisionBriefCapture, DecisionBriefCapture];
  return buildDecisionBrief(selection, captures);
}
const click = (root: HTMLElement, text: string) => (Array.from(root.querySelectorAll('button')).find(b => b.textContent === text)!).click();
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

it('keeps energy identity while invalid worksheet edits clear preview and exported operational results', async () => {
  const data = snapshot();
  const blobs: Blob[] = [];
  vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => { blobs.push(blob as Blob); return 'blob:test'; });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  const root = createDecisionBriefOutput({ code: 'DE', name: 'Germany' }, new AbortController().signal, async () => data, () => {});
  click(root, 'Capture / refresh both');
  await vi.waitFor(() => expect(root.querySelector('.cdp-decision-paper .operational-summary')!.textContent).toContain('Baseline first gap: Day 8'));
  const stock = root.querySelector<HTMLInputElement>('[aria-label="Starting usable stock"]')!;
  stock.value = ''; stock.dispatchEvent(new Event('input', { bubbles: true }));
  expect(root.querySelector('.cdp-decision-paper .operational-result')).toBeNull();
  expect(root.querySelector('.cdp-decision-paper')!.textContent).toContain('Operational worksheet incomplete or invalid');
  click(root, 'Download decision JSON');
  const exported = JSON.parse(await blobs[0]!.text());
  expect(exported.operationalWorksheet).toBeNull();
  const { operationalWorksheet, ...energy } = exported;
  expect(energy).toEqual(data);
  stock.value = '100'; stock.dispatchEvent(new Event('input', { bubbles: true }));
  expect(root.querySelector('.cdp-decision-paper .operational-summary')!.textContent).toContain('Baseline first gap: Day 8');
});


describe('decision brief preview and exports', () => {
  for (const missing of [false, true]) it(`renders exact snapshot and distinct action for missing=${missing}`, async () => {
    const data = snapshot(missing);
    const blobs: Blob[] = [];
    vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => { blobs.push(blob as Blob); return 'blob:test'; });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const root = createDecisionBriefOutput({ code: 'DE', name: 'Germany' }, new AbortController().signal, async () => data, () => {});
    document.body.append(root);
    click(root, 'Capture / refresh both');
    await vi.waitFor(() => expect(root.querySelector('.cdp-decision-action')?.textContent).toBe(data.action.text));
    expect(root.textContent).toContain(data.action.constraint);
    expect(root.textContent).toContain(data.action.trigger);
    for (const ref of data.action.references) expect(root.textContent).toContain(ref);
    click(root, 'Download decision HTML'); click(root, 'Download decision JSON');
    const html = await blobs[0]!.text();
    const json = JSON.parse(await blobs[1]!.text());
    expect(json.operationalWorksheet.baseline.firstGapDay).toBe(8);
    const { operationalWorksheet: worksheet, ...energy } = json;
    expect(energy).toEqual(data);
    const doc = new DOMParser().parseFromString(html, 'text/html');
    expect(JSON.parse(doc.querySelector('#decision-brief-snapshot')!.textContent!)).toEqual(json);
    expect(doc.querySelector('.cdp-decision-action')!.textContent).toBe(data.action.text);
    expect(doc.body.textContent).toContain(data.action.constraint);
    expect(doc.body.textContent).toContain(data.action.trigger);
  });

  for (const missing of [true, false]) it(`exports real oil handler state with missing imports=${missing}`, async () => {
    redis.clear();
    redis.set('energy:chokepoint-flows:v1', { hormuz_strait: { flowRatio: 1 } });
    redis.set('energy:jodi-oil:v1:DE', { crude: { importsKbd: missing ? null : 100 }, diesel: { demandKbd: 80 } });
    redis.set('comtrade:flows:276:2709', [{ partnerCode: '000', tradeValueUsd: 100 }]);
    const oilSelection = { ...selection, fuelMode: 'oil' as const };
    const captures = await Promise.all([50, 100].map(async disruptionPct => ({
      retrievedAt: '2026-09-10T10:00:00Z',
      response: await computeEnergyShockScenario({} as never, { countryCode: 'DE', chokepointId: 'hormuz_strait', disruptionPct, fuelMode: 'oil' }),
    }))) as [DecisionBriefCapture, DecisionBriefCapture];
    const data = buildDecisionBrief(oilSelection, captures);
    expect(data.results.map(r => r.loss)).toEqual(missing ? [null, null] : [20, 40]);
    expect(data.evidence.find(e => e.id === 'baseline-route')!.value).toBeNull();
    expect(data.unknowns.join(' ')).toContain('fixed proxy');
    expect(data.action.text).toContain(missing ? 'Recover the oil import' : "Compare Germany's");
    const blobs: Blob[] = [];
    vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => { blobs.push(blob as Blob); return 'blob:test'; });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const root = createDecisionBriefOutput({ code: 'DE', name: 'Germany' }, new AbortController().signal, async () => data, () => {});
    document.body.append(root);
    const fuel = root.querySelector('select')!;
    fuel.value = 'oil'; fuel.dispatchEvent(new Event('change'));
    click(root, 'Capture / refresh both');
    await vi.waitFor(() => expect(root.querySelector('.cdp-decision-action')?.textContent).toBe(data.action.text));
    expect(root.textContent).toContain('fixed proxy');
    click(root, 'Download decision HTML'); click(root, 'Download decision JSON');
    const exported = JSON.parse(await blobs[1]!.text());
    expect(exported.operationalWorksheet.baseline.firstGapDay).toBe(8);
    const { operationalWorksheet: worksheet, ...energy } = exported;
    expect(energy).toEqual(data);
    const doc = new DOMParser().parseFromString(await blobs[0]!.text(), 'text/html');
    expect(JSON.parse(doc.querySelector('#decision-brief-snapshot')!.textContent!)).toEqual(exported);
    expect(doc.querySelector('.cdp-decision-paper')!.textContent).toBe(root.querySelector('.cdp-decision-paper')!.textContent);
  });

  it('ignores late responses after selection changes, close and panel abort', async () => {
    for (const cause of ['change', 'close', 'abort']) {
      let resolve!: (value: ReturnType<typeof snapshot>) => void;
      const signal = new AbortController();
      const root = createDecisionBriefOutput({ code: 'DE', name: 'Germany' }, signal.signal, () => new Promise(r => { resolve = r; }), () => {});
      document.body.append(root); click(root, 'Capture / refresh both');
      if (cause === 'change') root.querySelector('select')!.dispatchEvent(new Event('change'));
      if (cause === 'close') click(root, '← Back to brief');
      if (cause === 'abort') signal.abort();
      resolve(snapshot()); await new Promise(r => setTimeout(r, 0));
      expect(root.querySelector('.cdp-decision-paper')).toBeNull();
      expect(root.querySelector<HTMLButtonElement>('button[disabled]')).not.toBeNull();
      root.remove();
    }
  });

  it('withholds exports on denied or failed request and allows refresh recovery', async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error('403')).mockRejectedValueOnce(new Error('503')).mockResolvedValue(snapshot());
    const root = createDecisionBriefOutput({ code: 'DE', name: 'Germany' }, new AbortController().signal, load, () => {});
    for (let i = 0; i < 2; i++) {
      click(root, 'Capture / refresh both');
      await vi.waitFor(() => expect(root.textContent).toContain('Check your access and retry'));
      expect(root.querySelector('.cdp-decision-paper')).toBeNull();
    }
    click(root, 'Capture / refresh both');
    await vi.waitFor(() => expect(root.textContent).toContain('6,197.7 TJ'));
  });

  it('keeps small positive modeled loss distinct from zero', () => {
    const data = snapshot(); data.results[0]!.loss = 0.001;
    expect(renderDecisionBrief(data).textContent).toContain('<0.1 TJ');
  });

  // The three states must stay visibly distinct: unavailable, too small to state, and
  // a genuine recorded zero. Collapsing fmt's `value !== 0 &&` guard would render a
  // measured zero as "<0.1" — the exact unknown-vs-zero confusion this feature exists
  // to prevent — and every other assertion in this file would still pass.
  it('renders a recorded zero as 0.0, not <0.1 or Unknown', () => {
    const data = snapshot(); data.results[0]!.loss = 0;
    const text = renderDecisionBrief(data).textContent!;
    expect(text).toContain('0.0 TJ');
    expect(text).not.toContain('<0.1 TJ');
  });

  it('renders an unavailable modeled loss as Unknown', () => {
    const data = snapshot(); data.results[0]!.loss = null;
    const text = renderDecisionBrief(data).textContent!;
    expect(text).toContain('Unknown');
    expect(text).not.toContain('0.0 TJ');
  });

  it('escapes embedded snapshot markup', () => {
    const data = snapshot(); data.action.text = '</script><img src=x onerror=alert(1)>';
    const paper = renderDecisionBrief(data);
    expect(paper.querySelector('img')).toBeNull();
    expect(paper.querySelector('script')!.textContent).not.toContain('<');
  });
});

describe('commodity snapshot lifecycle', () => {
  it('keeps preview details collapsible and the exported report complete with the same snapshot', async () => {
    const { renderCommodityBrief } = await import('@/components/CountryBriefOutput');
    const { buildCommodityBrief } = await import('@/utils/decision-brief');
    const data = buildCommodityBrief({ countryCode: 'JP', countryName: 'Japan', commodityId: 'helium', chokepointId: 'hormuz_strait' }, {
      retrievedAt: '2026-09-10', products: { iso2: 'JP', fetchedAt: '', products: [{ hs4: '2804', description: '', totalValue: 100, year: 2024,
        topExporters: [{ partnerCode: 634, partnerIso2: 'QA', share: 0.5, value: 50 }] }] },
      vulnerabilities: { iso2: 'JP', country: '', vulnerabilities: [], generatedAt: '', methodologyVersion: '', upstreamUnavailable: true },
      production: null,
    });
    const preview = renderCommodityBrief(data, true);
    const report = renderCommodityBrief(data);
    expect(preview.classList.contains('cdp-output-paper')).toBe(false);
    expect(preview.querySelectorAll('details[open]')).toHaveLength(0);
    expect(report.querySelectorAll('details:not([open])')).toHaveLength(0);
    expect(preview.querySelector('h3')!.textContent).toBe('Qatar');
    expect(preview.textContent).toContain('Strait of Hormuz');
    expect(preview.querySelector('.cdp-commodity-heading')!.textContent).toContain(data.caveats[0]);
    for (const view of [preview, report]) {
      expect(JSON.parse(view.querySelector('#commodity-brief-snapshot')!.textContent!)).toEqual(data);
      expect(view.textContent).toContain(data.action.constraint);
      expect(view.textContent).toContain(data.action.trigger);
    }
  });

  it('invalidates exports and ignores an old commodity capture after changing selection', async () => {
    const { createCommodityBriefOutput } = await import('@/components/CountryBriefOutput');
    const { buildCommodityBrief, COMMODITY_BRIEF_OPTIONS } = await import('@/utils/decision-brief');
    let resolve!: (value: ReturnType<typeof buildCommodityBrief>) => void;
    const controller = new AbortController();
    const root = createCommodityBriefOutput({ code: 'JP', name: 'Japan' }, controller.signal, COMMODITY_BRIEF_OPTIONS, () => new Promise(r => { resolve = r; }), () => {});
    document.body.append(root);
    click(root, 'Capture commodity comparison');
    const commodity = root.querySelector('select')!;
    commodity.value = 'wheat'; commodity.dispatchEvent(new Event('change'));
    resolve(buildCommodityBrief({ countryCode: 'JP', countryName: 'Japan', commodityId: 'helium', chokepointId: 'hormuz_strait' }, {
      retrievedAt: '2026-09-10', products: { iso2: 'JP', products: [], fetchedAt: '' }, vulnerabilities: { iso2: 'JP', country: '', vulnerabilities: [], generatedAt: '', methodologyVersion: '', upstreamUnavailable: true }, production: null,
    }));
    await new Promise(r => setTimeout(r, 0));
    expect(root.querySelector('.cdp-commodity-paper')).toBeNull();
    expect(root.querySelector<HTMLButtonElement>('[aria-label="Download decision JSON"]')!.disabled).toBe(true);
    expect(Array.from(root.querySelectorAll('button')).find(b => b.textContent === 'Capture commodity comparison')!.disabled).toBe(false);
    controller.abort();
  });
});

it('commodity denied/failed captures withhold exports and recover with the real builder', async () => {
  const { createCommodityBriefOutput } = await import('@/components/CountryBriefOutput');
  const { buildCommodityBrief, COMMODITY_BRIEF_OPTIONS } = await import('@/utils/decision-brief');
  const load = vi.fn().mockRejectedValueOnce(new Error('403')).mockRejectedValueOnce(new Error('503')).mockImplementation(async selected => buildCommodityBrief(selected, {
    retrievedAt: '2026-09-10', products: { iso2: 'JP', products: [], fetchedAt: '' }, vulnerabilities: { iso2: 'JP', country: '', vulnerabilities: [], generatedAt: '', methodologyVersion: '', upstreamUnavailable: true }, production: null,
  }));
  const root = createCommodityBriefOutput({ code: 'JP', name: 'Japan' }, new AbortController().signal, COMMODITY_BRIEF_OPTIONS, load, () => {});
  expect(root.querySelector('select')!.value).toBe('helium');
  for (let i = 0; i < 2; i++) {
    click(root, 'Capture commodity comparison');
    await vi.waitFor(() => expect(root.textContent).toContain('Check your access and retry'));
    expect(root.querySelector('.cdp-commodity-paper')).toBeNull();
    expect(root.querySelector<HTMLButtonElement>('[aria-label="Download decision JSON"]')!.disabled).toBe(true);
  }
  click(root, 'Capture commodity comparison');
  await vi.waitFor(() => expect(root.textContent).toContain('No recorded HS 2804 bilateral product evidence'));
});

import { getCountryProducts } from '../../server/worldmonitor/supply-chain/v1/get-country-products';
import { renderCommodityBrief } from '@/components/CountryBriefOutput';
vi.mock('../../server/_shared/premium-check', () => ({ isCallerPremium: async () => true }));

it('legacy JP842 survives real reader to builder to preview and embedded export without renormalization', async () => {
  redis.clear();
  redis.set('comtrade:bilateral-hs4:JP:v1', { iso2: 'JP', fetchedAt: new Date().toISOString(), products: [{
    hs4: '2804', description: 'Helium', year: 2024, totalValue: 1000,
    topExporters: [{partnerCode:842,partnerIso2:'',value:392,share:0.392},{partnerCode:490,partnerIso2:'',value:100,share:0.1}],
  }] });
  const products = await getCountryProducts({request:new Request('https://example.test')} as never, {iso2:'JP',hs4:'2804'});
  const data = buildCommodityBrief({countryCode:'JP',countryName:'Japan',commodityId:'helium',chokepointId:'hormuz_strait'}, {
    retrievedAt: new Date().toISOString(), products,
    vulnerabilities: {iso2:'JP',vulnerabilities:[],upstreamUnavailable:true} as never, production: null,
  });
  expect(data.candidates.find(c => c.origin === 'US')?.sharePct).toBe(39.2);
  const preview = renderCommodityBrief(data);
  const visible = preview.cloneNode(true) as HTMLElement;
  visible.querySelector('script')?.remove();
  expect(visible.textContent).toContain('39.2%');
  expect(visible.textContent).toContain('490');
  expect(visible.textContent).toContain('Hydrogen, rare gases and other non-metals');
  expect(visible.textContent).toContain(products.fetchedAt);
  expect(visible.textContent).toContain('2024');
  expect(JSON.parse(preview.querySelector('#commodity-brief-snapshot')!.textContent!)).toEqual(data);
  expect(products.products[0]!.topExporters[0]!.partnerCode).toBe(842);
});

// Refresh outcome -> the attempt state the reader must report. Capped and
// regressed refreshes are different failures and keep different names.
// Refresh outcome -> the attempt state the reader must report. When the whole
// catalogue refresh is rejected (a held heading missing or regressed), the
// requested heading still gets its own bounded attempt, which succeeds here.
const germanyOutcomes = {
  unavailable: 'unavailable', no_records: 'no_records', malformed: 'malformed', incomplete: 'incomplete',
  missing_heading: 'observed', year_regression: 'observed', recovered: 'observed',
} as const;
for (const [outcome, attemptState] of Object.entries(germanyOutcomes)) it(`preserves or recovers Germany with refresh outcome ${outcome}`, async () => {
  redis.clear();
  const previous = {iso2:'DE', fetchedAt:'2026-07-27T16:47:53.750Z',products:[{hs4:'1001',description:'Wheat',year:2023,totalValue:100,topExporters:[{partnerCode:251,partnerIso2:'',value:100,share:1}]}]};
  redis.set('comtrade:bilateral-hs4:DE:v1',previous);
  vi.spyOn(globalThis,'fetch').mockImplementation(async (input) => {
    if(outcome==='unavailable') return new Response('upstream failure',{status:503});
    if(outcome==='malformed') return Response.json({unexpected:true});
    const url = new URL(String(input));
    const codes = url.searchParams.get('cmdCode')!.split(',');
    if(outcome==='incomplete') return Response.json({data:Array.from({length:Number(url.searchParams.get('maxRecords'))},(_,i)=>({cmdCode:codes[0],partnerCode:1+(i%890),primaryValue:1,period:2024}))});
    const wheat = outcome==='recovered' ? [{cmdCode:'1001',partnerCode:251,primaryValue:100,period:2024}]
      : outcome==='year_regression' ? [{cmdCode:'1001',partnerCode:251,primaryValue:100,period:2022}] : [];
    const rows = outcome==='no_records'?[]:[{cmdCode:'2804',partnerCode:842,primaryValue:392,period:2024},...wheat];
    return Response.json({data:rows.filter(row=>codes.includes(row.cmdCode))});
  });
  const result = await getCountryProducts({request:new Request('https://example.test')} as never,{iso2:'DE',hs4:'2804'});
  expect(result.evidence?.lastAttemptState).toBe(attemptState);
  // Warm recovery never replaces the canonical key; only the sentinel carries it.
  expect(redis.get('comtrade:bilateral-hs4:DE:v1')).toEqual(previous);
  if(outcome==='recovered') {
    expect(result.products.find(p=>p.hs4==='2804')?.topExporters[0]?.partnerIso2).toBe('US');
    expect(result.fetchedAt).not.toBe(previous.fetchedAt);
    expect(result.evidence?.requestedHs4s).toContain('2804');
    expect((redis.get('comtrade:bilateral-hs4-lazy-sentinel:DE:v1') as {state?: string}).state).toBe('observed');
  } else if(outcome==='missing_heading' || outcome==='year_regression') {
    // The catalogue refresh was rejected, so the stale wheat row is preserved,
    // while the requested heading was recovered on its own.
    expect(result.fetchedAt).toBe(previous.fetchedAt);
    expect(result.products.find(p=>p.hs4==='1001')?.year).toBe(2023);
    expect(result.products.find(p=>p.hs4==='2804')?.topExporters[0]?.partnerIso2).toBe('US');
    expect(result.evidence?.state).toBe('stale_preserved');
    expect(result.evidence?.recoveredHs4s).toEqual(['2804']);
    expect((redis.get('comtrade:bilateral-hs4-lazy-sentinel:DE:v1') as {state?: string}).state).toBe('regression_rejected');
  } else {
    expect(result.fetchedAt).toBe(previous.fetchedAt);
    expect(result.products[0]?.year).toBe(2023);
    expect(result.evidence?.state).toBe('stale_preserved');
  }
});

it('service capture requests the selected heading and carries reader provenance into exports', async () => {
  redis.clear();
  redis.set('comtrade:bilateral-hs4:JP:v1',{iso2:'JP',fetchedAt:new Date().toISOString(),products:[{hs4:'2804',description:'Helium',year:2024,totalValue:1000,topExporters:[{partnerCode:842,partnerIso2:'',value:392,share:0.392}]}]});
  const requests: URL[]=[];
  vi.spyOn(globalThis,'fetch').mockImplementation(async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'https://example.test'); requests.push(url);
    if(url.pathname.endsWith('/get-country-products')) return Response.json(await getCountryProducts({request:new Request(url)} as never,{iso2:url.searchParams.get('iso2')!,hs4:url.searchParams.get('hs4')!}));
    return Response.json({iso2:'JP',vulnerabilities:[],upstreamUnavailable:true});
  });
  const {captureCommodityBrief}=await import('@/services/decision-brief');
  const selection={countryCode:'JP',countryName:'Japan',commodityId:'helium',chokepointId:'hormuz_strait'};
  const capture=await captureCommodityBrief(selection,new AbortController().signal);
  expect(requests.find(url=>url.pathname.endsWith('/get-country-products'))?.searchParams.get('hs4')).toBe('2804');
  const snapshot=buildCommodityBrief(selection,capture);
  expect(snapshot.candidates[0]?.sharePct).toBe(39.2);
  expect(snapshot.capture.products.evidence?.state).toBe('partial');
  const article=renderCommodityBrief(snapshot);
  expect(JSON.parse(article.querySelector('script')!.textContent!)).toEqual(snapshot);
});

it('valid empty recovery identifies requested headings and never implies zero exposure', async () => {
  redis.clear();
  vi.spyOn(globalThis,'fetch').mockImplementation(async () => Response.json({data:[]}));
  const products=await getCountryProducts({request:new Request('https://example.test')} as never,{iso2:'JP',hs4:'2804'});
  expect(products.evidence?.state).toBe('no_records');
  expect(products.evidence?.requestedHs4s).toContain('2804');
  const snapshot=buildCommodityBrief({countryCode:'JP',countryName:'Japan',commodityId:'helium',chokepointId:'hormuz_strait'}, {retrievedAt:new Date().toISOString(),products,vulnerabilities:{iso2:'JP',vulnerabilities:[],upstreamUnavailable:true} as never,production:null});
  expect(snapshot.coverage.join(' ')).toContain('requested, but no usable positive rows');
  expect(snapshot.candidates).toEqual([]);
  expect(snapshot.action.text).toContain('Recover');
});

// U5: evidence depth per origin. `production` is a third capture leg, so every
// fixture below states it explicitly — an absent leg is null, never undefined.
describe('commodity brief evidence depth', () => {
  type Exporter = Record<string, unknown>;
  const THRESHOLD_ORIGINS = ['QA','US','DE','FR','CA','AU','BR','IN','KR','GB','IT','ES','PL','NO'];
  const partner = (iso2: string, code: number, share: number, extra: Exporter = {}): Exporter =>
    ({ partnerCode: code, partnerIso2: iso2, value: Math.round(share * 10_000), share, ...extra });

  const build = (product: Record<string, unknown> | null, options: { commodityId?: string; chokepointId?: string; production?: unknown; worldExportsFetchedAt?: string } = {}) =>
    buildCommodityBrief(
      { countryCode: 'JP', countryName: 'Japan', commodityId: options.commodityId ?? 'helium', chokepointId: options.chokepointId ?? 'hormuz_strait' },
      {
        retrievedAt: '2026-09-10T10:00:00Z',
        products: {
          iso2: 'JP', fetchedAt: '2026-09-09T00:00:00Z', products: product ? [product] : [],
          evidence: { state: 'fresh', source: 'UN Comtrade bilateral HS4', requestedHs4s: [], missingHs4s: [], lastAttemptAt: '', lastAttemptState: 'observed', recoveredHs4s: [],
            ...(options.worldExportsFetchedAt ? { worldExportsFetchedAt: options.worldExportsFetchedAt } : {}) },
        },
        vulnerabilities: { iso2: 'JP', country: '', vulnerabilities: [], generatedAt: '', methodologyVersion: '', upstreamUnavailable: true },
        production: options.production ?? null,
      } as never,
    );

  const thresholdProduct = () => ({
    hs4: '2804', description: 'Hydrogen and rare gases', totalValue: 10_000, year: 2024,
    denominatorBasis: 'reported_world', partnerBasis: 'share_threshold', omittedPartnerCount: 39, omittedPartnerShare: 0.031,
    topExporters: THRESHOLD_ORIGINS.map((iso2, index) => partner(iso2, 100 + index, 0.2 - index * 0.012)),
  });

  it('AE1: shows every threshold origin in the export, caps the preview, and states the omitted tail', () => {
    const data = build(thresholdProduct());
    expect(data.candidates).toHaveLength(14);
    const preview = renderCommodityBrief(data, true);
    const report = renderCommodityBrief(data);
    expect(preview.querySelectorAll('.cdp-commodity-candidate')).toHaveLength(10);
    expect(report.querySelectorAll('.cdp-commodity-candidate')).toHaveLength(14);
    expect(preview.textContent).toContain('+4 more origins in the export');
    // The coverage lines below the cards count every listed origin, so the
    // preview says which population they describe.
    expect(preview.textContent).toContain('Coverage figures describe all 14 listed origins');
    expect(report.textContent).not.toContain('more origins in the export');
    expect(data.coverage.join(' ')).toContain('Origins listed: partners holding at least 1% of the denominator, padded to 5 and capped at 25 (14 listed; 39 omitted holding 3.1% combined)');
    expect(data.coverage.join(' ')).not.toMatch(/\b(shown|displayed|Displayed)\b/);
    // Preview affordances stay as they are today.
    expect(preview.querySelectorAll('details[open]')).toHaveLength(0);
    expect(preview.querySelector('h3')!.textContent).toBe(new Intl.DisplayNames(['en'], { type: 'region' }).of(data.candidates[0]!.origin));
  });

  it('states the leading-5 basis for a legacy row that kept no threshold list', () => {
    const data = build({ hs4: '2804', description: '', totalValue: 1000, year: 2024, partnerBasis: 'leading_5',
      topExporters: [partner('QA', 634, 0.6), partner('US', 842, 0.3)] });
    expect(data.coverage.join(' ')).toContain('the stored leading 5 origins; smaller partners were not retained');
    expect(data.coverage.join(' ')).toContain('Supplier scale unavailable');
    expect(data.candidates.every(c => c.netWeightKg === null && c.quantity === null && c.scale === null && c.production === null)).toBe(true);
  });

  it('renders reported volume, an unreported volume and a provider quantity unit distinctly', () => {
    const data = build({ hs4: '2804', description: '', totalValue: 1000, year: 2024, partnerBasis: 'share_threshold',
      omittedPartnerCount: 0, omittedPartnerShare: 0,
      topExporters: [
        partner('US', 842, 0.5, { netWeightKg: 839, netWeightEstimated: true, quantity: 12_500, quantityUnitCode: 12 }),
        partner('CA', 124, 0.3),
      ] });
    const us = data.candidates.find(c => c.origin === 'US')!;
    expect(us.netWeightKg).toBe(839);
    expect(us.netWeightEstimated).toBe(true);
    expect(us.quantity).toBe(12_500);
    expect(us.quantityUnit).toBe('m³');
    const ca = data.candidates.find(c => c.origin === 'CA')!;
    expect(ca.netWeightKg).toBeNull();
    expect(ca.netWeightEstimated).toBe(false);
    expect(ca.quantity).toBeNull();
    expect(ca.quantityUnit).toBeNull();
    const report = renderCommodityBrief(data);
    const usSection = report.querySelector('[data-origin="US"]')!;
    expect(usSection.textContent).toContain('839 kg (estimated)');
    expect(usSection.textContent).toContain('12,500 m³');
    expect(report.querySelector('[data-origin="CA"]')!.textContent).toContain('Volume not reported');
  });

  it('renders supplier scale from world exports and says so when the join is missing', () => {
    const data = build({ hs4: '2804', description: '', totalValue: 1000, year: 2024, partnerBasis: 'share_threshold',
      omittedPartnerCount: 0, omittedPartnerShare: 0,
      topExporters: [
        partner('US', 842, 0.5, { scale: { worldExportsUsd: 2_100_000_000, worldExportsKg: 2_400_000, rank: 1, year: 2024, reporterCount: 118, unrankedReporterCount: 0 } }),
        partner('CA', 124, 0.3),
      ] }, { worldExportsFetchedAt: '2026-09-08T00:00:00Z' });
    expect(data.candidates.find(c => c.origin === 'US')!.scale).toEqual({ worldExportsUsd: 2_100_000_000, worldExportsKg: 2_400_000, rank: 1, year: 2024, reporterCount: 118, unrankedReporterCount: 0 });
    expect(data.candidates.find(c => c.origin === 'CA')!.scale).toBeNull();
    const report = renderCommodityBrief(data);
    expect(report.querySelector('[data-origin="US"]')!.textContent).toContain('$2.1B world exports of HS 2804, rank 1 of 118 reporters filing 2024');
    // Every reporter filed the ranking year, so no late-filer caveat is printed.
    expect(data.coverage.join(' ')).not.toContain('not ranked');
    expect(report.querySelector('[data-origin="CA"]')!.textContent).toContain('Supplier scale unavailable');
    expect(data.coverage.join(' ')).toContain('world exports of HS 2804 fetched 2026-09-08T00:00:00Z');
  });

  it('AE4: flags a transit hub, prefers a non-hub next action and names the hub it skipped', () => {
    const data = build({ hs4: '2804', description: '', totalValue: 1000, year: 2024, partnerBasis: 'share_threshold',
      omittedPartnerCount: 0, omittedPartnerShare: 0,
      // NL and FR share the Suez lane to Japan, so they sit in the same route tier.
      topExporters: [partner('NL', 528, 0.5), partner('FR', 251, 0.3)] });
    expect(data.candidates[0]!.origin).toBe('NL');
    expect(data.candidates[0]!.transitHub).toBe(true);
    expect(data.candidates[1]!.routeState).toBe(data.candidates[0]!.routeState);
    expect(data.candidates.find(c => c.origin === 'FR')!.transitHub).toBe(false);
    expect(data.action.text).toContain("Validate FR's");
    expect(data.action.text).toMatch(/Netherlands \(NL\) holds a larger recorded share with the same route state .* skipped/);
    expect(data.coverage.join(' ')).toContain('Possible transit hubs among listed origins: Netherlands (NL)');
    const report = renderCommodityBrief(data);
    expect(report.querySelector('[data-origin="NL"]')!.textContent).toContain('Possible transit hub');
    expect(report.querySelector('[data-origin="FR"]')!.textContent).not.toContain('Possible transit hub');
  });

  it('the hub preference never crosses route-state tiers', () => {
    // NL avoids the blocked chokepoint on its modeled route; US has no modeled
    // route at all. That ordering is about the route, not the hub flag, so the
    // action still names NL and says the flag could not be avoided in its tier.
    const data = build({ hs4: '2804', description: '', totalValue: 1000, year: 2024, partnerBasis: 'share_threshold',
      omittedPartnerCount: 0, omittedPartnerShare: 0,
      topExporters: [partner('US', 842, 0.392), partner('NL', 528, 0.1)] });
    expect(data.candidates.map(c => c.origin)).toEqual(['NL', 'US']);
    expect(data.candidates[0]!.routeState).toBe('not_on_modeled_route');
    expect(data.candidates[1]!.routeState).toBe('unknown');
    expect(data.action.text).toContain("Validate NL's");
    expect(data.action.text).toContain('Every eligible origin with this route state is flagged');
    expect(data.action.text).not.toContain('skipped');
  });

  it('names the first hub when every eligible origin is a hub and says the flag was not avoidable', () => {
    const data = build({ hs4: '2804', description: '', totalValue: 1000, year: 2024, partnerBasis: 'share_threshold',
      omittedPartnerCount: 0, omittedPartnerShare: 0,
      topExporters: [partner('NL', 528, 0.5), partner('BE', 56, 0.3)] });
    expect(data.candidates.every(c => c.transitHub)).toBe(true);
    expect(data.action.text).toContain('NL');
    expect(data.action.text).toContain('Every eligible origin');
    expect(data.action.text).not.toContain('skipped');
  });

  it('maps mine-stage production share for a mineral commodity and keeps a restricted source numberless', () => {
    const stage = (countries: unknown[]) => ({ year: 2024, unit: 't', countries, hhi: 0, withheldCount: 0 });
    const product = { hs4: '8105', description: '', totalValue: 1000, year: 2024, partnerBasis: 'share_threshold',
      omittedPartnerCount: 0, omittedPartnerShare: 0, topExporters: [partner('CD', 180, 0.5), partner('CA', 124, 0.3)] };
    const open = build(product, { commodityId: 'cobalt', production: { commodities: [{ commodityId: 'cobalt', commodity: 'Cobalt', year: 2024, unit: 't', sources: ['usgs-mcs'],
      mine: stage([{ iso2: 'CD', country: 'DR Congo', share: 12.5, output: 220_000, withheld: false, estimated: false, residual: false }]) }],
      countries: [], fetchedAt: '2026-09-01T00:00:00Z', upstreamUnavailable: false, dataYear: 2024 } });
    expect(open.candidates.find(c => c.origin === 'CD')!.production).toEqual({ sharePct: 12.5, stage: 'mine', source: 'USGS MCS', restricted: false });
    expect(open.candidates.find(c => c.origin === 'CA')!.production).toBeNull();
    expect(renderCommodityBrief(open).querySelector('[data-origin="CD"]')!.textContent).toContain('12.5% of world mine output (USGS MCS)');
    expect(open.coverage.join(' ')).toContain('World production: mine-stage shares from USGS MCS');

    const restricted = build(product, { commodityId: 'cobalt', production: { commodities: [{ commodityId: 'cobalt', commodity: 'Cobalt', year: 2024, unit: 't', sources: ['bgs'],
      refinery: stage([{ iso2: 'CD', country: 'DR Congo', share: 12.5, withheld: false, estimated: false, residual: false }]) }],
      countries: [], fetchedAt: '2026-09-01T00:00:00Z', upstreamUnavailable: false, dataYear: 2024 } });
    // The restriction covers the exportable snapshot, not just the rendered
    // row: the JSON download and the embedded HTML snapshot carry the whole
    // object, so the number must be gone from the candidate and from the
    // captured production response, while attribution, year and unit stay.
    expect(restricted.candidates.find(c => c.origin === 'CD')!.production).toEqual({ sharePct: null, stage: 'refinery', source: 'BGS', restricted: true });
    const serialized = JSON.stringify(restricted);
    expect(serialized).not.toContain('12.5');
    expect(serialized).not.toContain('220000');
    expect(restricted.capture.production!.commodities[0]!.refinery!.countries).toEqual([]);
    expect(restricted.capture.production!.commodities[0]!.refinery!.year).toBe(2024);
    expect(restricted.capture.production!.commodities[0]!.sources).toEqual(['bgs']);
    const restrictedText = renderCommodityBrief(restricted).querySelector('[data-origin="CD"]')!.textContent!;
    expect(restrictedText).toContain('share from BGS, redistribution restricted');
    expect(restrictedText).not.toContain('12.5%');
    // An open source keeps its numbers in the export.
    expect(JSON.stringify(open)).toContain('220000');
  });

  it('reports an unavailable mineral leg without losing the trade evidence', () => {
    const data = build({ hs4: '8105', description: '', totalValue: 1000, year: 2024, partnerBasis: 'share_threshold',
      omittedPartnerCount: 0, omittedPartnerShare: 0, topExporters: [partner('CD', 180, 0.5)] }, { commodityId: 'cobalt', production: null });
    expect(data.candidates[0]!.production).toBeNull();
    expect(data.coverage.join(' ')).toContain('Production share unavailable');
    expect(data.candidates[0]!.sharePct).toBe(50);
  });

  it('adds no production line for a commodity without a mineral-production id', () => {
    const data = build({ hs4: '1001', description: '', totalValue: 1000, year: 2024,
      topExporters: [partner('AU', 36, 1)] }, { commodityId: 'wheat' });
    expect(data.coverage.join(' ')).not.toContain('Production share unavailable');
    expect(data.coverage.join(' ')).not.toContain('World production:');
  });

  it('serializes every new candidate field as null or false, never undefined', () => {
    const data = build(thresholdProduct());
    for (const candidate of data.candidates) {
      for (const key of ['netWeightKg', 'netWeightEstimated', 'quantity', 'quantityUnit', 'transitHub', 'scale', 'production'] as const) {
        expect(candidate[key], `${candidate.origin}.${key}`).toBeDefined();
      }
    }
    expect(JSON.parse(JSON.stringify(data.candidates))).toStrictEqual(data.candidates);
    expect(JSON.parse(renderCommodityBrief(data).querySelector('#commodity-brief-snapshot')!.textContent!)).toEqual(data);
  });
});

describe('commodity capture mineral leg', () => {
  const routeCapture = async (commodityId: string, hs4: string, mineral: 'ok' | 'fail') => {
    redis.clear();
    redis.set('comtrade:bilateral-hs4:JP:v1', { iso2: 'JP', fetchedAt: new Date().toISOString(), products: [
      { hs4, description: '', year: 2024, totalValue: 1000, topExporters: [{ partnerCode: 842, partnerIso2: '', value: 392, share: 0.392 }] }] });
    const requests: URL[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = new URL(input instanceof Request ? input.url : String(input), 'https://example.test');
      requests.push(url);
      if (url.pathname.endsWith('/get-country-products')) return Response.json(await getCountryProducts({ request: new Request(url) } as never, { iso2: url.searchParams.get('iso2')!, hs4: url.searchParams.get('hs4')! }));
      if (url.pathname.endsWith('/get-mineral-production')) {
        if (mineral === 'fail') return new Response('upstream failure', { status: 503 });
        return Response.json({ commodities: [], countries: [], fetchedAt: '2026-09-01T00:00:00Z', upstreamUnavailable: false, dataYear: 2024 });
      }
      return Response.json({ iso2: 'JP', vulnerabilities: [], upstreamUnavailable: true });
    });
    const { captureCommodityBrief } = await import('@/services/decision-brief');
    const capture = await captureCommodityBrief({ countryCode: 'JP', countryName: 'Japan', commodityId, chokepointId: 'hormuz_strait' }, new AbortController().signal);
    return { capture, requests, mineralRequest: requests.find(url => url.pathname.endsWith('/get-mineral-production')) };
  };

  it('requests world production for a mineral commodity with no iso2 filter', async () => {
    const { capture, mineralRequest } = await routeCapture('cobalt', '8105', 'ok');
    expect(mineralRequest?.searchParams.get('commodity')).toBe('cobalt');
    expect(mineralRequest?.searchParams.get('iso2')).toBeNull();
    expect(mineralRequest?.searchParams.get('stage')).toBeNull();
    expect(capture.production).not.toBeNull();
  });

  it('keeps the capture usable when the mineral leg fails', async () => {
    const { capture, mineralRequest } = await routeCapture('cobalt', '8105', 'fail');
    expect(mineralRequest).toBeDefined();
    expect(capture.production).toBeNull();
    expect(capture.products.products).toHaveLength(1);
  });

  it('makes no mineral request for a commodity the registry maps to no mineral id', async () => {
    const { capture, mineralRequest } = await routeCapture('wheat', '1001', 'ok');
    expect(mineralRequest).toBeUndefined();
    expect(capture.production).toBeNull();
  });
});
