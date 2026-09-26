import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CHANNEL_PAGE_TIMEOUT_MS,
  channelLiveUrl,
  fetchChannelLivePage,
  proxyForAttempt,
  readChannelLivePage,
  resolveChannelsLive,
} from '../scripts/lib/live-video-channel-live.mjs';

// Synthetic pages: the real /live page is about 1.2 MB, and only these two signals are read from it.
const CHANNEL = 'UCNye-wNBqNL5ZzHSJj3l8Bg';
const OTHER_CHANNEL = 'UCknLrEdhRCp1aegoMqRaCZg';
const VIDEO = 'gCNeDWCI0vo';

function playerResponse({
  videoId = VIDEO,
  channelId = CHANNEL,
  title = 'Al Jazeera English | Live',
  isLive = true,
  isUpcoming,
  status = 'OK',
  playableInEmbed = true,
} = {}) {
  const videoDetails = { videoId, title, channelId, isLiveContent: true, author: 'Al Jazeera English' };
  if (isLive !== null) videoDetails.isLive = isLive;
  if (isUpcoming !== undefined) videoDetails.isUpcoming = isUpcoming;
  return { responseContext: { serviceTrackingParams: [] }, playabilityStatus: { status, playableInEmbed }, videoDetails };
}

function livePage({ canonical = `https://www.youtube.com/watch?v=${VIDEO}`, player = playerResponse(), rawPlayer } = {}) {
  const json = rawPlayer === undefined ? JSON.stringify(player) : rawPlayer;
  return [
    '<!DOCTYPE html><html lang="en"><head>',
    '<title>Al Jazeera English - YouTube</title>',
    canonical === null ? '' : `<link rel="canonical" href="${canonical}">`,
    '</head><body>',
    '<script nonce="abc">var ytcfg = {"a":"}"};</script>',
    json === null ? '' : `<script nonce="abc">var ytInitialPlayerResponse = ${json};var meta = document.createElement('meta');</script>`,
    '</body></html>',
  ].join('\n');
}

const NOT_LIVE_PAGE = [
  '<!DOCTYPE html><html><head><title>MTV Lebanon News - YouTube</title>',
  `<link rel="canonical" href="https://www.youtube.com/channel/${CHANNEL}">`,
  '</head><body><script>var ytInitialData = {"contents":{}};</script></body></html>',
].join('\n');

const CONSENT_PAGE = [
  '<!DOCTYPE html><html><head><title>Before you continue to YouTube</title></head><body>',
  '<form action="https://consent.youtube.com/save" method="POST"><input type="hidden" name="gl" value="DE"></form>',
  '</body></html>',
].join('\n');

const BOT_WALL_PAGE = [
  '<!DOCTYPE html><html><head><title>YouTube</title>',
  `<link rel="canonical" href="https://www.youtube.com/watch?v=${VIDEO}">`,
  '</head><body><script>var ytInitialPlayerResponse = {"playabilityStatus":{"status":"LOGIN_REQUIRED",',
  '"reason":"Sign in to confirm you’re not a bot"}};</script></body></html>',
].join('\n');

const SORRY_PAGE = '<html><head><title>https://www.youtube.com/channel/x/live</title></head><body>Our systems have detected unusual traffic from your computer network. <form action="https://www.google.com/sorry/index"></form></body></html>';

describe('channelLiveUrl', () => {
  it('builds the English /live URL for a UC channel id and refuses anything else', () => {
    assert.equal(channelLiveUrl(CHANNEL), `https://www.youtube.com/channel/${CHANNEL}/live?hl=en`);
    for (const bad of ['@aljazeeraenglish', 'UCshort', `${CHANNEL}/../x`, '', null]) {
      assert.throws(() => channelLiveUrl(bad), /not a YouTube channel id/, String(bad));
    }
  });
});

