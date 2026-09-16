#!/usr/bin/env node
// Checks whether live-video entries (YouTube videos, channels, HLS streams) are live right now,
// using the classifier the dashboard uses (src/services/live-video/model.ts).
// Run with: npm run live-video:check -- <entry> [name=<entry> ...]

import { isMainModule } from './lib/main-module.mjs';
import { AUDIT_CANARIES, LIVE_NEWS_SOURCES, WEBCAM_SOURCES } from '../src/config/live-video-sources.ts';
import { classifyAttempt, LIVE_VIDEO_TIMING, parseSourceEntry } from '../src/services/live-video/model.ts';

const PROBE_ORIGIN = 'https://www.worldmonitor.app';
const PROBE_URL = `${PROBE_ORIGIN}/__live_video_probe__`;
const BATCH_SIZE = 8;
const MAX_POLLS = Math.ceil((2 * LIVE_VIDEO_TIMING.verdictDeadlineMs) / LIVE_VIDEO_TIMING.pollMs);
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const INDENT = ' '.repeat(12);
const CATALOG_FILE = 'src/config/live-video-sources.ts';
const DEFAULT_CATALOG = { webcams: WEBCAM_SOURCES, news: LIVE_NEWS_SOURCES, canaries: AUDIT_CANARIES };

const USAGE = `Usage: npm run live-video:check -- <entry> [<entry> ...]
       npm run live-video:check -- --slot webcams/<id>
       npm run live-video:check -- --slot live-news/<id>
       npm run live-video:check -- --all

Checks whether each entry is live right now, with the classifier the dashboard uses.
An entry is a YouTube video ID, any YouTube watch/live/embed/youtu.be URL, a
youtube.com/channel/UC... URL (plays whatever that channel has live), or an https .m3u8 URL.
Label an entry with name=, e.g. kyiv=https://www.youtube.com/watch?v=e2gC37ILQmk

--slot checks every entry of one slot in ${CATALOG_FILE}.
--all checks every slot and the audit canaries, and lists slots with no entries.

YouTube entries play in headless Chromium as if embedded on ${PROBE_ORIGIN}, so a LIVE
verdict covers the web dashboard only; the desktop sidecar embed (http://localhost:<port>)
is not probed here. HLS entries are fetched from this machine; their playback is not checked.
Exits 1 when any entry is not live or a slot is empty.`;

const PROBLEM_WHY = {
  'not-https': 'the manifest must be an https URL',
  'youtube-manifest': 'YouTube manifests only play inside the official player; paste the watch URL instead',
  'needs-channel-url': 'paste the channel URL (youtube.com/channel/UC...) or a live video URL; handles cannot be resolved without scraping',
  unrecognized: 'not a YouTube video or channel URL, a video ID, or an https .m3u8 URL',
};

const PLAYER_ERROR_WHY = {
  2: 'the player rejected the request',
  5: 'the HTML5 player failed',
  100: 'the video was not found, was removed, or is private',
  101: 'the owner does not allow embedding, or the video is unavailable here',
  150: 'the owner does not allow embedding, or the video is unavailable here',
  152: 'the player refused this embedding',
  153: 'the player refused this embedding (missing referrer)',
};

export function parseCheckArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h')) return { mode: 'help' };
  if (argv.length === 1 && argv[0] === '--all') return { mode: 'all' };
  if (argv[0] === '--slot') {
    if (argv.length !== 2 || argv[1].startsWith('--')) throw new Error(`--slot needs a slot, e.g. --slot webcams/kyiv\n\n${USAGE}`);
    return { mode: 'slot', slot: argv[1] };
  }
  const option = argv.find((arg) => arg.startsWith('--') && !/^[A-Za-z0-9_-]{11}$/.test(arg));
  if (option) throw new Error(`Unknown option ${option}\n\n${USAGE}`);
  if (!argv.length) throw new Error(USAGE);
  return {
    mode: 'entries',
    entries: argv.map((arg) => {
      const labelled = /^([A-Za-z0-9_.-]+)=(.+)$/.exec(arg);
      return labelled ? { name: labelled[1], entry: labelled[2] } : { name: null, entry: arg };
    }),
  };
}

function canonicalEntry(candidate) {
  if (candidate.kind === 'video') return `https://www.youtube.com/watch?v=${candidate.videoId}`;
  if (candidate.kind === 'channel') return `https://www.youtube.com/channel/${candidate.channelId}`;
  return candidate.url;
}

