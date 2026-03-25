import type { GetWebcamImageRequest, GetWebcamImageResponse, ServerContext } from '../../../../src/generated/server/worldmonitor/webcam/v1/service_server';
import { cachedFetchJson } from '../../../_shared/redis';

const WINDY_BASE = 'https://api.windy.com/webcams/api/v3/webcams';
const CACHE_TTL = 300;

const WEBCAM_ID_RE = /^[\w-]+$/;

export async function getWebcamImage(_ctx: ServerContext, req: GetWebcamImageRequest): Promise<GetWebcamImageResponse> {
  const { webcamId } = req;
  const windyUrl = `https://www.windy.com/webcams/${encodeURIComponent(webcamId || '')}`;

  if (!webcamId || !WEBCAM_ID_RE.test(webcamId)) {
    return { thumbnailUrl: '', playerUrl: '', title: '', windyUrl, lastUpdated: '', error: 'missing webcam_id' };
  }

  const apiKey = process.env.WINDY_API_KEY;
  if (!apiKey) {
    return { thumbnailUrl: '', playerUrl: '', title: '', windyUrl, lastUpdated: '', error: 'unavailable' };
  }

  const result = await cachedFetchJson<GetWebcamImageResponse>(
    `webcam:image:${webcamId}`,
    CACHE_TTL,
    async () => {
      const resp = await fetch(`${WINDY_BASE}/${encodeURIComponent(webcamId)}?include=images,urls`, {
        headers: { 'x-windy-api-key': apiKey },
        signal: AbortSignal.timeout(5000),
      });
      if (!resp.ok) return null;

      const data = await resp.json();
      const wc = data.webcams?.[0] ?? data;
      const images = wc.images || wc.image || {};
      const urls = wc.urls || {};

      return {
        thumbnailUrl: images.current?.preview || images.current?.thumbnail || '',
        playerUrl: urls.player || '',
        title: wc.title || '',
        windyUrl,
        lastUpdated: wc.lastUpdatedOn ? new Date(wc.lastUpdatedOn).toISOString() : '',
        error: '',
      };
    },
  );

  return result ?? { thumbnailUrl: '', playerUrl: '', title: '', windyUrl, lastUpdated: '', error: 'unavailable' };
}
