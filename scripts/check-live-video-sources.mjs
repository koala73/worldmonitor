#!/usr/bin/env node
// Checks whether live-video entries (YouTube videos, channels, HLS streams) are live right now,
// using the classifier the dashboard uses (src/services/live-video/model.ts).
// Run with: npm run live-video:check -- <entry> [name=<entry> ...]

import { writeFileSync } from 'node:fs';
import { readLiveVideoSurfaces } from './lib/live-video-surfaces.mjs';
import { isMainModule } from './lib/main-module.mjs';
import { AUDIT_CANARIES, LIVE_NEWS_SOURCES, WEBCAM_GRID_PRIORITY, WEBCAM_SOURCES } from '../src/config/live-video-sources.ts';
import { classifyAttempt, LIVE_VIDEO_TIMING, parseSourceEntry } from '../src/services/live-video/model.ts';

const PROBE_ORIGIN = 'https://www.worldmonitor.app';
const PROBE_URL = `${PROBE_ORIGIN}/__live_video_probe__`;
const BATCH_SIZE = 8;
const MAX_POLLS = Math.ceil((2 * LIVE_VIDEO_TIMING.verdictDeadlineMs) / LIVE_VIDEO_TIMING.pollMs);
/** A YouTube stall (never ready, no verdict, never started) counts as dead only after this many checks alone stall too. */
export const ALONE_RECHECKS = 2;
/** Total time the alone checks may take (about 10 at their 45 s worst case), so the audit workflow reaches its reporter inside the job timeout. */
export const ALONE_RECHECK_BUDGET_MS = 8 * 60_000;
/** The longest one alone check can take: a browser launch, the page and every poll. A check starts only if this still fits. */
const ALONE_CHECK_MAX_MS = MAX_POLLS * LIVE_VIDEO_TIMING.pollMs + 15_000;
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const INDENT = ' '.repeat(12);
const CATALOG_FILE = 'src/config/live-video-sources.ts';
export const DEFAULT_CATALOG = { webcams: WEBCAM_SOURCES, gridPriority: WEBCAM_GRID_PRIORITY, news: LIVE_NEWS_SOURCES, canaries: AUDIT_CANARIES };

const USAGE = `Usage: npm run live-video:check -- <entry> [<entry> ...]
       npm run live-video:check -- --slot webcams/<id>
       npm run live-video:check -- --slot live-news/<id>
       npm run live-video:check -- --all [--report <file>]

Checks whether each entry is live right now, with the classifier the dashboard uses.
An entry is a YouTube video ID, any YouTube watch/live/embed/youtu.be URL, a
youtube.com/channel/UC... URL (plays whatever that channel has live), or an https .m3u8 URL.
Label an entry with name=, e.g. kyiv=https://www.youtube.com/watch?v=e2gC37ILQmk

--slot checks every entry of one slot in ${CATALOG_FILE}.
--all checks every slot and the audit canaries, and lists slots with no entries. The canaries are
  checked first; while one plays, a YouTube player that stalls (never ready, no verdict, never started)
  is checked again on its own page, up to twice within ${ALONE_RECHECK_BUDGET_MS / 60_000} minutes, and counts as
  dead only when both checks stall.
--report also writes the --all result as JSON: where each slot shows, its status and every attempt.
  scripts/report-live-video-audit.mjs turns that file into the daily audit issue.

YouTube entries play in headless Chromium as if embedded on ${PROBE_ORIGIN}.
HLS entries are fetched from this machine; their playback is not checked. Exits 1 when any entry is not live or a slot is empty.`;

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
  const reportAt = argv.indexOf('--report');
  if (reportAt >= 0) {
    const file = argv[reportAt + 1];
    if (!file || file.startsWith('--')) throw new Error(`--report needs a file, e.g. --all --report audit.json\n\n${USAGE}`);
    const rest = argv.filter((_, index) => index !== reportAt && index !== reportAt + 1);
    if (rest.length !== 1 || rest[0] !== '--all') throw new Error(`--report needs --all\n\n${USAGE}`);
    return { mode: 'all', report: file };
  }
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

