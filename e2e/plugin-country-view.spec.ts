import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import us from './fixtures/country-brief-us.json' with { type: 'json' };

const root = process.cwd();
test.use({ serviceWorkers: 'block' });

type HostCall = { name: string; arguments: Record<string, unknown> };
async function installCountryHost(page: Page) {
  const calls: HostCall[] = [];
  const requestNames = new Map<number, string>();
  const cancelled: string[] = [];
  let delayCoverage = false;
  let releaseCoverage: () => void = () => {};
  const coverageDelayed = new Promise<void>(resolve => { releaseCoverage = resolve; });
  const contexts: Array<{ countryCode: string; topic: string; sections: Array<{ section: string; state: string; renderedText: string }> }> = [];
  const links: string[] = [];
  let failFacts = false;
  let delayUS = false;
  let releaseUS: () => void = () => {};
  const delayed = new Promise<void>(resolve => { releaseUS = resolve; });
  const unmanaged: string[] = [];
  page.on('request', request => { if (request.url().includes('/api/')) unmanaged.push(request.url()); });
  await page.route('**/plugin/assets/**', async route => {
    const file = join(root, 'dist/plugin/assets', new URL(route.request().url()).pathname.split('/').at(-1)!);
    await route.fulfill({ path: file });
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
    const code = String(args.country_code ?? (args.arguments as Record<string, unknown>)?.country_code ?? (args.arguments as Record<string, unknown>)?.countryCode ?? 'US');
    if (params.name === 'get_country_brief') return { structuredContent: { ...us.brief, countryCode: code, brief: `Controlled ${code} assessment. Source observations, not live acceptance.` } };
    if (params.name === 'get_country_coverage' && delayCoverage) await coverageDelayed;
    if (params.name === 'get_country_coverage') return { structuredContent: { countryCode: code, countryName: code, generatedAt: '2026-10-01T15:00:00Z', degraded: false, headlines: [{ title: `Controlled ${code} source article`, source: 'Fixture publisher', url: 'https://example.com/evidence', publishedAtMs: 1790863200000 }], events: [], sources: [{ source: 'news', state: 'ready' }, { source: 'events', state: 'unavailable' }] } };
    const section = String(args.section);
    if (section === 'facts' && code === 'US' && delayUS) await delayed;
    if (section === 'facts' && failFacts) return { structuredContent: { section, state: 'unavailable', reason: 'Controlled source failure' } };
    const values: Record<string, object> = {
      facts: { countryCode: code, countryName: code, capital: code === 'US' ? 'Washington, D.C.' : 'Kyiv', population: '340100000', areaSqKm: 9826675, languages: ['English'], currencies: ['US dollar'] },
      factors: us.scorecard,
      risk: { upstreamUnavailable: true },
      scenario: { countryCode: code, chokepointId: String((args.arguments as Record<string, unknown>).chokepoint_id), disruptionPct: Number((args.arguments as Record<string, unknown>).disruption_pct), dataAvailable: true, jodiOilCoverage: true, crudeLossKbd: 100, gulfCrudeShare: 0.3, products: [], limitations: [], coverageLevel: 'partial', gasSensitivity: { dataAvailable: true, lngImportsTj: 100000, totalDemandTj: 500000, lngDisruptionTj: Number((args.arguments as Record<string, unknown>).disruption_pct) * 300, deficitPct: Number((args.arguments as Record<string, unknown>).disruption_pct) * 0.06, dataMonth: '2026-05', dataSource: 'JODI', modelBasis: 'assumed_route_sensitivity', assessment: 'Controlled route sensitivity, not measured supplier exposure.' } },
      stock: { available: false },
      energy: { countryCode: code, upstreamUnavailable: true },
      maritime: { countryCode: code, upstreamUnavailable: true },
      markets: { markets: [], dataAvailable: true },
      housing: { data: { bisPropertyResidential: { entries: [{ countryCode: code, indexValue: 156.4, yoyChange: -2.1, qoqChange: null, period: '2026-Q1' }] }, bisDsr: { entries: [{ countryCode: code, dsrPct: 8, change: 1.3, period: '2026-Q1' }] } } },
      imf: { data: {} },
      exposure: { exposures: [] },
      commodities: { vulnerabilities: [], upstreamUnavailable: true },
      products: { products: [] },
      debt: { entries: [] },
      flows: { flows: [] },
      tariffs: { datapoints: [] },
      food: { unavailable: false, records: [{ countryCode: code, commodity: 'wheat', marketingYear: '2025/26', stocksToUse: 0.25, hasStocksToUse: true, source: 'usda', totalUseTmt: 500 }] },
      demographics: { available: false },
    };
    if (section === 'defense' || section === 'resilience') return { structuredContent: { section, state: 'locked', reason: 'Controlled connection lacks access' } };
    return { structuredContent: { section, state: 'ready', value: values[section] ?? {}, retrievedAt: '2026-10-01T15:00:00.000Z' } };
  });
  await page.goto('/country-host-test');
  const html = await readFile(join(root, 'dist/plugin/country.html'), 'utf8');
  await page.evaluate(html => {
    const frame = document.querySelector('iframe')!;
    window.addEventListener('message', async event => {
      if (event.source !== frame.contentWindow || event.data?.jsonrpc !== '2.0') return;
      if (!event.data.id && event.data.method !== 'notifications/cancelled') return;
      try {
        const result = await (window as unknown as { countryHost: (method: string, params: object, id?: number) => Promise<object> }).countryHost(event.data.method, event.data.params, event.data.id);
        frame.contentWindow!.postMessage({ jsonrpc: '2.0', id: event.data.id, result }, '*');
        if (event.data.method === 'ui/initialize') frame.contentWindow!.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/tool-input', params: { country_code: 'US', topic: 'overview' } }, '*');
      } catch {
        frame.contentWindow!.postMessage({ jsonrpc: '2.0', id: event.data.id, error: { code: -32603, message: 'Controlled host failure' } }, '*');
      }
    });
    frame.srcdoc = html.replace('<head>', `<head><base href="${location.origin}/">`);
  }, html);
  return { calls, contexts, links, unmanaged, cancelled, delayCoverage: () => { delayCoverage = true; }, releaseCoverage, fail: () => { failFacts = true; }, recover: () => { failFacts = false; }, delay: () => { delayUS = true; }, release: releaseUS };
}

