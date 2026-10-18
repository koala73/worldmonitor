import { readPluginDocument } from './news-dashboard-app';

export const PREVIOUS_MARKET_RADAR_UI_URI = 'ui://worldmonitor/market-radar-v2.html';
export const LEGACY_MARKET_RADAR_UI_URI = 'ui://worldmonitor/market-radar.html';

export function readMarketRadar(id: unknown, corsHeaders: Record<string, string>, uri: string): Promise<Response> {
  return readPluginDocument(id, corsHeaders, 'market.html', 'marketRoot', uri);
}
