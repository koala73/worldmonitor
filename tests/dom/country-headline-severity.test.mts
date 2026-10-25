import { readFileSync } from 'node:fs';
import { afterAll, expect, it, vi } from 'vitest';

const now = Date.now();
const classification = (level: string, extra = {}) => ({ level, category: 'economic', confidence: 0.7, source: 'keyword', ...extra });
const categories = ['conflict', 'protest', 'disaster', 'diplomatic', 'economic', 'terrorism', 'cyber', 'health', 'environmental', 'military', 'crime', 'infrastructure', 'tech', 'general'];
const categoryTitles = ['Apricot orchard', 'Badger habitat', 'Cedar grove', 'Dolphin migration', 'Emerald deposits', 'Falcon nesting', 'Granite quarry', 'Hazelnut growers', 'Indigo textiles', 'Jasmine cultivation', 'Kestrel breeding', 'Limestone cliffs', 'Mangrove restoration', 'Nectar research'];
const rows = [
  ['Harbor evacuation', classification('THREAT_LEVEL_HIGH'), now - 9_000],
  ['Factory prices', classification('THREAT_LEVEL_MEDIUM'), now - 8_000],
  ['Mountain rescue', classification('THREAT_LEVEL_CRITICAL'), now - 10_000],
  ['Bridge inspection', classification('THREAT_LEVEL_LOW'), now - 7_000],
  ['Orchid exhibition', classification('THREAT_LEVEL_UNSPECIFIED'), now],
  ['Copper inventories', undefined, now - 2 * 3_600_000],
  ['Railway expansion', null, now - 19_000],
  ['Satellite launch', classification('THREAT_LEVEL_UNKNOWN'), now - 18_000],
  ['Ocean survey', classification('THREAT_LEVEL_HIGH', { category: 'invented' }), now - 17_000],
  ['Wheat harvest', classification('THREAT_LEVEL_HIGH', { confidence: 1.1 }), now - 16_000],
  ['Cobalt reserves', classification('THREAT_LEVEL_HIGH', { confidence: Number.NaN }), now - 15_000],
  ['Forest census', classification('THREAT_LEVEL_HIGH', { source: 'invented' }), now - 14_000],
  ['Pearl diving', classification('THREAT_LEVEL_HIGH', { confidence: -0.1 }), now - 13_000],
  ['Quartz formation', classification('THREAT_LEVEL_HIGH', { confidence: Infinity }), now - 12_000],
  ['Reed beds', classification('THREAT_LEVEL_HIGH', { category: '__proto__' }), now - 11_000],
  ...categories.map((category, index) => [categoryTitles[index]!, classification('THREAT_LEVEL_HIGH', { category, confidence: index % 2, source: ['keyword', 'ml', 'llm'][index % 3] }), now - 30_000 - index * 1000] as const),
] as const;

const originalParent = window.parent;
// Section reads the host never answers, so the close-view case below always
// finds them in flight instead of depending on how far the first case got.
// Keyed by request id; an entry leaves when the view cancels the read, so the
// map holds exactly the held reads still open.
const heldSections = new Set(['demographics', 'factors']);
const heldInFlight = new Map<number, string>();
// The host asks for a same-country refresh: `refresh` rides on the tool input,
// and the tool result that follows opens the view.
function refreshView(): void {
  const send = (data: object) => window.dispatchEvent(new MessageEvent('message', { source: window.parent, data: { jsonrpc: '2.0', ...data } }));
  send({ method: 'ui/notifications/tool-input', params: { arguments: { country_code: 'NO', topic: 'overview', refresh: true } } });
  send({ method: 'ui/notifications/tool-result', params: { result: { structuredContent: { countryCode: 'NO', topic: 'overview' } } } });
}
afterAll(async () => {
  window.dispatchEvent(new Event('pagehide'));
  await new Promise(resolve => setTimeout(resolve, 0));
  Object.defineProperty(window, 'parent', { configurable: true, value: originalParent });
  vi.unstubAllGlobals();
});

