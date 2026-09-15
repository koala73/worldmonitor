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
      /**
       * advancing: `currentTime` moved forward while playing. stalled: a browser that has seen no playback yet.
       * unchecked: a caller that cannot play media (the Node checker), so the manifest is the only evidence.
       */
      readonly progress: 'advancing' | 'stalled' | 'unchecked';
      readonly failure: { readonly kind: 'http'; readonly status: number } | { readonly kind: 'fatal'; readonly detail: string } | null;
    };

export type FailureOutcome =
  | { readonly kind: 'player-error'; readonly code: number }
  | { readonly kind: 'channel-not-live' }
  /** Listed as live but never played: a scheduled YouTube stream's waiting room, or an HLS stream the browser cannot render. */
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
  relockWindowMs: 60_000,
  failureMemoryMs: 5 * 60_000,
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
 *  hls: http/fatal failure                       → failed(hls-http / hls-fatal)
 *       vod manifest                             → recording
 *       live manifest + playback advancing       → live (a playlist can say live over a frame that never renders)
 *       live manifest + playback unchecked       → live (the Node checker has only the manifest)
 *       deadline: live manifest, playback stalled → failed(not-started)
 *                 otherwise                      → failed(timeout)
 * Duration never decides live: a live stream's getDuration() stays flat while it plays.
 */