describe('readChannelLivePage', () => {
  it('reads a live, embeddable video owned by the channel as live, with its id and title', () => {
    assert.deepEqual(readChannelLivePage(livePage(), CHANNEL), {
      status: 'live',
      reason: null,
      videoId: VIDEO,
      channelId: CHANNEL,
      title: 'Al Jazeera English | Live',
      playableInEmbed: true,
    });
  });

  it('reads a canonical that points at the channel page as not live', () => {
    assert.deepEqual(readChannelLivePage(NOT_LIVE_PAGE, CHANNEL), { status: 'not-live', reason: 'not-live', videoId: null, channelId: CHANNEL, title: null });
  });

  it('reads an upcoming premiere or a video that is no longer live as not live', () => {
    const upcoming = readChannelLivePage(livePage({ player: playerResponse({ isLive: null, isUpcoming: true, status: 'LIVE_STREAM_OFFLINE' }) }), CHANNEL);
    assert.deepEqual([upcoming.status, upcoming.reason, upcoming.videoId], ['not-live', 'upcoming', VIDEO]);
    const ended = readChannelLivePage(livePage({ player: playerResponse({ isLive: false }) }), CHANNEL);
    assert.deepEqual([ended.status, ended.reason], ['not-live', 'not-live']);
    const missing = readChannelLivePage(livePage({ player: playerResponse({ isLive: null }) }), CHANNEL);
    assert.deepEqual([missing.status, missing.reason], ['not-live', 'not-live']);
  });

  it('reads a live video the owner does not allow to be embedded, or one that is not playable, as not embeddable', () => {
    const blocked = readChannelLivePage(livePage({ player: playerResponse({ playableInEmbed: false }) }), CHANNEL);
    assert.deepEqual([blocked.status, blocked.reason, blocked.videoId], ['not-live', 'not-embeddable', VIDEO]);
    const unplayable = readChannelLivePage(livePage({ player: playerResponse({ status: 'UNPLAYABLE' }) }), CHANNEL);
    assert.deepEqual([unplayable.status, unplayable.reason], ['not-live', 'not-embeddable']);
  });

  it('reads a video owned by another channel as unreadable, never as that channel\'s live', () => {
    const result = readChannelLivePage(livePage({ player: playerResponse({ channelId: OTHER_CHANNEL }) }), CHANNEL);
    assert.deepEqual([result.status, result.reason, result.videoId], ['unreadable', 'channel-mismatch', null]);
  });

  it('reads a player response for a different video than the canonical link as unreadable', () => {
    const result = readChannelLivePage(livePage({ player: playerResponse({ videoId: 'abc123DEF45' }) }), CHANNEL);
    assert.deepEqual([result.status, result.reason], ['unreadable', 'parse-error']);
  });

  it('reads a page with no canonical link, a canonical elsewhere, or no player response as unreadable', () => {
    assert.equal(readChannelLivePage(livePage({ canonical: null }), CHANNEL).reason, 'no-canonical');
    assert.equal(readChannelLivePage(livePage({ canonical: 'https://www.youtube.com/' }), CHANNEL).reason, 'no-canonical');
    assert.equal(readChannelLivePage(livePage({ rawPlayer: null }), CHANNEL).reason, 'no-player');
    assert.equal(readChannelLivePage('', CHANNEL).reason, 'no-canonical');
  });

  it('reads a truncated or malformed player response as a parse error', () => {
    const json = JSON.stringify(playerResponse());
    const truncated = readChannelLivePage(livePage({ rawPlayer: json.slice(0, json.length - 20) }).replace(/;var meta[\s\S]*$/, ''), CHANNEL);
    assert.deepEqual([truncated.status, truncated.reason], ['unreadable', 'parse-error']);
    assert.equal(readChannelLivePage(livePage({ rawPlayer: '{"videoDetails": nope}' }), CHANNEL).reason, 'parse-error');
  });

  it('scans the player response by its braces, so a title with quotes and braces does not end it early', () => {
    const title = 'Live: "Gaza {day 3}" \\ updates } ; </script>';
    const result = readChannelLivePage(livePage({ player: playerResponse({ title }) }), CHANNEL);
    assert.deepEqual([result.status, result.title], ['live', title]);
  });

  it('reads a consent page, a bot check and Google\'s unusual-traffic page as walls', () => {
    assert.deepEqual(readChannelLivePage(CONSENT_PAGE, CHANNEL), { status: 'unreadable', reason: 'consent-wall', videoId: null, channelId: CHANNEL, title: null });
    assert.equal(readChannelLivePage(BOT_WALL_PAGE, CHANNEL).reason, 'bot-wall');
    assert.equal(readChannelLivePage(SORRY_PAGE, CHANNEL).reason, 'bot-wall');
  });

  it('never throws on input that is not a page', () => {
    for (const junk of [null, undefined, 42, {}, '<link rel="canonical" href="https://www.youtube.com/watch?v=short">']) {
      assert.equal(readChannelLivePage(junk, CHANNEL).status, 'unreadable');
    }
  });
});

