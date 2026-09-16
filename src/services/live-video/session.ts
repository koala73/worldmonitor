// One playback of a live video source. Tries each entry through the official player, keeps only
// what is verified live, and tells the panel what to show. Panels render words from LiveVideoState;
// they never see YT.Player, hls.js, player error codes or sidecar bridge messages.

import { getStreamQuality } from '@/services/ai-flow-settings';
import { track } from '@/services/analytics';
import { isAllowedWebcamEmbedMessageOrigin } from '@/services/live-video/embed-message-origin';
import { getLocalApiPort, isDesktopRuntime } from '@/services/runtime';

import {
  advanceChain,
  classifyAttempt,
  failureKey,
  LIVE_VIDEO_TIMING,
  parseSource,
  startChain,
  watchUrlFor,
  youtubeEmbedSrc,
  type Candidate,
  type ChainEvent,
  type ChainState,
  type ChainStep,
  type DurationSample,
  type LiveVideoSource,
  type OfflineReason,
  type ParsedSource,
  type PlayerObservation,
  type SettledVerdict,
  type UnverifiableReason,
  type YouTubeVideoSnapshot,
} from './model';
import { loadYouTubeIframeApi, type YouTubePlayerLike } from './youtube-iframe-api';

export type LiveVideoState =
  | { readonly phase: 'connecting'; readonly attempt: number; readonly of: number }
  | { readonly phase: 'live'; readonly via: Candidate['kind']; readonly title: string | null; readonly author: string | null; readonly watchUrl: string | null }
  | { readonly phase: 'recording'; readonly title: string | null; readonly watchUrl: string | null }
  | { readonly phase: 'unverified'; readonly reason: UnverifiableReason; readonly watchUrl: string | null }
  | { readonly phase: 'offline'; readonly reason: OfflineReason; readonly watchUrl: string | null };

export interface LiveVideoPresentation {
  /** iframe/video title, e.g. 'Taipei live webcam'. */
  readonly title: string;
  readonly className: string;
  readonly controls: boolean;
}

export interface LiveVideoOptions {
  readonly source: LiveVideoSource;
  readonly autoplay: boolean;
  readonly muted: boolean;
  readonly presentation: LiveVideoPresentation;
  /** Called synchronously from openLiveVideo with the first state, then on every change. */
  readonly onState: (state: LiveVideoState) => void;
  readonly onMutedChange?: (muted: boolean) => void;
  /** The viewer paused or resumed from the player's own controls. */
  readonly onPlayingChange?: (playing: boolean) => void;
}

export interface LiveVideoSession {
  setMuted(muted: boolean): void;
  setPaused(paused: boolean): void;
  /** Forgets this source's recent failures and tries again. Ignored while connecting. */
  retry(): void;
  /** Tears down the player, listeners and timers. Idempotent; no callback fires afterwards. */
  destroy(): void;
}

/** A panel's memory of which of its sources went offline lately, so it passes over them meanwhile. */
export interface FailureMemory {
  isKnownOffline(id: string): boolean;
  markOffline(id: string): void;
  clear(id: string): void;
}

export function createFailureMemory(): FailureMemory {
  const offlineAt = new Map<string, number>();
  return {
    isKnownOffline(id) {
      const at = offlineAt.get(id);
      return at !== undefined && Date.now() - at < LIVE_VIDEO_TIMING.failureMemoryMs;
    },
    markOffline(id) {
      offlineAt.set(id, Date.now());
    },
    clear(id) {
      offlineAt.delete(id);
    },
  };
}

interface Transport {
  observe(): PlayerObservation;
  setMuted(muted: boolean): void;
  setPaused(paused: boolean): void;
  destroy(): void;
}

interface TransportContext {
  readonly presentation: LiveVideoPresentation;
  readonly autoplay: boolean;
  readonly muted: boolean;
  elapsedMs(): number;
  onLiveLost(): void;
  onPlayingChange(playing: boolean): void;
  onMutedChange(muted: boolean): void;
}

type YouTubeCandidate = Extract<Candidate, { kind: 'video' | 'channel' }>;
type HlsFailure = Extract<PlayerObservation, { transport: 'hls' }>['failure'];

