// YouTube video naming for channel management (src/live-channels-window.ts).
// ?videoId= answers YouTube's public oEmbed title and channel name. ?channel= live
// detection is retired: it scraped youtube.com through a residential proxy, and Live
// News now plays verified streams listed in src/config/live-video-sources.ts.

import { getCorsHeaders, isDisallowedOrigin } from '../_cors.js';
import { checkRateLimit } from '../_rate-limit.js';

export const config = { runtime: 'edge' };

// Mirrors ENDPOINT_RATE_POLICIES['/api/youtube/live'] in
// server/_shared/rate-limit.ts. api/*.js cannot import ../server/ (AGENTS.md),
// so the budget is duplicated here and tests/rate-limit.test.mts fails if the
// two copies drift. (#6234)
const RATE_LIMIT_SCOPE = 'youtube-live';
const RATE_LIMIT_PER_MINUTE = 30;
const CHANNEL_ID_RE = /^UC[A-Za-z0-9_-]{22}$/;
const HANDLE_RE = /^[\p{L}\p{N}](?:[\p{L}\p{N}\p{M}._·-]{0,28}[\p{L}\p{N}\p{M}])?$/u;
const CHANNEL_DETECTION_RETIRED = 'channel_live_detection_retired';
// Matches the RPC's oEmbed deadline (server/worldmonitor/aviation/v1/get-youtube-live-stream-info.ts).
const OEMBED_TIMEOUT_MS = 5_000;

export default async function handler(request, ctx) {
  const cors = getCorsHeaders(request);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (isDisallowedOrigin(request)) {
    return new Response(JSON.stringify({ error: 'Origin not allowed' }), { status: 403, headers: cors });
  }

  // Metered before the parameter check so malformed requests are not a free
  // unlimited path. Availability-first on purpose: this is a read proxy for
  // channel management, and checkRateLimit already returns null when Upstash is
  // unconfigured, so a Redis blip degrades to today's behaviour instead of
  // failing the lookup. (#6234)
  // `ctx` is forwarded so the degraded-path Sentry envelope survives isolate
  // teardown, matching api/reverse-geocode.js. (#6412 review)
  const limited = await checkRateLimit(request, cors, {
    ctx,
    scope: RATE_LIMIT_SCOPE,
    limit: RATE_LIMIT_PER_MINUTE,
    window: '60 s',
  });
  if (limited) return limited;

  const url = new URL(request.url);
  const channel = url.searchParams.get('channel');
  const videoIdParam = url.searchParams.get('videoId');
  const handle = channel?.replace(/^@/, '').normalize('NFC') || '';
  if ((channel && (channel.length > 128 || channel !== channel.trim()
    || (!CHANNEL_ID_RE.test(channel) && !HANDLE_RE.test(handle))))
    || (videoIdParam && (videoIdParam.length !== 11 || !/^[A-Za-z0-9_-]{11}$/.test(videoIdParam)))) {
    return new Response(JSON.stringify({ error: 'Invalid YouTube handle, channel ID or video ID' }), {
      status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  if (!channel && !videoIdParam) {
    return new Response(JSON.stringify({ error: 'Missing channel or videoId parameter' }), {
      status: 400,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  if (videoIdParam) {
    try {
      const oembedRes = await fetch(
        `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoIdParam}&format=json`,
        {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
          signal: AbortSignal.timeout(OEMBED_TIMEOUT_MS),
        },
      );
      if (oembedRes.ok) {
        const data = await oembedRes.json();
        return new Response(JSON.stringify({ channelName: data.author_name || null, title: data.title || null, videoId: videoIdParam }), {
          status: 200,
          headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600, s-maxage=3600' },
        });
      }
    } catch { /* oembed failed or passed its deadline — return minimal response */ }
    return new Response(JSON.stringify({ channelName: null, title: null, videoId: videoIdParam }), {
      status: 200,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  // Tabs opened before the retirement still ask for a channel's live video. A cacheable 410
  // tells them without any YouTube or relay request, and their client falls back on non-2xx.
  return new Response(JSON.stringify({ error: CHANNEL_DETECTION_RETIRED }), {
    status: 410,
    headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=86400, s-maxage=86400' },
  });
}
