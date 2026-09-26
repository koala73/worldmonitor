// Resolves a YouTube channel to the video it has live right now, from the channel's public /live page:
// its <link rel="canonical"> and its ytInitialPlayerResponse. Shared by the live video audit
// (scripts/check-live-video-sources.mjs) and the refresh cron, so both mean the same thing by "live".
//
// Plain Node on purpose: it imports only Node builtins and scripts/_proxy-utils.cjs, so a Railway
// seeder packaged from scripts/ alone can import it (tests/scripts-railway-nixpacks-no-escape-import.test.mts).
//
// Every result is one of:
//   { status: 'live', reason: null, videoId, channelId, title, playableInEmbed: true }
//   { status: 'not-live', reason: 'not-live' | 'upcoming' | 'not-embeddable', videoId, channelId, title }
//   { status: 'unreadable', reason, videoId: null, channelId, title: null, detail?, proxyFailure? }
// `title` is for logs and the audit line only; nothing that publishes ids may publish it.
// `proxyFailure: true` marks a page the proxy exit failed to fetch (CONNECT refused, tunnel or response timeout,
// a dropped proxy connection), as opposed to a page YouTube served: only that kind moves to another exit.

import { createRequire } from 'node:module';

const { parseProxyConfigForAttempt, proxyFetch } = createRequire(import.meta.url)('../_proxy-utils.cjs');

// Duplicated from src/services/live-video/model.ts, which is TypeScript and cannot be imported here.
const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/** Each page read waits at most this long for the proxy tunnel, and again for the response (proxyFetch applies it twice). */
export const CHANNEL_PAGE_TIMEOUT_MS = 15_000;
/** A real /live page is about 1.2 MB before compression; anything past this is not a channel page. */
export const CHANNEL_PAGE_MAX_BYTES = 4 * 1024 * 1024;
const MAX_REDIRECTS = 2;
/** A channel whose page failed at the proxy is fetched again on a fresh exit at most this many times. */
export const MAX_PROXY_RETRIES = 2;
/** proxyFetch failure stages that happen before YouTube answers (scripts/_proxy-utils.cjs recordProxyFailure). */
const PROXY_STAGES = new Set(['proxy_connection', 'proxy_connect', 'target_tls']);
const YOUTUBE_HOSTS = new Set(['www.youtube.com', 'youtube.com', 'consent.youtube.com']);
const CHANNEL_PAGE_BASE = 'https://www.youtube.com/channel';
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const PAGE_HEADERS = {
  'User-Agent': BROWSER_UA,
  'Accept-Language': 'en-US,en;q=0.8',
  // Pre-answers the EU consent interstitial, which otherwise replaces the page for European exits.
  Cookie: 'SOCS=CAI; CONSENT=YES+cb',
};

export function channelLiveUrl(channelId) {
  if (typeof channelId !== 'string' || !CHANNEL_ID.test(channelId)) throw new Error('not a YouTube channel id (UC followed by 22 characters)');
  return `${CHANNEL_PAGE_BASE}/${channelId}/live?hl=en`;
}

function unreadable(channelId, reason, detail) {
  const result = { status: 'unreadable', reason, videoId: null, channelId, title: null };
  if (detail) result.detail = detail;
  return result;
}

const notLive = (channelId, reason, videoId = null, title = null) => ({ status: 'not-live', reason, videoId, channelId, title });