const ENDED = 0;
const PLAYING = 1;
const PAUSED = 2;
const MAX_DURATION_SAMPLES = 30;
/** How often the web player's mute state is read: the IFrame API has no mute event. */
const MUTE_SYNC_MS = 500;
/** Media time an HLS stream must play before it counts as live: a playlist can say live over a black 0:00 frame. */
const HLS_PLAYED_SECONDS = 1;
/** How far the media clock may outrun the wall clock between polls before the jump counts as a seek. */
const HLS_SEEK_SLACK_SECONDS = 0.25;

// Page-wide, so a feed that just failed in one tile is tried last in the next.
const recentFailures = new Map<string, number>();
let signalMissingReported = false;

function recentFailureKeys(slot: string, nowMs: number): Set<string> {
  const keys = new Set<string>();
  for (const [key, failedAtMs] of recentFailures) {
    if (nowMs - failedAtMs >= LIVE_VIDEO_TIMING.failureMemoryMs) recentFailures.delete(key);
    else if (key.startsWith(`${slot}|`)) keys.add(key);
  }
  return keys;
}

function forgetFailures(slot: string): void {
  for (const key of recentFailures.keys()) {
    if (key.startsWith(`${slot}|`)) recentFailures.delete(key);
  }
}

function streamQuality(): string | null {
  const quality = getStreamQuality();
  return quality === 'auto' ? null : quality;
}

function pushDuration(durations: DurationSample[], sample: DurationSample): void {
  durations.push(sample);
  if (durations.length > MAX_DURATION_SAMPLES) durations.shift();
}

function createFrame(presentation: LiveVideoPresentation, src: string): HTMLIFrameElement {
  const iframe = document.createElement('iframe');
  iframe.className = presentation.className;
  iframe.title = presentation.title;
  iframe.allow = 'autoplay; encrypted-media; picture-in-picture; storage-access';
  iframe.referrerPolicy = 'strict-origin-when-cross-origin';
  if (!isDesktopRuntime()) {
    iframe.allowFullscreen = true;
    iframe.setAttribute('loading', 'lazy');
  }
  iframe.src = src;
  return iframe;
}

