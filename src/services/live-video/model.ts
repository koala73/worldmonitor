// What counts as a live-video source entry, and whether one playback attempt is live.
// Pure and import-free: the browser, the Node checker (scripts/check-live-video-sources.mjs)
// and the tests all classify with this one definition.

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

/** 11-char YouTube video id. Only `parseSourceEntry` mints one. */
export type VideoId = Brand<string, 'VideoId'>;
/** `UC` + 22 chars. Only `parseSourceEntry` mints one. */
export type ChannelId = Brand<string, 'ChannelId'>;
/** https manifest whose host is not YouTube or googlevideo (scraped YouTube manifests never play outside the official player). */
export type HttpsStreamUrl = Brand<string, 'HttpsStreamUrl'>;

export type Candidate =
  | { readonly kind: 'hls'; readonly url: HttpsStreamUrl }
  | { readonly kind: 'video'; readonly videoId: VideoId }
  | { readonly kind: 'channel'; readonly channelId: ChannelId };

export type EntryProblem =
  | 'not-https'
  | 'youtube-manifest'
  | 'needs-channel-url'
  | 'unrecognized';

export type ParsedEntry =
  | { readonly ok: true; readonly entry: string; readonly candidate: Candidate }
  | { readonly ok: false; readonly entry: string; readonly problem: EntryProblem };

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
const YOUTUBE_PAGE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtube-nocookie.com', 'www.youtube-nocookie.com']);
const VIDEO_PATH_PREFIXES = new Set(['live', 'embed', 'shorts', 'v']);

function isYouTubeOwnedHost(host: string): boolean {
  return ['youtube.com', 'youtu.be', 'youtube-nocookie.com', 'googlevideo.com']
    .some((domain) => host === domain || host.endsWith(`.${domain}`));
}

function toUrl(raw: string): URL | null {
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw)
    ? raw
    : /^(?:www\.|m\.)?(?:youtube\.com|youtu\.be)\//i.test(raw) ? `https://${raw}` : null;
  if (!withScheme) return null;
  try {
    return new URL(withScheme);
  } catch {
    return null;
  }
}

/**
 * Accepts whatever the owner pastes: a bare video or channel id, any watch / youtu.be / live /
 * embed URL, a `/channel/UC…` URL or `embed/live_stream?channel=UC…` (channel live embed), or an
 * https `.m3u8`. Handles (`@CNN`, `/c/X`) have no keyless mapping to a channel id.
 */
export function parseSourceEntry(entry: string): ParsedEntry {
  const ok = (candidate: Candidate): ParsedEntry => ({ ok: true, entry, candidate });
  const fail = (problem: EntryProblem): ParsedEntry => ({ ok: false, entry, problem });
  const videoOr = (id: string | undefined): ParsedEntry =>
    id && VIDEO_ID.test(id) ? ok({ kind: 'video', videoId: id as VideoId }) : fail('unrecognized');
  const channelOr = (id: string | undefined | null): ParsedEntry =>
    id && CHANNEL_ID.test(id) ? ok({ kind: 'channel', channelId: id as ChannelId }) : fail('unrecognized');

  const raw = entry.trim();
  if (VIDEO_ID.test(raw)) return videoOr(raw);
  if (CHANNEL_ID.test(raw)) return channelOr(raw);
  if (raw.startsWith('@')) return fail('needs-channel-url');

  const url = toUrl(raw);
  if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) return fail('unrecognized');
  const host = url.hostname.toLowerCase();

  if (url.pathname.toLowerCase().endsWith('.m3u8')) {
    if (isYouTubeOwnedHost(host)) return fail('youtube-manifest');
    if (url.protocol !== 'https:') return fail('not-https');
    return ok({ kind: 'hls', url: url.href as HttpsStreamUrl });
  }

  // Browsers sometimes copy www.youtu.be; treat any youtu.be host the same.
  if (host === 'youtu.be' || host.endsWith('.youtu.be')) return videoOr(url.pathname.split('/')[1]);
  if (!YOUTUBE_PAGE_HOSTS.has(host)) return fail('unrecognized');

  const [first, second] = url.pathname.split('/').filter(Boolean);
  if (first === 'watch') return videoOr(url.searchParams.get('v') ?? undefined);
  if (first === 'embed' && second === 'live_stream') return channelOr(url.searchParams.get('channel'));
  if (first && VIDEO_PATH_PREFIXES.has(first)) return videoOr(second);
  if (first === 'channel') return channelOr(second);
  if (first?.startsWith('@') || first === 'c' || first === 'user') return fail('needs-channel-url');
  return fail('unrecognized');
}

export interface YouTubeVideoSnapshot {
  readonly videoId: string;              // '' while a channel embed has not resolved
  readonly isLive: boolean | undefined;  // undefined = YouTube stopped exposing the field
  readonly title: string;
  readonly author: string;
}

export interface DurationSample { readonly atMs: number; readonly seconds: number }

