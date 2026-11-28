// ChatGPT deep links into the news-and-maps view (OpenAI MCP extensions, Global Entrypoint > Deep Links).
// A link opens the open_news_dashboard entrypoint with empty arguments and hands the view an app-relative
// URL. Its query reuses the tool's own argument names, so there is one vocabulary:
//   /?country=IR&category=conflict&time_range=24h&map_layers=natural,fires&map_latitude=26.5&map_longitude=56.3&map_zoom=5
import { pluginNewsViewSchema, type PluginNewsView } from '../shared/plugin-news-view';

const NEWS_KEYS = new Set(['query', 'source', 'category', 'country', 'time_range', 'renderer', 'map_layers', 'map_latitude', 'map_longitude', 'map_zoom']);
const NUMBER_KEYS = new Set(['map_latitude', 'map_longitude', 'map_zoom']);

export interface NewsDeepLink {
  view: PluginNewsView;
  /** Parameters dropped because they are unknown or invalid. */
  ignored: string[];
}

/** The view a news deep link asks for, or undefined when the path is not one this view serves. */
export function newsViewFromDeepLink(url: string): NewsDeepLink | undefined {
  // The host context only admits app-relative URLs without a fragment, so the path is everything before '?'.
  const queryStart = url.indexOf('?');
  if ((queryStart === -1 ? url : url.slice(0, queryStart)) !== '/') return undefined;
  const params = new URLSearchParams(queryStart === -1 ? '' : url.slice(queryStart + 1));
  const view: Record<string, unknown> = {};
  const ignored: string[] = [];
  for (const key of new Set(params.keys())) {
    const raw = params.get(key) ?? '';
    if (!NEWS_KEYS.has(key)) { ignored.push(key); continue; }
    const value = key === 'map_layers' ? raw.split(',').filter(Boolean)
      : NUMBER_KEYS.has(key) ? (raw.trim() === '' ? Number.NaN : Number(raw))
      : key === 'country' ? raw.toUpperCase()
      : raw;
    // The center is checked as a pair below: the schema refuses one coordinate alone.
    if (key === 'map_latitude' || key === 'map_longitude') { view[key] = value; continue; }
    if (pluginNewsViewSchema.safeParse({ [key]: value }).success) view[key] = value;
    else ignored.push(key);
  }
  const center = { map_latitude: view.map_latitude, map_longitude: view.map_longitude };
  if ((center.map_latitude !== undefined || center.map_longitude !== undefined) && !pluginNewsViewSchema.safeParse(center).success) {
    for (const key of ['map_latitude', 'map_longitude'] as const) {
      if (view[key] !== undefined) { delete view[key]; ignored.push(key); }
    }
  }
  return { view: view as PluginNewsView, ignored };
}