describe('fetchChannelLivePage', () => {
  const PROXY = { host: 'gate.example.com', port: 7000, auth: 'probe-user-7Qx:S3cret-Pa55-zK9', tls: true };
  const LEAK = /probe-user-7Qx|S3cret-Pa55-zK9/;
  const proxied = (answer) => {
    const calls = [];
    const proxyFetchImpl = async (url, proxy, options) => {
      calls.push({ url, proxy, options });
      return typeof answer === 'function' ? answer(url, calls.length) : answer;
    };
    return { calls, proxyFetchImpl };
  };
  const okBody = (html) => ({ ok: true, status: 200, location: '', buffer: Buffer.from(html) });
  const redirectTo = (location, status = 302) => ({ ok: false, status, location, buffer: Buffer.alloc(0) });

  it('fetches the /live page through the proxy with browser headers, a byte cap and the page timeout', async () => {
    const { calls, proxyFetchImpl } = proxied(okBody(livePage()));
    const result = await fetchChannelLivePage(CHANNEL, { proxy: PROXY, proxyFetchImpl });
    assert.equal(result.status, 'live');
    assert.equal(result.videoId, VIDEO);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, channelLiveUrl(CHANNEL));
    assert.equal(calls[0].proxy, PROXY);
    assert.equal(calls[0].options.accept, 'text/html');
    assert.equal(calls[0].options.timeoutMs, CHANNEL_PAGE_TIMEOUT_MS);
    assert.equal(calls[0].options.maxResponseBytes, 4 * 1024 * 1024);
    assert.match(calls[0].options.headers['User-Agent'], /Chrome\//);
    assert.match(calls[0].options.headers['Accept-Language'], /^en-US/);
    assert.match(calls[0].options.headers.Cookie, /SOCS=CAI/);
  });

  it('reads a non-2xx answer as unreadable: proxyFetch resolves it with ok false, it does not reject', async () => {
    const { proxyFetchImpl } = proxied({ ok: false, status: 429, location: '', buffer: Buffer.from('slow down') });
    const result = await fetchChannelLivePage(CHANNEL, { proxy: PROXY, proxyFetchImpl });
    assert.deepEqual([result.status, result.reason], ['unreadable', 'http-429']);
  });

  it('reads a rejected CONNECT as a fetch error and keeps the proxy credential out of the detail', async () => {
    const proxyFetchImpl = async () => {
      throw Object.assign(new Error(`Proxy CONNECT: HTTP/1.1 407 for probe-user-7Qx:S3cret-Pa55-zK9 (${encodeURIComponent('S3cret-Pa55-zK9')})`), { proxyConnect: true, status: 407 });
    };
    const result = await fetchChannelLivePage(CHANNEL, { proxy: PROXY, proxyFetchImpl });
    assert.deepEqual([result.status, result.reason], ['unreadable', 'fetch-error']);
    assert.match(result.detail, /\*\*\*/);
    assert.match(result.detail, /407/);
    assert.doesNotMatch(JSON.stringify(result), LEAK);
  });

  it('reads a CONNECT or response timeout as a timeout, and an oversized page as a fetch error', async () => {
    for (const message of ['proxy fetch timeout', 'CONNECT tunnel timeout']) {
      const result = await fetchChannelLivePage(CHANNEL, { proxy: PROXY, proxyFetchImpl: async () => { throw new Error(message); } });
      assert.deepEqual([result.status, result.reason], ['unreadable', 'timeout'], message);
    }
    const tooLarge = await fetchChannelLivePage(CHANNEL, {
      proxy: PROXY,
      proxyFetchImpl: async () => { throw Object.assign(new Error('proxy response too large'), { code: 'RESPONSE_TOO_LARGE' }); },
    });
    assert.deepEqual([tooLarge.status, tooLarge.reason], ['unreadable', 'fetch-error']);
  });

  it('reads a redirect to consent.youtube.com as the consent wall without following it', async () => {
    const { calls, proxyFetchImpl } = proxied(redirectTo('https://consent.youtube.com/m?continue=https%3A%2F%2Fwww.youtube.com'));
    const result = await fetchChannelLivePage(CHANNEL, { proxy: PROXY, proxyFetchImpl });
    assert.deepEqual([result.status, result.reason], ['unreadable', 'consent-wall']);
    assert.equal(calls.length, 1);
  });

  it('never follows a redirect off YouTube', async () => {
    for (const location of ['https://evil.example/live', 'http://www.youtube.com/channel/x/live', 'https://www.youtube.com.evil.example/x']) {
      const { calls, proxyFetchImpl } = proxied(redirectTo(location));
      const result = await fetchChannelLivePage(CHANNEL, { proxy: PROXY, proxyFetchImpl });
      assert.deepEqual([result.status, result.reason], ['unreadable', 'redirect-blocked'], location);
      assert.equal(calls.length, 1, `${location} must not be requested`);
    }
  });

  it('follows at most two YouTube redirects, resolving a relative location', async () => {
    const two = proxied((_url, call) => (call === 1 ? redirectTo('/channel/UCNye-wNBqNL5ZzHSJj3l8Bg/live') : call === 2 ? redirectTo('https://youtube.com/live') : okBody(livePage())));
    const followed = await fetchChannelLivePage(CHANNEL, { proxy: PROXY, proxyFetchImpl: two.proxyFetchImpl });
    assert.equal(followed.status, 'live');
    assert.deepEqual(two.calls.map((call) => call.url), [
      channelLiveUrl(CHANNEL),
      'https://www.youtube.com/channel/UCNye-wNBqNL5ZzHSJj3l8Bg/live',
      'https://youtube.com/live',
    ]);

    const three = proxied(() => redirectTo('https://www.youtube.com/loop'));
    const looped = await fetchChannelLivePage(CHANNEL, { proxy: PROXY, proxyFetchImpl: three.proxyFetchImpl });
    assert.deepEqual([looped.status, looped.reason], ['unreadable', 'fetch-error']);
    assert.equal(three.calls.length, 3, 'the page and two redirects, never a fourth request');
  });

  describe('without a proxy (a local run)', () => {
    const response = (status, body = '', headers = {}) => ({
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers(headers),
      text: async () => body,
    });
    const direct = (answer) => {
      const calls = [];
      const fetchImpl = async (url, init) => {
        calls.push({ url, init });
        return typeof answer === 'function' ? answer(url, calls.length) : answer;
      };
      return { calls, fetchImpl };
    };

    it('fetches directly with manual redirects, a timeout signal and the same headers', async () => {
      const { calls, fetchImpl } = direct(response(200, livePage()));
      const result = await fetchChannelLivePage(CHANNEL, { fetchImpl });
      assert.equal(result.status, 'live');
      assert.equal(calls[0].url, channelLiveUrl(CHANNEL));
      assert.equal(calls[0].init.redirect, 'manual');
      assert.ok(calls[0].init.signal instanceof AbortSignal);
      assert.match(calls[0].init.headers.Cookie, /SOCS=CAI/);
    });

    it('maps a non-2xx, a timeout and a network error the same way as the proxied path', async () => {
      assert.equal((await fetchChannelLivePage(CHANNEL, { fetchImpl: direct(response(503)).fetchImpl })).reason, 'http-503');
      const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
      assert.equal((await fetchChannelLivePage(CHANNEL, { fetchImpl: async () => { throw timeout; } })).reason, 'timeout');
      assert.equal((await fetchChannelLivePage(CHANNEL, { fetchImpl: async () => { throw new TypeError('fetch failed'); } })).reason, 'fetch-error');
    });

    it('applies the same redirect rules', async () => {
      const consent = direct(response(302, '', { location: 'https://consent.youtube.com/m' }));
      assert.equal((await fetchChannelLivePage(CHANNEL, { fetchImpl: consent.fetchImpl })).reason, 'consent-wall');
      const offsite = direct(response(302, '', { location: 'https://evil.example/' }));
      assert.equal((await fetchChannelLivePage(CHANNEL, { fetchImpl: offsite.fetchImpl })).reason, 'redirect-blocked');
      assert.equal(offsite.calls.length, 1);
      const loop = direct(() => response(301, '', { location: 'https://www.youtube.com/again' }));
      assert.equal((await fetchChannelLivePage(CHANNEL, { fetchImpl: loop.fetchImpl })).reason, 'fetch-error');
      assert.equal(loop.calls.length, 3);
      for (const call of loop.calls) assert.equal(call.init.redirect, 'manual');
    });

    it('refuses a page larger than the byte cap', async () => {
      const result = await fetchChannelLivePage(CHANNEL, { fetchImpl: direct(response(200, livePage())).fetchImpl, maxBytes: 100 });
      assert.deepEqual([result.status, result.reason], ['unreadable', 'fetch-error']);
    });
  });
});

