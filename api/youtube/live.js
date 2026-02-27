// YouTube Live Stream Detection API
// Uses YouTube's oembed endpoint to check for live streams

import { getCorsHeaders, isDisallowedOrigin } from '../_cors.js';

export const config = {
  runtime: 'edge',
};

export default async function handler(request) {
  const cors = getCorsHeaders(request);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (isDisallowedOrigin(request)) {
    return new Response(JSON.stringify({ error: 'Origin not allowed' }), { status: 403, headers: cors });
  }
  const url = new URL(request.url);
  const channel = url.searchParams.get('channel');
  const videoIdParam = url.searchParams.get('videoId');

  // Video ID lookup: resolve author name via oembed
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
    } catch {}
    return new Response(JSON.stringify({ channelName: null, title: null, videoId: videoIdParam }), {
      status: 200,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  if (!channel) {
    return new Response(JSON.stringify({ error: 'Missing channel parameter' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    // Try to fetch the channel's live page
    const channelHandle = channel.startsWith('@') ? channel : `@${channel}`;
    const liveUrl = `https://www.youtube.com/${channelHandle}/live`;

    const response = await fetch(liveUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      redirect: 'follow',
    });

    if (!response.ok) {
      return new Response(JSON.stringify({ videoId: null, channelExists: false }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const html = await response.text();

    // Channel exists if the page contains canonical channel metadata
    const channelExists = html.includes('"channelId"') || html.includes('og:url');

    // Extract channel name from page metadata (prefer channel name over video title)
    let channelName = null;
    const ownerMatch = html.match(/"ownerChannelName"\s*:\s*"([^"]+)"/);
    if (ownerMatch) {
      channelName = ownerMatch[1];
    } else {
      const authorMatch = html.match(/"author"\s*:\s*"([^"]+)"/);
      if (authorMatch) channelName = authorMatch[1];
    }

    // Scope both fields to the same videoDetails block so we don't
    // combine a videoId from one object with isLive from another.
    let videoId = null;
    const detailsIdx = html.indexOf('"videoDetails"');
    if (detailsIdx !== -1) {
      const block = html.substring(detailsIdx, detailsIdx + 5000);
      const vidMatch = block.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
      const liveMatch = block.match(/"isLive"\s*:\s*true/);
      if (vidMatch && liveMatch) {
        videoId = vidMatch[1];
      }
    }

    // Extract HLS manifest URL for native playback (available for live streams).
    // The URL is in streamingData and contains a signed googlevideo.com manifest.
    let hlsUrl = null;
    const hlsMatch = html.match(/"hlsManifestUrl"\s*:\s*"([^"]+)"/);
    if (hlsMatch && videoId) {
      hlsUrl = hlsMatch[1].replace(/\\u0026/g, '&');
    }

    return new Response(JSON.stringify({ videoId, isLive: videoId !== null, channelExists, channelName, hlsUrl }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=300, s-maxage=300, stale-while-revalidate=60',
      },
    });
  } catch (error) {
    console.error('YouTube live check error:', error);
    return new Response(JSON.stringify({ videoId: null, error: error.message }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
