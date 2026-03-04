// Sentinel-specific feature flag definitions and default toggles.
// The RuntimeFeatureId union itself MUST be edited in runtime-config.ts.
// This file holds the RUNTIME_FEATURES entries and default toggle values.
import type { RuntimeFeatureDefinition } from '../services/runtime-config';

export const SENTINEL_FEATURES: RuntimeFeatureDefinition[] = [
  { id: 'aiClaude', name: 'Claude AI', description: 'Anthropic Claude for summarization (Haiku) and analysis (Sonnet).', requiredSecrets: ['CLAUDE_API_KEY'], fallback: 'Falls back to OpenRouter, then existing chain.' },
  { id: 'socialReddit', name: 'Reddit Feed', description: 'OSINT subreddit monitoring via OAuth2.', requiredSecrets: ['REDDIT_CLIENT_ID', 'REDDIT_CLIENT_SECRET'], fallback: 'Disabled' },
  { id: 'socialTwitter', name: 'X/Twitter Feed', description: 'OSINT account monitoring via TwitterAPI.io.', requiredSecrets: ['TWITTER_API_IO_KEY'], fallback: 'Disabled' },
  { id: 'socialBluesky', name: 'Bluesky Feed', description: 'Bluesky OSINT search via AT Protocol (no auth).', requiredSecrets: [], fallback: 'Disabled' },
  { id: 'socialYouTube', name: 'YouTube Feed', description: 'YouTube Data API keyword search + channel monitoring.', requiredSecrets: ['YOUTUBE_API_KEY'], fallback: 'Disabled' },
  { id: 'socialTikTok', name: 'TikTok Feed', description: 'TikTok via Apify scraper on Railway.', requiredSecrets: ['TIKTOK_APIFY_TOKEN'], fallback: 'Disabled' },
  { id: 'socialVK', name: 'VK Feed', description: 'VKontakte military groups via VK API v5.', requiredSecrets: ['VK_SERVICE_TOKEN'], fallback: 'Disabled' },
  { id: 'govdataNotam', name: 'FAA NOTAM', description: 'NOTAMs and TFRs for pre-strike detection.', requiredSecrets: ['FAA_API_KEY'], fallback: 'Disabled' },
  { id: 'trajectoryFlight', name: 'Flight History', description: 'Historical flight tracks from OpenSky.', requiredSecrets: [], fallback: 'Disabled' },
  { id: 'predictionKalshi', name: 'Kalshi Markets', description: 'US-regulated prediction market data.', requiredSecrets: [], fallback: 'Shows only Polymarket' },
  { id: 'predictionMetaculus', name: 'Metaculus Forecasts', description: 'Community forecasting data.', requiredSecrets: [], fallback: 'Shows only Polymarket' },
];

export const SENTINEL_DEFAULT_TOGGLES: Record<string, boolean> = {
  aiClaude: true, socialReddit: true, socialTwitter: true, socialBluesky: true,
  socialYouTube: true, socialTikTok: false, socialVK: false,
  govdataNotam: true, trajectoryFlight: true, predictionKalshi: true, predictionMetaculus: true,
};