/** Web: an embed iframe the official IFrame API attaches to, which reads isLive, duration, errors and mute. */
function mountYouTubeWeb(container: HTMLElement, candidate: YouTubeCandidate, context: TransportContext): Transport {
  const iframe = createFrame(context.presentation, youtubeEmbedSrc(candidate, {
    origin: window.location.origin,
    autoplay: context.autoplay,
    muted: context.muted,
    controls: context.presentation.controls,
    quality: streamQuality(),
  }));
  let player: YouTubePlayerLike | null = null;
  let apiBlocked = false;
  let destroyed = false;
  let frameLoaded = false;
  let readyAtMs: number | null = null;
  let errorCode: number | null = null;
  let video: YouTubeVideoSnapshot | null = null;
  const durations: DurationSample[] = [];
  let reportedMuted = context.muted;
  let desiredMuted = context.muted;
  let muteSyncTimer: ReturnType<typeof setInterval> | null = null;

  // A toggle can arrive before the IFrame API attaches, so onReady replays the last value asked for.
  const applyMuted = () => {
    try {
      if (desiredMuted) player?.mute();
      else player?.unMute();
    } catch { /* the embed URL already carries the initial mute */ }
  };

  // The session stops polling once a stream is live, but a viewer can unmute from YouTube's own
  // control bar at any time, so the transport reads the player for as long as it is mounted.
  const syncMuted = () => {
    if (destroyed || !player) return;
    let muted: boolean;
    try {
      muted = player.isMuted();
    } catch {
      return;
    }
    if (muted === reportedMuted) return;
    reportedMuted = muted;
    context.onMutedChange(muted);
  };

  // The IFrame API renames the frame after the video it loads; the tile keeps its own title.
  const keepTitle = () => {
    if (iframe.title !== context.presentation.title) iframe.title = context.presentation.title;
  };

  const readVideo = () => {
    if (!player) return;
    try {
      const data = player.getVideoData();
      video = {
        videoId: data.video_id ?? '',
        isLive: typeof data.isLive === 'boolean' ? data.isLive : undefined,
        title: data.title ?? '',
        author: data.author ?? '',
      };
    } catch { /* the player has no data before it is ready */ }
  };

  iframe.addEventListener('load', () => { frameLoaded = true; });
  container.appendChild(iframe);

  void loadYouTubeIframeApi().then((api) => {
    if (destroyed) return;
    if (!api) {
      apiBlocked = true;
      return;
    }
    try {
      player = new api.Player(iframe, {
        events: {
          onReady: () => {
            if (destroyed) return;
            readyAtMs = context.elapsedMs();
            keepTitle();
            readVideo();
            applyMuted();
            muteSyncTimer ??= setInterval(syncMuted, MUTE_SYNC_MS);
          },
          onStateChange: ({ data }) => {
            if (destroyed) return;
            keepTitle();
            if (data === PLAYING) context.onPlayingChange(true);
            else if (data === PAUSED) context.onPlayingChange(false);
            else if (data === ENDED) context.onLiveLost();
          },
          onError: ({ data }) => {
            if (destroyed) return;
            errorCode = data;
            context.onLiveLost();
          },
        },
      });
    } catch {
      apiBlocked = true;
    }
  });

  return {
    observe() {
      if (apiBlocked) return { transport: 'youtube', api: 'blocked' };
      if (player && readyAtMs !== null) {
        keepTitle();
        readVideo();
        try {
          if (player.getPlayerState() === PLAYING) pushDuration(durations, { atMs: context.elapsedMs(), seconds: player.getDuration() });
        } catch { /* keep the samples already taken */ }
      }
      return {
        transport: 'youtube',
        api: 'loaded',
        candidate: candidate.kind,
        elapsedMs: context.elapsedMs(),
        frameLoaded,
        readyAtMs,
        errorCode,
        video,
        durations: [...durations],
      };
    },
    setMuted(muted) {
      // Already known to the caller: never report it back.
      reportedMuted = muted;
      desiredMuted = muted;
      applyMuted();
    },
    setPaused(paused) {
      try {
        if (paused) player?.pauseVideo();
        else player?.playVideo();
      } catch { /* not ready yet */ }
    },
    destroy() {
      destroyed = true;
      if (muteSyncTimer !== null) clearInterval(muteSyncTimer);
      muteSyncTimer = null;
      try {
        player?.destroy();
      } catch { /* the frame is removed below either way */ }
      player = null;
      // Removing the frame discards its document, which stops playback.
      iframe.remove();
    },
  };
}

interface SidecarMessage {
  type?: unknown;
  state?: unknown;
  code?: unknown;
  muted?: unknown;
  videoId?: unknown;
  isLive?: unknown;
  title?: unknown;
  author?: unknown;
  duration?: unknown;
}

/**
 * Desktop: YouTube rejects the tauri:// parent origin (error 153), so the sidecar serves the player
 * from localhost and relays its signals. `probe` asks it for the current video data.
 */
