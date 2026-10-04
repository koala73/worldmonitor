import { test, expect, type Page } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import us from './fixtures/country-brief-us.json' with { type: 'json' };
import { readCountryView } from '../api/mcp/ui/news-dashboard-app';
import type { CountrySignalCounts } from '../src/types';

const root = process.cwd();
test.use({ serviceWorkers: 'block' });

type HostCall = { name: string; arguments: Record<string, unknown> };
async function installCountryHost(page: Page, fullExposure = false, initialOpenError?: string, atlasFixture = false, atlasOutages: { energy?: boolean; timeline?: boolean } = {}, cachedShell?: string) {
  const calls: HostCall[] = [];
  const requestNames = new Map<number, string>();
  const cancelled: string[] = [];
  let delayCoverage = false;
  let releaseCoverage: () => void = () => {};
  const coverageDelayed = new Promise<void>(resolve => { releaseCoverage = resolve; });
  const contexts: Array<{ countryCode: string; topic: string; signals?: CountrySignalCounts; sections: Array<{ section: string; state: string; coverage?: string; renderedText: string }> }> = [];
  const links: string[] = [];
  let failFacts = false;
  let failActivity = false;
  let denyActivity = false;
  let atlasDenied = false;
  let atlasUnavailable = false;
  let disruptionsFailed = false;
  let energyFailed = atlasOutages.energy ?? false;
  let releaseDisruptions: () => void = () => {};
  const delayedDisruptions = new Promise<void>(resolve => { releaseDisruptions = resolve; });
  let atlasPartial = false;
  let delayAtlasDetail = false;
  let releaseAtlasDetail: () => void = () => {};
  const delayedAtlasDetail = new Promise<void>(resolve => { releaseAtlasDetail = resolve; });
  let partialBootstrap = false;
  let quotaExceeded = false;
  let admissions = 0;
  const admitted = new Set<string>();
  const panelCountries = new Map<string, string>();
  let delayUS = false;
  let delayAdmission = false;
  let releaseAdmission: () => void = () => {};
  const admissionDelayed = new Promise<void>(resolve => { releaseAdmission = resolve; });
  let releaseUS: () => void = () => {};
  const delayed = new Promise<void>(resolve => { releaseUS = resolve; });
  const unmanaged: string[] = [];
  page.on('request', request => { if (request.url().includes('/api/')) unmanaged.push(request.url()); });
  await page.route('**/plugin/assets/**', async route => {
    if (route.request().url().endsWith('/country-removed.js')) return route.fulfill({ status: 404, contentType: 'text/html', body: 'Removed build asset', headers: { 'Access-Control-Allow-Origin': '*' } });
    const file = join(root, 'dist/plugin/assets', new URL(route.request().url()).pathname.split('/').at(-1)!);
    await route.fulfill({ path: file, headers: { 'Access-Control-Allow-Origin': '*' } });
  });
  await page.route('**/data/*.geojson', async route => route.fulfill({ path: join(root, 'public/data', new URL(route.request().url()).pathname.split('/').at(-1)!), headers: { 'Access-Control-Allow-Origin': '*' } }));
  await page.route('**/country-host-test', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><title>Country plugin acceptance — controlled fixtures</title><h1>Country plugin acceptance — controlled fixtures</h1><p>Tests the built iframe and host transport. Does not test live OAuth or source freshness.</p><iframe title="WorldMonitor country view" sandbox="allow-scripts allow-downloads" style="width:100%;height:950px;border:0"></iframe>' }));
  await page.exposeFunction('countryHost', async (method: string, params: HostCall & { content?: Array<{ text: string }>; url?: string; requestId?: number }, id?: number) => {
    if (method === 'notifications/cancelled') { cancelled.push(requestNames.get(params.requestId!) ?? 'unknown'); return {}; }
    if (method === 'ui/initialize') return { hostCapabilities: { serverTools: {}, openLinks: {}, updateModelContext: {} }, hostContext: { theme: 'dark' } };
    if (method === 'ui/update-model-context') { contexts.push(JSON.parse(params.content![0].text)); return {}; }
    if (method === 'ui/open-link') { links.push(params.url!); return {}; }
    if (method !== 'tools/call') return {};
    calls.push(params);
    if (id !== undefined) requestNames.set(id, params.name);
    const args = params.arguments;
    const code = String(args.country_code ?? (args.arguments as Record<string, unknown>)?.country_code ?? (args.arguments as Record<string, unknown>)?.countryCode ?? panelCountries.get(String(args.panel_request ?? '')) ?? 'US');
    if (params.name === 'get_country_brief') return { structuredContent: { ...us.brief, countryCode: code, brief: `Controlled ${code} assessment. Source observations, not live acceptance.` } };
    if (params.name === 'get_country_coverage' && delayCoverage) await coverageDelayed;
    if (params.name === 'get_country_coverage') return { structuredContent: { countryCode: code, countryName: code, generatedAt: '2026-10-01T15:00:00Z', degraded: false, headlines: [{ title: `Controlled ${code} source article`, source: 'Fixture publisher', url: 'https://example.com/evidence', publishedAtMs: 1790863200000 }], events: [], sources: [{ source: 'news', state: 'ready' }, { source: 'events', state: 'unavailable' }] } };
    if (params.name === 'open_country_brief') {
      if (initialOpenError) return { isError: true, content: [{ type: 'text', text: initialOpenError }] };
      if (code === 'US' && delayAdmission) await admissionDelayed;
      if (quotaExceeded) throw new Error('Daily MCP quota exceeded (50 requests/day). Resets at next UTC midnight.');
      const reused = admitted.has(code) && !args.refresh;
      if (!reused) admissions++;
      admitted.add(code);
      const token = `${code}.controlled-admission-${admissions}`;
      panelCountries.set(token, code);
      return { structuredContent: { countryCode: code, topic: args.topic ?? 'overview', panelRequest: { token, countryCode: code, expiresAt: new Date(Date.now() + 300000).toISOString(), reused, usage: { used: admissions, limit: 50, remaining: 50 - admissions, resetsAt: '2026-10-03T00:00:00.000Z', unit: 'requests' } } } };
    }
    const section = String(args.section);
    if (section === 'facts' && code === 'US' && delayUS) await delayed;
    if (section === 'facts' && failFacts) return { structuredContent: { section, state: 'unavailable', reason: 'Controlled source failure' } };
    if (denyActivity && ['vessels', 'flights', 'fleet'].includes(section)) return { structuredContent: { section, state: 'locked', reason: 'Controlled authorization loss' } };
    if (failActivity && section === 'vessels') return { structuredContent: { section, state: 'unavailable', reason: 'Controlled AIS outage' } };
    if (delayAtlasDetail && ['pipelineDetail', 'facilityDetail'].includes(section)) await delayedAtlasDetail;
    if (atlasOutages.timeline && section === 'disruptions') await delayedDisruptions;
    if (energyFailed && section === 'energy') return { structuredContent: { section, state: 'unavailable', reason: 'Controlled energy outage' } };
    if (disruptionsFailed && section === 'disruptions') return { structuredContent: { section, state: 'unavailable', reason: 'Controlled timeline outage' } };
    if (atlasUnavailable && section === 'facilities') return { structuredContent: { section, state: 'unavailable', reason: 'Controlled storage outage' } };
    if (atlasDenied && ['facilityDetail', 'facilities'].includes(section)) return { structuredContent: { section, state: 'locked', reason: 'Controlled Atlas connection lacks access' } };
    const pipeline = { id: 'us-pipeline', name: 'Controlled US Pipeline', operator: 'Fixture operator', commodityType: 'gas', fromCountry: 'US', toCountry: 'CA', transitCountries: [], capacityBcmYr: 12, capacityMbd: 0, lengthKm: 100, inService: 2025, publicBadge: 'flowing', startPoint: { lat: 38, lon: -77 }, endPoint: { lat: 43, lon: -79 }, waypoints: [], evidence: { physicalState: 'flowing', physicalStateSource: 'operator', commercialState: 'active', sanctionRefs: [], operatorStatement: { text: 'Controlled operator statement', url: 'https://example.com/pipeline-source', date: '2026-10-01' }, classifierVersion: 'fixture', classifierConfidence: 0.9 } };
    const facility = { id: 'us-storage', name: 'Controlled US Storage', operator: 'Fixture storage operator', country: 'US', facilityType: 'spr', capacityMb: 12, capacityTwh: 0, capacityMtpa: 0, workingCapacityUnit: 'Mb', inService: 2025, location: { lat: 38, lon: -77 }, publicBadge: 'operational', evidence: { physicalState: 'operational', physicalStateSource: 'operator', commercialState: 'active', operatorStatement: { text: 'Controlled storage statement', url: 'https://example.com/storage-source', date: '2026-10-01' }, sanctionRefs: [] } };
    const shortage = { id: 'us-shortage', country: 'US', product: 'diesel', severity: 'confirmed', firstSeen: '2026-09-29', lastConfirmed: '2026-10-01', resolvedAt: '', shortDescription: 'Controlled active shortage', impactTypes: ['transport'], causeChain: ['supply'], evidence: { evidenceSources: [{ authority: 'Fixture authority', title: 'Controlled shortage source', url: 'https://example.com/shortage-source', date: '2026-10-01', sourceType: 'official' }], classifierConfidence: 0.9 } };
    const values: Record<string, object> = {
      flights: { flights: code === 'FR' ? [
        { id: 'controlled-paris-flight', operatorCountry: 'FR', location: { latitude: 48.8566, longitude: 2.3522 } },
        { id: 'controlled-zurich-flight', operatorCountry: 'CH', location: { latitude: 47.3769, longitude: 8.5417 } },
      ] : [{ id: 'controlled-us-flight', operatorCountry: 'US', location: { latitude: 38, longitude: -77 } }], pagination: { nextCursor: '' } },
      vessels: { dataAvailable: true, snapshot: { snapshotAt: Date.now(), status: { connected: true }, candidateReports: [{ mmsi: '235123456', name: 'Controlled military activity', shipType: 35, lat: code === 'FR' ? 47.3769 : 38, lon: code === 'FR' ? 8.5417 : -77, timestamp: Date.now() }] } },
      fleet: {},
      facts: { countryCode: code, countryName: code, capital: code === 'US' ? 'Washington, D.C.' : 'Kyiv', population: '340100000', areaSqKm: 9826675, languages: ['English'], currencies: ['US dollar'] },
      factors: us.scorecard,
      risk: { upstreamUnavailable: true },
      scenario: { countryCode: code, chokepointId: String((args.arguments as Record<string, unknown>).chokepoint_id), disruptionPct: Number((args.arguments as Record<string, unknown>).disruption_pct), dataAvailable: true, jodiOilCoverage: true, crudeLossKbd: 100, gulfCrudeShare: 0.3, products: [], limitations: [], coverageLevel: 'partial', gasSensitivity: { dataAvailable: true, lngImportsTj: 100000, totalDemandTj: 500000, lngDisruptionTj: Number((args.arguments as Record<string, unknown>).disruption_pct) * 300, deficitPct: Number((args.arguments as Record<string, unknown>).disruption_pct) * 0.06, dataMonth: '2026-05', dataSource: 'JODI', modelBasis: 'assumed_route_sensitivity', assessment: 'Controlled route sensitivity, not measured supplier exposure.' } },
      stock: { available: false },
      energy: atlasFixture && !energyFailed ? { countryCode: code, importShareAvailable: true, importShare: 12, importShareYear: 2025, importShareSource: 'Fixture source' } : { countryCode: code, upstreamUnavailable: true },
      pipelines: { pipelines: [pipeline, { ...pipeline, id: 'cn-pipeline', name: 'Other country pipeline', fromCountry: 'CN', toCountry: 'RU' }], fetchedAt: '2026-10-01', classifierVersion: 'fixture', upstreamUnavailable: false },
      facilities: { facilities: [facility, { ...facility, id: 'cn-storage', country: 'CN' }], fetchedAt: '2026-10-01', classifierVersion: 'fixture', upstreamUnavailable: false },
      shortages: { shortages: [shortage, { ...shortage, id: 'resolved', resolvedAt: '2026-10-01' }, { ...shortage, id: 'cn-shortage', country: 'CN' }], fetchedAt: '2026-10-01', classifierVersion: 'fixture', upstreamUnavailable: false },
      pipelineDetail: { pipeline, revisions: [], unavailable: false, fetchedAt: '2026-10-01' },
      facilityDetail: { facility, revisions: [], unavailable: false, fetchedAt: '2026-10-01' },
      shortageDetail: { shortage, unavailable: false, fetchedAt: '2026-10-01' },
      disruptions: { events: [{ id: 'controlled-disruption', assetId: 'us-pipeline', assetType: 'pipeline', countries: ['US', 'CA'], eventType: 'maintenance', shortDescription: 'Controlled pipeline maintenance', startAt: '2026-09-29', endAt: '2026-09-30', causeChain: ['maintenance'], capacityOfflineBcmYr: 2, capacityOfflineMbd: 0 }], fetchedAt: '2026-10-01', upstreamUnavailable: false },
      maritime: { countryCode: code, upstreamUnavailable: true },
      markets: { markets: [], dataAvailable: true },
      housing: { data: { bisPropertyResidential: { entries: [{ countryCode: code, indexValue: 156.4, yoyChange: -2.1, qoqChange: null, period: '2026-Q1' }] }, bisDsr: { entries: [{ countryCode: code, dsrPct: 8, change: 1.3, period: '2026-Q1' }] } } },
      imf: { data: {
        imfMacro: { countries: { [code]: { inflationPct: 2.5, year: 2026 } } },
        imfGrowth: { countries: { [code]: { realGdpGrowthPct: 1.8, gdpPerCapitaUsd: 85000, year: 2026 } } },
        imfLabor: { countries: { [code]: { unemploymentPct: 4.1, year: 2026 } } },
        imfExternal: { countries: { [code]: { exportsUsd: 123, year: 2026 } } },
      }, missing: [] },
      exposure: { exposures: fullExposure ? [{ chokepointId: 'hormuz', chokepointName: 'Strait of Hormuz', exposureScore: 0.2 }] : [], primaryChokepointId: 'hormuz', vulnerabilityIndex: 0.2, fetchedAt: '2026-10-01' },
      dependency: { flags: [], primaryExporterIso2: 'CN', primaryExporterShare: 0.2 },
      commodities: { vulnerabilities: [], upstreamUnavailable: true },
      products: { products: [] },
      debt: { entries: [] },
      flows: { flows: [] },
      tariffs: { datapoints: [] },
      food: { unavailable: false, records: [{ countryCode: code, commodity: 'wheat', marketingYear: '2025/26', stocksToUse: 0.25, hasStocksToUse: true, source: 'usda', totalUseTmt: 500 }] },
      demographics: { available: false },
    };
    if (atlasPartial && section === 'pipelines') (values.pipelines as { upstreamUnavailable: boolean }).upstreamUnavailable = true;
    if (partialBootstrap && section === 'imf') {
      const value = values.imf as { data: Record<string, unknown>; missing: string[] };
      delete value.data.imfGrowth;
      value.missing = ['imfGrowth'];
    }
    if (partialBootstrap && section === 'housing') (values.housing as { missing?: string[] }).missing = ['bisPropertyCommercial'];
    if (section === 'defense' || section === 'resilience') return { structuredContent: { section, state: 'locked', reason: 'Controlled connection lacks access' } };
    return { structuredContent: { section, state: 'ready', value: values[section] ?? {}, retrievedAt: '2026-10-01T15:00:00.000Z' } };
  });
  await page.goto('/country-host-test');
  const html = cachedShell ?? await readFile(join(root, 'dist/plugin/country.html'), 'utf8');
  await page.evaluate(html => {
    const frame = document.querySelector('iframe')!;
    window.addEventListener('message', async event => {
      if (event.source !== frame.contentWindow || event.data?.jsonrpc !== '2.0') return;
      if (!event.data.method || (!event.data.id && event.data.method !== 'notifications/cancelled')) return;
      try {
        const result = await (window as unknown as { countryHost: (method: string, params: object, id?: number) => Promise<object> }).countryHost(event.data.method, event.data.params, event.data.id);
        frame.contentWindow!.postMessage({ jsonrpc: '2.0', id: event.data.id, result }, '*');
        if (event.data.method === 'ui/initialize') {
          const args = { country_code: 'US', topic: 'overview' };
          frame.contentWindow!.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/tool-input', params: args }, '*');
          const opened = await (window as unknown as { countryHost: (method: string, params: object) => Promise<object> }).countryHost('tools/call', { name: 'open_country_brief', arguments: args });
          frame.contentWindow!.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: opened }, '*');
        }
      } catch (error) {
        frame.contentWindow!.postMessage({ jsonrpc: '2.0', id: event.data.id, error: { code: -32603, message: String(error) } }, '*');
      }
    });
    frame.srcdoc = html.replace('<head>', `<head><base href="${location.origin}/">`);
  }, html);
  const action = (name: string, args: object) => page.evaluate(({ name, args }) => new Promise<Record<string, unknown>>(resolve => {
    const id = -Math.random();
    const frame = document.querySelector('iframe')!;
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow || event.data.id !== id || event.data.method) return;
      window.removeEventListener('message', receive); resolve(event.data.result);
    };
    window.addEventListener('message', receive);
    frame.contentWindow!.postMessage({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }, '*');
  }), { name, args });
  return { calls, contexts, links, unmanaged, cancelled, action, releaseDisruptions, failAtlas: () => { atlasUnavailable = true; }, recoverAtlas: () => { atlasUnavailable = false; }, delayAtlasDetail: () => { delayAtlasDetail = true; }, releaseAtlasDetail, failDisruptions: () => { disruptionsFailed = true; }, failEnergy: () => { energyFailed = true; }, partialAtlas: () => { atlasPartial = true; }, denyAtlas: () => { atlasDenied = true; }, activityOutage: () => { failActivity = true; }, activityRecover: () => { failActivity = false; }, denyActivity: () => { denyActivity = true; }, partial: () => { partialBootstrap = true; }, complete: () => { partialBootstrap = false; }, quota: () => { quotaExceeded = true; }, get admissions() { return admissions; }, delayAdmission: () => { delayAdmission = true; }, releaseAdmission, delayCoverage: () => { delayCoverage = true; }, releaseCoverage, fail: () => { failFacts = true; }, recover: () => { failFacts = false; }, delay: () => { delayUS = true; }, release: releaseUS };
}