it('carries coverage through managed boot and the actual parent bridge to real panel severity and ordering', async () => {
  document.documentElement.dataset.wmPluginManagedBoot = 'true';
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800);
  const markup = new DOMParser().parseFromString(readFileSync('country.html', 'utf8'), 'text/html');
  markup.querySelectorAll('script').forEach(script => script.remove());
  document.body.innerHTML = markup.body.innerHTML;
  localStorage.setItem('worldmonitor-language', 'en');
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('No network in controlled host regression'); }));
  const calls: string[] = [];
  const host = { postMessage: vi.fn((message: { id?: number; method?: string; params?: { name?: string; requestId?: number; arguments?: { section?: string } } }) => {
    if (message.method === 'notifications/cancelled') heldInFlight.delete(message.params!.requestId!);
    if (message.id === undefined) return;
    calls.push(message.method === 'tools/call' ? message.params!.name! : message.method!);
    const section = message.params?.arguments?.section;
    if (message.params?.name === 'get_country_brief_section' && section && heldSections.has(section)) { heldInFlight.set(message.id, section); return; }
    const result = message.method === 'ui/initialize'
      ? { hostCapabilities: { serverTools: {} }, hostContext: { theme: 'dark' } }
      : message.params?.name === 'get_country_coverage'
        ? { structuredContent: { countryCode: 'NO', countryName: 'Norway', generatedAt: new Date(now).toISOString(), degraded: false,
          headlines: rows.map(([title, threat, publishedAtMs], i) => ({ title, threat, publishedAtMs, source: `Publisher ${i}`, url: `https://example.org/story-${i}` })),
          events: [{ timestampMs: now - 1000, lane: 'protest', label: 'Controlled timeline event', severity: 'medium' }],
          sources: [{ source: 'coverage:headlines', state: 'ok' }, { source: 'coverage:events', state: 'empty' }] } }
        : { isError: true, content: [{ type: 'text', text: 'Controlled incidental section unavailable' }] };
    queueMicrotask(() => window.dispatchEvent(new MessageEvent('message', { source: host as unknown as Window, data: { jsonrpc: '2.0', id: message.id, result } })));
  }) };
  Object.defineProperty(window, 'parent', { configurable: true, value: host });
  await import('@/plugin-country-main');
  document.dispatchEvent(new Event('wm-plugin-mount'));
  await vi.waitFor(() => expect(calls).toContain('ui/initialize'));
  await vi.waitFor(() => expect(document.getElementById('countryStatus')?.textContent).toContain('Select a country'));
  window.dispatchEvent(new MessageEvent('message', { source: host as unknown as Window, data: {
    jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { result: { structuredContent: { countryCode: 'NO', topic: 'overview' } } },
  } }));
  await vi.waitFor(() => expect(calls).toContain('get_country_coverage'));
  await vi.waitFor(() => expect(document.querySelectorAll('.cdp-news-item')).toHaveLength(rows.length));
  const articles = Array.from(document.querySelectorAll<HTMLAnchorElement>('.cdp-news-item'));
  const article = (title: string) => articles.find(node => node.textContent?.includes(title))!;
  expect(article('Harbor evacuation').querySelector('.cdp-severity-badge')?.textContent).toBe('HIGH');
  expect(article('Factory prices').querySelector('.cdp-severity-badge')?.textContent).toBe('MODERATE');
  expect(article('Mountain rescue').querySelector('.cdp-severity-badge')?.textContent).toBe('CRITICAL');
  for (const [title] of rows.slice(3, 15)) expect(article(title).querySelector('.cdp-severity-badge')?.textContent).toBe('LOW');
  for (const title of categoryTitles) expect(article(title).querySelector('.cdp-severity-badge')?.textContent).toBe('HIGH');
  expect(articles.indexOf(article('Copper inventories'))).toBeLessThan(articles.indexOf(article('Orchid exhibition')));
  expect(article('Orchid exhibition').querySelector('.sev-info')).not.toBeNull();
  expect(article('Copper inventories').querySelector('.sev-low')).not.toBeNull();
  for (const [i, [title]] of rows.entries()) {
    expect(article(title).href).toBe(`https://example.org/story-${i}`);
    expect(article(title).textContent).toContain(`Publisher ${i}`);
  }
  const event = document.querySelector('.cdp-timeline-mount circle')!;
  expect(event.getAttribute('r')).toBe('5');
  expect(event.getAttribute('fill')).toBe('#ffaa00');
  event.dispatchEvent(new MouseEvent('mouseenter'));
  expect(document.body.textContent).toContain('Controlled timeline event');
  expect(document.body.textContent).toContain('coverage:headlines: ok');
  expect(document.body.textContent).toContain('coverage:events: empty');
  expect(article('Copper inventories').querySelector('.cdp-news-meta')?.textContent).toContain('2h');
});

// Closing the view aborts in-flight section reads. A cancelled read is not a
// failure: logging it put a console call on a timer after the test body, and
// under load it landed after vitest closed the worker RPC
// (EnvironmentTeardownError: Closing rpc while "onUserConsoleLog" was pending).
it('closing the view cancels in-flight section reads without logging them as failures', async () => {
  // Start this case's own reads: a refresh re-requests both held sections.
  refreshView();
  await vi.waitFor(() => expect([...new Set(heldInFlight.values())].sort()).toEqual(['demographics', 'factors']));
  const warn = vi.spyOn(console, 'warn');
  try {
    // pagehide rejects every pending host call synchronously; give the
    // rejected reads time to reach their catch blocks.
    window.dispatchEvent(new Event('pagehide'));
    await new Promise(resolve => setTimeout(resolve, 50));
    const failures = warn.mock.calls.filter(([label]) => /^\[CountryDeepDivePanel\] .* load failed$/.test(String(label)));
    expect(failures.map(([label]) => label)).toEqual([]);
  } finally {
    warn.mockRestore();
  }
});
