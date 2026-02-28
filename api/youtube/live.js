// YouTube Live Stream Detection API
// Uses residential proxy to bypass YouTube's datacenter IP blocking

import { getCorsHeaders, isDisallowedOrigin } from '../_cors.js';
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';

export const config = {
  maxDuration: 15,
};

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

// Parse proxy URL: http://user:pass@host:port
function parseProxy(proxyUrl) {
  if (!proxyUrl) return null;
  try {
    const u = new URL(proxyUrl);
    return {
      host: u.hostname,
      port: parseInt(u.port, 10),
      auth: u.username ? `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}` : null,
    };
  } catch { return null; }
}

// Fetch via HTTP CONNECT proxy tunnel
function fetchViaProxy(targetUrl, proxy) {
  return new Promise((resolve, reject) => {
    const target = new URL(targetUrl);
    const connectOpts = {
      host: proxy.host,
      port: proxy.port,
      method: 'CONNECT',
      path: `${target.hostname}:443`,
      headers: {},
    };
    if (proxy.auth) {
      connectOpts.headers['Proxy-Authorization'] = 'Basic ' + Buffer.from(proxy.auth).toString('base64');
    }
    const connectReq = http.request(connectOpts);
    connectReq.on('connect', (_res, socket) => {
      const req = https.request({
        hostname: target.hostname,
        path: target.pathname + target.search,
        method: 'GET',
        headers: { 'User-Agent': CHROME_UA, 'Accept-Encoding': 'gzip, deflate' },
        socket,
        agent: false,
      }, (res) => {
        let stream = res;
        const encoding = (res.headers['content-encoding'] || '').trim().toLowerCase();
        if (encoding === 'gzip') stream = res.pipe(zlib.createGunzip());
        else if (encoding === 'deflate') stream = res.pipe(zlib.createInflate());

        const chunks = [];
        stream.on('data', (c) => chunks.push(c));
        stream.on('end', () => {
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            text: () => Promise.resolve(Buffer.concat(chunks).toString()),
            json: () => Promise.resolve(JSON.parse(Buffer.concat(chunks).toString())),
          });
        });
        stream.on('error', reject);
      });
      req.on('error', reject);
      req.end();
    });
    connectReq.on('error', reject);
    connectReq.setTimeout(12000, () => { connectReq.destroy(); reject(new Error('Proxy timeout')); });
    connectReq.end();
  });
}

// Fetch YouTube - uses proxy if configured, otherwise direct fetch
async function ytFetch(url) {
  const proxy = parseProxy(process.env.YOUTUBE_PROXY_URL);
  if (proxy) {
    return fetchViaProxy(url, proxy);
  }
  return globalThis.fetch(url, { headers: { 'User-Agent': CHROME_UA, 'Accept-Encoding': 'gzip, deflate, br' }, redirect: 'follow' });
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

  // Video ID lookup: resolve author name via oembed
  if (videoIdParam && /^[A-Za-z0-9_-]{11}$/.test(videoIdParam)) {
    try {
      const oembedRes = await ytFetch(
        `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoIdParam}&format=json`,
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
    const channelHandle = channel.startsWith('@') ? channel : `@${channel}`;
    const liveUrl = `https://www.youtube.com/${channelHandle}/live`;

    const response = await ytFetch(liveUrl);

    if (!response.ok) {
      return new Response(JSON.stringify({ videoId: null, channelExists: false }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const html = await response.text();

    const channelExists = html.includes('"channelId"') || html.includes('og:url');

    let channelName = null;
    const ownerMatch = html.match(/"ownerChannelName"\s*:\s*"([^"]+)"/);
    if (ownerMatch) {
      channelName = ownerMatch[1];
    } else {
      const authorMatch = html.match(/"author"\s*:\s*"([^"]+)"/);
      if (authorMatch) channelName = authorMatch[1];
    }

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

    let hlsUrl = null;
    const hlsMatch = html.match(/"hlsManifestUrl"\s*:\s*"([^"]+)"/);
    if (hlsMatch && videoId) {
      hlsUrl = hlsMatch[1].replace(/\\u0026/g, '&');
    }

    return new Response(JSON.stringify({ videoId, isLive: videoId !== null, channelExists, channelName, hlsUrl }), {
      status: 200,
      headers: {
        ...cors,
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=300, s-maxage=300, stale-while-revalidate=60',
      },
    });
  } catch (error) {
    console.error('YouTube live check error:', error);
    return new Response(JSON.stringify({ videoId: null, error: error.message }), {
      status: 200,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }
}