test('static country tiers match the website without adding host data readers', async ({ page }, info) => {
  const host = await installCountryHost(page);
  const frame = page.frameLocator('iframe');
  await expect.poll(() => host.contexts.at(-1)?.signals?.militaryFlights).toBe(1);
  await expect.poll(() => host.contexts.at(-1)?.sections.filter(section => section.state === 'loading').length).toBe(0);
  await writeFile(info.outputPath('static-tier-opening.json'), JSON.stringify({ context: host.contexts.at(-1), calls: host.calls }, null, 2));
  await expect.poll(() => host.contexts.at(-1)?.signals?.isTier1).toBe(true);
  await page.screenshot({ path: info.outputPath('static-tier-us-desktop.png'), fullPage: true });
  const initialCalls = host.calls.length;
  const selected = await host.action('select_country_view', { country_code: 'US', topic: 'security' });
  expect(selected).toMatchObject({ structuredContent: { countryCode: 'US', signals: { isTier1: true } } });
  await frame.getByRole('button', { name: 'Overview', exact: true }).click();
  await expect.poll(() => host.contexts.at(-1)?.topic).toBe('overview');
  expect(host.calls).toHaveLength(initialCalls);
  expect(host.admissions).toBe(1);

  await frame.getByRole('textbox', { name: 'Country name or code' }).fill('Switzerland');
  await frame.getByRole('button', { name: 'Open country', exact: true }).click();
  await expect.poll(() => host.contexts.at(-1)?.countryCode).toBe('CH');
  await expect.poll(() => host.contexts.at(-1)?.signals?.isTier1).toBe(false);
  expect(host.contexts.at(-1)?.signals?.criticalNews).toBeNull();
  expect(host.contexts.at(-1)?.signals?.protests).toBeNull();
  expect(host.admissions).toBe(2);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: info.outputPath('static-tier-ch-mobile.png'), fullPage: true });

  host.denyActivity();
  await frame.getByRole('button', { name: 'Refresh country', exact: true }).click();
  await expect.poll(() => host.admissions).toBe(3);
  await expect.poll(() => host.contexts.at(-1)?.signals?.militaryFlights).toBeNull();
  await expect.poll(() => host.contexts.at(-1)?.signals?.isTier1).toBe(false);
  await expect.poll(() => host.contexts.at(-1)?.sections.find(section => section.section === 'signals')?.state).toBe('unavailable');
  await frame.getByRole('textbox', { name: 'Country name or code' }).fill('USA');
  await frame.getByRole('button', { name: 'Open country', exact: true }).click();
  await expect.poll(() => host.contexts.at(-1)?.countryCode).toBe('US');
  await expect.poll(() => host.contexts.at(-1)?.signals?.isTier1).toBe(true);
  expect(host.contexts.at(-1)?.signals?.militaryFlights).toBeNull();
  await expect.poll(() => host.contexts.at(-1)?.sections.find(section => section.section === 'signals')?.state).toBe('unavailable');
  expect(host.admissions).toBe(3);
  expect(host.unmanaged).toEqual([]);
  await writeFile(info.outputPath('static-tier-final.json'), JSON.stringify({ contexts: host.contexts, calls: host.calls, admissions: host.admissions }, null, 2));
});