export function classifyAttempt(observation: PlayerObservation): AttemptVerdict {
  if (observation.transport === 'hls') {
    const { failure, manifest, progress, elapsedMs } = observation;
    if (failure?.kind === 'http') return failed({ kind: 'hls-http', status: failure.status });
    if (failure?.kind === 'fatal') return failed({ kind: 'hls-fatal', detail: failure.detail });
    if (manifest === 'vod') return { verdict: 'recording', video: null };
    if (manifest === 'live' && (progress === 'advancing' || progress === 'unchecked')) return { verdict: 'live', video: null };
    if (elapsedMs < LIVE_VIDEO_TIMING.verdictDeadlineMs) return PENDING;
    return manifest === 'live' && progress === 'stalled' ? failed({ kind: 'not-started' }) : failed({ kind: 'timeout' });
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

export type SourceOrigin = 'builtin' | 'custom';

/** What a panel hands the session. Entries are raw strings; parsing happens once, inside. */
export interface LiveVideoSource {
  /** Named in telemetry and the audit, e.g. 'webcams/taipei'. */
  readonly slot: string;
  readonly entries: readonly string[];
  /** Only a user-added video may keep playing an ended recording; built-in sources never do. */
  readonly origin: SourceOrigin;
}

export interface SourceCandidate { readonly entry: string; readonly candidate: Candidate }

export interface ParsedSource {
  readonly source: LiveVideoSource;
  readonly candidates: readonly SourceCandidate[];
  /** Why nothing is playable; null whenever at least one entry parsed. */
  readonly problem: 'no-entries' | 'needs-channel-url' | 'insecure-url' | null;
}

export function parseSource(source: LiveVideoSource): ParsedSource {
  const parsed = source.entries.map(parseSourceEntry);
  const candidates = parsed.flatMap((item) => (item.ok ? [{ entry: item.entry, candidate: item.candidate }] : []));
  if (candidates.length > 0) return { source, candidates, problem: null };
  const problems = new Set(parsed.flatMap((item) => (item.ok ? [] : [item.problem])));
  const problem = problems.has('needs-channel-url') ? 'needs-channel-url' : problems.has('not-https') ? 'insecure-url' : 'no-entries';
  return { source, candidates, problem };
}

export interface AttemptReport {
  readonly index: number;
  readonly entry: string;
  readonly candidate: Candidate;
  readonly verdict: SettledVerdict;
}

export type OfflineReason =
  | 'no-entries'         // nothing configured: the owner fills the slot
  | 'needs-channel-url'  // a user-added @handle channel
  | 'insecure-url'       // a user-added http:// manifest
  | 'not-live'           // every attempt was an ended recording, a stream that never started, or a channel with nothing live
  | 'embed-blocked'      // every attempt failed with 101/150/152/153
  | 'unavailable'        // mixed failures: 100, 2, 5, timeouts, silent players, HLS failures
  | 'stream-ended';      // a live stream ended again soon after one re-resolve

interface ChainProgress {
  /** Candidate indexes in try order: recently failed candidates last. */
  readonly order: readonly number[];
  readonly attempts: readonly AttemptReport[];
  /** When a locked live stream last ended; ending again inside the relock window goes offline. */
  readonly liveLostAtMs: number | null;
}

export type ChainState = ChainProgress & (
  | { readonly phase: 'connecting'; readonly index: number }
  | { readonly phase: 'live'; readonly index: number; readonly video: YouTubeVideoSnapshot | null }
  | { readonly phase: 'recording'; readonly index: number; readonly video: YouTubeVideoSnapshot | null }
  | { readonly phase: 'unverified'; readonly index: number; readonly reason: UnverifiableReason }
  | { readonly phase: 'offline'; readonly reason: OfflineReason }
);

export type ChainEvent =
  | { readonly type: 'verdict'; readonly verdict: SettledVerdict }
  | { readonly type: 'live-lost' }
  | { readonly type: 'retry' };

export type ChainEffect =
  | { readonly type: 'mount'; readonly index: number }
  | { readonly type: 'keep' }
  | { readonly type: 'unmount' };

export interface ChainStep { readonly state: ChainState; readonly effect: ChainEffect }

const KEEP: ChainEffect = { type: 'keep' };
const EMBED_BLOCKED_CODES = new Set([101, 150, 152, 153]);

export function failureKey(slot: string, candidate: Candidate): string {
  const id = candidate.kind === 'video' ? candidate.videoId : candidate.kind === 'channel' ? candidate.channelId : candidate.url;
  return `${slot}|${candidate.kind}:${id}`;
}

function connectTo(index: number, progress: ChainProgress): ChainStep {
  return { state: { ...progress, phase: 'connecting', index }, effect: { type: 'mount', index } };
}

function summarizeOffline(attempts: readonly AttemptReport[]): OfflineReason {
  const verdicts = attempts.map((attempt) => attempt.verdict);
  if (verdicts.length === 0) return 'unavailable';
  if (verdicts.every((v) => v.verdict === 'failed' && v.outcome.kind === 'player-error' && EMBED_BLOCKED_CODES.has(v.outcome.code))) {
    return 'embed-blocked';
  }
  if (verdicts.every((v) => v.verdict === 'recording'
    || (v.verdict === 'failed' && (v.outcome.kind === 'channel-not-live' || v.outcome.kind === 'not-started')))) {
    return 'not-live';
  }
  return 'unavailable';
}

function untried(progress: ChainProgress, index: number): boolean {
  return !progress.attempts.some((attempt) => attempt.index === index);
}

function nextOrOffline(progress: ChainProgress): ChainStep {
  const next = progress.order.find((index) => untried(progress, index));
  if (next !== undefined) return connectTo(next, progress);
  return { state: { ...progress, phase: 'offline', reason: summarizeOffline(progress.attempts) }, effect: { type: 'unmount' } };
}

/**
 * Start from the first candidate not in `recentFailureKeys`. When every candidate failed recently,
 * try them all anyway: memory reorders, it never produces offline on its own.
 */
export function startChain(parsed: ParsedSource, recentFailureKeys: ReadonlySet<string>): ChainStep {
  const indexes = parsed.candidates.map((_, index) => index);
  const remembered = (index: number) => recentFailureKeys.has(failureKey(parsed.source.slot, parsed.candidates[index]!.candidate));
  const progress: ChainProgress = {
    order: [...indexes.filter((index) => !remembered(index)), ...indexes.filter(remembered)],
    attempts: [],
    liveLostAtMs: null,
  };
  const first = progress.order[0];
  if (first === undefined) {
    return { state: { ...progress, phase: 'offline', reason: parsed.problem ?? 'no-entries' }, effect: { type: 'unmount' } };
  }
  return connectTo(first, progress);
}

/**
 *  connecting + live          → live, keep
 *  connecting + recording     → a user-added video keeps it as a recording; otherwise next candidate or offline
 *  connecting + failed        → next candidate or offline (a stream that never started counts as not live)
 *  connecting + silent player → built-in: next candidate or offline; user-added: unverified, keep
 *  connecting + blocked API or missing live signal → an untried HLS candidate, else unverified, keep
 *                               (the signal is missing for every YouTube video, so trying the next one cannot help)
 *  live + live-lost           → re-resolve from the top once; again inside the relock window → offline(stream-ended)
 *  settled + retry            → start over (the caller clears failure memory)
 *  anything else              → unchanged, keep
 */
export function advanceChain(state: ChainState, event: ChainEvent, parsed: ParsedSource, nowMs: number): ChainStep {
  const unchanged: ChainStep = { state, effect: KEEP };
  if (event.type === 'retry') return state.phase === 'connecting' ? unchanged : startChain(parsed, new Set());

  if (event.type === 'live-lost') {
    if (state.phase !== 'live') return unchanged;
    if (state.liveLostAtMs !== null && nowMs - state.liveLostAtMs < LIVE_VIDEO_TIMING.relockWindowMs) {
      const progress: ChainProgress = { order: state.order, attempts: state.attempts, liveLostAtMs: state.liveLostAtMs };
      return { state: { ...progress, phase: 'offline', reason: 'stream-ended' }, effect: { type: 'unmount' } };
    }
    return connectTo(state.order[0]!, { order: state.order, attempts: [], liveLostAtMs: nowMs });
  }

  if (state.phase !== 'connecting') return unchanged;
  const { index } = state;
  const current = parsed.candidates[index]!;
  const { verdict } = event;
  const progress: ChainProgress = {
    order: state.order,
    attempts: [...state.attempts, { index, entry: current.entry, candidate: current.candidate, verdict }],
    liveLostAtMs: state.liveLostAtMs,
  };

  switch (verdict.verdict) {
    case 'live':
      return { state: { ...progress, phase: 'live', index, video: verdict.video }, effect: KEEP };
    case 'recording':
      if (parsed.source.origin === 'custom' && current.candidate.kind === 'video') {
        return { state: { ...progress, phase: 'recording', index, video: verdict.video }, effect: KEEP };
      }
      return nextOrOffline(progress);
    case 'failed':
      return nextOrOffline(progress);
    case 'unverifiable': {
      const unverified: ChainStep = { state: { ...progress, phase: 'unverified', index, reason: verdict.reason }, effect: KEEP };
      if (verdict.reason === 'player-api-silent') {
        return parsed.source.origin === 'builtin' ? nextOrOffline(progress) : unverified;
      }
      const hls = progress.order.find((candidateIndex) => parsed.candidates[candidateIndex]!.candidate.kind === 'hls' && untried(progress, candidateIndex));
      return hls === undefined ? unverified : connectTo(hls, progress);
    }
  }
}

export interface EmbedSrcOptions {
  /** Encoded into origin= and widget_referrer=. */
  readonly origin: string;
  readonly autoplay: boolean;
  readonly muted: boolean;
  readonly controls: boolean;
  readonly quality: string | null;
}

/** An embed URL the IFrame API can attach to (enablejsapi=1); a channel plays whatever it has live. */
export function youtubeEmbedSrc(candidate: Extract<Candidate, { kind: 'video' | 'channel' }>, options: EmbedSrcOptions): string {
  const params = new URLSearchParams({
    autoplay: options.autoplay ? '1' : '0',
    mute: options.muted ? '1' : '0',
    controls: options.controls ? '1' : '0',
    modestbranding: '1',
    playsinline: '1',
    rel: '0',
    enablejsapi: '1',
    origin: options.origin,
    widget_referrer: options.origin,
  });
  if (options.quality) params.set('vq', options.quality);
  if (candidate.kind === 'channel') return `https://www.youtube.com/embed/live_stream?channel=${candidate.channelId}&${params}`;
  return `https://www.youtube.com/embed/${candidate.videoId}?${params}`;
}

/** Link for "Open on YouTube": a video's watch page, a channel's live page, nothing for HLS. */
export function watchUrlFor(candidate: Candidate | null): string | null {
  if (candidate?.kind === 'video') return `https://www.youtube.com/watch?v=${candidate.videoId}`;
  if (candidate?.kind === 'channel') return `https://www.youtube.com/channel/${candidate.channelId}/live`;
  return null;
}