/** A YouTube stall that recurred in every alone check reads as its batched why, then where it recurred. */
function aloneSuffix(result) {
  return result.aloneChecks >= ALONE_RECHECKS ? ', in the batch or in two checks alone' : '';
}

function why(result) {
  if (!result.parsed.ok) return PROBLEM_WHY[result.parsed.problem];
  if (result.recheckSkipped) {
    return result.aloneChecks > 0 ? 'checked alone once, second check skipped: audit time budget used up' : 'not re-checked: audit time budget used up';
  }
  const { verdict } = result;
  const isHls = result.parsed.candidate.kind === 'hls';
  switch (verdict.verdict) {
    case 'live':
      return isHls ? 'HLS playlist is live (playback not checked outside a browser)' : 'YouTube reports a live stream (isLive=true) and it is playing';
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
        return isHls ? `HLS playlist is live but did not play within ${within}` : `scheduled or not started: YouTube lists it as live but it did not play within ${within}${aloneSuffix(result)}`;
      }
      if (outcome.kind === 'timeout') return `no verdict within ${LIVE_VIDEO_TIMING.verdictDeadlineMs / 1000} s${aloneSuffix(result)}`;
      if (outcome.kind === 'hls-http') return `manifest returned HTTP ${outcome.status}`;
      return 'stream failed';
    }
    case 'unverifiable':
      if (verdict.reason === 'player-api-blocked') return 'the YouTube IFrame API did not load';
      if (verdict.reason === 'live-signal-missing') return 'the player no longer reports whether a video is live (isLive missing)';
      return result.aloneChecks >= ALONE_RECHECKS
        ? 'the player never became ready, in the batch or in two checks alone'
        : 'the player frame loaded but never became ready';
  }
  return 'unknown verdict';
}

/** What a failing stream reported (an error code or message). Kept out of `why`, which the audit issue renders as trusted text. */
function failureDetail(result) {
  const outcome = result.verdict?.verdict === 'failed' ? result.verdict.outcome : null;
  return outcome?.kind === 'hls-fatal' ? outcome.detail : null;
}