test('country territory counts honor loaded polygons instead of neighboring bounding-box observations', async ({ page }, info) => {
  const host = await installCountryHost(page);
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('[data-brief-section=military] .cdp-military-grid')).toContainText('Own Flights1');
  await frame.getByRole('textbox', { name: 'Country name or code' }).fill('FR');
  await frame.getByRole('button', { name: 'Open country', exact: true }).click();
  await expect(frame.locator('#countryStatus')).toContainText('France country brief.');
  await frame.getByRole('button', { name: 'Security', exact: true }).click();
  const military = frame.locator('[data-brief-section=military]');
  const grid = military.locator('.cdp-military-grid');
  await expect(grid).toContainText('Own Flights1');
  await military.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('country-territory-desktop.png'), fullPage: true });
  await expect(grid).toContainText('Foreign Flights0');
  await expect(grid).toContainText('Naval Vessels0');
  await expect(grid).toContainText('Foreign PresenceUnknown');
  await expect.poll(() => host.contexts.at(-1)?.sections.find(section => section.section === 'military')?.renderedText).toMatch(/Foreign Flights\s*0/);
  expect(host.admissions).toBe(2);
  await frame.getByRole('button', { name: 'Overview', exact: true }).click();
  await frame.getByRole('button', { name: 'Security', exact: true }).click();
  expect(host.admissions).toBe(2);
  await page.setViewportSize({ width: 390, height: 844 });
  await military.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('country-territory-mobile.png'), fullPage: true });
});

