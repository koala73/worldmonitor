// Sentinel-specific cache tier overrides. Imported into gateway.ts.

export const SENTINEL_CACHE_TIERS: Record<string, string> = {
  '/api/claude/v1/summarize': 'medium',    // 15min cache
  '/api/claude/v1/analyze': 'slow',        // 30min cache
  '/api/claude/v1/predict': 'slow',        // 30min cache
  '/api/social/v1/list-reddit-posts': 'medium',
  '/api/social/v1/list-tweets': 'fast',
  '/api/social/v1/list-bluesky-posts': 'fast',
  '/api/social/v1/list-youtube-videos': 'medium',
  '/api/social/v1/list-tiktok-posts': 'slow',
  '/api/social/v1/list-vk-posts': 'medium',
  '/api/govdata/v1/list-notams': 'medium',
  '/api/trajectory/v1/query-flight-history': 'slow',
  '/api/analyst/v1/run-assessment': 'slow',
  '/api/analyst/v1/get-prediction': 'slow',
  '/api/kalshi/v1/list-markets': 'medium',
  '/api/metaculus/v1/list-questions': 'medium',
};