test('built opaque country view uses the shared sections, host reads, sources and actual report output', async ({ page }, info) => {
  const host = await installCountryHost(page);
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('.cdp-country-name')).toHaveText(/United States/);
  await expect(frame.locator('[data-brief-section=facts]')).toContainText('Washington, D.C.');
  await expect(frame.locator('[data-brief-section=factors]')).toContainText('Production');
  await expect(frame.locator('[data-brief-section]')).toHaveCount(23);
  expect(await frame.locator('#deep-dive-content').evaluate(el => el.getBoundingClientRect().width)).toBeGreaterThan(1000);
  await frame.getByRole('button', { name: 'Resources & infrastructure', exact: true }).click();
  await expect(frame.locator('[data-brief-section=food]')).toContainText('2025/26');
  await expect(frame.locator('[data-brief-section=food]')).toContainText('25.0%');
  await frame.getByRole('button', { name: 'Economy & trade', exact: true }).click();
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
  for (const [name, width, height] of [['desktop', 1280, 1000], ['mobile', 390, 844]] as const) {
    await page.setViewportSize({ width, height });
    await page.screenshot({ path: info.outputPath(`country-plugin-${name}.png`), fullPage: true });
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
  await frame.getByRole('button', { name: 'New AI assessment', exact: true }).click();
  await expect.poll(() => host.calls.filter(call => call.name === 'get_country_brief').length).toBe(2);
  host.recover();
  host.delay();
  await frame.getByRole('button', { name: 'Refresh country', exact: true }).click();
  await frame.getByRole('textbox', { name: 'Country name or code' }).fill('Ukraine');
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