test('country Signals reuse loaded military observations and keep missing sources explicit', async ({ page }, info) => {
  const host = await installCountryHost(page, true);
  const frame = page.frameLocator('iframe');
  await frame.getByRole('button', { name: 'Security', exact: true }).click();
  const signals = frame.locator('[data-brief-section=signals]');
  await expect(signals).toContainText('1 Military Air');
  await expect(signals).toContainText('1 Naval Vessels');
  await expect(signals).toContainText('Critical News unavailable');
  await expect(signals).toContainText('Aggregate severity and recent high-severity observations are unavailable');
  await expect(signals).toHaveAttribute('data-brief-coverage', 'partial');
  await expect.poll(() => host.contexts.at(-1)?.signals?.militaryFlights).toBe(1);
  expect(host.contexts.at(-1)?.signals?.criticalNews).toBeNull();
  await expect.poll(() => host.contexts.at(-1)?.sections.filter(section => section.state === 'loading').length).toBe(0);
  const initialReads = host.calls.length;
  await frame.getByRole('button', { name: 'Economy & trade', exact: true }).click();
  await frame.getByRole('button', { name: 'Security', exact: true }).click();
  expect(host.calls).toHaveLength(initialReads);
  expect(host.admissions).toBe(1);
  await signals.screenshot({ path: info.outputPath('signals-observed-desktop.png') });
  host.activityOutage();
  await frame.getByRole('button', { name: 'Refresh country', exact: true }).click();
  await expect(signals).toContainText('Showing previously loaded observations');
  await expect(signals).toContainText('1 Naval Vessels');
  await expect(signals).toContainText('1 Military Air');
  await expect.poll(() => host.contexts.at(-1)?.signals?.militaryVessels).toBe(1);
  await signals.screenshot({ path: info.outputPath('signals-source-outage-desktop.png') });
  host.activityRecover();
  await frame.getByRole('button', { name: 'Refresh country', exact: true }).click();
  await expect(signals).toContainText('1 Naval Vessels');
  await expect(signals).not.toContainText('Naval Vessels unavailable');
  await expect.poll(() => host.contexts.at(-1)?.signals?.militaryVessels).toBe(1);
  await expect(signals).not.toContainText('Showing previously loaded observations');
  expect(host.admissions).toBe(3);
  expect(host.unmanaged).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  await signals.screenshot({ path: info.outputPath('signals-recovered-mobile.png') });
  expect(await frame.locator('body').evaluate(body => body.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await writeFile(info.outputPath('signals-request-cost.json'), JSON.stringify({ surface: 'compiled opaque iframe, controlled observations', initialHostCalls: initialReads, initialDailyUnits: 1, navigationCalls: 0, newSignalsReaders: 0, signalProjection: 'observed military counts, remaining sources explicitly unavailable' }, null, 2));
  host.denyActivity();
  await frame.getByRole('button', { name: 'Refresh country', exact: true }).click();
  await expect(signals).toContainText('Military Air unavailable');
  await expect(signals).toContainText('Naval Vessels unavailable');
  await expect(signals).not.toContainText('Showing previously loaded observations');
  await expect.poll(() => host.contexts.at(-1)?.signals?.militaryFlights).toBeNull();
  await expect.poll(() => host.contexts.at(-1)?.signals?.militaryVessels).toBeNull();
  expect(host.admissions).toBe(4);
});

test('cached country resource loads the current compiled panel after its old assets are removed', async ({ page }, info) => {
  const fetchBefore = globalThis.fetch;
  let shell: string;
  try {
    globalThis.fetch = async () => new Response('<!doctype html><html><head></head><body><main id="countryRoot">Old country panel</main><script type="module" src="/plugin/assets/country-removed.js"></script></body></html>', { headers: { 'Content-Type': 'text/html' } });
    const response = await (await readCountryView(1, {})).json();
    shell = response.result.contents[0].text;
  } finally { globalThis.fetch = fetchBefore; }
  const requests: string[] = [];
  page.on('request', request => requests.push(request.url()));
  await page.route('**/plugin/country.html*', route => route.fulfill({ path: join(root, 'dist/plugin/country.html'), headers: { 'Access-Control-Allow-Origin': '*' } }));
  const host = await installCountryHost(page, false, undefined, true, {}, shell);
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('.cdp-country-name')).toHaveText('United States', { timeout: 5000 });
  expect(requests.some(url => url.endsWith('/country-removed.js'))).toBe(false);
  await frame.getByRole('button', { name: 'Resources & infrastructure', exact: true }).click();
  const energy = frame.locator('[data-brief-section=energy]');
  await expect(energy).toContainText('1 pipeline');
  await energy.getByRole('button', { name: 'Controlled US Pipeline', exact: true }).click();
  await expect(frame.locator('[data-country-atlas-detail]')).toContainText('Controlled operator statement');
  await expect(frame.locator('[data-country-atlas-detail]')).toContainText('Controlled pipeline maintenance');
  await frame.getByRole('button', { name: 'Back to country', exact: true }).click();
  await frame.getByRole('button', { name: 'Overview', exact: true }).click();
  expect(host.admissions).toBe(1);
  await page.screenshot({ path: info.outputPath('cached-country-current-build.png'), fullPage: true });
  await page.setViewportSize({ width: 430, height: 1200 });
  await expect(frame.locator('.cdp-country-name')).toHaveText('United States');
  await page.screenshot({ path: info.outputPath('cached-country-current-build-mobile.png'), fullPage: true });
});

test('country military observations render under one allocation and survive an AIS outage', async ({ page }, info) => {
  const host = await installCountryHost(page);
  const frame = page.frameLocator('iframe');
  await frame.getByRole('button', { name: 'Security', exact: true }).click();
  const military = frame.locator('[data-brief-section=military]');
  await expect(military).toContainText('Flight counts include observations licensed');
  await expect(military).toContainText('bounded to 1,500 reports');
  const aisCalls = host.calls.filter(call => call.arguments.section === 'vessels');
  expect(aisCalls).toHaveLength(1);
  expect(aisCalls[0]?.arguments.arguments).toMatchObject({ ne_lat: 0, ne_lon: 0, sw_lat: 0, sw_lon: 0 });
  await expect(military.locator('.cdp-military-grid')).toContainText('Own Flights1');
  await expect(military.locator('.cdp-military-grid')).toContainText('Naval Vessels1');
  expect(host.admissions).toBe(1);
  expect(host.unmanaged).toEqual([]);
  await military.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('country-military-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await military.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('country-military-mobile.png'), fullPage: true });
  host.activityOutage();
  await frame.getByRole('button', { name: 'Refresh country', exact: true }).click();
  await expect(military.locator('.cdp-military-grid')).toContainText('Naval VesselsUnavailable');
  await expect(military.locator('.cdp-military-grid')).toContainText('Foreign PresenceUnknown');
  await expect(military).toContainText('Live AIS observations unavailable');
  await expect(military.locator('.cdp-military-grid')).toContainText('Own Flights1');
  await expect.poll(() => host.contexts.at(-1)?.sections.find(section => section.section === 'military')?.renderedText).toContain('Live AIS observations unavailable');
  expect(host.admissions).toBe(2);
  await military.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('country-military-outage-mobile.png'), fullPage: true });
  host.activityRecover();
  await frame.getByRole('button', { name: 'Refresh country', exact: true }).click();
  await expect(military.locator('.cdp-military-grid')).toContainText('Naval Vessels1');
  expect(host.admissions).toBe(3);
});