function formatSeconds(seconds) {
  return `${Math.round(seconds).toLocaleString('en-US')} s`;
}

function verdictLabel(result) {
  if (!result.parsed.ok) return 'INVALID';
  return { live: 'LIVE', recording: 'RECORDING', failed: 'FAILED', unverifiable: 'UNVERIFIED' }[result.verdict.verdict];
}

function why(result) {
  if (!result.parsed.ok) return PROBLEM_WHY[result.parsed.problem];
  const { verdict } = result;
  const isHls = result.parsed.candidate.kind === 'hls';
  switch (verdict.verdict) {
    case 'live':
      return isHls ? 'HLS playlist is live (it advanced between reloads)' : 'YouTube reports a live stream (isLive=true) and it is playing';
    case 'recording':
      if (isHls) return 'HLS playlist has ended (VOD or ENDLIST)';
      return `ended recording (isLive=false, duration ${formatSeconds(result.durationSeconds ?? 0)})`;
    case 'failed': {
      const { outcome } = verdict;
      if (outcome.kind === 'player-error') {
        return `YouTube player error ${outcome.code}: ${PLAYER_ERROR_WHY[outcome.code] ?? 'unknown error'}`;
      }
      if (outcome.kind === 'channel-not-live') return 'the channel has no live stream right now';
      if (outcome.kind === 'not-started') {
        const within = `${LIVE_VIDEO_TIMING.verdictDeadlineMs / 1000} s`;
        return isHls ? `HLS playlist is live but did not play within ${within}` : `scheduled or not started: YouTube lists it as live but it did not play within ${within}`;
      }
      if (outcome.kind === 'timeout') return `no verdict within ${LIVE_VIDEO_TIMING.verdictDeadlineMs / 1000} s`;
      if (outcome.kind === 'hls-http') return `manifest returned HTTP ${outcome.status}`;
      return `stream failed: ${outcome.detail}`;
    }
    case 'unverifiable':
      if (verdict.reason === 'player-api-blocked') return 'the YouTube IFrame API did not load';
      if (verdict.reason === 'live-signal-missing') return 'the player no longer reports whether a video is live (isLive missing)';
      return 'the player frame loaded but never became ready';
  }
  return 'unknown verdict';
}

/** One block per entry: verdict, what was checked, title/author, why, and the line to paste when live. */
export function formatCheckLine(result) {
  const video = result.verdict?.video ?? null;
  let subject = result.parsed.ok ? canonicalEntry(result.parsed.candidate) : result.parsed.entry;
  if (result.parsed.ok && result.parsed.candidate.kind === 'channel' && video?.videoId) subject += ` → ${video.videoId}`;
  const byline = [video?.title && `"${video.title}"`, video?.author && `by ${video.author}`].filter(Boolean).join(' ') || null;
  const head = [verdictLabel(result).padEnd(10), result.name, subject, byline].filter(Boolean).join('  ');
  const lines = [head, `${INDENT}why: ${why(result)}`];
  if (result.parsed.ok && result.verdict.verdict === 'live') lines.push(`${INDENT}paste: '${canonicalEntry(result.parsed.candidate)}'`);
  return lines.join('\n');
}

export function exitCodeFor(results) {
  return results.length > 0 && results.every((result) => result.parsed.ok && result.verdict?.verdict === 'live') ? 0 : 1;
}

/** Page records carry raw player readings; this turns one into the classifier's observation. */
export function observationFromRecord(record) {
  if (record.apiBlocked) return { transport: 'youtube', api: 'blocked' };
  const video = record.video
    ? {
        videoId: String(record.video.videoId ?? ''),
        isLive: typeof record.video.isLive === 'boolean' ? record.video.isLive : undefined,
        title: String(record.video.title ?? ''),
        author: String(record.video.author ?? ''),
      }
    : null;
  return {
    transport: 'youtube',
    api: 'loaded',
    candidate: record.kind,
    elapsedMs: record.elapsedMs,
    frameLoaded: record.frameLoaded,
    readyAtMs: record.readyAtMs ?? null,
    errorCode: record.errorCode ?? null,
    video,
    durations: record.durations ?? [],
  };
}

/** The verdict for a candidate no probe ever settled: a stalled poll, or a batch that threw. */
function timedOutResult() {
  return { verdict: { verdict: 'failed', outcome: { kind: 'timeout' } }, durationSeconds: null, verdictAtMs: null };
}

