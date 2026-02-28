/**
 * Application constants for World Monitor
 * @module config/constants
 */

/** Application metadata */
export const APP_NAME = 'World Monitor' as const;
export const APP_VERSION = import.meta.env.VITE_APP_VERSION || '2.5.20';
export const APP_URL = 'https://worldmonitor.app' as const;

/** Default map settings */
export const DEFAULT_MAP_CENTER = { lat: 20, lng: 0 } as const;
export const DEFAULT_MAP_ZOOM = 3 as const;
export const MAX_MAP_ZOOM = 18 as const;
export const MIN_MAP_ZOOM = 2 as const;

/** Time windows for filtering (in hours) */
export const TIME_WINDOWS = {
  ONE_HOUR: 1,
  SIX_HOURS: 6,
  TWENTY_FOUR_HOURS: 24,
  FORTY_EIGHT_HOURS: 48,
  SEVEN_DAYS: 168,
} as const;

/** Cache durations (in seconds) */
export const CACHE_DURATIONS = {
  WORLD_BRIEF: 24 * 60 * 60, // 24 hours
  COUNTRY_DATA: 60 * 60, // 1 hour
  NEWS_FEED: 5 * 60, // 5 minutes
  MARKET_DATA: 60, // 1 minute
} as const;

/** API endpoints */
export const API_ENDPOINTS = {
  WORLD_BRIEF: '/api/world-brief',
  COUNTRY_DATA: '/api/country',
  NEWS_FEED: '/api/news',
  MARKETS: '/api/markets',
} as const;

/** Feature flags (can be overridden by env) */
export const FEATURES = {
  ENABLE_AI_BRIEF: import.meta.env.VITE_ENABLE_AI_BRIEF !== 'false',
  ENABLE_PREDICTION_MARKETS: import.meta.env.VITE_ENABLE_PREDICTION_MARKETS === 'true',
  ENABLE_DESKTOP_APP: import.meta.env.VITE_ENABLE_DESKTOP_APP !== 'false',
} as const;