test('partial bootstrap coverage is visible and clears when the country recovers', async ({ page }, info) => {
  const host = await installCountryHost(page);
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('[data-brief-section=facts]')).toContainText('Washington, D.C.');
  host.partial();
  await frame.getByRole('button', { name: 'Refresh country', exact: true }).click();
  await frame.getByRole('button', { name: 'Economy & trade', exact: true }).click();
  const economic = frame.locator('[data-brief-section=economic]');
  await expect(economic).toContainText('2.5%');
  await expect(economic).toContainText('Partial coverage. Unavailable data: growth and GDP');
  await expect(frame.locator('[data-brief-section=housing]')).toContainText('Partial coverage. Unavailable data: commercial property');
  await expect.poll(() => host.contexts.at(-1)?.sections.find(section => section.section === 'economic')?.coverage).toBe('partial');
  expect(host.contexts.at(-1)?.sections.find(section => section.section === 'economic')?.renderedText).toContain('Unavailable data: growth and GDP');
  await frame.getByRole('button', { name: 'Export report ↗', exact: true }).click();
  const download = page.waitForEvent('download');
  await frame.getByRole('button', { name: 'Download report HTML', exact: true }).click();
  const report = await readFile((await (await download).path())!, 'utf8');
  expect(report).toContain('Unavailable data: growth and GDP');
  expect(report).toContain('Unavailable data: commercial property');
  await frame.getByRole('button', { name: '← Back to brief', exact: true }).click();
  await frame.getByRole('button', { name: 'Economy & trade', exact: true }).click();
  await economic.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('country-partial-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 1000 });
  await economic.locator('.cdp-section-coverage').evaluate(element => element.scrollIntoView({ block: 'center' }));
  await expect(economic.locator('.cdp-section-coverage')).toBeInViewport();
  await page.screenshot({ path: info.outputPath('country-partial-mobile.png'), fullPage: true });
  host.complete();
  await frame.getByRole('button', { name: 'Refresh country', exact: true }).click();
  await expect(economic).toContainText('1.8%');
  await expect(economic.locator('.cdp-section-coverage')).toHaveCount(0);
  await expect(frame.locator('[data-brief-section=housing] .cdp-section-coverage')).toHaveCount(0);
});