describe('proxy session rotation', () => {
  const USER = 'probe-user-7Qx';
  const PASS = 'S3cret-Pa55-zK9';
  const LEAK = new RegExp(`${USER}|${PASS}|${encodeURIComponent(PASS)}`);
  const RAW = `gate.decodo.com:10001:${USER}:${PASS}`;
  const okPage = (html) => ({ ok: true, status: 200, location: '', buffer: Buffer.from(html) });
  const connectRefused = () => Object.assign(new Error(`Proxy CONNECT: HTTP/1.1 522 Server Error for ${USER}:${PASS}`), { proxyConnect: true, status: 522 });
  /** A fake proxyFetch whose Decodo sticky session 10001 is dead: CONNECT fails there and works on any other port. */
  function deadFirstSession(html = livePage()) {
    const ports = [];
    const proxyFetchImpl = async (_url, proxy) => {
      ports.push(proxy.port);
      if (proxy.port === 10001) throw connectRefused();
      return okPage(html);
    };
    return { ports, proxyFetchImpl };
  }

  it('builds each attempt\'s route from the raw proxy value, moving only a Decodo sticky port', () => {
    assert.deepEqual(proxyForAttempt(RAW, 0), { host: 'gate.decodo.com', port: 10001, auth: `${USER}:${PASS}`, tls: true });
    assert.equal(proxyForAttempt(RAW, 2).port, 10003);
    assert.equal(proxyForAttempt(`gate.decodo.com:7000:${USER}:${PASS}`, 3).port, 7000, 'a rotating port has no sessions to move');
    assert.equal(proxyForAttempt('', 1), null);
  });

  it('reads a proxy failure as unreadable with proxyFailure set, and a page problem without it', async () => {
    const { proxyFetchImpl } = deadFirstSession();
    const failed = await fetchChannelLivePage(CHANNEL, { proxyUrl: RAW, attempt: 0, proxyFetchImpl });
    assert.deepEqual([failed.status, failed.reason, failed.proxyFailure], ['unreadable', 'fetch-error', true]);
    assert.doesNotMatch(JSON.stringify(failed), LEAK);
    const recovered = await fetchChannelLivePage(CHANNEL, { proxyUrl: RAW, attempt: 1, proxyFetchImpl });
    assert.equal(recovered.status, 'live');
    for (const message of ['proxy fetch timeout', 'CONNECT tunnel timeout']) {
      const timedOut = await fetchChannelLivePage(CHANNEL, { proxyUrl: RAW, proxyFetchImpl: async () => { throw new Error(message); } });
      assert.equal(timedOut.proxyFailure, true, message);
    }
    const hangUp = await fetchChannelLivePage(CHANNEL, {
      proxyUrl: RAW,
      proxyFetchImpl: async () => { throw Object.assign(new Error('socket hang up'), { proxyFailure: { stage: 'proxy_connection' } }); },
    });
    assert.equal(hangUp.proxyFailure, true);
    const walled = await fetchChannelLivePage(CHANNEL, { proxyUrl: RAW, proxyFetchImpl: async () => okPage(BOT_WALL_PAGE) });
    assert.deepEqual([walled.reason, walled.proxyFailure], ['bot-wall', undefined]);
    const limited = await fetchChannelLivePage(CHANNEL, { proxyUrl: RAW, proxyFetchImpl: async () => ({ ok: false, status: 429, location: '', buffer: Buffer.alloc(0) }) });
    assert.deepEqual([limited.reason, limited.proxyFailure], ['http-429', undefined], 'an origin status is not a proxy failure');
    const direct = await fetchChannelLivePage(CHANNEL, { fetchImpl: async () => { throw new Error('proxy fetch timeout'); } });
    assert.equal(direct.proxyFailure, undefined, 'without a proxy nothing is a proxy failure');
  });

  it('resolves a channel on the next sticky session when the first one fails CONNECT', async () => {
    const { ports, proxyFetchImpl } = deadFirstSession();
    const session = { current: 0 };
    const results = await resolveChannelsLive([CHANNEL], {
      fetchPage: (id, { attempt }) => fetchChannelLivePage(id, { proxyUrl: RAW, attempt, proxyFetchImpl }),
      session,
    });
    assert.equal(results.get(CHANNEL).status, 'live');
    assert.deepEqual(ports, [10001, 10002]);
    assert.equal(session.current, 1, 'the healthy session is left for the next fetch');
    assert.doesNotMatch(JSON.stringify([...results.values()]), LEAK);
  });

  it('moves every later channel to the healthy session instead of paying the dead one again', async () => {
    const { ports, proxyFetchImpl } = deadFirstSession();
    const ids = [CHANNEL, OTHER_CHANNEL, 'UCIALMKvObZNtJ6AmdCLP7Lg'];
    const pages = { [OTHER_CHANNEL]: livePage({ player: playerResponse({ channelId: OTHER_CHANNEL }) }) };
    await resolveChannelsLive(ids, {
      fetchPage: (id, { attempt }) => fetchChannelLivePage(id, {
        proxyUrl: RAW,
        attempt,
        proxyFetchImpl: async (url, proxy, options) => (pages[id] && proxy.port !== 10001 ? okPage(pages[id]) : proxyFetchImpl(url, proxy, options)),
      }),
      concurrency: 1,
    });
    assert.deepEqual(ports.filter((port) => port === 10001).length, 1, 'only the first fetch hit the dead session');
  });

  it('retries a proxy failure at most twice, then keeps it unreadable', async () => {
    const attempts = [];
    const fetchPage = async (id, { attempt }) => {
      attempts.push(attempt);
      return { status: 'unreadable', reason: 'fetch-error', videoId: null, channelId: id, title: null, proxyFailure: true };
    };
    const results = await resolveChannelsLive([CHANNEL], { fetchPage });
    assert.deepEqual(attempts, [0, 1, 2]);
    assert.deepEqual([results.get(CHANNEL).status, results.get(CHANNEL).reason], ['unreadable', 'fetch-error']);
  });

  it('never rotates for a page problem: a bot wall, a parse error or a channel mismatch is fetched once', async () => {
    for (const reason of ['bot-wall', 'parse-error', 'channel-mismatch', 'consent-wall', 'http-429']) {
      const attempts = [];
      const session = { current: 0 };
      await resolveChannelsLive([CHANNEL], {
        fetchPage: async (id, { attempt }) => { attempts.push(attempt); return { status: 'unreadable', reason, videoId: null, channelId: id, title: null }; },
        session,
      });
      assert.deepEqual([attempts, session.current], [[0], 0], reason);
    }
  });

  it('starts no retry once the budget is used up', async () => {
    let clock = 0;
    const attempts = [];
    const results = await resolveChannelsLive([CHANNEL, OTHER_CHANNEL], {
      fetchPage: async (id, { attempt }) => {
        attempts.push([id, attempt]);
        clock += 1_000;
        return { status: 'unreadable', reason: 'timeout', videoId: null, channelId: id, title: null, proxyFailure: true };
      },
      concurrency: 1,
      budgetMs: 1_500,
      now: () => clock,
    });
    assert.deepEqual(attempts, [[CHANNEL, 0], [CHANNEL, 1]]);
    assert.equal(results.get(CHANNEL).reason, 'timeout');
    assert.equal(results.get(OTHER_CHANNEL).reason, 'skipped');
  });
});

