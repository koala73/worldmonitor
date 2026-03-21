import type {
  AviationServiceHandler,
  ServerContext,
  GetYoutubeLiveStreamInfoRequest,
  GetYoutubeLiveStreamInfoResponse,
} from '../../../../src/generated/server/worldmonitor/aviation/v1/service_server';
import { getRelayBaseUrl, getRelayHeaders } from './_shared';
import { CHROME_UA } from '../../../_shared/constants';

interface YoutubeRelayPayload {
  videoId?: string;
  isLive?: boolean;
  channelExists?: boolean;
  channelName?: string;
  hlsUrl?: string;
  title?: string;
  error?: string;
}

interface YoutubeOEmbedPayload {
  title?: string;
  author_name?: string;
}

function emptyResult(error: string, channelExists = false): GetYoutubeLiveStreamInfoResponse {
  return {
    videoId: '',
    isLive: false,
    channelExists,
    channelName: '',
    hlsUrl: '',
    title: '',
    error,
  };
}

function parseRelayPayload(payload: YoutubeRelayPayload): GetYoutubeLiveStreamInfoResponse {
  return {
    videoId: payload.videoId || '',
    isLive: Boolean(payload.isLive),
    channelExists: Boolean(payload.channelExists),
    channelName: payload.channelName || '',
    hlsUrl: payload.hlsUrl || '',
    title: payload.title || '',
    error: payload.error || '',
  };
}

/**
 * GetYoutubeLiveStreamInfo detects if a YouTube channel is live, with relay and direct fallback.
 */
export const getYoutubeLiveStreamInfo: AviationServiceHandler['getYoutubeLiveStreamInfo'] = async (
  _ctx: ServerContext,
  req: GetYoutubeLiveStreamInfoRequest,
): Promise<GetYoutubeLiveStreamInfoResponse> => {
  const { channel, videoId } = req;
  const params = new URLSearchParams();
  if (channel) params.set('channel', channel);
  if (videoId) params.set('videoId', videoId);

  if (!params.toString()) {
    return emptyResult('Missing channel or videoId');
  }

  const relayBaseUrl = getRelayBaseUrl();
  if (relayBaseUrl) {
    try {
      const relayResponse = await fetch(`${relayBaseUrl}/youtube-live?${params.toString()}`, {
        headers: getRelayHeaders({ 'User-Agent': 'WorldMonitor-Server/1.0' }),
        signal: AbortSignal.timeout(8_000),
      });
      if (relayResponse.ok) {
        const relayPayload = (await relayResponse.json()) as YoutubeRelayPayload;
        return parseRelayPayload(relayPayload);
      }
    } catch {
      // Fall through to direct checks.
    }
  }

  if (videoId && /^[A-Za-z0-9_-]{11}$/.test(videoId)) {
    try {
      const oembedResponse = await fetch(
        `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`,
        {
          headers: {
            'User-Agent': CHROME_UA,
          },
          signal: AbortSignal.timeout(5_000),
        },
      );
      if (oembedResponse.ok) {
        const payload = (await oembedResponse.json()) as YoutubeOEmbedPayload;
        return {
          videoId,
          // OEmbed confirms video/channel existence, not live status.
          isLive: false,
          channelExists: true,
          channelName: payload.author_name || '',
          hlsUrl: '',
          title: payload.title || '',
          error: '',
        };
      }
    } catch {
      // Fall through to channel scrape fallback.
    }
  }

  if (channel) {
    try {
      const channelHandle = channel.startsWith('@') ? channel : `@${channel}`;
      const response = await fetch(`https://www.youtube.com/${channelHandle}/live`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) {
        const html = await response.text();
        const channelExists = html.includes('"channelId"') || html.includes('og:url');

        let channelName = '';
        const ownerMatch = html.match(/"ownerChannelName"\s*:\s*"([^"]+)"/);
        if (ownerMatch?.[1]) {
          channelName = ownerMatch[1];
        } else {
          const authorMatch = html.match(/"author"\s*:\s*"([^"]+)"/);
          if (authorMatch?.[1]) channelName = authorMatch[1];
        }

        let detectedVideoId = '';
        const detailsIndex = html.indexOf('"videoDetails"');
        if (detailsIndex !== -1) {
          const detailsBlock = html.substring(detailsIndex, detailsIndex + 5_000);
          const videoIdMatch = detailsBlock.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
          const isLiveMatch = detailsBlock.match(/"isLive"\s*:\s*true/);
          if (videoIdMatch?.[1] && isLiveMatch) {
            detectedVideoId = videoIdMatch[1];
          }
        }

        let hlsUrl = '';
        const hlsMatch = html.match(/"hlsManifestUrl"\s*:\s*"([^"]+)"/);
        if (hlsMatch?.[1] && detectedVideoId) {
          hlsUrl = hlsMatch[1].replace(/\\u0026/g, '&');
        }

        return {
          videoId: detectedVideoId,
          isLive: Boolean(detectedVideoId),
          channelExists,
          channelName,
          hlsUrl,
          title: '',
          error: '',
        };
      }
    } catch {
      // Fall through.
    }
  }

  return emptyResult('Failed to detect live status', Boolean(channel));
};
