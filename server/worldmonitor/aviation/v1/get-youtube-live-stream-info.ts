import type {
  AviationServiceHandler,
  ServerContext,
  GetYoutubeLiveStreamInfoRequest,
  GetYoutubeLiveStreamInfoResponse,
} from '../../../../src/generated/server/worldmonitor/aviation/v1/service_server';
import { ApiError } from '../../../../src/generated/server/worldmonitor/aviation/v1/service_server';
import { getRelayBaseUrl, getRelayHeaders } from './_shared';
import { CHROME_UA } from '../../../_shared/constants';
import { cachedFetchJson } from '../../../_shared/redis';

const POSITIVE_TTL = 60;
const NEGATIVE_TTL = 30;
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const CHANNEL_ID_RE = /^UC[A-Za-z0-9_-]{22}$/;
// Short international handles and combining marks are valid. Bound the safe
// identifier shape without reimplementing YouTube's per-script naming policy.
const HANDLE_RE = /^[\p{L}\p{N}](?:[\p{L}\p{N}\p{M}._·-]{0,28}[\p{L}\p{N}\p{M}])?$/u;

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

async function tryRelay(query: string): Promise<GetYoutubeLiveStreamInfoResponse | null> {
  const relayBaseUrl = getRelayBaseUrl();
  if (!relayBaseUrl) return null;
  try {
    const relayResponse = await fetch(`${relayBaseUrl}/youtube-live?${query}`, {
      headers: getRelayHeaders({ 'User-Agent': 'WorldMonitor-Server/1.0' }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!relayResponse.ok) return null;
    const relayPayload = (await relayResponse.json()) as YoutubeRelayPayload;
    return parseRelayPayload(relayPayload);
  } catch {
    return null;
  }
}

async function tryOEmbed(videoId: string): Promise<GetYoutubeLiveStreamInfoResponse | null> {
  if (!VIDEO_ID_RE.test(videoId)) return null;
  try {
    const oembedResponse = await fetch(
      `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`,
      { headers: { 'User-Agent': CHROME_UA }, signal: AbortSignal.timeout(5_000) },
    );
    if (!oembedResponse.ok) return null;
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
  } catch {
    return null;
  }
}

function parseChannelHtml(html: string): GetYoutubeLiveStreamInfoResponse {
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

async function tryChannelScrape(channel: string): Promise<GetYoutubeLiveStreamInfoResponse | null> {
  try {
    const channelPath = CHANNEL_ID_RE.test(channel)
      ? `channel/${channel}`
      : `@${encodeURIComponent(channel.replace(/^@/, ''))}`;
    const response = await fetch(`https://www.youtube.com/${channelPath}/live`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      redirect: 'follow',
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    return parseChannelHtml(await response.text());
  } catch {
    return null;
  }
}

async function fetchLiveStreamInfo(
  channel: string,
  videoId: string,
  query: string,
): Promise<GetYoutubeLiveStreamInfoResponse | null> {
  const relayResult = await tryRelay(query);
  if (relayResult) return relayResult;

  if (videoId) {
    const oembedResult = await tryOEmbed(videoId);
    if (oembedResult) return oembedResult;
  }

  if (channel) {
    const scrapeResult = await tryChannelScrape(channel);
    if (scrapeResult) return scrapeResult;
  }

  return null;
}

/**
 * GetYoutubeLiveStreamInfo detects if a YouTube channel is live, with relay and direct fallback.
 */
export const getYoutubeLiveStreamInfo: AviationServiceHandler['getYoutubeLiveStreamInfo'] = async (
  _ctx: ServerContext,
  req: GetYoutubeLiveStreamInfoRequest,
): Promise<GetYoutubeLiveStreamInfoResponse> => {
  const { videoId } = req;
  const rawHandle = req.channel.replace(/^@/, '').normalize('NFC');
  if ((videoId && !VIDEO_ID_RE.test(videoId))
      || (req.channel && !CHANNEL_ID_RE.test(req.channel) && !HANDLE_RE.test(rawHandle))) {
    throw new ApiError(400, 'Invalid YouTube handle, channel ID or video ID', '');
  }
  // Handles are case-insensitive, but channel/video IDs are not. Retaining @
  // also separates a handle named UC... from a canonical channel ID.
  const channel = !req.channel ? '' : CHANNEL_ID_RE.test(req.channel)
    ? req.channel
    : `@${rawHandle.toLowerCase()}`;
  const params = new URLSearchParams();
  if (channel) params.set('channel', channel);
  if (videoId) params.set('videoId', videoId);

  if (!params.toString()) {
    return emptyResult('Missing channel or videoId');
  }

  // Distinct request shapes (videoId-only, channel-only, both) MUST get distinct
  // cache keys — a negative sentinel for one shape must not suppress the others.
  const cacheKey = `aviation:yt-live:vid:${videoId}:ch:${channel}:v2`;

  const cached = await cachedFetchJson<GetYoutubeLiveStreamInfoResponse>(
    cacheKey,
    POSITIVE_TTL,
    () => fetchLiveStreamInfo(channel, videoId, params.toString()),
    NEGATIVE_TTL,
  );
  if (cached) return cached;

  return emptyResult('Failed to detect live status', Boolean(channel));
};