describe('resolveChannelsLive', () => {
  const ids = Array.from({ length: 10 }, (_, index) => `UC${String(index).padStart(22, '0')}`);

  it('runs at most `concurrency` page fetches at once and returns every channel', async () => {
    let running = 0;
    let peak = 0;
    const fetchPage = async (id) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running--;
      return { status: 'live', reason: null, videoId: 'abc123DEF45', channelId: id, title: 't' };
    };
    const results = await resolveChannelsLive(ids, { fetchPage, concurrency: 3 });
    assert.equal(peak, 3);
    assert.deepEqual([...results.keys()], ids);
    assert.ok([...results.values()].every((result) => result.status === 'live'));
  });

  it('skips the channels it cannot start before the budget runs out, without fetching them', async () => {
    let clock = 0;
    const fetched = [];
    const fetchPage = async (id) => {
      fetched.push(id);
      clock += 1_000;
      return { status: 'not-live', reason: 'not-live', videoId: null, channelId: id, title: null };
    };
    const results = await resolveChannelsLive(ids, { fetchPage, concurrency: 1, budgetMs: 2_500, now: () => clock });
    assert.deepEqual(fetched, ids.slice(0, 3));
    assert.deepEqual(ids.slice(3).map((id) => [results.get(id).status, results.get(id).reason]), ids.slice(3).map(() => ['unreadable', 'skipped']));
    assert.equal(results.size, ids.length);
  });

  it('turns a fetch that throws into that channel\'s unreadable result and keeps going', async () => {
    const fetchPage = async (id) => {
      if (id === ids[1]) throw new Error('boom');
      return { status: 'live', reason: null, videoId: 'abc123DEF45', channelId: id, title: 't' };
    };
    const results = await resolveChannelsLive(ids.slice(0, 3), { fetchPage });
    assert.deepEqual([results.get(ids[1]).status, results.get(ids[1]).reason], ['unreadable', 'fetch-error']);
    assert.equal(results.get(ids[2]).status, 'live');
  });

  it('resolves each channel once when it is listed twice', async () => {
    const fetched = [];
    const results = await resolveChannelsLive([ids[0], ids[1], ids[0]], {
      fetchPage: async (id) => { fetched.push(id); return { status: 'not-live', reason: 'not-live', videoId: null, channelId: id, title: null }; },
    });
    assert.deepEqual(fetched, [ids[0], ids[1]]);
    assert.equal(results.size, 2);
  });
});