test('built opaque country view uses the shared sections, host reads, sources and actual report output', async ({ page }, info) => {
  const host = await installCountryHost(page);
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('.cdp-country-name')).toHaveText(/United States/);
  await expect(frame.locator('[data-brief-section=facts]')).toContainText('Washington, D.C.');
  await expect(frame.locator('#countryUsage')).toContainText('49 of 50 requests remaining');
  await expect(frame.locator('[data-brief-section=factors]')).toContainText('Production');
  await expect(frame.locator('[data-brief-section]')).toHaveCount(23);
  expect(await frame.locator('#deep-dive-content').evaluate(el => el.getBoundingClientRect().width)).toBeGreaterThan(1000);
  await frame.getByRole('button', { name: 'Resources & infrastructure', exact: true }).click();
  await expect(frame.locator('[data-brief-section=food]')).toContainText('2025/26');
  await expect(frame.locator('[data-brief-section=food]')).toContainText('25.0%');
  await frame.getByRole('button', { name: 'Economy & trade', exact: true }).click();
  await expect(frame.locator('[data-brief-section=economic]')).toContainText('2.5%');
  await expect(frame.locator('[data-brief-section=economic]')).toContainText('IMF WEO');
  await expect(frame.locator('[data-brief-section=housing]')).toContainText('156.4');
  await expect(frame.locator('[data-brief-section=housing]')).toContainText('2026-Q1');
  await frame.getByRole('button', { name: 'Security', exact: true }).click();
  await expect(frame.locator('[data-brief-section=military]')).toContainText('not authorized');
  await frame.getByRole('button', { name: 'Sources', exact: true }).click();
  await frame.getByRole('link', { name: /Controlled US source article/ }).click();
  await expect.poll(() => host.links).toContain('https://example.com/evidence');
  await frame.getByRole('button', { name: 'Overview', exact: true }).click();
  await expect.poll(() => host.contexts.at(-1)?.topic).toBe('overview');
  expect(host.contexts.at(-1)?.countryCode).toBe('US');
  expect(host.contexts.at(-1)?.sections.find(section => section.section === 'housing')?.renderedText).toContain('2026-Q1');
  await frame.getByRole('button', { name: 'Export report ↗', exact: true }).click();
  await expect(frame.getByRole('button', { name: 'Download report HTML', exact: true })).toBeVisible();
  const download = page.waitForEvent('download');
  await frame.getByRole('button', { name: 'Download report HTML', exact: true }).click();
  const file = await (await download).path();
  const report = await readFile(file!, 'utf8');
  expect(report).toContain('Washington, D.C.');
  expect(report).toContain('2026-Q1');
  expect(report).toContain('Controlled US source article');
  await frame.getByRole('button', { name: '← Back to brief', exact: true }).click();
  await frame.getByRole('button', { name: 'Economy & trade', exact: true }).click();
  for (const [name, width, height] of [['desktop', 1280, 1000], ['mobile', 390, 844]] as const) {
    await page.setViewportSize({ width, height });
    await frame.locator('[data-brief-section=economic]').scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`country-plugin-${name}.png`), fullPage: true });
    await frame.locator('[data-brief-section=housing]').scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`country-housing-${name}.png`), fullPage: true });
    await expect.poll(() => frame.locator('body').evaluate(body => body.scrollWidth <= innerWidth + 1)).toBe(true);
  }
  expect(host.unmanaged).toEqual([]);
  expect(host.calls.some(call => call.name === 'get_country_brief_section')).toBe(true);
});

test('refresh keeps prior observations and delayed country work cannot repaint a new country', async ({ page }) => {
  const host = await installCountryHost(page);
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('[data-brief-section=facts]')).toContainText('Washington, D.C.');
  await expect.poll(() => host.calls.filter(call => call.arguments.section === 'factors').length).toBe(1);
  host.fail();
  await frame.getByRole('button', { name: 'Refresh country', exact: true }).click();
  await expect(frame.locator('[data-brief-section=facts]')).toContainText('Previously loaded observations remain visible');
  await expect(frame.locator('[data-brief-section=facts]')).toContainText('Washington, D.C.');
  await expect.poll(() => host.calls.filter(call => call.arguments.section === 'factors').length).toBe(2);
  host.delayCoverage();
  await frame.getByRole('button', { name: 'Refresh country', exact: true }).click();
  await expect.poll(() => host.calls.filter(call => call.name === 'get_country_coverage').length).toBe(3);
  await frame.getByRole('button', { name: 'Refresh country', exact: true }).click();
  await expect.poll(() => host.cancelled).toContain('get_country_coverage');
  host.releaseCoverage();
  expect(host.calls.filter(call => call.name === 'get_country_brief')).toHaveLength(1);
  await expect(frame.locator('#countryUsage')).toContainText('46 of 50 requests remaining');
  await frame.getByRole('button', { name: 'New AI assessment', exact: true }).click();
  await expect.poll(() => host.calls.filter(call => call.name === 'get_country_brief').length).toBe(2);
  host.recover();
  host.delay();
  host.delayAdmission();
  const beforeRefreshAdmissions = host.admissions;
  await frame.getByRole('button', { name: 'Refresh country', exact: true }).click();
  await frame.getByRole('textbox', { name: 'Country name or code' }).fill('Ukraine');
  host.releaseAdmission();
  await expect(frame.locator('#countryUsage')).toContainText(`${49 - beforeRefreshAdmissions} of 50 requests remaining`);
  await expect(frame.getByRole('textbox', { name: 'Country name or code' })).toHaveValue('Ukraine');
  await frame.getByRole('button', { name: 'Open country', exact: true }).click();
  await expect(frame.locator('.cdp-country-name')).toHaveText('Ukraine');
  host.release();
  await expect(frame.locator('[data-brief-section=facts]')).toContainText('Kyiv');
  await expect(frame.locator('[data-brief-section=facts]')).not.toContainText('Washington, D.C.');
  await expect.poll(() => host.contexts.at(-1)?.countryCode).toBe('UA');
  await frame.getByRole('textbox', { name: 'Country name or code' }).fill('United States');
  await frame.getByRole('button', { name: 'Open country', exact: true }).click();
  await expect(frame.locator('[data-brief-section=assessment]')).toContainText('Controlled US assessment');
  expect(host.calls.filter(call => call.name === 'get_country_brief')).toHaveLength(3);
});

test('decision calculations and their JSON download use the authenticated host source', async ({ page }) => {
  const host = await installCountryHost(page);
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('[data-brief-section=facts]')).toContainText('Washington, D.C.');
  await frame.getByRole('button', { name: 'Decision brief', exact: true }).click();
  const output = frame.getByRole('region', { name: 'Decision brief', exact: true });
  await output.getByRole('button', { name: 'Capture / refresh both' }).click();
  await expect(output.getByRole('status')).toContainText('Captured.');
  await expect(output.locator('.cdp-decision-paper')).toContainText('2026-05');
  const download = page.waitForEvent('download');
  await output.getByRole('button', { name: 'Download decision JSON', exact: true }).click();
  const file = await (await download).path();
  const saved = JSON.parse(await readFile(file!, 'utf8'));
  expect(saved.selection.countryCode).toBe('US');
  expect(JSON.stringify(saved)).toContain('2026-05');
  expect(host.calls.filter(call => call.arguments.section === 'scenario')).toHaveLength(2);
  expect(host.unmanaged).toEqual([]);
});


