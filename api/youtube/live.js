// YouTube Live Stream Detection API
// Proxies to Railway relay which uses residential proxy for YouTube scraping

import { getCorsHeaders, isDisallowedOrigin } from '../_cors.js';
import { getRelayBaseUrl, getRelayHeaders } from '../_relay.js';
import { checkRateLimit } from '../_rate-limit.js';

export const config = { runtime: 'edge' };

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const CHANNEL_ID_RE = /^UC[A-Za-z0-9_-]{22}$/;
// YouTube handle (@name, 3-30 chars) or canonical channel id (UC + 22 chars).
// The handle class is Unicode-aware on purpose: YouTube handles legitimately
// contain non-ASCII letters (the shipped CTI News channel is '@中天新聞CtiNews'),
// and an ASCII-only class would 400 them. \p{L}\p{N} still excludes every
// path/query metacharacter this validator exists to keep out of the upstream
// URL -- '/', '?', '#', '&', '%', '\', whitespace and control characters.
const CHANNEL_RE = /^(@[\p{L}\p{N}._-]{3,30}|UC[A-Za-z0-9_-]{22})$/u;

export function isValidChannel(value) {
  if (typeof value !== 'string') return false;
  return CHANNEL_RE.test(value) || CHANNEL_RE.test(`@${value}`);
}

// YouTube serves handles at /@name but canonical ids at /channel/UCxxxx.
// isValidChannel accepts both shapes, so the scrape fallback has to build the
// matching path for each -- prefixing '@' onto a UC id yields a 404 page.
export function toChannelPath(channel) {
  if (CHANNEL_ID_RE.test(channel)) return `channel/${channel}`;
  return channel.startsWith('@') ? channel : `@${channel}`;
}

export default async function handler(request, ctx) {
  const cors = getCorsHeaders(request);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (isDisallowedOrigin(request)) {
    return new Response(JSON.stringify({ error: 'Origin not allowed' }), { status: 403, headers: cors });
  }
  const url = new URL(request.url);
  const channel = url.searchParams.get('channel');
  const videoIdParam = url.searchParams.get('videoId');

  if (channel !== null && !isValidChannel(channel)) {
    return new Response(JSON.stringify({
      error: 'Invalid channel parameter',
      error_description: 'Expected a YouTube handle (@name, 3-30 letters/digits/._-, the @ is optional) or a canonical channel id (UC followed by 22 characters of [A-Za-z0-9_-]).',
    }), {
      status: 400,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }
  if (videoIdParam !== null && !VIDEO_ID_RE.test(videoIdParam)) {
    return new Response(JSON.stringify({
      error: 'Invalid videoId parameter',
      error_description: 'Expected an 11-character YouTube video id made up of [A-Za-z0-9_-].',
    }), {
      status: 400,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  const params = new URLSearchParams();
  if (channel) params.set('channel', channel);
  if (videoIdParam) params.set('videoId', videoIdParam);
  const qs = params.toString();

  if (!qs) {
    return new Response(JSON.stringify({ error: 'Missing channel or videoId parameter' }), {
      status: 400,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  // Every path below reaches YouTube (directly or through the metered
  // residential-proxy relay) on behalf of an unauthenticated caller, so this
  // per-IP budget is the primary abuse control on the route.
  //
  // Deliberately fail-OPEN (no `failClosed`): live-stream detection is general
  // traffic, and api/_rate-limit.js reserves the fail-closed posture for
  // endpoints where the limiter is the ONLY thing standing between a caller and
  // a billable action (LLM, checkout). A Redis blip therefore lifts the budget
  // rather than 503-ing the panel; the bounded abort in getRatelimit() keeps
  // that degradation fast instead of stalling on the vendor retry ladder.
  // Flip to `failClosed: true` if relay spend ever outranks availability here.
  const rateLimited = await checkRateLimit(request, cors, { scope: 'youtube-live', limit: 60, window: '60 s', ctx });
  if (rateLimited) return rateLimited;

  // Proxy to Railway relay
  const relayBase = getRelayBaseUrl();
  if (relayBase) {
    try {
      const relayHeaders = getRelayHeaders({ 'User-Agent': 'WorldMonitor-Edge/1.0' });
      const relayRes = await fetch(`${relayBase}/youtube-live?${qs}`, { headers: relayHeaders });
      if (relayRes.ok) {
        const data = await relayRes.json();
        const cacheTime = videoIdParam ? 3600 : 600;
        return new Response(JSON.stringify(data), {
          status: 200,
          headers: {
            ...cors,
            'Content-Type': 'application/json',
            'Cache-Control': `public, max-age=${cacheTime}, s-maxage=${cacheTime}, stale-while-revalidate=60`,
          },
        });
      }
    } catch { /* relay unavailable — fall through to direct fetch */ }
  }

  // Fallback: direct fetch (works for oembed, limited for live detection from datacenter IPs)
  if (videoIdParam) {
    try {
      const oembedRes = await fetch(
        `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoIdParam}&format=json`,
        { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } },
      );
      if (oembedRes.ok) {
        const data = await oembedRes.json();
        return new Response(JSON.stringify({ channelName: data.author_name || null, title: data.title || null, videoId: videoIdParam }), {
          status: 200,
          headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600, s-maxage=3600' },
        });
      }
    } catch { /* oembed failed — return minimal response */ }
    return new Response(JSON.stringify({ channelName: null, title: null, videoId: videoIdParam }), {
      status: 200,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  if (!channel) {
    return new Response(JSON.stringify({ error: 'Missing channel parameter' }), {
      status: 400,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  // Fallback: direct scrape (limited from datacenter IPs)
  try {
    const channelHandle = toChannelPath(channel);
    const response = await fetch(`https://www.youtube.com/${channelHandle}/live`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      redirect: 'follow',
    });
    if (!response.ok) {
      return new Response(JSON.stringify({ videoId: null, channelExists: false }), {
        status: 200, headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }
    const html = await response.text();
    const channelExists = html.includes('"channelId"') || html.includes('og:url');
    let channelName = null;
    const ownerMatch = html.match(/"ownerChannelName"\s*:\s*"([^"]+)"/);
    if (ownerMatch) channelName = ownerMatch[1];
    else { const am = html.match(/"author"\s*:\s*"([^"]+)"/); if (am) channelName = am[1]; }

    let videoId = null;
    const detailsIdx = html.indexOf('"videoDetails"');
    if (detailsIdx !== -1) {
      const block = html.substring(detailsIdx, detailsIdx + 5000);
      const vidMatch = block.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
      const liveMatch = block.match(/"isLive"\s*:\s*true/);
      if (vidMatch && liveMatch) videoId = vidMatch[1];
    }

    let hlsUrl = null;
    const hlsMatch = html.match(/"hlsManifestUrl"\s*:\s*"([^"]+)"/);
    if (hlsMatch && videoId) hlsUrl = hlsMatch[1].replace(/\\u0026/g, '&');

    return new Response(JSON.stringify({ videoId, isLive: videoId !== null, channelExists, channelName, hlsUrl }), {
      status: 200,
      headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300, s-maxage=600, stale-while-revalidate=120' },
    });
  } catch {
    return new Response(JSON.stringify({ videoId: null, error: 'Failed to fetch channel data' }), {
      status: 200, headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }
}
