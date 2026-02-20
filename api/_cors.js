const isDev = process.env.NODE_ENV !== 'production';

const ALLOWED_ORIGIN_PATTERNS = [
  /^https:\/\/(.*\.)?worldmonitor\.app$/,
  /^https:\/\/worldmonitor-[a-z0-9-]+-elie-habib-projects\.vercel\.app$/,
  // Plain localhost/127.0.0.1 — dev only
  ...(isDev ? [
    /^https?:\/\/localhost(:\d+)?$/,
    /^https?:\/\/127\.0\.0\.1(:\d+)?$/,
  ] : []),
  // Tauri desktop origins — always allowed
  /^https?:\/\/tauri\.localhost(:\d+)?$/,
  /^https?:\/\/[a-z0-9-]+\.tauri\.localhost(:\d+)?$/i,
  /^tauri:\/\/localhost$/,
  /^asset:\/\/localhost$/,
];

function isAllowedOrigin(origin) {
  return Boolean(origin) && ALLOWED_ORIGIN_PATTERNS.some((pattern) => pattern.test(origin));
}

export function getCorsHeaders(req, methods = 'GET, OPTIONS') {
  const origin = req.headers.get('origin') || '';
  const allowOrigin = isAllowedOrigin(origin) ? origin : 'https://worldmonitor.app';
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': methods,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

export function isDisallowedOrigin(req) {
  const origin = req.headers.get('origin');
  if (!origin) return false;
  return !isAllowedOrigin(origin);
}
