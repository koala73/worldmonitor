import { ARCHIVE_REQUEST_TIMEOUT_MS, requestArchive, type ArchiveFailure, type ArchiveId, type ArchiveRequestOptions } from './archive-result';

export interface LoadedArchiveImage {
  /** A `blob:` URL for the `<img>`, or a scene-wide preview URL as is; neither carries the point. */
  objectUrl: string;
  /** Which candidate loaded. */
  index: number;
  release: () => void;
}

export type ArchiveImageResult =
  | { status: 'ok'; image: LoadedArchiveImage }
  | { status: 'failed'; failure: ArchiveFailure };

/** Hosts whose image URLs U5 builds around the point. Scene-wide previews elsewhere carry no point. */
const POINT_IMAGE_HOSTS = new Set(['planetarycomputer.microsoft.com', 'gibs.earthdata.nasa.gov', 'view.eumetsat.int']);

const carriesPoint = (url: string) => {
  try {
    return POINT_IMAGE_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
};

async function decodable(blob: Blob): Promise<Blob> {
  if (!blob.type.startsWith('image/')) throw new Error('not an image');
  if (typeof createImageBitmap === 'function') (await createImageBitmap(blob)).close();
  return blob;
}

/**
 * Fetches the first candidate image that loads and decodes, inside one deadline.
 * Archive image URLs carry the point in their path or query, and DebugBear reports
 * the largest-contentful-paint image's URL with both, so they never go in `img.src`. A URL
 * from any other host is a scene-wide preview and is returned as is.
 */
export async function loadArchiveImage(archive: ArchiveId, candidates: readonly string[], options: ArchiveRequestOptions = {}): Promise<ArchiveImageResult> {
  const until = Date.now() + (options.timeoutMs ?? ARCHIVE_REQUEST_TIMEOUT_MS);
  let failure: ArchiveFailure = { archive, reason: 'invalid-response' };
  for (const [index, url] of candidates.entries()) {
    if (!carriesPoint(url)) return { status: 'ok', image: { objectUrl: url, index, release: () => {} } };
    const timeoutMs = until - Date.now();
    if (timeoutMs <= 0) return { status: 'failed', failure: { archive, reason: 'timeout' } };
    const reply = await requestArchive(archive, url, {}, { ...options, timeoutMs }, async (response) => decodable(await response.blob()));
    if (reply.ok) {
      const objectUrl = URL.createObjectURL(reply.value);
      return { status: 'ok', image: { objectUrl, index, release: () => URL.revokeObjectURL(objectUrl) } };
    }
    failure = reply.failure;
    if (failure.reason === 'aborted' || failure.reason === 'timeout') break;
  }
  return { status: 'failed', failure };
}
