import './bootstrap/zod-csp';
import mapLibreWorkerAsset from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import './styles/base-layer.css';
import { pluginNewsViewSchema, PLUGIN_NEWS_VIEW_INPUT_SCHEMA, type PluginNewsView } from '../shared/plugin-news-view';
import { countryMentionTerms, mentionsCountry } from '../shared/country-mention.js';
import { clusterNews } from '@/services/clustering';
import './styles/plugin.css';
import { SearchModal } from '@/components/SearchModal';
import type { NewsItem } from '@/types';
import { NewsPanel } from '@/components/NewsPanel';
import { MapContainer } from '@/components/MapContainer';
import { DEFAULT_MAP_LAYERS, DEFAULT_PANELS } from '@/config';
import type { MapLayers } from '@/types';
import type { ListFeedDigestResponse } from '@/generated/client/worldmonitor/news/v1/service_client';
import { protoItemToNewsItem } from '@/services/news-digest-items';
import { getCountryMapFocus } from '@/app/country-map-focus';
import { preloadCountryGeometry } from '@/services/country-geometry';
import { initI18n } from '@/services/i18n';

const panels = new Map<string, NewsPanel>();
const status = document.getElementById('pluginStatus')!;
const grid = document.getElementById('panelsGrid')!;
let nextId = 1;
let map: MapContainer;
let search: SearchModal;
let news: NewsItem[] = [];
let digest: ListFeedDigestResponse | undefined;
let view: PluginNewsView = { time_range: 'all' };
let viewQueue: Promise<unknown> = Promise.resolve();
let applyingTimeRange = false;
let modelContext = false;
let sourceSelect: HTMLSelectElement;
let categorySelect: HTMLSelectElement;
let serverTools = false;
let openLinks = false;
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
const send = (message: object) => window.parent.postMessage({ jsonrpc: '2.0', ...message }, '*');

function request(method: string, params: object): Promise<unknown> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Host request timed out')); }, 30_000);
    pending.set(id, { resolve, reject, timer });
    send({ id, method, params });
  });
}

async function analyze(args: object): Promise<{ summary: string; model: string }> {
  if (!serverTools) throw new Error('News analysis is unavailable in this host.');
  const result = await request('tools/call', { name: 'analyze_news_headlines', arguments: args }) as { isError?: boolean; structuredContent?: { summary?: string; model?: string; error?: string } };
  const data = result.structuredContent;
  if (result.isError || typeof data?.summary !== 'string' || !data.summary || data.error) throw new Error('News analysis was denied or unavailable.');
  return { summary: data.summary, model: data.model ?? '' };
}

function renderResult(result: unknown): void {
  if (!result || typeof result !== 'object') return;
  const response = result as { isError?: boolean; structuredContent?: ListFeedDigestResponse & { requestedView?: unknown } };
  if (response.isError) {
    status.textContent = 'News refresh failed. Previously loaded news remains visible.';
    for (const panel of panels.values()) panel.setRefreshDegraded(true);
    return;
  }
  const data = response.structuredContent;
  if (!data?.categories || typeof data.categories !== 'object' || Array.isArray(data.categories)) {
    status.textContent = 'News data is unavailable. Previously loaded news remains visible.';
    return;
  }
  digest = data;
  if (data.requestedView) {
    void applyView(data.requestedView).catch(() => { status.textContent = 'The requested view could not be applied.'; });
  } else renderDigest();
}

