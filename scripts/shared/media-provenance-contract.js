// Media provenance (#9096): the contract shared by the API (server/), the
// Railway worker (scripts/media-provenance-worker.mjs) and the pages.
// scripts/shared/media-provenance-contract.js is a byte-for-byte mirror
// (tests/scripts-shared-mirror.test.mjs).
//
// WorldMonitor reports what a file's content credentials declare and where a
// reverse image search has seen the image. It never says media is authentic,
// fake, original or first published there.

/** Jobs the API enqueues and the worker pulls (BLMOVE). Raw keys, unprefixed. */
export const MEDIA_QUEUE_KEY = 'media-provenance:queue:pending';
export const MEDIA_PROCESSING_KEY = 'media-provenance:queue:processing';
/** Above this many waiting jobs, new checks are refused with 429. */
export const MEDIA_QUEUE_MAX_DEPTH = 50;

/** Results and owner bindings live a day; a caller polls within minutes. */
export const MEDIA_RESULT_TTL_SECONDS = 24 * 60 * 60;

/** Owner decision (#9096): submitted files are kept 30 days, then deleted. */
export const MEDIA_RETENTION_DAYS = 30;
export const MEDIA_STORED_INDEX_KEY = 'media-provenance:stored:v1';
export const MEDIA_STORAGE_PREFIX = 'media-provenance/v1';

/** Largest file the worker fetches. Larger files are refused, never cut. */
export const MEDIA_MAX_BYTES = 25 * 1024 * 1024;
export const MEDIA_URL_MAX_CHARS = 2048;
export const MEDIA_MAX_REDIRECTS = 5;

/** Types the worker accepts, after sniffing the bytes (the header alone is not trusted). */
export const MEDIA_IMAGE_TYPES = Object.freeze(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif', 'image/heic', 'image/tiff']);
export const MEDIA_VIDEO_TYPES = Object.freeze(['video/mp4', 'video/quicktime']);
/** Image types the earliest-copy search accepts. Video is not searched. */
export const MEDIA_SEARCHABLE_TYPES = Object.freeze(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif', 'image/tiff']);

/** Owner decision (#9096): TinEye spend is capped per calendar month (UTC). */
export const TINEYE_DEFAULT_MONTHLY_CAP_USD = 50;
export const TINEYE_DEFAULT_COST_PER_SEARCH_USD = 0.04;
export const TINEYE_SPEND_KEY_PREFIX = 'media-provenance:tineye-spend:v1';
export const TINEYE_CACHE_KEY_PREFIX = 'media-provenance:tineye:v1';
export const TINEYE_MAX_COPIES = 10;

export const MEDIA_JOB_ID_RE = /^media:\d{13}:[a-f0-9]{32}$/;
export const MEDIA_OWNER_TOKEN_RE = /^[a-f0-9]{64}$/;

export function mediaOwnerKey(jobId) {
  return `media-provenance:owner:${jobId}`;
}

export function mediaResultKey(owner, jobId) {
  return `media-provenance:result:${owner}:${jobId}`;
}

export function tineyeSpendKey(now = Date.now()) {
  return `${TINEYE_SPEND_KEY_PREFIX}:${new Date(now).toISOString().slice(0, 7)}`;
}

export function tineyeCacheKey(sha256) {
  return `${TINEYE_CACHE_KEY_PREFIX}:${sha256}`;
}

export const MEDIA_CAVEATS = Object.freeze([
  'Content credentials say who signed a file and what they declared about it. They are not a judgment that the media is genuine.',
  'An earliest copy is when a search provider\'s crawler first saw the image on a page, not when or where it was first published.',
]);

export const MEDIA_WORDING = Object.freeze({
  noCredentials: 'No content credentials found. Most sites remove them when images are uploaded, so this is common and says nothing about whether the media was edited.',
  unreadableCredentials: 'The file has content credentials that could not be read.',
  untrustedSigner: 'Signed, but the signer is not on the C2PA trust list this check uses.',
  unknownTrust: 'Signed. The signer could not be checked against a trust list.',
  aiDeclared: 'The credentials say this was made with a generative AI model.',
  changedAfterSigning: 'The credentials do not match the file: it was changed after it was signed. This does not say how or by whom.',
  failedValidation: 'The credentials failed validation: the signature or what they declare could not be confirmed. This does not say how the media was made or changed.',
  earliestNone: 'TinEye has not seen this image anywhere.',
  earliestUnsupported: 'The earliest-copy search covers images only.',
  earliestNotConfigured: 'The earliest-copy search is not set up on this server.',
  earliestCapReached: 'The earliest-copy search has reached its monthly limit. It is available again next month.',
  earliestUnavailable: 'The earliest-copy search could not run right now.',
});