/** Mounts every candidate on one page, then polls until each has a settled verdict. */
export async function probeYouTubeCandidates(candidates, { page, sleep }) {
  await page.mount(candidates.map((candidate) => (candidate.kind === 'video'
    ? { kind: 'video', id: candidate.videoId }
    : { kind: 'channel', id: candidate.channelId })));
  const results = candidates.map(() => null);
  for (let poll = 1; ; poll++) {
    const records = await page.read();
    records.forEach((record, index) => {
      if (results[index]) return;
      const verdict = classifyAttempt(observationFromRecord(record));
      if (verdict.verdict === 'pending') return;
      results[index] = { verdict, durationSeconds: record.durations?.at(-1)?.seconds ?? null, verdictAtMs: record.elapsedMs ?? null };
    });
    if (results.every(Boolean)) return results;
    if (poll >= MAX_POLLS) {
      return results.map((result) => result ?? timedOutResult());
    }
    await sleep(LIVE_VIDEO_TIMING.pollMs);
  }
}

// Runs inside the probe page. Each record is read back by probeYouTubeCandidates.
const PROBE_SCRIPT = `
const ORIGIN = ${JSON.stringify(PROBE_ORIGIN)};
const pageStart = performance.now();
const entries = [];
let api = 'loading';
window.onYouTubeIframeAPIReady = () => { api = 'ready'; mountQueued(); };
const script = document.createElement('script');
script.src = 'https://www.youtube.com/iframe_api';
script.onerror = () => { api = 'blocked'; };
document.head.appendChild(script);

function embedSrc(item) {
  const params = new URLSearchParams({ enablejsapi: '1', autoplay: '1', mute: '1', playsinline: '1', rel: '0', origin: ORIGIN, widget_referrer: ORIGIN });
  if (item.kind === 'channel') {
    params.set('channel', item.id);
    return 'https://www.youtube.com/embed/live_stream?' + params;
  }
  return 'https://www.youtube.com/embed/' + encodeURIComponent(item.id) + '?' + params;
}

function mount(entry) {
  const rec = { startedAt: performance.now(), frameLoaded: false, readyAtMs: null, errorCode: null, video: null, durations: [], player: null };
  const at = () => performance.now() - rec.startedAt;
  const snap = () => {
    try {
      const data = rec.player.getVideoData();
      rec.video = { videoId: data.video_id || '', isLive: data.isLive, title: data.title || '', author: data.author || '' };
    } catch {}
  };
  const iframe = document.createElement('iframe');
  iframe.width = '320';
  iframe.height = '180';
  iframe.allow = 'autoplay; encrypted-media; picture-in-picture';
  iframe.addEventListener('load', () => { rec.frameLoaded = true; });
  iframe.src = embedSrc(entry.item);
  document.body.appendChild(iframe);
  rec.player = new YT.Player(iframe, {
    events: {
      onReady: () => { rec.readyAtMs = at(); snap(); },
      onStateChange: () => snap(),
      onError: (event) => { rec.errorCode = event.data; },
    },
  });
  setInterval(() => {
    if (rec.readyAtMs === null) return;
    snap();
    try {
      if (rec.player.getPlayerState() === 1) {
        rec.durations.push({ atMs: at(), seconds: rec.player.getDuration() });
        if (rec.durations.length > 30) rec.durations.shift();
      }
    } catch {}
  }, 1000);
  entry.rec = rec;
  entry.at = at;
}

function mountQueued() {
  if (api !== 'ready') return;
  for (const entry of entries) if (!entry.rec) mount(entry);
}

window.__liveVideoProbe = {
  mount(items) {
    for (const item of items) entries.push({ item, rec: null });
    mountQueued();
  },
  read() {
    return entries.map(({ item, rec, at }) => {
      if (api === 'blocked') return { kind: item.kind, apiBlocked: true };
      if (!rec) {
        return { kind: item.kind, apiBlocked: false, mounted: false, elapsedMs: performance.now() - pageStart, frameLoaded: false, readyAtMs: null, errorCode: null, video: null, durations: [] };
      }
      return { kind: item.kind, apiBlocked: false, mounted: true, elapsedMs: at(), frameLoaded: rec.frameLoaded, readyAtMs: rec.readyAtMs, errorCode: rec.errorCode, video: rec.video, durations: rec.durations };
    });
  },
};
`;

