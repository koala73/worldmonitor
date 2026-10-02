import type {
  AviationServiceHandler,
  ServerContext,
  GetYoutubeLiveStreamInfoRequest,
  GetYoutubeLiveStreamInfoResponse,
} from '../../../../src/generated/server/worldmonitor/aviation/v1/service_server';
import { ApiError } from '../../../../src/generated/server/worldmonitor/aviation/v1/service_server';
import { CHROME_UA } from '../../../_shared/constants';
import { cachedFetchJson } from '../../../_shared/redis';

const POSITIVE_TTL = 60;
const NEGATIVE_TTL = 30;
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const CHANNEL_ID_RE = /^UC[A-Za-z0-9_-]{22}$/;
// Short international handles and combining marks are valid. Bound the safe
// identifier shape without reimplementing YouTube's per-script naming policy.
const HANDLE_RE = /^[\p{L}\p{N}](?:[\p{L}\p{N}\p{M}._·-]{0,28}[\p{L}\p{N}\p{M}])?$/u;
const CHANNEL_DETECTION_RETIRED = 'channel_live_detection_retired';

interface YoutubeOEmbedPayload {
  title?: string;
  author_name?: string;
}

function emptyResult(error: string): GetYoutubeLiveStreamInfoResponse {
  return {
    videoId: '',
    isLive: false,
    channelExists: false,
    channelName: '',
    hlsUrl: '',
    title: '',
    error,
  };
}

async function tryOEmbed(videoId: string): Promise<GetYoutubeLiveStreamInfoResponse | null> {
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

/**
 * GetYoutubeLiveStreamInfo names a YouTube video through oEmbed. Channel live detection is retired
 * (the channel, isLive and hlsUrl fields are deprecated), so a channel-only query answers error
 * 'channel_live_detection_retired' without I/O.
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

  if (videoId) {
    // Keyed by the video alone: a channel given alongside it no longer changes the answer.
    const cached = await cachedFetchJson<GetYoutubeLiveStreamInfoResponse>(
      `aviation:yt-live:vid:${videoId}:v3`,
      POSITIVE_TTL,
      () => tryOEmbed(videoId),
      NEGATIVE_TTL,
    );
    return cached ?? emptyResult('Video lookup failed');
  }

  return emptyResult(req.channel ? CHANNEL_DETECTION_RETIRED : 'Missing channel or videoId');
};
