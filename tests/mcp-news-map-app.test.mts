import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { NEWS_INTELLIGENCE_APP_HTML } from '../api/mcp/ui/news-intelligence-app';
import { CACHE_TOOLS } from '../api/mcp/registry/cache-tools';
import { buildPublicTool } from '../api/mcp/registry';

const windows: Window[] = [];
const news = CACHE_TOOLS.find((tool) => tool.name === 'get_news_intelligence')!;
const story = { primaryTitle: 'Shipping update', primarySource: 'Reuters', primaryLink: 'https://example.com/news', countryCode: 'US', category: 'economy', pubDate: 1000, sourceProvenance: { summary: 'Declared wire source.' } };

async function mount() {
  const win = new Window({ url: 'https://worldmonitor.app/' });
  windows.push(win);
  win.document.write(NEWS_INTELLIGENCE_APP_HTML);
  const sent: Array<Record<string, any>> = [];
  const parent = { postMessage: (message: Record<string, any>) => sent.push(message) };
  Object.defineProperty(win, 'parent', { value: parent });
  win.eval(win.document.querySelector('script')!.textContent!);
  const send = (message: object, source: unknown = parent) => win.dispatchEvent(new win.MessageEvent('message', { data: { jsonrpc: '2.0', ...message }, source: source as any }));
  send({ id: 1, result: { hostCapabilities: { serverTools: {}, openLinks: {}, updateModelContext: { text: {} } }, hostContext: { theme: 'dark' } } });
  const result = (stories: object[] | null, stale = false) => send({ method: 'ui/notifications/tool-result', params: { structuredContent: { cached_at: '2026-09-29T00:00:00Z', stale, data: { insights: stories === null ? null : { topStories: stories } } } } });
  return { win, sent, send, result };
}
afterEach(async () => { await Promise.all(windows.splice(0).map((win) => win.happyDOM.close())); });

describe('news and maps MCP app', () => {
  it('advertises extension entrypoints without changing existing access metadata', () => {
    const tool = buildPublicTool(news, { compressDescriptions: false });
    assert.equal(tool.title, 'WorldMonitor news and maps');
    assert.deepEqual(tool._meta['openai/ui'], { entrypoints: [{ type: 'global' }, { type: 'thread' }] });
    assert.equal(tool._meta['worldmonitor/access'], 'free-account');
    assert.deepEqual(tool.inputSchema.required, []);
    tool._meta['openai/ui']!.entrypoints.pop();
    assert.equal(buildPublicTool(news, { compressDescriptions: false })._meta['openai/ui']!.entrypoints.length, 2);
  });
  it('renders the initial result without another data call and links stories to country geometry', async () => {
    const { win, result, sent } = await mount();
    result([story]);
    assert.equal(win.document.querySelectorAll('.story').length, 1);
    assert.equal(sent.filter((msg) => msg.method === 'tools/call').length, 0);
    assert.ok(win.document.querySelector('[data-country="US"]')!.classList.contains('covered'));
    const locate = Array.from(win.document.querySelectorAll('button')).find((button) => button.textContent === 'Show country')!;
    locate.click();
    assert.ok(win.document.querySelector('[data-country="US"]')!.classList.contains('selected'));
    const receipt = sent.filter((msg) => msg.method === 'ui/update-model-context').at(-1)!;
    assert.equal(JSON.parse(receipt.params.content[0].text).map.precision, 'country');
  });
  it('uses the same tool for UI filters and keeps the previous view on a denial', async () => {
    const { win, result, sent, send } = await mount(); result([story]);
    (win.document.getElementById('source') as any).value = 'Reuters';
    win.document.getElementById('apply')!.click();
    const call = sent.find((msg) => msg.method === 'tools/call')!;
    assert.equal(call.params.name, 'get_news_intelligence');
    assert.equal(call.params.arguments.source, 'Reuters');
    send({ id: call.id, result: { isError: true, content: [{ type: 'text', text: 'Denied' }] } });
    assert.equal(win.document.querySelectorAll('.story').length, 1);
    assert.match(win.document.getElementById('status')!.textContent!, /denied/);
  });
  it('distinguishes empty, unavailable, and stale data', async () => {
    const { win, result } = await mount();
    result([]); assert.match(win.document.getElementById('list')!.textContent!, /No news stories available/);
    result(null); assert.match(win.document.getElementById('list')!.textContent!, /temporarily unavailable/);
    result([story], true); assert.match(win.document.getElementById('status')!.textContent!, /stale/);
  });
  it('rejects foreign messages and renders hostile headlines as text', async () => {
    const { win, result, send } = await mount();
    send({ method: 'ui/notifications/tool-result', params: { structuredContent: { data: { insights: { topStories: [story] } } } } }, {});
    assert.equal(win.document.querySelectorAll('.story').length, 0);
    result([{ ...story, primaryTitle: '<img src=x onerror=alert(1)>', primaryLink: 'javascript:alert(1)' }]);
    assert.equal(win.document.querySelectorAll('img').length, 0);
    (Array.from(win.document.querySelectorAll('button')).find((button) => button.textContent === 'Details')!).click();
    assert.equal(Array.from(win.document.querySelectorAll('button')).some((button) => button.textContent === 'Open source'), false);
  });
  it('does not call tools or publish applied context when the host lacks those capabilities', async () => {
    const { win, result, sent, send } = await mount();
    send({ id: 1, result: { hostCapabilities: {}, hostContext: {} } });
    sent.length = 0;
    result([story]);
    assert.equal((win.document.getElementById('apply') as any).disabled, true);
    assert.equal(sent.some((message) => message.method === 'tools/call' || message.method === 'ui/update-model-context'), false);
  });
  it('applies model-requested coordinates and zoom only after a result is rendered', async () => {
    const { win, result, sent, send } = await mount();
    sent.length = 0;
    send({ method: 'ui/notifications/tool-input', params: { arguments: { map_latitude: 0, map_longitude: 0, map_zoom: 2 } } });
    assert.equal(sent.some((message) => message.method === 'ui/update-model-context'), false);
    result([story]);
    assert.equal(win.document.getElementById('news-map')!.getAttribute('viewBox'), '225 112.5 450 225');
    assert.ok(sent.some((message) => message.method === 'ui/update-model-context'));
  });
  it('filters publication time and source before the cap without accepting unknown dates', () => {
    const data = { insights: { topStories: [{ ...story, primarySource: 'Other' }, { ...story, pubDate: null }, { ...story, pubDate: 2000 }] } };
    news._postFilter!(data, { source: 'reuters', published_since: 1500, limit: 1 });
    assert.equal(data.insights.topStories.length, 1);
    assert.equal(data.insights.topStories[0]!.pubDate, 2000);
  });
});