function mountYouTubeSidecar(container: HTMLElement, candidate: YouTubeCandidate, context: TransportContext): Transport {
  const params = new URLSearchParams(candidate.kind === 'video' ? { videoId: candidate.videoId } : { channel: candidate.channelId });
  params.set('autoplay', context.autoplay ? '1' : '0');
  params.set('mute', context.muted ? '1' : '0');
  params.set('controls', context.presentation.controls ? '1' : '0');
  const quality = streamQuality();
  if (quality) params.set('vq', quality);
  params.set('parentOrigin', window.location.origin);
  const iframe = createFrame(context.presentation, `http://localhost:${getLocalApiPort()}/api/youtube-embed?${params.toString()}`);
  const sidecarOrigin = new URL(iframe.src).origin;
  let destroyed = false;
  let frameLoaded = false;
  let readyAtMs: number | null = null;
  let errorCode: number | null = null;
  let video: YouTubeVideoSnapshot | null = null;
  const durations: DurationSample[] = [];
  let reportedMuted = context.muted;

  const post = (type: string) => {
    try {
      iframe.contentWindow?.postMessage({ type }, sidecarOrigin);
    } catch { /* the frame is navigating away */ }
  };

  const onMessage = (event: MessageEvent) => {
    if (destroyed || event.source !== iframe.contentWindow || !isAllowedWebcamEmbedMessageOrigin(event.origin, iframe.src)) return;
    const message = event.data as SidecarMessage | null;
    if (!message || typeof message !== 'object') return;
    switch (message.type) {
      case 'yt-ready':
        if (readyAtMs === null) readyAtMs = context.elapsedMs();
        break;
      case 'yt-state':
        if (message.state === PLAYING) context.onPlayingChange(true);
        else if (message.state === PAUSED) context.onPlayingChange(false);
        else if (message.state === ENDED) context.onLiveLost();
        break;
      case 'yt-error':
        errorCode = typeof message.code === 'number' ? message.code : 5;
        context.onLiveLost();
        break;
      case 'yt-mute-state':
        // The sidecar's own mute sync echoes what setMuted posted: only a real change is news.
        if (typeof message.muted === 'boolean' && message.muted !== reportedMuted) {
          reportedMuted = message.muted;
          context.onMutedChange(message.muted);
        }
        break;
      case 'yt-video-data':
        video = {
          videoId: typeof message.videoId === 'string' ? message.videoId : '',
          isLive: typeof message.isLive === 'boolean' ? message.isLive : undefined,
          title: typeof message.title === 'string' ? message.title : '',
          author: typeof message.author === 'string' ? message.author : '',
        };
        if (message.state === PLAYING && typeof message.duration === 'number') {
          pushDuration(durations, { atMs: context.elapsedMs(), seconds: message.duration });
        }
        break;
    }
  };

  window.addEventListener('message', onMessage);
  iframe.addEventListener('load', () => { frameLoaded = true; });
  container.appendChild(iframe);

  return {
    observe() {
      if (readyAtMs !== null) post('probe');
      return {
        transport: 'youtube',
        api: 'loaded',
        candidate: candidate.kind,
        elapsedMs: context.elapsedMs(),
        frameLoaded,
        readyAtMs,
        errorCode,
        video,
        durations: [...durations],
      };
    },
    setMuted(muted) {
      // Already known to the caller: never report it back.
      reportedMuted = muted;
      post(muted ? 'mute' : 'unmute');
    },
    setPaused(paused) {
      post(paused ? 'pause' : 'play');
    },
    destroy() {
      destroyed = true;
      window.removeEventListener('message', onMessage);
      iframe.remove();
    },
  };
}