test('country navigation and repeated questions reuse reads and show a quota denial without losing observations', async ({ page }, info) => {
  const start = performance.now();
  const host = await installCountryHost(page, true);
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('[data-brief-section=facts]')).toContainText('Washington, D.C.');
  await expect.poll(() => host.calls.filter(call => call.arguments.section === 'exposure').length).toBe(10);
  await expect.poll(() => host.contexts.at(-1)?.sections.filter(section => section.state === 'loading').length).toBe(0);
  await expect.poll(() => host.calls.filter(call => call.arguments.section === 'dependency').length).toBe(10);
  const initialMs = performance.now() - start;
  const initialReads = host.calls.length;
  await frame.getByRole('button', { name: 'Open country', exact: true }).click();
  await frame.getByRole('button', { name: 'Economy & trade', exact: true }).click();
  await frame.getByRole('button', { name: 'Resources & infrastructure', exact: true }).click();
  expect(host.calls).toHaveLength(initialReads);
  expect(host.admissions).toBe(1);
  expect(host.calls.filter(call => call.arguments.section === 'risk')).toHaveLength(1);
  expect(host.calls.filter(call => call.name !== 'open_country_brief').every(call => call.arguments.panel_request === 'US.controlled-admission-1')).toBe(true);
  await frame.getByRole('textbox', { name: 'Country name or code' }).fill('Ukraine');
  await frame.getByRole('button', { name: 'Open country', exact: true }).click();
  await expect(frame.locator('[data-brief-section=facts]')).toContainText('Kyiv');
  await expect.poll(() => host.contexts.at(-1)?.countryCode).toBe('UA');
  await expect.poll(() => host.contexts.at(-1)?.sections.filter(section => section.state === 'loading').length).toBe(0);
  const beforeReturn = host.calls.length;
  await frame.getByRole('textbox', { name: 'Country name or code' }).fill('United States');
  await frame.getByRole('button', { name: 'Open country', exact: true }).click();
  await expect(frame.locator('[data-brief-section=facts]')).toContainText('Washington, D.C.');
  await expect.poll(() => host.contexts.at(-1)?.countryCode).toBe('US');
  expect(host.admissions).toBe(2);
  const returnCalls = host.calls.length - beforeReturn;
  expect(host.calls.filter(call => call.arguments.section === 'facts')).toHaveLength(2);
  const beforeRefresh = host.calls.length;
  const beforeRefreshAdmissions = host.admissions;
  await frame.getByRole('button', { name: 'Refresh country', exact: true }).click();
  await expect.poll(() => host.admissions).toBe(beforeRefreshAdmissions + 1);
  await expect.poll(() => host.calls.filter(call => call.arguments.section === 'dependency').length).toBe(30);
  await expect.poll(() => host.contexts.at(-1)?.sections.filter(section => section.state === 'loading').length).toBe(0);
  const refreshCalls = host.calls.length - beforeRefresh;
  await expect(frame.locator('#countryUsage')).toContainText('47 of 50 requests remaining');
  host.quota();
  const beforeDenied = host.calls.length;
  await frame.getByRole('button', { name: 'Refresh country', exact: true }).click();
  await expect(frame.locator('#countryStatus')).toContainText('Daily MCP quota exceeded');
  await expect(frame.locator('#countryStatus')).toContainText('UTC midnight');
  await expect(frame.locator('[data-brief-section=facts]')).toContainText('Washington, D.C.');
  expect(host.calls).toHaveLength(beforeDenied + 1);
  await writeFile(info.outputPath('country-request-cost.json'), JSON.stringify({ measuredSurface: 'built opaque iframe, controlled host', initialHostCalls: initialReads, initialDailyUnits: 1, initialMs: Math.round(initialMs), repeatedCountryAndTopicsCalls: 0, navigationBackHostCalls: returnCalls, navigationBackDailyUnits: 0, refreshHostCalls: refreshCalls, refreshDailyUnits: 1, deniedRefreshSectionCalls: 0, deniedRefreshDailyUnits: 0 }, null, 2));
});

test('an initial host open denial displays its reason without section loads', async ({ page }) => {
  const host = await installCountryHost(page, false, 'Daily MCP quota exceeded (50 requests/day). Resets at next UTC midnight.');
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('#countryStatus')).toContainText('Daily MCP quota exceeded');
  await expect(frame.locator('#countryStatus')).toContainText('UTC midnight');
  await expect(frame.locator('#countryUsage')).toBeHidden();
  expect(host.calls.map(call => call.name)).toEqual(['open_country_brief']);
});


test('Atlas counts open original asset details, evidence and timeline under one country allocation', async ({ page }, info) => {
  const host = await installCountryHost(page, false, undefined, true);
  const frame = page.frameLocator('iframe');
  await frame.getByRole('button', { name: 'Resources & infrastructure', exact: true }).click();
  const energy = frame.locator('[data-brief-section=energy]');
  await expect(energy).toContainText('Pipelines touching US');
  await expect(energy).toContainText('1 pipeline');
  await expect(energy).toContainText('1 facility');
  await expect(energy).toContainText('1 confirmed');
  await expect(energy).not.toContainText('Other country pipeline');
  await expect(energy.getByRole('button', { name: 'diesel — Controlled active shortage', exact: true })).toHaveCount(1);
  await energy.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('atlas-counts-desktop.png'), fullPage: true });
  await energy.getByRole('button', { name: 'Controlled US Pipeline', exact: true }).click();
  const output = frame.locator('[data-country-atlas-detail]');
  await expect(output).toContainText('Controlled operator statement');
  await expect(output).toContainText('Controlled pipeline maintenance');
  await expect(output).toContainText('12.0 bcm/yr');
  await expect.poll(() => output.locator('.pp-drawer').evaluate(el => el.clientHeight >= el.scrollHeight - 1 && el.clientHeight > 250)).toBe(true);
  await output.locator('.pp-drawer').scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('atlas-pipeline-desktop.png'), fullPage: true });
  await output.getByRole('link', { name: '2026-10-01', exact: true }).click();
  await expect.poll(() => host.links).toContain('https://example.com/pipeline-source');
  await expect.poll(() => host.contexts.at(-1)).toMatchObject({ selectedAtlasAsset: { type: 'pipeline', id: 'us-pipeline', renderedText: expect.stringContaining('Controlled operator statement') } });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => output.locator('.pp-drawer').evaluate(el => el.clientHeight >= el.scrollHeight - 1 && el.clientHeight > 250)).toBe(true);
  await output.locator('.pp-drawer').scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('atlas-pipeline-mobile.png'), fullPage: true });
  await expect.poll(() => frame.locator('body').evaluate(body => body.scrollWidth <= innerWidth + 1)).toBe(true);
  await frame.getByRole('button', { name: 'Back to country', exact: true }).click();
  await energy.getByRole('button', { name: 'Controlled US Storage', exact: true }).click();
  await expect(output).toContainText('Controlled storage statement');
  await expect(output).toContainText('12 Mb');
  await expect.poll(() => output.locator('.sf-drawer').evaluate(el => el.clientHeight >= el.scrollHeight - 1)).toBe(true);
  await page.screenshot({ path: info.outputPath('atlas-storage-mobile.png'), fullPage: true });
  await frame.getByRole('button', { name: 'Back to country', exact: true }).click();
  await energy.getByRole('button', { name: 'diesel — Controlled active shortage', exact: true }).click();
  await expect(output).toContainText('Controlled shortage source');
  await expect.poll(() => output.locator('.fs-drawer').evaluate(el => el.clientHeight >= el.scrollHeight - 1)).toBe(true);
  await page.screenshot({ path: info.outputPath('atlas-shortage-mobile.png'), fullPage: true });
  await frame.getByRole('button', { name: 'Back to country', exact: true }).click();
  expect(host.admissions).toBe(1);
  expect(host.unmanaged).toEqual([]);
  expect(host.calls.filter(call => String(call.arguments.section).endsWith('Detail')).every(call => (call.arguments.arguments as Record<string, unknown>).country_code === 'US')).toBe(true);
  host.denyAtlas();
  await frame.getByRole('button', { name: 'Refresh country', exact: true }).click();
  await expect(energy).toContainText('Storage Atlas data is not authorized by this connection');
  await expect(energy).toContainText('Controlled US Pipeline');
  await energy.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('atlas-denial-mobile.png'), fullPage: true });
});