/** One block per entry: verdict, what was checked, title/author, why, and the line to paste when live. */
export function formatCheckLine(result) {
  const video = result.verdict?.video ?? null;
  let subject = result.parsed.ok ? canonicalEntry(result.parsed.candidate) : result.parsed.entry;
  if (result.parsed.ok && result.parsed.candidate.kind === 'channel' && video?.videoId) subject += ` → ${video.videoId}`;
  const byline = [video?.title && `"${video.title}"`, video?.author && `by ${video.author}`].filter(Boolean).join(' ') || null;
  const head = [verdictLabel(result).padEnd(10), result.name, subject, byline].filter(Boolean).join('  ');
  const detail = failureDetail(result);
  const lines = [head, `${INDENT}why: ${why(result)}${detail ? `: ${detail}` : ''}`];
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
      return results.map((result) => result ?? { verdict: { verdict: 'failed', outcome: { kind: 'timeout' } }, durationSeconds: null, verdictAtMs: null });
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

/** Plays the candidates in one headless browser, `batchSize` players per page, one page after another. */
export async function probeYouTubeWithBrowser(candidates, { batchSize = BATCH_SIZE } = {}) {
  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  try {
    const results = [];
    for (let start = 0; start < candidates.length; start += batchSize) {
      const page = await openProbePage(browser);
      try {
        results.push(...await probeYouTubeCandidates(candidates.slice(start, start + batchSize), { page, sleep }));
      } finally {
        await page.close();
      }
    }
    return results;
  } finally {
    await browser.close();
  }
}

export function classifyHlsPlaylist(text) {
  if (!text.trimStart().startsWith('#EXTM3U')) return 'unknown';
  if (/#EXT-X-ENDLIST|#EXT-X-PLAYLIST-TYPE:VOD/.test(text)) return 'vod';
  return /#EXTINF/.test(text) ? 'live' : 'unknown';
}

function firstVariantUri(text) {
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  const streamInf = lines.findIndex((line) => line.startsWith('#EXT-X-STREAM-INF'));
  if (streamInf < 0) return null;
  return lines.slice(streamInf + 1).find((line) => line && !line.startsWith('#')) ?? null;
}

async function probeHlsCandidate(candidate) {
  const startedAt = Date.now();
  const observe = (fields) => classifyAttempt({ transport: 'hls', elapsedMs: Date.now() - startedAt, manifest: 'unknown', progress: 'unchecked', failure: null, ...fields });
  const signal = AbortSignal.timeout(LIVE_VIDEO_TIMING.verdictDeadlineMs);
  try {
    let url = candidate.url;
    for (let depth = 0; depth < 3; depth++) {
      const response = await fetch(url, { signal, headers: { 'user-agent': BROWSER_UA } });
      if (!response.ok) return { verdict: observe({ failure: { kind: 'http', status: response.status } }) };
      const text = await response.text();
      const variant = firstVariantUri(text);
      if (variant) {
        url = new URL(variant, response.url || url).href;
        continue;
      }
      const manifest = classifyHlsPlaylist(text);
      return { verdict: observe(manifest === 'unknown' ? { failure: { kind: 'fatal', detail: 'not an HLS media playlist' } } : { manifest }) };
    }
    return { verdict: observe({ failure: { kind: 'fatal', detail: 'too many nested playlists' } }) };
  } catch (error) {
    if (error?.name === 'TimeoutError') return { verdict: observe({ elapsedMs: LIVE_VIDEO_TIMING.verdictDeadlineMs }) };
    return { verdict: observe({ failure: { kind: 'fatal', detail: error?.cause?.code ?? error?.message ?? String(error) } }) };
  }
}

async function probeHlsCandidates(candidates) {
  return Promise.all(candidates.map(probeHlsCandidate));
}

/** Every catalog slot in check order, as [slot, entries]. */
export function catalogSlots(catalog) {
  return [
    ...Object.entries(catalog.webcams).map(([id, entries]) => [`webcams/${id}`, entries]),
    ...Object.entries(catalog.news ?? {}).map(([id, entries]) => [`live-news/${id}`, entries]),
  ];
}

const entryName = (slot, index) => (index === 0 ? slot : `${slot}#${index + 1}`);

/** The entries a catalog mode checks, named by slot (a second entry is `slot#2`), plus the slots with no entries. */
export function catalogTargets(target, catalog = DEFAULT_CATALOG) {
  const slots = catalogSlots(catalog);
  const selected = target.mode === 'all' ? slots : slots.filter(([slot]) => slot === target.slot);
  if (target.mode === 'slot' && selected.length === 0) {
    throw new Error(`Unknown slot ${target.slot}. Slots: ${slots.map(([slot]) => slot).join(', ')}`);
  }
  const entries = selected.flatMap(([slot, list]) => list.map((entry, index) => ({ name: entryName(slot, index), entry })));
  if (target.mode === 'all') entries.push(...catalog.canaries.map((entry, index) => ({ name: `canary/${index + 1}`, entry })));
  const empty = selected.filter(([, list]) => list.length === 0).map(([slot]) => slot);
  return { entries, empty };
}

function formatEmptySlot(slot) {
  return ['EMPTY'.padEnd(10), slot, `no entries: paste a live stream URL into ${CATALOG_FILE}`].join('  ');
}

async function probeRows(rows, { probeYouTube, probeHls }) {
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
}

// HLS answers that can depend on where the check runs rather than on the stream: a region block or rate limit,
// an origin error, a slow, dropped or unreachable connection (fetch reports these as error codes, not as the
// probe's own deadline), and a certificate chain Node cannot complete without fetching an intermediate, which
// Chrome does. A missing host, a refused connection, a 400/404/410, a body that is not a playlist and an expired
// certificate are broken for viewers too.
const runnerDependentHlsStatus = (status) => status === 403 || status === 451 || status === 429 || (status >= 500 && status <= 599);
const RUNNER_DEPENDENT_HLS_ERRORS = new Set([
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'ETIMEDOUT',
  'EAI_AGAIN', 'ECONNRESET', 'UND_ERR_SOCKET', 'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'SELF_SIGNED_CERT_IN_CHAIN',
]);

function unverifiableFromRunner(row) {
  if (!row.parsed.ok) return false;
  const { verdict } = row;
  // A YouTube stall (never ready, no verdict, listed live but never played) is dead only once it recurred in
  // ALONE_RECHECKS checks alone while a canary played (recheckStalledAlone): on a busy page the stall can be the page.
  if (stalledLikeThePage(row)) return !(row.aloneChecks >= ALONE_RECHECKS);
  if (verdict.verdict === 'unverifiable') return true;
  if (verdict.verdict !== 'failed' || row.parsed.candidate.kind !== 'hls') return false;
  const { outcome } = verdict;
  return outcome.kind === 'timeout'
    || (outcome.kind === 'hls-http' && runnerDependentHlsStatus(outcome.status))
    || (outcome.kind === 'hls-fatal' && RUNNER_DEPENDENT_HLS_ERRORS.has(outcome.detail));
}

/** One checked entry as the audit report records it: the verdict, why, and the evidence behind it. */
function attemptRecord(row) {
  const verdict = row.parsed.ok ? row.verdict : null;
  const video = verdict?.video ?? null;
  const outcome = verdict?.verdict === 'failed' ? verdict.outcome : null;
  return {
    entry: row.parsed.entry,
    kind: row.parsed.ok ? row.parsed.candidate.kind : null,
    verdict: verdict ? verdict.verdict : 'invalid',
    why: why(row),
    unverifiableFromRunner: unverifiableFromRunner(row),
    evidence: {
      videoId: video?.videoId || null,
      title: video?.title || null,
      author: video?.author || null,
      isLive: typeof video?.isLive === 'boolean' ? video.isLive : null,
      errorCode: outcome?.kind === 'player-error' ? outcome.code : null,
      httpStatus: outcome?.kind === 'hls-http' ? outcome.status : null,
      detail: failureDetail(row),
      durationSeconds: row.durationSeconds ?? null,
      verdictAtMs: row.verdictAtMs ?? null,
      aloneChecks: row.aloneChecks ?? 0,
      recheckSkipped: row.recheckSkipped === true,
    },
  };
}

/**
 * What a slot needs, from its attempts in try order:
 *  no entries → empty; first entry live → ok; a dead entry ahead of a live or unverifiable one → degraded;
 *  nothing live and nothing unverifiable → needs-replacement; the first entry the runner could not verify,
 *  with no dead entry ahead of it → unverifiable-from-runner.
 */
export function slotStatus(attempts) {
  if (attempts.length === 0) return 'empty';
  const liveAt = attempts.findIndex((attempt) => attempt.verdict === 'live');
  if (liveAt >= 0) return attempts.slice(0, liveAt).some((attempt) => !attempt.unverifiableFromRunner) ? 'degraded' : 'ok';
  const unverifiedAt = attempts.findIndex((attempt) => attempt.unverifiableFromRunner);
  if (unverifiedAt < 0) return 'needs-replacement';
  return unverifiedAt > 0 ? 'degraded' : 'unverifiable-from-runner';
}

const NOTHING_LIVE = new Set(['empty', 'needs-replacement']);

function titleCase(key) {
  return key.split('-').map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

/**
 * Where customers see each slot, by the panels' own rules. The "all regions" wall is the first
 * `gridCells` slots of the grid priority; a wall slot with nothing live gives its cell to the next
 * spare that plays (LiveWebcamsPanel.gridFeeds). An empty wall slot keeps its cell here, so the
 * owner sees which hotspot is missing and which slot fills in for it.
 */
export function placeSlots(catalog, statusBySlot, surfaces) {
  const nothingLive = (id) => NOTHING_LIVE.has(statusBySlot.get(`webcams/${id}`));
  const priority = catalog.gridPriority ?? [];
  const intended = priority.slice(0, surfaces.gridCells);
  const spares = priority.slice(surfaces.gridCells).filter((id) => !nothingLive(id));
  const wall = intended.map((id) => (nothingLive(id) && spares.length > 0 ? spares.shift() : id));
  const regions = new Map(surfaces.webcamFeeds.map((feed) => [feed.id, feed.region]));
  const placements = new Map();

  for (const id of Object.keys(catalog.webcams)) {
    const slot = `webcams/${id}`;
    const region = regions.get(id);
    if (!region) throw new Error(`${slot} is not a feed in LiveWebcamsPanel.ts WEBCAM_FEEDS, so the audit cannot say where it shows`);
    const cell = intended.includes(id) ? intended.indexOf(id) : wall.indexOf(id);
    placements.set(slot, cell < 0
      ? { surface: `Webcam (${titleCase(region)})`, shownByDefault: false, shownInstead: null }
      : { surface: `Webcam grid cell ${cell + 1}`, shownByDefault: true, shownInstead: intended[cell] === id && wall[cell] !== id ? `webcams/${wall[cell]}` : null });
  }

  for (const id of Object.keys(catalog.news ?? {})) {
    const slot = `live-news/${id}`;
    const variants = Object.entries(surfaces.newsDefaults).filter(([, ids]) => ids.includes(id)).map(([variant]) => variant);
    if (variants.length > 0) {
      placements.set(slot, { surface: `Live News default (${variants.join(', ')})`, shownByDefault: true, shownInstead: null });
    } else if (surfaces.newsOptional.includes(id)) {
      placements.set(slot, { surface: 'Live News optional', shownByDefault: false, shownInstead: null });
    } else {
      throw new Error(`${slot} is not a channel in LiveNewsPanel.ts, so the audit cannot say where it shows`);
    }
  }
  return placements;
}

/** The --report file: every slot with where it shows, its status and every attempt, plus the canaries. */
export function buildAuditReport({ catalog, rows, surfaces, checkedAt }) {
  const byName = new Map(rows.map((row) => [row.name, row]));
  const slots = catalogSlots(catalog).map(([slot, entries]) => ({
    slot,
    attempts: entries.map((_, index) => attemptRecord(byName.get(entryName(slot, index)))),
  }));
  const statuses = new Map(slots.map(({ slot, attempts }) => [slot, slotStatus(attempts)]));
  const placements = placeSlots(catalog, statuses, surfaces);
  return {
    checkedAt,
    canaries: catalog.canaries.map((_, index) => attemptRecord(byName.get(`canary/${index + 1}`))),
    slots: slots.map(({ slot, attempts }) => {
      const { surface, shownByDefault, shownInstead } = placements.get(slot);
      return { slot, surface, shownByDefault, status: statuses.get(slot), attempts, shownInstead };
    }),
  };
}

const isCanary = (row) => row.name?.startsWith('canary/') === true;
const STALL_OUTCOMES = new Set(['timeout', 'not-started']);
/** A YouTube attempt that can be the busy page rather than the stream: never ready, no verdict, or listed live but never played. */
const stalledLikeThePage = (row) => row.parsed.ok && row.parsed.candidate.kind !== 'hls' && (
  (row.verdict?.verdict === 'unverifiable' && row.verdict.reason === 'player-api-silent')
  || (row.verdict?.verdict === 'failed' && STALL_OUTCOMES.has(row.verdict.outcome.kind))
);

/**
 * Re-checks every YouTube entry that stalled, one player per page with the full deadline, in up to
 * ALONE_RECHECKS rounds: a crowded page, or one unlucky page alone (1 of 12 when measured), can stall a
 * player that plays fine. The latest verdict replaces the earlier one, so a real waiting room that stalls
 * again still counts. A check starts only while it still fits in `budgetMs`; entries it cannot reach are
 * marked recheckSkipped. Callers run this only while a canary plays, so a runner-wide stall never turns into rot.
 */
async function recheckStalledAlone(rows, probeYouTube, { budgetMs, clock }) {
  const startedAt = clock();
  const fits = () => clock() - startedAt + ALONE_CHECK_MAX_MS <= budgetMs;
  let pending = rows.filter(stalledLikeThePage);
  for (let check = 1; check <= ALONE_RECHECKS && pending.length > 0; check++) {
    for (const row of pending) {
      if (!fits()) {
        row.recheckSkipped = true;
        continue;
      }
      const [probed] = await probeYouTube([row.parsed.candidate], { batchSize: 1 });
      Object.assign(row, probed, { aloneChecks: check });
    }
    pending = pending.filter((row) => !row.recheckSkipped && stalledLikeThePage(row));
  }
}

/** Checks bare entries and returns them as report attempts; the reporter re-checks the canaries with this. */
export async function auditAttempts(entries, { probeYouTube = probeYouTubeWithBrowser, probeHls = probeHlsCandidates } = {}) {
  const rows = entries.map((entry) => ({ name: null, parsed: parseSourceEntry(entry) }));
  await probeRows(rows, { probeYouTube, probeHls });
  return rows.map(attemptRecord);
}

export async function runCheck(argv, {
  write = console.log,
  probeYouTube = probeYouTubeWithBrowser,
  probeHls = probeHlsCandidates,
  catalog = DEFAULT_CATALOG,
  surfaces,
  writeReport = writeFileSync,
  now = () => new Date(),
  clock = () => performance.now(),
} = {}) {
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

  // Place every slot before the slow probe, so a panel list that can no longer be read fails first.
  const placement = args.report ? surfaces ?? readLiveVideoSurfaces() : null;
  if (placement) placeSlots(catalog, new Map(), placement);
  const checkedAt = now().toISOString();

  const rows = targets.entries.map(({ name, entry }) => ({ name, parsed: parseSourceEntry(entry) }));
  // Canaries first, on their own page: whether one plays decides how a never-ready slot player is read.
  const canaryRows = rows.filter(isCanary);
  const slotRows = rows.filter((row) => !isCanary(row));
  await probeRows(canaryRows, { probeYouTube, probeHls });
  await probeRows(slotRows, { probeYouTube, probeHls });
  // Retry canaries once before alone rechecks — same flake tolerance as confirmProbeWorks —
  // so a flaky first canary pass does not skip alone rechecks and leave dead feeds unverifiable.
  if (!canaryRows.some((row) => row.verdict?.verdict === 'live')) {
    await probeRows(canaryRows, { probeYouTube, probeHls });
  }
  if (canaryRows.some((row) => row.verdict?.verdict === 'live')) {
    await recheckStalledAlone(slotRows, probeYouTube, { budgetMs: ALONE_RECHECK_BUDGET_MS, clock });
  }

  for (const slot of targets.empty) write(formatEmptySlot(slot));
  for (const row of rows) write(formatCheckLine(row));
  const notLive = rows.filter((row) => !(row.parsed.ok && row.verdict?.verdict === 'live')).length;
  if (rows.length > 0) write(notLive ? `${notLive} of ${rows.length} entries are not live.` : `All ${rows.length} entries are live.`);
  if (targets.empty.length > 0) write(`${targets.empty.length} slot(s) have no entries.`);
  if (args.report) {
    const report = buildAuditReport({ catalog, rows, surfaces: placement, checkedAt });
    writeReport(args.report, `${JSON.stringify(report, null, 2)}\n`);
  }
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
