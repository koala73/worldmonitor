import type {
  AviationServiceHandler,
  ServerContext,
  GetYoutubeLiveStreamInfoRequest,
  GetYoutubeLiveStreamInfoResponse,
} from '../../../../src/generated/server/worldmonitor/aviation/v1/service_server';

/**
 * GetYoutubeLiveStreamInfo detects if a YouTube channel is live, with relay and direct fallback.
 */
export const getYoutubeLiveStreamInfo: AviationServiceHandler['getYoutubeLiveStreamInfo'] = async (
  _ctx: ServerContext,
  req: GetYoutubeLiveStreamInfoRequest,
): Promise<GetYoutubeLiveStreamInfoResponse> => {
  const { channel, videoId: videoIdParam } = req;
  const params = new URLSearchParams();
  if (channel) params.set('channel', channel);
  if (videoIdParam) params.set('videoId', videoIdParam);
  const qs = params.toString();

  if (!qs) {
    return { videoId: '', isLive: false, channelExists: false, channelName: '', hlsUrl: '', title: '', error: 'Missing channel or videoId' };
  }

  // 1. Try Railway Relay
  const relayUrl = process.env.WS_RELAY_URL;
  if (relayUrl) {
    try {
      const base = relayUrl.replace('wss://', 'https://').replace('ws://', 'http://').replace(/\/$/, '');
      const relaySecret = process.env.RELAY_SHARED_SECRET || '';
      const headers: Record<string, string> = { 'User-Agent': 'WorldMonitor-Server/1.0' };
      if (relaySecret) {
        const relayHeader = (process.env.RELAY_AUTH_HEADER || 'x-relay-key').toLowerCase();
        headers[relayHeader] = relaySecret;
        headers.Authorization = `Bearer ${relaySecret}`;
      }

      const relayRes = await fetch(`${base}/youtube-live?${qs}`, { headers, signal: AbortSignal.timeout(8000) });
      if (relayRes.ok) {
        const data = await relayRes.json();
        return {
          videoId: data.videoId || '',
          isLive: !!data.isLive,
          channelExists: !!data.channelExists,
          channelName: data.channelName || '',
          hlsUrl: data.hlsUrl || '',
          title: data.title || '',
          error: data.error || '',
        };
      }
    } catch { /* fall through */ }
  }

  // 2. Fallback: OEmbed (for videoId)
  if (videoIdParam && /^[A-Za-z0-9_-]{11}$/.test(videoIdParam)) {
    try {
      const oembedRes = await fetch(
        `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoIdParam}&format=json`,
        { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }, signal: AbortSignal.timeout(5000) }
      );
      if (oembedRes.ok) {
        const data = await oembedRes.json();
        return {
          videoId: videoIdParam,
          isLive: true, // If we have a videoId and oembed works, we assume we want to show it.
          channelExists: true,
          channelName: data.author_name || '',
          hlsUrl: '',
          title: data.title || '',
          error: '',
        };
      }
    } catch { /* fall through */ }
  }

  // 3. Fallback: Direct Scrape (limited)
  if (channel) {
    try {
      const channelHandle = channel.startsWith('@') ? channel : `@${channel}`;
      const response = await fetch(`https://www.youtube.com/${channelHandle}/live`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        redirect: 'follow',
        signal: AbortSignal.timeout(10000),
      });
      if (response.ok) {
        const html = await response.text();
        const channelExists = html.includes('"channelId"') || html.includes('og:url');
        
        let channelName = '';
        const ownerMatch = html.match(/"ownerChannelName"\s*:\s*"([^"]+)"/);
        if (ownerMatch?.[1]) channelName = ownerMatch[1];
        else { const am = html.match(/"author"\s*:\s*"([^"]+)"/); if (am?.[1]) channelName = am[1]; }

        let videoId = '';
        const detailsIdx = html.indexOf('"videoDetails"');
        if (detailsIdx !== -1) {
          const block = html.substring(detailsIdx, detailsIdx + 5000);
          const vidMatch = block.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
          const liveMatch = block.match(/"isLive"\s*:\s*true/);
          if (vidMatch?.[1] && liveMatch) videoId = vidMatch[1];
        }

        let hlsUrl = '';
        const hlsMatch = html.match(/"hlsManifestUrl"\s*:\s*"([^"]+)"/);
        if (hlsMatch?.[1] && videoId) hlsUrl = hlsMatch[1].replace(/\\u0026/g, '&');

        return {
          videoId,
          isLive: !!videoId,
          channelExists,
          channelName,
          hlsUrl,
          title: '', // Scrape doesn't easily give title without more parsing.
          error: '',
        };
      }
    } catch { /* fall through */ }
  }

  return { videoId: '', isLive: false, channelExists: !!channel, channelName: '', hlsUrl: '', title: '', error: 'Failed to detect live status' };
};