const CONSENT_WALL = [/<form[^>]+action="https:\/\/consent\.youtube\.com\//i, /<title>\s*Before you continue to YouTube/i];
const BOT_WALL = [/confirm you(?:'|’|\\u2019)re not a bot/i, /google\.com\/sorry\//i, /detected unusual traffic from your computer network/i];

function canonicalHref(html) {
  for (const [tag] of html.matchAll(/<link\b[^>]*>/gi)) {
    if (!/\brel\s*=\s*["']canonical["']/i.test(tag)) continue;
    return /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1] ?? null;
  }
  return null;
}

/** What the canonical link says: the channel page itself (nothing live), a watch URL, or neither. */
function readCanonical(href) {
  let url;
  try {
    url = new URL(href.replace(/&amp;/g, '&'));
  } catch {
    return { kind: 'other' };
  }
  if (url.protocol !== 'https:' || (url.hostname !== 'www.youtube.com' && url.hostname !== 'youtube.com')) return { kind: 'other' };
  if (url.pathname === '/watch') {
    const id = url.searchParams.get('v');
    return id && VIDEO_ID.test(id) ? { kind: 'watch', videoId: id } : { kind: 'other' };
  }
  if (/^\/(?:channel\/UC[A-Za-z0-9_-]{22}|@[^/]+|c\/[^/]+|user\/[^/]+)\/?$/.test(url.pathname)) return { kind: 'channel' };
  return { kind: 'other' };
}

/**
 * The JSON object assigned to ytInitialPlayerResponse, found by scanning balanced braces outside strings,
 * so a title containing `}` or `</script>` does not end it early. null when absent, undefined when broken.
 */
function playerResponseJson(html) {
  const match = /ytInitialPlayerResponse\s*=\s*\{/.exec(html);
  if (!match) return null;
  const start = match.index + match[0].length - 1;
  let depth = 0;
  let inString = false;
  for (let i = start; i < html.length; i++) {
    const char = html[i];
    if (inString) {
      if (char === '\\') i++;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) {
      try {
        return JSON.parse(html.slice(start, i + 1));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/** Pure: a /live page's HTML (already fetched) to live, not-live or unreadable for `channelId`. Never throws. */
export function readChannelLivePage(html, channelId) {
  if (typeof html !== 'string') return unreadable(channelId, 'parse-error');
  if (CONSENT_WALL.some((pattern) => pattern.test(html))) return unreadable(channelId, 'consent-wall');
  if (BOT_WALL.some((pattern) => pattern.test(html))) return unreadable(channelId, 'bot-wall');
  const href = canonicalHref(html);
  const canonical = href ? readCanonical(href) : { kind: 'other' };
  if (canonical.kind === 'channel') return notLive(channelId, 'not-live');
  if (canonical.kind !== 'watch') return unreadable(channelId, 'no-canonical');

  const player = playerResponseJson(html);
  if (player === null) return unreadable(channelId, 'no-player');
  const details = player?.videoDetails;
  const playability = player?.playabilityStatus;
  if (!details || typeof details !== 'object' || !playability || typeof playability !== 'object') return unreadable(channelId, 'parse-error');
  if (details.videoId !== canonical.videoId) return unreadable(channelId, 'parse-error');
  if (details.channelId !== channelId) return unreadable(channelId, 'channel-mismatch');
  const { videoId } = canonical;
  const title = typeof details.title === 'string' ? details.title : null;
  if (details.isUpcoming === true) return notLive(channelId, 'upcoming', videoId, title);
  if (details.isLive !== true) return notLive(channelId, 'not-live', videoId, title);
  if (playability.status !== 'OK' || playability.playableInEmbed !== true) return notLive(channelId, 'not-embeddable', videoId, title);
  return { status: 'live', reason: null, videoId, channelId, title, playableInEmbed: true };
}

/** Removes a proxy credential, raw or URL-encoded, from text headed for a log or a report. */
function redact(text, proxy) {
  let out = String(text);
  const auth = typeof proxy?.auth === 'string' ? proxy.auth : '';
  const colon = auth.indexOf(':');
  const secrets = colon === -1 ? [auth] : [auth.slice(0, colon), auth.slice(colon + 1)];
  for (const secret of secrets.filter(Boolean)) {
    for (const form of new Set([secret, encodeURIComponent(secret)])) out = out.split(form).join('***');
  }
  return out;
}

const isTimeout = (error) => error?.name === 'TimeoutError'
  || /^(?:proxy fetch timeout|CONNECT tunnel timeout)$/.test(String(error?.message ?? ''));

/** A fetch that failed at the proxy exit rather than at YouTube: another exit may well succeed. */
const isProxyFailure = (error) => error?.proxyConnect === true
  || PROXY_STAGES.has(error?.proxyFailure?.stage)
  || /^(?:proxy fetch timeout|CONNECT tunnel timeout)$/.test(String(error?.message ?? ''));

/**
 * The proxy route for one attempt, from the raw proxy value (any form parseProxyConfig reads). A Decodo sticky port
 * moves to the next sticky session per attempt, so a retry leaves a dead exit; any other route is returned unchanged.
 */
export function proxyForAttempt(raw, attempt = 0) {
  return raw ? parseProxyConfigForAttempt(String(raw).trim(), attempt) : null;
}

/** A response body as text, refusing one past `maxBytes` (streamed when the response exposes a reader). */
async function cappedText(response, maxBytes) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error('page too large');
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) throw new Error('page too large');
    return text;
  }
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error('page too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
}

/**
 * Fetches `channelId`'s /live page and reads it, through `proxyUrl` (the raw proxy value, routed for `attempt` by
 * proxyForAttempt) or through `proxy` (a parseProxyConfig object, used as given). Without either the fetch is direct
 * (a local run). Redirects are followed by hand, at most twice, and only to YouTube.
 * Never throws: every failure is an unreadable result whose `detail` carries no proxy credential.
 */
export async function fetchChannelLivePage(channelId, {
  proxyUrl = null,
  attempt = 0,
  proxy: givenProxy = null,
  proxyFetchImpl = proxyFetch,
  fetchImpl = (...args) => globalThis.fetch(...args),
  timeoutMs = CHANNEL_PAGE_TIMEOUT_MS,
  maxBytes = CHANNEL_PAGE_MAX_BYTES,
} = {}) {
  const proxy = givenProxy ?? proxyForAttempt(proxyUrl, attempt);
  let url;
  try {
    url = channelLiveUrl(channelId);
  } catch (error) {
    return unreadable(channelId, 'fetch-error', error.message);
  }
  const get = async (target) => {
    if (proxy) {
      const response = await proxyFetchImpl(target, proxy, { accept: 'text/html', headers: PAGE_HEADERS, maxResponseBytes: maxBytes, timeoutMs });
      return { ok: response.ok, status: response.status, location: response.location || '', body: () => Buffer.from(response.buffer ?? '').toString('utf8') };
    }
    const response = await fetchImpl(target, { headers: { Accept: 'text/html', ...PAGE_HEADERS }, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    return { ok: response.ok, status: response.status, location: response.headers?.get?.('location') || '', body: () => cappedText(response, maxBytes) };
  };
  try {
    for (let redirects = 0; ; redirects++) {
      const response = await get(url);
      if (response.status >= 300 && response.status < 400 && response.location) {
        if (redirects >= MAX_REDIRECTS) return unreadable(channelId, 'fetch-error', `more than ${MAX_REDIRECTS} redirects`);
        let next;
        try {
          next = new URL(response.location, url);
        } catch {
          return unreadable(channelId, 'redirect-blocked');
        }
        if (next.protocol !== 'https:' || !YOUTUBE_HOSTS.has(next.hostname)) return unreadable(channelId, 'redirect-blocked');
        if (next.hostname === 'consent.youtube.com') return unreadable(channelId, 'consent-wall');
        url = next.href;
        continue;
      }
      if (!response.ok) return unreadable(channelId, `http-${response.status}`);
      return readChannelLivePage(await response.body(), channelId);
    }
  } catch (error) {
    const result = unreadable(channelId, isTimeout(error) ? 'timeout' : 'fetch-error', redact(error?.message ?? error, proxy));
    if (proxy && isProxyFailure(error)) result.proxyFailure = true;
    return result;
  }
}

/**
 * Resolves every channel once, `concurrency` pages at a time, calling `fetchPage(channelId, { attempt })`. A page that
 * failed at the proxy (`proxyFailure`) moves the shared `session.current` to the next proxy session and is fetched
 * again there, at most MAX_PROXY_RETRIES times; later channels start on that session, so one dead exit costs one
 * failed fetch per worker rather than one per channel. A page YouTube served (a wall, a parse error, a mismatch) is
 * never re-fetched. No fetch or retry starts after `budgetMs`: a channel not started by then reads unreadable/skipped,
 * so the pass takes at most budgetMs plus one page's worst case. Never throws.
 */
export async function resolveChannelsLive(channelIds, {
  fetchPage,
  concurrency = 4,
  budgetMs = Number.POSITIVE_INFINITY,
  now = Date.now,
  session = { current: 0 },
} = {}) {
  const queue = [...new Set(channelIds)];
  const results = new Map(queue.map((id) => [id, null]));
  const startedAt = now();
  const withinBudget = () => now() - startedAt < budgetMs;
  let next = 0;
  const fetchOnce = async (id, attempt) => {
    try {
      return await fetchPage(id, { attempt });
    } catch (error) {
      return unreadable(id, 'fetch-error', String(error?.message ?? error));
    }
  };
  const worker = async () => {
    while (next < queue.length) {
      const id = queue[next++];
      if (!withinBudget()) {
        results.set(id, unreadable(id, 'skipped'));
        continue;
      }
      let attempt = session.current;
      let result = await fetchOnce(id, attempt);
      for (let retry = 1; result?.proxyFailure === true && retry <= MAX_PROXY_RETRIES && withinBudget(); retry++) {
        // Another worker may already have moved past this exit; never move backwards.
        session.current = Math.max(session.current, attempt + 1);
        attempt = session.current;
        result = await fetchOnce(id, attempt);
      }
      results.set(id, result);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, queue.length)) }, worker));
  return results;
}