function renderDigest(): void {
  if (!digest) return;
  for (const [category, panel] of panels) {
    if (!(category in digest.categories)) { panel.destroy(); panel.getElement().remove(); panels.delete(category); }
  }
  const locations: Parameters<MapContainer['setNewsLocations']>[0] = [];
  news = [];
  for (const [category, bucket] of Object.entries(digest.categories)) {
    if (!bucket || !Array.isArray(bucket.items)) continue;
    let panel = panels.get(category);
    if (!panel) {
      panel = new NewsPanel(category, DEFAULT_PANELS[category]?.name ?? category, undefined, {
        clusterNews: async items => clusterNews(items),
        generateSummary: async (headlines, _progress, geoContext, lang, options) => {
          const result = await analyze({ headlines, bodies: options?.bodies, geoContext, lang, mode: 'brief' });
          return { summary: result.summary, provider: 'groq', model: result.model, cached: false };
        },
        translateText: async (text, lang) => (await analyze({ headlines: [text], lang, mode: 'translate' })).summary,
      });
      panels.set(category, panel);
      grid.appendChild(panel.getElement());
    }
    const allItems = bucket.items.map(protoItemToNewsItem);
    news.push(...allItems);
    const hours = { '1h': 1, '6h': 6, '24h': 24, '48h': 48, '7d': 168, all: Infinity }[view.time_range ?? 'all'];
    const cutoff = Date.now() - hours * 3_600_000;
    const terms = view.country ? countryMentionTerms(view.country) : null;
    const items = allItems.filter(item =>
      (!view.source || item.source === view.source) &&
      (!terms || mentionsCountry(`${item.title} ${item.locationName ?? ''}`, terms)) &&
      (hours === Infinity || (!item.pubDateMissing && item.pubDate.getTime() >= cutoff)));
    panel.getElement().hidden = Boolean(view.category && view.category !== category);
    panel.setRefreshDegraded(digest.coverage?.servedStale === true);
    if (items.length || !allItems.length) panel.renderNews(items);
    else panel.renderFilteredEmpty('No news matches these filters.');
    for (const item of view.category && view.category !== category ? [] : items) {
      if (Number.isFinite(item.lat) && Number.isFinite(item.lon)) {
        locations.push({ lat: item.lat!, lon: item.lon!, title: item.title, threatLevel: item.threat?.level ?? 'info', timestamp: item.pubDate });
      }
    }
  }
  map.setNewsLocations(locations);
  updateSelect(sourceSelect, [...new Set(news.map(item => item.source))].sort(), view.source ?? '', 'All sources');
  updateSelect(categorySelect, Object.keys(digest.categories), view.category ?? '', 'All news panels');
  search.registerSource('news', news.map(item => ({ id: item.link, title: item.title, subtitle: item.source, data: item })));
  status.textContent = !Object.keys(digest.categories).length ? 'No news is available.' : digest.coverage?.servedStale ? 'Showing cached news.' : digest.coverage?.state === 'partial' ? 'Some news sources are unavailable.' : '';
}

function updateSelect(select: HTMLSelectElement, values: string[], value: string, label: string): void {
  select.replaceChildren(new Option(label, ''), ...values.map(value => new Option(DEFAULT_PANELS[value]?.name ?? value, value)));
  select.value = value;
}

async function applyView(input: unknown, reset = false): Promise<object> {
  const next = pluginNewsViewSchema.parse(input);
  const operation = viewQueue.then(() => updateView(next, reset));
  viewQueue = operation.catch(() => {});
  return operation;
}

async function updateView(next: PluginNewsView, reset: boolean): Promise<object> {
  const intended = { ...(reset ? {} : view), ...next };
  let renderer: object | undefined;
  if (next.renderer) {
    const result = next.renderer === 'globe' ? await map.switchToGlobe() : await map.switchToFlat();
    renderer = result;
    intended.renderer = result.mode;
    for (const control of document.querySelectorAll<HTMLButtonElement>('#mapDimensionToggle button')) {
      control.classList.toggle('active', control.dataset.mode === result.mode);
    }
  }
  if (next.time_range) {
    applyingTimeRange = true;
    try { map.setTimeRange(next.time_range); }
    finally { applyingTimeRange = false; }
  }
  if (next.country) {
    await preloadCountryGeometry();
    const country = getCountryMapFocus(next.country);
    if (!country) throw new Error('Country geography is unavailable.');
    const token = map.setCenter(country.lat, country.lon, country.zoom);
    await map.whenViewportSettled(token);
    map.highlightCountry(next.country);
  }
  if (next.map_zoom !== undefined && next.map_latitude === undefined && !next.country) {
    await map.whenRendererReady();
    const center = map.getCenter();
    if (!center) throw new Error('Map center is unavailable.');
    const token = map.setCenter(center.lat, center.lon, next.map_zoom);
    await map.whenViewportSettled(token);
  }
  if (next.map_latitude !== undefined && next.map_longitude !== undefined) {
    const token = map.setCenter(next.map_latitude, next.map_longitude, next.map_zoom);
    await map.whenViewportSettled(token);
  }
  view = intended;
  if (reset && !next.country) map.clearCountryHighlight();
  renderDigest();
  if (next.query !== undefined) { search.open(); search.applyQuery(next.query); }
  const receipt = { applied: true, view, center: map.getCenter(), map: map.getState(), ...(renderer ? { renderer } : {}) };
  if (modelContext) void request('ui/update-model-context', { content: [{ type: 'text', text: JSON.stringify(receipt) }] }).catch(() => {});
  return receipt;
}

