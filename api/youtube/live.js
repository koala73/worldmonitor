// YouTube Live Stream Detection API
// Proxies to Railway relay which uses residential proxy for YouTube scraping

import { getCorsHeaders, isDisallowedOrigin } from '../_cors.js';

export const config = { runtime: 'edge' };

function getRelayBaseUrl() {
  const relayUrl = process.env.WS_RELAY_URL;
  if (!relayUrl) return null;
  return relayUrl.replace('wss://', 'https://').replace('ws://', 'http://').replace(/\/$/, '');
}

function getRelayHeaders(baseHeaders = {}) {
  const headers = { ...baseHeaders };
  const relaySecret = process.env.RELAY_SHARED_SECRET || '';
  if (relaySecret) {
    const relayHeader = (process.env.RELAY_AUTH_HEADER || 'x-relay-key').toLowerCase();
    headers[relayHeader] = relaySecret;
    headers.Authorization = `Bearer ${relaySecret}`;
  }
  return headers;
}

export default async function handler(request) {
  const cors = getCorsHeaders(request);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (isDisallowedOrigin(request)) {
    return new Response(JSON.stringify({ error: 'Origin not allowed' }), { status: 403, headers: cors });
  }
  const url = new URL(request.url);
  const channel = url.searchParams.get('channel');
  const videoIdParam = url.searchParams.get('videoId');

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

  // Proxy to Railway relay
  const relayBase = getRelayBaseUrl();
  if (relayBase) {
    try {
      const relayHeaders = getRelayHeaders({ 'User-Agent': 'WorldMonitor-Edge/1.0' });
      const relayRes = await fetch(`${relayBase}/youtube-live?${qs}`, { headers: relayHeaders });
      if (relayRes.ok) {
        const data = await relayRes.json();
        const cacheTime = videoIdParam ? 3600 : 300;
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
  if (videoIdParam && /^[A-Za-z0-9_-]{11}$/.test(videoIdParam)) {
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
    const channelHandle = channel.startsWith('@') ? channel : `@${channel}`;
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
      headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300, s-maxage=300, stale-while-revalidate=60' },
    });
  } catch {
    return new Response(JSON.stringify({ videoId: null, error: 'Failed to fetch channel data' }), {
      status: 200, headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }
}