/** HLS: Safari and WKWebView play it natively; elsewhere hls.js loads on first use. */
function mountHls(container: HTMLElement, candidate: Extract<Candidate, { kind: 'hls' }>, context: TransportContext): Transport {
  const video = document.createElement('video');
  video.className = context.presentation.className;
  video.title = context.presentation.title;
  video.muted = context.muted;
  video.autoplay = context.autoplay;
  video.playsInline = true;
  video.controls = context.presentation.controls;
  video.setAttribute('referrerpolicy', 'no-referrer');
  let destroyed = false;
  let manifest: 'live' | 'vod' | 'unknown' = 'unknown';
  let failure: HlsFailure = null;
  let hls: import('hls.js').default | null = null;
  let playedSeconds = 0;
  let lastSample: { readonly atMs: number; readonly seconds: number } | null = null;
  let reportedMuted = context.muted;

  const fail = (next: NonNullable<HlsFailure>) => {
    if (destroyed || failure) return;
    failure = next;
    context.onLiveLost();
  };

  // Sums the media time that advanced between polls while playing. A jump faster than the wall
  // clock is a seek (hls.js moves a live stream to its edge before any frame renders), not playback.
  const readProgress = (): 'advancing' | 'stalled' => {
    if (playedSeconds >= HLS_PLAYED_SECONDS) return 'advancing';
    const sample = { atMs: context.elapsedMs(), seconds: video.currentTime };
    const previous = lastSample;
    lastSample = video.paused ? null : sample;
    if (previous && lastSample) {
      const step = sample.seconds - previous.seconds;
      if (step > 0 && step <= (sample.atMs - previous.atMs) / 1000 + HLS_SEEK_SLACK_SECONDS) playedSeconds += step;
    }
    return playedSeconds >= HLS_PLAYED_SECONDS ? 'advancing' : 'stalled';
  };

  video.addEventListener('loadedmetadata', () => {
    if (manifest !== 'unknown') return;
    if (video.duration === Infinity) manifest = 'live';
    else if (Number.isFinite(video.duration) && video.duration > 0) manifest = 'vod';
  });
  video.addEventListener('ended', () => { if (!destroyed) context.onLiveLost(); });
  video.addEventListener('error', () => fail({ kind: 'fatal', detail: 'media-error' }));
  video.addEventListener('play', () => { if (!destroyed) context.onPlayingChange(true); });
  video.addEventListener('pause', () => { if (!destroyed) context.onPlayingChange(false); });
  // Setting video.muted fires volumechange too, so only a change the caller does not already know is news.
  video.addEventListener('volumechange', () => {
    if (destroyed) return;
    const muted = video.muted || video.volume === 0;
    if (muted === reportedMuted) return;
    reportedMuted = muted;
    context.onMutedChange(muted);
  });
  container.appendChild(video);

  if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = candidate.url;
  } else {
    void import('hls.js').then(({ default: Hls }) => {
      if (destroyed) return;
      if (!Hls.isSupported()) {
        fail({ kind: 'fatal', detail: 'hls-unsupported' });
        return;
      }
      const instance = new Hls({ enableWorker: true, lowLatencyMode: true });
      hls = instance;
      instance.on(Hls.Events.LEVEL_LOADED, (_event, data) => { manifest = data.details.live ? 'live' : 'vod'; });
      instance.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal) return;
        const status = data.response?.code;
        fail(typeof status === 'number' && status >= 400 ? { kind: 'http', status } : { kind: 'fatal', detail: data.details });
      });
      instance.loadSource(candidate.url);
      instance.attachMedia(video);
    }, () => fail({ kind: 'fatal', detail: 'hls-load-failed' }));
  }
  if (context.autoplay) video.play()?.catch(() => {});

  return {
    observe: () => ({ transport: 'hls', elapsedMs: context.elapsedMs(), manifest, progress: readProgress(), failure }),
    setMuted(muted) {
      // Already known to the caller: never report it back.
      reportedMuted = muted;
      video.muted = muted;
    },
    setPaused(paused) {
      if (paused) video.pause();
      else video.play()?.catch(() => {});
    },
    destroy() {
      destroyed = true;
      hls?.destroy();
      hls = null;
      video.pause();
      video.removeAttribute('src');
      video.remove();
    },
  };
}

function viewState(state: ChainState, parsed: ParsedSource): LiveVideoState {
  switch (state.phase) {
    case 'connecting':
      return { phase: 'connecting', attempt: state.attempts.length + 1, of: parsed.candidates.length };
    case 'live': {
      const candidate = parsed.candidates[state.index]!.candidate;
      const watchUrl = state.video?.videoId ? `https://www.youtube.com/watch?v=${state.video.videoId}` : watchUrlFor(candidate);
      return { phase: 'live', via: candidate.kind, title: state.video?.title || null, author: state.video?.author || null, watchUrl };
    }
    case 'recording':
      return { phase: 'recording', title: state.video?.title || null, watchUrl: watchUrlFor(parsed.candidates[state.index]!.candidate) };
    case 'unverified':
      return { phase: 'unverified', reason: state.reason, watchUrl: watchUrlFor(parsed.candidates[state.index]!.candidate) };
    case 'offline': {
      const lastTried = state.attempts[state.attempts.length - 1]?.candidate ?? parsed.candidates[0]?.candidate ?? null;
      return { phase: 'offline', reason: state.reason, watchUrl: watchUrlFor(lastTried) };
    }
  }
}