test('Atlas remains usable when energy metrics and disruption timelines fail and partial coverage is explicit', async ({ page }) => {
  const host = await installCountryHost(page, false, undefined, true);
  const frame = page.frameLocator('iframe');
  await frame.getByRole('button', { name: 'Resources & infrastructure', exact: true }).click();
  const energy = frame.locator('[data-brief-section=energy]');
  await expect(energy).toContainText('Controlled US Pipeline');
  host.failEnergy(); host.failDisruptions(); host.partialAtlas();
  await frame.getByRole('button', { name: 'Refresh country', exact: true }).click();
  await expect(energy).toContainText('This section could not be loaded');
  await expect(energy).toContainText('Pipeline Atlas coverage is partial');
  await energy.getByRole('button', { name: 'Controlled US Pipeline', exact: true }).click();
  const output = frame.locator('[data-country-atlas-detail]');
  await expect(output).toContainText('Controlled operator statement');
  await expect(output).toContainText('Disruption timeline unavailable');
  await expect(output).not.toContainText('No disruption events on file');
  await frame.getByRole('button', { name: 'Back to country', exact: true }).click();
  host.denyAtlas();
  await energy.getByRole('button', { name: 'Controlled US Storage', exact: true }).click();
  await expect(output).toContainText('Controlled Atlas connection lacks access');
  expect(host.unmanaged).toEqual([]);
  expect(host.admissions).toBe(2);
});


test('agent Atlas actions share country scope and country changes cancel pending details', async ({ page }) => {
  const host = await installCountryHost(page, false, undefined, true);
  const frame = page.frameLocator('iframe');
  await frame.getByRole('button', { name: 'Resources & infrastructure', exact: true }).click();
  await expect(frame.locator('[data-brief-section=energy]')).toContainText('Controlled US Pipeline');
  expect(await host.action('open_country_atlas_asset', { type: 'pipeline', id: 'cn-pipeline' })).toMatchObject({ isError: true });
  expect(await host.action('open_country_atlas_asset', { type: 'pipeline', id: 'us-pipeline', extra: true })).toMatchObject({ isError: true });
  const opened = await host.action('open_country_atlas_asset', { type: 'pipeline', id: 'us-pipeline' });
  expect(opened).toMatchObject({ structuredContent: { selectedAtlasAsset: { type: 'pipeline', id: 'us-pipeline', renderedText: expect.stringContaining('Controlled operator statement') } } });
  await expect(frame.locator('[data-country-atlas-detail]')).toContainText('Controlled operator statement');
  await frame.getByRole('button', { name: 'Back to country', exact: true }).click();
  host.delayAtlasDetail();
  await frame.getByRole('button', { name: 'Controlled US Storage', exact: true }).click();
  await expect(frame.locator('[data-country-atlas-detail]')).toContainText('Loading');
  await host.action('select_country_view', { country_code: 'CN', topic: 'resources' });
  await expect.poll(() => host.cancelled).toContain('get_country_brief_section');
  host.releaseAtlasDetail();
  await expect(frame.locator('[data-country-atlas-detail]')).toHaveCount(0);
  await expect.poll(() => host.contexts.at(-1)).toMatchObject({ countryCode: 'CN', selectedAtlasAsset: null });
  expect(host.admissions).toBe(2);
  expect(host.unmanaged).toEqual([]);
});


test('initial energy failure does not block Atlas and delayed timelines do not block asset evidence', async ({ page }) => {
  const host = await installCountryHost(page, false, undefined, true, { energy: true, timeline: true });
  const frame = page.frameLocator('iframe');
  await frame.getByRole('button', { name: 'Resources & infrastructure', exact: true }).click();
  const energy = frame.locator('[data-brief-section=energy]');
  await expect(energy).toContainText('This section could not be loaded');
  await energy.getByRole('button', { name: 'Controlled US Pipeline', exact: true }).click();
  const output = frame.locator('[data-country-atlas-detail]');
  await expect(output).toContainText('12.0 bcm/yr');
  await expect(output).toContainText('Controlled operator statement');
  await expect(output).toContainText('Loading disruption timeline');
  host.releaseDisruptions();
  await expect(output).toContainText('Controlled pipeline maintenance');
  expect(host.admissions).toBe(1);
});


test('transient Atlas failure preserves same-country rows and detail actions while denial clears them', async ({ page }, info) => {
  const host = await installCountryHost(page, false, undefined, true);
  const frame = page.frameLocator('iframe');
  await frame.getByRole('button', { name: 'Resources & infrastructure', exact: true }).click();
  const energy = frame.locator('[data-brief-section=energy]');
  await expect(energy).toContainText('Controlled US Storage');
  host.failAtlas();
  await frame.getByRole('button', { name: 'Refresh country', exact: true }).click();
  await expect(energy).toContainText('Storage Atlas data unavailable. Previously loaded Atlas observations remain visible.');
  await energy.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('atlas-retained-desktop.png'), fullPage: true });
  await energy.getByRole('button', { name: 'Controlled US Storage', exact: true }).click();
  await expect(frame.locator('[data-country-atlas-detail]')).toContainText('12 Mb');
  await frame.getByRole('button', { name: 'Back to country', exact: true }).click();
  host.recoverAtlas(); host.denyAtlas();
  await frame.getByRole('button', { name: 'Refresh country', exact: true }).click();
  await expect(energy).toContainText('Storage Atlas data is not authorized');
  await expect(energy.getByRole('button', { name: 'Controlled US Storage', exact: true })).toHaveCount(0);
  expect(host.admissions).toBe(3);
});