async function focusNews(link: string): Promise<object> {
  const item = news.find(item => item.link === link);
  if (!item || !digest) throw new Error('This article is not in the current news snapshot.');
  const category = Object.entries(digest.categories).find(([, bucket]) => bucket.items.some(candidate => candidate.link === link))?.[0];
  const mapFocused = Number.isFinite(item.lat) && Number.isFinite(item.lon);
  await applyView({ category, time_range: 'all', ...(mapFocused ? { map_latitude: item.lat, map_longitude: item.lon, map_zoom: 4 } : {}) }, true);
  for (const panel of panels.values()) if (panel.hasNewsItem(item.link)) panel.scrollToNewsItem(item.link);
  return { applied: true, link, title: item.title, source: item.source, mapFocused, center: map.getCenter(), view };
}

async function start(): Promise<void> {
  await initI18n({ waitForFullTranslation: true });
  const layers: MapLayers = { ...DEFAULT_MAP_LAYERS };
  for (const key of Object.keys(layers) as Array<keyof MapLayers>) layers[key] = false;
  const workerModuleUrl = new URL(mapLibreWorkerAsset, import.meta.url).href;
  const workerResponse = await fetch(workerModuleUrl, { credentials: 'omit', signal: AbortSignal.timeout(15_000) });
  if (!workerResponse.ok) throw new Error(`Map worker could not load (${workerResponse.status})`);
  const workerUrl = URL.createObjectURL(new Blob([await workerResponse.text()], { type: 'text/javascript' }));
  map = new MapContainer(document.getElementById('mapContainer')!, { zoom: 1, pan: { x: 0, y: 0 }, view: 'global', layers, timeRange: 'all' }, false, { mapLibreWorkerUrl: workerUrl });
  document.getElementById('mapDimensionToggle')!.addEventListener('click', async event => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button[data-mode]') : null;
    if (!button) return;
    try {
      await applyView({ renderer: button.dataset.mode });
    } catch { status.textContent = 'The requested map renderer is unavailable.'; }
  });
  map.onCountryClicked(country => { if (country.code) void applyView({ country: country.code }).catch(() => { status.textContent = 'Country view could not be applied.'; }); });
  map.onTimeRangeChanged(time_range => {
    if (applyingTimeRange) return;
    void applyView({ time_range }).catch(() => { status.textContent = 'Time range could not be applied.'; });
  });
  search = new SearchModal(document.body, { placeholder: 'Search news', scopes: ['all', 'signals'] });
  search.setCommandVisibleFn(() => false);
  search.setResultVisibleFn(result => result.type === 'news');
  search.setOnSelect(result => { void focusNews(result.id).catch(() => { status.textContent = 'The article location could not be applied.'; }); });

  for (const key of ['source', 'category'] as const) {
    const select = document.createElement('select');
    select.className = 'view-select';
    select.setAttribute('aria-label', key === 'source' ? 'News source' : 'News category');
    select.addEventListener('change', () => { void applyView({ [key]: select.value }).catch(() => { status.textContent = 'News filter could not be applied.'; }); });
    document.getElementById('pluginActions')!.appendChild(select);
    if (key === 'source') sourceSelect = select;
    else categorySelect = select;
  }
  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'search-btn';
  clear.textContent = 'Clear filters';
  clear.addEventListener('click', () => { void applyView({ time_range: 'all' }, true).catch(() => { status.textContent = 'Filters could not be cleared.'; }); });
  document.getElementById('pluginActions')!.appendChild(clear);
  const searchButton = document.createElement('button');
  searchButton.type = 'button';
  searchButton.className = 'search-btn';
  searchButton.textContent = 'Search news';
  searchButton.addEventListener('click', () => search.open());
  document.getElementById('pluginActions')!.appendChild(searchButton);
  window.addEventListener('message', event => {
    if (event.source !== window.parent || event.data?.jsonrpc !== '2.0') return;
    const message = event.data;
    if (!message.method && typeof message.id === 'number' && pending.has(message.id)) {
      const call = pending.get(message.id)!;
      pending.delete(message.id);
      clearTimeout(call.timer);
      if (message.error) call.reject(new Error(String(message.error.message ?? 'Host request failed')));
      else call.resolve(message.result);
    }
    if (message.method === 'tools/list') send({ id: message.id, result: { tools: [
      { name: 'apply_news_view', description: 'Apply news filters and map view; returns the effective state after the map settles.', inputSchema: PLUGIN_NEWS_VIEW_INPUT_SCHEMA },
      { name: 'focus_news_article', description: 'Focus an article already present in the current news snapshot and its supplied geographic location. Reports when no location is available.', inputSchema: { type: 'object', properties: { link: { type: 'string' } }, required: ['link'] } },
    ] } });
    if (message.method === 'tools/call') {
      const operation = message.params?.name === 'apply_news_view' ? applyView(message.params.arguments ?? {})
        : message.params?.name === 'focus_news_article' && typeof message.params.arguments?.link === 'string' ? focusNews(message.params.arguments.link)
        : Promise.reject(new Error('Unknown news action or invalid arguments.'));
      void operation.then(receipt => send({ id: message.id, result: { structuredContent: receipt, content: [{ type: 'text', text: JSON.stringify(receipt) }] } }))
        .catch(error => send({ id: message.id, result: { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : 'View action failed' }] } }));
    }
    if (message.method === 'ui/notifications/tool-input') {
      const input = Object.fromEntries(Object.entries(message.params?.arguments ?? {}).filter(([key]) => key !== 'jmespath'));
      void applyView(input).catch(() => { status.textContent = 'The requested view could not be applied.'; });
    }
    if (message.method === 'ui/notifications/tool-result') renderResult(message.params);

    if (message.method === 'ui/notifications/host-context-changed' && ['light', 'dark'].includes(message.params?.theme)) document.documentElement.dataset.theme = message.params.theme;
  });
  document.addEventListener('click', event => {
    const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null;
    if (!link) return;
    if (!link.getAttribute('href')) {
      event.preventDefault();
      status.textContent = 'This article source link is unavailable.';
      return;
    }
    if (!/^https?:$/.test(new URL(link.href).protocol)) return;
    event.preventDefault();
    if (openLinks) void request('ui/open-link', { url: link.href }).catch(() => { status.textContent = 'The host could not open this link.'; });
    else status.textContent = 'Opening links is unavailable in this host.';
  });
  const refresh = document.createElement('button');
  refresh.type = 'button';
  refresh.className = 'search-btn';
  refresh.textContent = 'Refresh news';
  refresh.disabled = true;
  refresh.addEventListener('click', async () => {
    if (!serverTools) return;
    refresh.disabled = true;
    try { renderResult(await request('tools/call', { name: 'open_news_dashboard', arguments: {} })); }
    catch { status.textContent = 'News refresh failed. Previously loaded news remains visible.'; }
    finally { refresh.disabled = false; }
  });
  document.getElementById('pluginActions')!.appendChild(refresh);
  const initialized = await request('ui/initialize', { appInfo: { name: 'WorldMonitor', version: '1.0.0' }, appCapabilities: { tools: {} }, protocolVersion: '2026-01-26' }) as { hostCapabilities?: { serverTools?: object; openLinks?: object; updateModelContext?: object }; hostContext?: { theme?: string } };
  serverTools = Boolean(initialized.hostCapabilities?.serverTools);
  modelContext = Boolean(initialized.hostCapabilities?.updateModelContext);
  openLinks = Boolean(initialized.hostCapabilities?.openLinks);
  refresh.disabled = !serverTools;
  if (['light', 'dark'].includes(initialized.hostContext?.theme ?? '')) document.documentElement.dataset.theme = initialized.hostContext!.theme;
  send({ method: 'ui/notifications/initialized' });
  const observer = new ResizeObserver(() => send({ method: 'ui/notifications/size-changed', params: { height: document.documentElement.scrollHeight } }));
  observer.observe(document.body);
  window.addEventListener('pagehide', () => {
    observer.disconnect();
    for (const call of pending.values()) { clearTimeout(call.timer); call.reject(new Error('WorldMonitor view closed.')); }
    pending.clear();
    search.close();
    for (const panel of panels.values()) panel.destroy();
    map.destroy();
    URL.revokeObjectURL(workerUrl);
  }, { once: true });
}

void start().catch(error => { status.textContent = `WorldMonitor could not start: ${error instanceof Error ? error.message : 'unknown error'}`; });