export type PlayerObservation =
  | { readonly transport: 'youtube'; readonly api: 'blocked' }
  | {
      readonly transport: 'youtube';
      readonly api: 'loaded';
      readonly candidate: 'video' | 'channel';
      /** Since the player was mounted. */
      readonly elapsedMs: number;
      readonly frameLoaded: boolean;
      /** When onReady fired, on the same clock as `elapsedMs`; null until then. */
      readonly readyAtMs: number | null;
      readonly errorCode: number | null;
      readonly video: YouTubeVideoSnapshot | null;
      /** `getDuration()` sampled while PLAYING. */
      readonly durations: readonly DurationSample[];
    }
  | {
      readonly transport: 'hls';
      readonly elapsedMs: number;
      /** hls.js `details.live`, native `duration === Infinity`, or the playlist text. */
      readonly manifest: 'live' | 'vod' | 'unknown';
      readonly failure: { readonly kind: 'http'; readonly status: number } | { readonly kind: 'fatal'; readonly detail: string } | null;
    };

export type FailureOutcome =
  | { readonly kind: 'player-error'; readonly code: number }
  | { readonly kind: 'channel-not-live' }
  /** YouTube lists the video as live but it never played: a scheduled stream's waiting room. */
  | { readonly kind: 'not-started' }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'hls-http'; readonly status: number }
  | { readonly kind: 'hls-fatal'; readonly detail: string };

export type UnverifiableReason = 'player-api-blocked' | 'player-api-silent' | 'live-signal-missing';

export type AttemptVerdict =
  | { readonly verdict: 'pending' }
  | { readonly verdict: 'live'; readonly video: YouTubeVideoSnapshot | null }
  | { readonly verdict: 'recording'; readonly video: YouTubeVideoSnapshot | null }
  | { readonly verdict: 'failed'; readonly outcome: FailureOutcome }
  | { readonly verdict: 'unverifiable'; readonly reason: UnverifiableReason };

export type SettledVerdict = Exclude<AttemptVerdict, { verdict: 'pending' }>;

export const LIVE_VIDEO_TIMING = {
  pollMs: 1_000,
  verdictDeadlineMs: 15_000,
  channelEmptyGraceMs: 5_000,
  /** How long isLive=false must hold while playing before the video counts as an ended recording. */
  recordingConfirmMs: 2_000,
} as const;

const PENDING: AttemptVerdict = { verdict: 'pending' };

function failed(outcome: FailureOutcome): AttemptVerdict {
  return { verdict: 'failed', outcome };
}

/** True once PLAYING samples with a positive duration span `recordingConfirmMs`. */
function playedThroughConfirmWindow(durations: readonly DurationSample[]): boolean {
  const positive = durations.filter((sample) => sample.seconds > 0);
  const first = positive[0];
  const last = positive[positive.length - 1];
  return !!first && !!last && last.atMs - first.atMs >= LIVE_VIDEO_TIMING.recordingConfirmMs;
}

/**
 * First match wins:
 *  api blocked                                   → unverifiable(player-api-blocked)
 *  player error                                  → failed(player-error)
 *  video id + isLive true + a PLAYING sample     → live (a scheduled stream also says isLive but never plays)
 *  video id + isLive false, playing through the confirm window → recording
 *  channel embed ready with no video for the grace period → failed(channel-not-live)
 *  deadline: frame loaded but never ready        → unverifiable(player-api-silent)
 *            isLive true but never played        → failed(not-started)
 *            isLive missing                      → unverifiable(live-signal-missing)
 *            otherwise                           → failed(timeout)
 *  hls: http/fatal failure → failed; live → live; vod → recording; deadline → failed(timeout)
 * Duration never decides live: a live stream's getDuration() stays flat while it plays.
 */
export function classifyAttempt(observation: PlayerObservation): AttemptVerdict {
  if (observation.transport === 'hls') {
    const { failure, manifest, elapsedMs } = observation;
    if (failure?.kind === 'http') return failed({ kind: 'hls-http', status: failure.status });
    if (failure?.kind === 'fatal') return failed({ kind: 'hls-fatal', detail: failure.detail });
    if (manifest === 'live') return { verdict: 'live', video: null };
    if (manifest === 'vod') return { verdict: 'recording', video: null };
    return elapsedMs >= LIVE_VIDEO_TIMING.verdictDeadlineMs ? failed({ kind: 'timeout' }) : PENDING;
  }
  if (observation.api === 'blocked') return { verdict: 'unverifiable', reason: 'player-api-blocked' };

  const { candidate, elapsedMs, frameLoaded, readyAtMs, errorCode, video, durations } = observation;
  if (errorCode !== null) return failed({ kind: 'player-error', code: errorCode });

  if (video?.videoId && video.isLive === true && durations.length > 0) return { verdict: 'live', video };
  if (video?.videoId && video.isLive === false && playedThroughConfirmWindow(durations)) return { verdict: 'recording', video };

  if (candidate === 'channel' && readyAtMs !== null && video?.videoId === ''
    && elapsedMs - readyAtMs >= LIVE_VIDEO_TIMING.channelEmptyGraceMs) {
    return failed({ kind: 'channel-not-live' });
  }

  if (elapsedMs >= LIVE_VIDEO_TIMING.verdictDeadlineMs) {
    if (readyAtMs === null) {
      return frameLoaded ? { verdict: 'unverifiable', reason: 'player-api-silent' } : failed({ kind: 'timeout' });
    }
    if (video?.videoId && video.isLive === true) return failed({ kind: 'not-started' });
    if (video?.videoId && video.isLive === undefined) return { verdict: 'unverifiable', reason: 'live-signal-missing' };
    return failed({ kind: 'timeout' });
  }
  return PENDING;
}