async function openProbePage(browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  // Served under the production origin: embedding permission can depend on the embedding site.
  await page.route(PROBE_URL, (route) => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: `<!doctype html><html><body><script>${PROBE_SCRIPT}</script></body></html>`,
  }));
  await page.goto(PROBE_URL, { waitUntil: 'domcontentloaded' });
  return {
    mount: (items) => page.evaluate((batch) => window.__liveVideoProbe.mount(batch), items),
    read: () => page.evaluate(() => window.__liveVideoProbe.read()),
    close: () => context.close(),
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One page per batch, in order. A batch that cannot open or probe fails only its own entries:
 * a crashed page must not discard the batches already classified or the ones still to come.
 */
export async function probeYouTubeBatches(candidates, {
  openPage,
  probeBatch = probeYouTubeCandidates,
  onError = (message) => console.error(message),
} = {}) {
  const results = [];
  for (let start = 0; start < candidates.length; start += BATCH_SIZE) {
    const batch = candidates.slice(start, start + BATCH_SIZE);
    let probed = null;
    try {
      const page = await openPage();
      try {
        probed = await probeBatch(batch, { page, sleep });
      } finally {
        await page.close();
      }
    } catch (error) {
      onError(`live-video: batch ${start / BATCH_SIZE + 1} failed: ${error?.message ?? error}`);
    }
    results.push(...(probed ?? batch.map(() => timedOutResult())));
  }
  return results;
}

async function probeYouTubeWithBrowser(candidates) {
  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  try {
    return await probeYouTubeBatches(candidates, { openPage: () => openProbePage(browser) });
  } finally {
    await browser.close();
  }
}

const HLS_DEFAULT_TARGET_SECONDS = 6;
const HLS_MAX_RELOAD_WAIT_SECONDS = 10;

function playlistLines(text) {
  return text.trimStart().split(/\r?\n/).map((line) => line.trim());
}

/** Value of the first line that is exactly `tag` plus a value in `format`; tags match whole lines, never substrings. */
function tagValue(lines, tag, format) {
  const value = lines.find((line) => line.startsWith(tag))?.slice(tag.length);
  return value !== undefined && format.test(value) ? value : null;
}

/**
 * One fetch of a media playlist. ENDLIST or PLAYLIST-TYPE:VOD has ended. Anything else with segments is
 * only a live candidate: a frozen or ended-without-ENDLIST playlist looks the same, PROGRAM-DATE-TIME
 * included, until a reload shows whether it advanced.
 */
function readHlsPlaylist(text) {
  const lines = playlistLines(text);
  if (lines[0] !== '#EXTM3U') return { kind: 'invalid', detail: 'not an HLS playlist (no #EXTM3U header)' };
  if (lines.some((line) => line.startsWith('#EXT-X-STREAM-INF:'))) return { kind: 'invalid', detail: 'master playlist lists no variant URI' };
  if (lines.includes('#EXT-X-ENDLIST') || lines.includes('#EXT-X-PLAYLIST-TYPE:VOD')) return { kind: 'ended' };
  const segmentCount = lines.filter((line) => line.startsWith('#EXTINF:')).length;
  if (!segmentCount) return { kind: 'invalid', detail: 'media playlist has no segments' };
  return {
    kind: 'live-candidate',
    mediaSequence: Number(tagValue(lines, '#EXT-X-MEDIA-SEQUENCE:', /^\d+$/) ?? 0),
    targetSeconds: Number(tagValue(lines, '#EXT-X-TARGETDURATION:', /^\d+(?:\.\d+)?$/) ?? HLS_DEFAULT_TARGET_SECONDS),
    segmentCount,
    // Token-signing CDNs rewrite the query on every request, so only the path marks a new segment.
    lastSegment: lines.findLast((line) => line && !line.startsWith('#'))?.split(/[?#]/, 1)[0],
  };
}

/** A live playlist slides forward (EXT-X-MEDIA-SEQUENCE, last segment) or grows (EVENT) between reloads. */
function playlistAdvanced(before, after) {
  return after.mediaSequence > before.mediaSequence
    || after.lastSegment !== before.lastSegment
    || after.segmentCount > before.segmentCount;
}

function firstVariantUri(text) {
  const lines = playlistLines(text);
  const streamInf = lines.findIndex((line) => line.startsWith('#EXT-X-STREAM-INF:'));
  if (streamInf < 0) return null;
  return lines.slice(streamInf + 1).find((line) => line && !line.startsWith('#')) ?? null;
}

const HLS_NOT_HTTPS = 'the manifest must be an https URL';
const HLS_MAX_REDIRECTS = 5;
const defaultFetch = (...args) => globalThis.fetch(...args);

/** Same https gate as `parseSourceEntry`, applied to every resolved variant and redirect hop. */
function httpsHref(raw, base) {
  try {
    const parsed = new URL(raw, base);
    return parsed.protocol === 'https:' ? parsed.href : null;
  } catch {
    return null;
  }
}

/** Resolves after `ms`, or rejects with the signal's reason (the probe's TimeoutError) when it aborts first. */
function abortableDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export async function probeHlsCandidate(candidate, { fetch: fetchPlaylist = defaultFetch, delay = abortableDelay, now = Date.now } = {}) {
  const startedAt = now();
  // Node cannot play media: the manifest is the only evidence. A live verdict
  // still requires the playlist to advance (see the reload below).
  const observe = (fields) => classifyAttempt({ transport: 'hls', elapsedMs: now() - startedAt, manifest: 'unknown', progress: 'unchecked', failure: null, ...fields });
  const fatal = (detail) => ({ verdict: observe({ failure: { kind: 'fatal', detail } }) });
  const settle = (playlist) => (playlist.kind === 'ended' ? { verdict: observe({ manifest: 'vod' }) } : fatal(playlist.detail));
  const signal = AbortSignal.timeout(LIVE_VIDEO_TIMING.verdictDeadlineMs);
  const get = async (url) => {
    let current = url;
    for (let hop = 0; hop < HLS_MAX_REDIRECTS; hop++) {
      const httpsUrl = httpsHref(current);
      if (!httpsUrl) return { error: HLS_NOT_HTTPS };
      const response = await fetchPlaylist(httpsUrl, {
        signal,
        headers: { 'user-agent': BROWSER_UA },
        redirect: 'manual',
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers?.get?.('location');
        if (!location) return { error: 'redirect missing Location' };
        const next = httpsHref(location, response.url || httpsUrl);
        if (!next) return { error: HLS_NOT_HTTPS };
        current = next;
        continue;
      }
      if (response.url && !httpsHref(response.url)) return { error: HLS_NOT_HTTPS };
      return { response };
    }
    return { error: 'too many redirects' };
  };
  try {
    let url = candidate.url;
    for (let depth = 0; depth < 3; depth++) {
      const fetched = await get(url);
      if (fetched.error) return fatal(fetched.error);
      const response = fetched.response;
      if (!response.ok) return { verdict: observe({ failure: { kind: 'http', status: response.status } }) };
      const text = await response.text();
      const variant = firstVariantUri(text);
      if (variant) {
        const next = httpsHref(variant, response.url || url);
        if (!next) return fatal(HLS_NOT_HTTPS);
        url = next;
        continue;
      }
      const before = readHlsPlaylist(text);
      if (before.kind !== 'live-candidate') return settle(before);
      // Reload after one target duration, never past the probe deadline, and require progress.
      const targetMs = Math.min(Math.max(before.targetSeconds, 1), HLS_MAX_RELOAD_WAIT_SECONDS) * 1000;
      const timeLeftMs = () => LIVE_VIDEO_TIMING.verdictDeadlineMs - (now() - startedAt);
      const firstWaitMs = Math.max(0, Math.min(targetMs, timeLeftMs()));
      let waitedMs = 0;
      let reloads = 0;
      // RFC 8216 6.3.4: one unchanged reload is normal — a CDN edge can still hold the previous
      // copy — so look again after half a target duration before calling the playlist frozen.
      for (let attempt = 0; attempt < 2; attempt++) {
        const waitMs = attempt === 0 ? firstWaitMs : targetMs / 2;
        if (attempt > 0 && timeLeftMs() < waitMs) break;
        await delay(waitMs, signal);
        waitedMs += waitMs;
        reloads++;
        const reloadFetched = await get(response.url || url);
        if (reloadFetched.error) return fatal(reloadFetched.error);
        const reload = reloadFetched.response;
        if (!reload.ok) return { verdict: observe({ failure: { kind: 'http', status: reload.status } }) };
        const after = readHlsPlaylist(await reload.text());
        if (after.kind !== 'live-candidate') return settle(after);
        if (playlistAdvanced(before, after)) return { verdict: observe({ manifest: 'live' }) };
      }
      // The deadline clipped the only wait below one segment, so "frozen" is not a safe read.
      if (reloads < 2 && firstWaitMs < targetMs) return { verdict: observe({ elapsedMs: LIVE_VIDEO_TIMING.verdictDeadlineMs }) };
      return fatal(`media playlist did not advance in ${formatSeconds(waitedMs / 1000)}`);
    }
    return fatal('too many nested playlists');
  } catch (error) {
    if (error?.name === 'TimeoutError') return { verdict: observe({ elapsedMs: LIVE_VIDEO_TIMING.verdictDeadlineMs }) };
    return fatal(error?.cause?.code ?? error?.message ?? String(error));
  }
}

export async function probeHlsCandidates(candidates, fetchImpl = defaultFetch) {
  return Promise.all(candidates.map((candidate) => probeHlsCandidate(candidate, { fetch: fetchImpl })));
}

/** The entries a catalog mode checks, named by slot (a second entry is `slot#2`), plus the slots with no entries. */
export function catalogTargets(target, catalog = DEFAULT_CATALOG) {
  const slots = [
    ...Object.entries(catalog.webcams).map(([id, entries]) => [`webcams/${id}`, entries]),
    ...Object.entries(catalog.news ?? {}).map(([id, entries]) => [`live-news/${id}`, entries]),
  ];
  const selected = target.mode === 'all' ? slots : slots.filter(([slot]) => slot === target.slot);
  if (target.mode === 'slot' && selected.length === 0) {
    throw new Error(`Unknown slot ${target.slot}. Slots: ${slots.map(([slot]) => slot).join(', ')}`);
  }
  const entries = selected.flatMap(([slot, list]) => list.map((entry, index) => ({ name: index === 0 ? slot : `${slot}#${index + 1}`, entry })));
  if (target.mode === 'all') entries.push(...catalog.canaries.map((entry, index) => ({ name: `canary/${index + 1}`, entry })));
  const empty = selected.filter(([, list]) => list.length === 0).map(([slot]) => slot);
  return { entries, empty };
}

function formatEmptySlot(slot) {
  return ['EMPTY'.padEnd(10), slot, `no entries: paste a live stream URL into ${CATALOG_FILE}`].join('  ');
}

export async function runCheck(argv, options = {}) {
  const {
    write = console.log,
    probeYouTube = probeYouTubeWithBrowser,
    fetchImpl = defaultFetch,
    catalog = DEFAULT_CATALOG,
  } = options;
  const probeHls = options.probeHls ?? ((candidates) => probeHlsCandidates(candidates, fetchImpl));
  let args;
  let targets;
  try {
    args = parseCheckArgs(argv);
    if (args.mode !== 'help') targets = args.mode === 'entries' ? { entries: args.entries, empty: [] } : catalogTargets(args, catalog);
  } catch (error) {
    write(error.message);
    return 2;
  }
  if (args.mode === 'help') {
    write(USAGE);
    return 0;
  }

  const rows = targets.entries.map(({ name, entry }) => ({ name, parsed: parseSourceEntry(entry) }));
  const youtubeRows = rows.filter((row) => row.parsed.ok && row.parsed.candidate.kind !== 'hls');
  const hlsRows = rows.filter((row) => row.parsed.ok && row.parsed.candidate.kind === 'hls');
  if (youtubeRows.length) {
    const probed = await probeYouTube(youtubeRows.map((row) => row.parsed.candidate));
    youtubeRows.forEach((row, index) => Object.assign(row, probed[index]));
  }
  if (hlsRows.length) {
    const probed = await probeHls(hlsRows.map((row) => row.parsed.candidate));
    hlsRows.forEach((row, index) => Object.assign(row, probed[index]));
  }

  for (const slot of targets.empty) write(formatEmptySlot(slot));
  for (const row of rows) write(formatCheckLine(row));
  const notLive = rows.filter((row) => !(row.parsed.ok && row.verdict?.verdict === 'live')).length;
  if (rows.length > 0) write(notLive ? `${notLive} of ${rows.length} entries are not live.` : `All ${rows.length} entries are live.`);
  if (targets.empty.length > 0) write(`${targets.empty.length} slot(s) have no entries.`);
  return targets.empty.length > 0 ? 1 : exitCodeFor(rows);
}

if (isMainModule(import.meta.url, process.argv[1])) {
  try {
    process.exitCode = await runCheck(process.argv.slice(2));
  } catch (error) {
    console.error(error?.stack ?? error);
    process.exitCode = 1;
  }
}
