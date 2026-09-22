const YOUTUBE_EMBED_ORIGINS = new Set([
  'https://www.youtube.com',
  'https://www.youtube-nocookie.com',
]);

function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

function parseAbsoluteUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

export function isAllowedWebcamEmbedMessageOrigin(eventOrigin: string, iframeSrc: string): boolean {
  if (!eventOrigin || eventOrigin === 'null') return false;

  const iframeUrl = parseAbsoluteUrl(iframeSrc);
  if (!iframeUrl) return false;

  if (YOUTUBE_EMBED_ORIGINS.has(iframeUrl.origin) && iframeUrl.pathname.startsWith('/embed/')) {
    return eventOrigin === iframeUrl.origin;
  }

  if (
    iframeUrl.protocol === 'http:' &&
    iframeUrl.pathname === '/api/youtube-embed' &&
    isLoopbackHostname(iframeUrl.hostname)
  ) {
    return eventOrigin === iframeUrl.origin;
  }

  return false;
}