function attemptOutcome(verdict: SettledVerdict): Record<string, string | number> {
  if (verdict.verdict === 'failed') {
    return verdict.outcome.kind === 'player-error'
      ? { outcome: 'player-error', code: verdict.outcome.code }
      : { outcome: verdict.outcome.kind };
  }
  return { outcome: verdict.verdict === 'unverifiable' ? verdict.reason : verdict.verdict };
}

/** Once per page: YouTube stopped exposing isLive, so no tile can be verified live. */
function reportSignalMissing(slot: string, verdict: SettledVerdict): void {
  if (signalMissingReported || verdict.verdict !== 'unverifiable' || verdict.reason !== 'live-signal-missing') return;
  signalMissingReported = true;
  track('live-video-signal-missing', { slot });
}

/**
 * Must only be called after play intent (click-to-play gate): the first mount loads the YouTube
 * IFrame API. Callbacks never fire after destroy().
 */
export function openLiveVideo(container: HTMLElement, options: LiveVideoOptions): LiveVideoSession {
  const parsed = parseSource(options.source);
  const { slot } = options.source;
  const first = startChain(parsed, recentFailureKeys(slot, Date.now()));
  let state: ChainState = first.state;
  let transport: Transport | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let destroyed = false;
  let muted = options.muted;
  let paused = !options.autoplay;

  const stopPolling = () => {
    if (pollTimer === null) return;
    clearInterval(pollTimer);
    pollTimer = null;
  };

  const unmount = () => {
    stopPolling();
    transport?.destroy();
    transport = null;
  };

  const apply = (step: ChainStep) => {
    state = step.state;
    if (step.effect.type === 'mount') mount(step.effect.index);
    else if (step.effect.type === 'unmount') unmount();
    else if (state.phase !== 'connecting') stopPolling();
    if (!destroyed) options.onState(viewState(state, parsed));
  };

  const dispatch = (event: ChainEvent) => {
    if (!destroyed) apply(advanceChain(state, event, parsed, Date.now()));
  };

  const poll = (index: number, candidate: Candidate) => {
    if (destroyed || !transport || state.phase !== 'connecting' || state.index !== index) return;
    const verdict = classifyAttempt(transport.observe());
    if (verdict.verdict === 'pending') return;
    reportSignalMissing(slot, verdict);
    const step = advanceChain(state, { type: 'verdict', verdict }, parsed, Date.now());
    if (verdict.verdict !== 'live' && step.state.phase !== 'recording' && step.state.phase !== 'unverified') {
      recentFailures.set(failureKey(slot, candidate), Date.now());
      track('live-video-attempt-failed', { slot, kind: candidate.kind, ...attemptOutcome(verdict) });
    }
    apply(step);
  };

  function mount(index: number): void {
    unmount();
    const { candidate } = parsed.candidates[index]!;
    const startedAt = Date.now();
    let mounted: Transport | null = null;
    const isCurrent = () => !destroyed && mounted !== null && transport === mounted;
    const context: TransportContext = {
      presentation: options.presentation,
      autoplay: !paused,
      muted,
      elapsedMs: () => Date.now() - startedAt,
      onLiveLost: () => { if (isCurrent()) dispatch({ type: 'live-lost' }); },
      onPlayingChange: (playing) => { if (isCurrent()) options.onPlayingChange?.(playing); },
      onMutedChange: (next) => {
        if (!isCurrent()) return;
        muted = next;
        options.onMutedChange?.(next);
      },
    };
    if (candidate.kind === 'hls') mounted = mountHls(container, candidate, context);
    else if (isDesktopRuntime()) mounted = mountYouTubeSidecar(container, candidate, context);
    else mounted = mountYouTubeWeb(container, candidate, context);
    transport = mounted;
    pollTimer = setInterval(() => poll(index, candidate), LIVE_VIDEO_TIMING.pollMs);
  }

  apply(first);

  return {
    setMuted(next) {
      muted = next;
      transport?.setMuted(next);
    },
    setPaused(next) {
      paused = next;
      transport?.setPaused(next);
    },
    retry() {
      if (destroyed || state.phase === 'connecting') return;
      forgetFailures(slot);
      dispatch({ type: 'retry' });
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      unmount();
    },
  };
}
