import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { ApiError, createClient } from '../src/tui/data/client.mjs';
import { BOOT_ORDER, SOURCES, Store } from '../src/tui/data/store.mjs';
import {
  ageOf,
  allHeadlines,
  ciiRanking,
  enumLabel,
  fmtNum,
  fmtPct,
  fmtPrice,
  mapBlips,
  newsCategories,
  quoteGroups,
  streamCandidates,
  tickerSegments,
  youtubeChannelId,
  youtubeVideoId,
} from '../src/tui/data/select.mjs';
import { DEFAULT_PREFS, loadPrefs, prefsPath, savePrefs } from '../src/tui/prefs.mjs';
import { THEMES } from '../src/tui/ui/theme.mjs';
import { detectTerminalGraphics, mpvArgs, openExternal, playInWindow } from '../src/tui/video.mjs';
import { findRepoRoot, runWeb } from '../src/tui/web.mjs';

const bootstrap = JSON.parse(readFileSync(new URL('./fixtures/bootstrap.json', import.meta.url), 'utf8'));
const digest = JSON.parse(readFileSync(new URL('./fixtures/digest.json', import.meta.url), 'utf8'));
const t = THEMES.neon;

function fakeFetch(routes) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, init });
    for (const [match, handler] of routes) {
      if (url.includes(match)) {
        const res = typeof handler === 'function' ? handler(url, init) : handler;
        const status = res.status || 200;
        const body = typeof res.body === 'string' ? res.body : JSON.stringify(res.body ?? {});
        return { ok: status >= 200 && status < 300, status, text: async () => body, headers: new Map() };
      }
    }
    return { ok: false, status: 404, text: async () => '{"error":"not found"}', headers: new Map() };
  };
  return { fetch, calls };
}

describe('client', () => {
  it('sends the user agent and no credential for public reads', async () => {
    const { fetch, calls } = fakeFetch([['/api/version', { body: { version: '1' } }]]);
    const c = createClient({ fetch, userAgent: 'worldmonitor-tui/test (+https://worldmonitor.app)' });
    const body = await c.getJson('/api/version');
    assert.equal(body.version, '1');
    assert.equal(calls[0].url, 'https://api.worldmonitor.app/api/version');
    assert.equal(calls[0].init.headers['user-agent'], 'worldmonitor-tui/test (+https://worldmonitor.app)');
    assert.equal(calls[0].init.headers['X-WorldMonitor-Key'], undefined);
  });
  it('mints an anonymous session once and re-mints after a 401', async () => {
    let mints = 0;
    let rejectNext = true;
    const { fetch, calls } = fakeFetch([
      ['/api/wm-session', () => ({ body: { ok: true, token: `wms_${++mints}`, exp: Date.now() + 3600000 } })],
      [
        '/api/maritime',
        (_url, init) => {
          if (rejectNext && init.headers['X-WorldMonitor-Key'] === 'wms_1') {
            rejectNext = false;
            return { status: 401, body: { error: 'API key required' } };
          }
          return { body: { snapshot: { token: init.headers['X-WorldMonitor-Key'] } } };
        },
      ],
    ]);
    const c = createClient({ fetch });
    const a = await c.getJson('/api/maritime/v1/get-vessel-snapshot', { auth: 'session' });
    assert.equal(a.snapshot.token, 'wms_2');
    assert.equal(mints, 2);
    await c.getJson('/api/maritime/v1/get-vessel-snapshot', { auth: 'session' });
    assert.equal(mints, 2, 'the valid session is reused');
    assert.equal(calls.filter((x) => x.url.includes('wm-session'))[0].init.method, 'POST');
  });
  it('prefers a configured API key over a session', async () => {
    const { fetch, calls } = fakeFetch([['/api/x', { body: {} }]]);
    const c = createClient({ fetch, apiKey: 'wm_abc' });
    await c.getJson('/api/x', { auth: 'session' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init.headers['X-WorldMonitor-Key'], 'wm_abc');
  });
  it('throws ApiError with status and body on failures', async () => {
    const { fetch } = fakeFetch([['/api/boom', { status: 503, body: { error: 'down' } }]]);
    const c = createClient({ fetch });
    await assert.rejects(c.getJson('/api/boom'), (err) => err instanceof ApiError && err.status === 503 && /down/.test(err.message));
  });
});

describe('store', () => {
  function makeStore(now = { t: 1000000 }) {
    const { fetch, calls } = fakeFetch([
      ['tier=fast', { body: { data: { marketQuotes: bootstrap.data.marketQuotes, insights: bootstrap.data.insights }, missing: ['pizzint'] } }],
      ['tier=slow', { body: { data: { ucdpEvents: bootstrap.data.ucdpEvents } } }],
      ['keys=cyberThreats', { body: { data: { cyberThreats: bootstrap.data.cyberThreats } } }],
      ['list-feed-digest', { body: digest }],
      ['/api/health', { body: { status: 'HEALTHY', summary: { total: 1, ok: 1 } } }],
      ['/api/version', { body: { version: '2.11.0' } }],
      ['/api/wm-session', { body: { ok: true, token: 'wms_x', exp: Date.now() + 3600000 } }],
      ['list-military-flights', { body: { flights: [{ id: 'a', callsign: 'TEST1', location: { latitude: 1, longitude: 2 } }] } }],
      ['bootstrap', { body: { data: {} } }],
    ]);
    const client = createClient({ fetch });
    const store = new Store(client, { now: () => now.t });
    return { store, calls, now };
  }
  it('boots sources in order and merges bootstrap keys', async () => {
    const { store, calls } = makeStore();
    const progress = [];
    await store.boot((p, id) => progress.push([p, id]));
    assert.equal(progress.length, BOOT_ORDER.length);
    assert.equal(progress[progress.length - 1][0], 1);
    assert.ok(store.data.marketQuotes.quotes.length > 0);
    assert.ok(store.data.ucdpEvents.events.length > 0);
    assert.ok(store.data.cyberThreats.threats.length > 0);
    assert.equal(store.raw.digest.generatedAt, digest.generatedAt);
    assert.equal(store.raw.version.version, '2.11.0');
    assert.deepEqual(store.meta.fast.missing, ['pizzint']);
    assert.equal(store.status().errors.length, 0);
    assert.ok(!calls.some((c) => c.url.includes('list-military-flights')), 'lazy sources do not load at boot');
  });
  it('respects refresh intervals and loads lazy sources only when wanted', async () => {
    const { store, calls, now } = makeStore();
    await store.refresh('fast');
    const n = calls.length;
    assert.equal(await store.refresh('fast'), false, 'fresh data is not refetched');
    assert.equal(calls.length, n);
    now.t += SOURCES.fast.every + 1;
    assert.equal(await store.refresh('fast'), true);
    store.want('flights');
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(store.raw.flights.flights[0].callsign, 'TEST1');
    assert.ok(calls.some((c) => c.url.includes('wm-session')), 'session minted for flights');
  });
  it('records errors with backoff and emits events', async () => {
    const { fetch } = fakeFetch([['tier=fast', { status: 503, body: { error: 'nope' } }]]);
    const store = new Store(createClient({ fetch }), { now: () => 5000000 });
    const events = [];
    store.on('error', (id, msg) => events.push([id, msg]));
    assert.equal(await store.refresh('fast'), false);
    assert.match(store.meta.fast.error, /503/);
    assert.equal(events.length, 1);
    assert.equal(store.status().errors[0], 'fast');
  });
  it('reports a failed refresh without an error listener instead of throwing', async () => {
    const { fetch } = fakeFetch([['tier=fast', { status: 503, body: { error: 'nope' } }]]);
    const store = new Store(createClient({ fetch }), { now: () => 5000000 });
    assert.equal(await store.refresh('fast'), false);
    assert.match(store.meta.fast.error, /503/);
  });
  it('keeps a failed source at no-success while backing off', async () => {
    const now = { t: 5000000 };
    const { fetch, calls } = fakeFetch([['tier=fast', { status: 503, body: { error: 'nope' } }]]);
    const store = new Store(createClient({ fetch }), { now: () => now.t });
    store.on('error', () => {});
    await store.refresh('fast');
    assert.equal(store.meta.fast.loadedAt, 0, 'a failure is not a load');
    assert.equal(store.age('fast'), Infinity);
    const n = calls.length;
    now.t += 5000;
    assert.equal(await store.refresh('fast'), false, 'backoff holds the retry');
    assert.equal(calls.length, n);
    now.t += 15000;
    await store.refresh('fast');
    assert.equal(calls.length, n + 1, 'retries once the backoff passes');
  });
  it('stops booting and does not restart polling once stopped', async () => {
    const { store, calls } = makeStore();
    const seen = [];
    const booting = store.boot((_p, id) => {
      seen.push(id);
      if (seen.length === 2) store.stop();
    });
    await booting;
    assert.equal(seen.length, 2, 'boot halts after stop()');
    assert.equal(calls.filter((c) => !c.url.includes('wm-session')).length, 2);
  });
});

describe('client shutdown', () => {
  it('aborts in-flight requests and refuses new ones after close()', async () => {
    let aborted = false;
    const fetch = (_url, init) =>
      new Promise((_, reject) => {
        init.signal.addEventListener('abort', () => {
          aborted = true;
          reject(init.signal.reason);
        });
      });
    const client = createClient({ fetch, timeoutMs: 60000 });
    const pending = client.getJson('/api/health');
    client.close();
    await assert.rejects(pending, /client closed/);
    assert.equal(aborted, true);
    await assert.rejects(client.getJson('/api/version'), /client closed/);
  });
});

describe('selectors', () => {
  it('formats numbers, prices, percentages and ages', () => {
    assert.equal(fmtNum(265562010866), '265.56B');
    assert.equal(fmtNum(1234567), '1.23M');
    assert.equal(fmtPrice(0.80728), '0.8073');
    assert.equal(fmtPrice(81433), '81,433.00');
    assert.equal(fmtPct(1.5), '+1.50%');
    assert.equal(ageOf(1_700_000_000_000, 1_700_000_060_000), '1m');
    assert.equal(ageOf(1_700_000_000, 1_700_000_060_000), '1m', 'second-resolution timestamps are scaled');
    assert.equal(ageOf(undefined), '—');
  });
  it('turns protobuf enums into labels', () => {
    assert.equal(enumLabel('THREAT_LEVEL_HIGH'), 'high');
    assert.equal(enumLabel('UCDP_VIOLENCE_TYPE_ONE_SIDED'), 'one sided');
    assert.equal(enumLabel('SERVICE_OPERATIONAL_STATUS_PARTIAL_OUTAGE'), 'partial outage');
    assert.equal(enumLabel('UNREST_EVENT_TYPE_UNSPECIFIED'), '');
  });
  it('orders news categories and ranks headlines', () => {
    const cats = newsCategories(digest);
    assert.ok(cats.length > 0);
    assert.equal(cats[0].id, 'politics');
    const top = allHeadlines(digest, 5);
    assert.equal(top.length, 5);
    assert.ok((top[0].importanceScore || 0) >= (top[4].importanceScore || 0));
  });
  it('groups quotes and builds map blips and ticker segments', () => {
    const g = quoteGroups(bootstrap.data);
    assert.ok(g.indices.length && g.crypto.length && g.sectors.length);
    const blips = mapBlips(bootstrap.data, t);
    assert.ok(blips.length > 0);
    assert.ok(blips.every((b) => Number.isFinite(b.lat) && Number.isFinite(b.lon)));
    const segs = tickerSegments(bootstrap.data, digest, t);
    assert.ok(segs.some((s) => s.text.includes('SPX')));
    assert.ok(ciiRanking(bootstrap.data)[0].combinedScore >= ciiRanking(bootstrap.data)[1].combinedScore);
  });
  it('resolves live stream candidates', () => {
    assert.equal(youtubeChannelId('https://www.youtube.com/channel/UCIALMKvObZNtJ6AmdCLP7Lg'), 'UCIALMKvObZNtJ6AmdCLP7Lg');
    assert.equal(youtubeVideoId('https://www.youtube.com/watch?v=QB5BNdBFujE'), 'QB5BNdBFujE');
    assert.equal(youtubeVideoId('QB5BNdBFujE'), 'QB5BNdBFujE');
    const now = Date.parse('2026-10-17T19:00:00Z');
    const c = streamCandidates(
      ['https://bloomberg.com/media-manifest/streams/us.m3u8', 'https://www.youtube.com/channel/UCIALMKvObZNtJ6AmdCLP7Lg'],
      bootstrap.data.liveVideoResolved,
      now,
    );
    assert.deepEqual(
      c.map((x) => x.kind),
      ['hls', 'youtube', 'youtube-channel'],
    );
    assert.equal(c[1].url, 'https://www.youtube.com/watch?v=QB5BNdBFujE');
    const stale = streamCandidates(['https://www.youtube.com/channel/UCIALMKvObZNtJ6AmdCLP7Lg'], bootstrap.data.liveVideoResolved, now + 48 * 3600 * 1000);
    assert.deepEqual(
      stale.map((x) => x.kind),
      ['youtube-channel'],
    );
  });
});

describe('prefs', () => {
  it('round-trips through XDG_CONFIG_HOME and never stores a key', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wm-tui-'));
    try {
      const env = { XDG_CONFIG_HOME: dir };
      assert.equal(prefsPath(env), join(dir, 'worldmonitor', 'tui.json'));
      assert.deepEqual(loadPrefs(env), DEFAULT_PREFS);
      assert.equal(savePrefs({ theme: 'matrix', animations: false, apiKey: 'wm_secret' }, env), true);
      const raw = readFileSync(prefsPath(env), 'utf8');
      assert.ok(raw.includes('matrix'));
      assert.ok(!raw.includes('wm_secret'), 'only known preference keys are written');
      assert.equal(loadPrefs(env).theme, 'matrix');
      assert.equal(loadPrefs(env).animations, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('video', () => {
  it('detects terminal graphics', () => {
    assert.equal(detectTerminalGraphics({ TERM_PROGRAM: 'ghostty' }), 'kitty');
    assert.equal(detectTerminalGraphics({ KITTY_WINDOW_ID: '1' }), 'kitty');
    assert.equal(detectTerminalGraphics({ TERM: 'xterm-256color' }), 'tct');
    assert.equal(detectTerminalGraphics({ TERM_PROGRAM: 'ghostty', TMUX: '/tmp/x' }), 'tct');
    assert.equal(detectTerminalGraphics({ WM_TUI_VO: 'sixel' }), 'sixel');
  });
  it('builds mpv arguments for terminal and window modes', () => {
    const term = mpvArgs('https://x/y.m3u8', { mode: 'terminal', vo: 'kitty', title: 'T' });
    assert.ok(term.includes('--vo=kitty'));
    assert.equal(term[term.length - 1], 'https://x/y.m3u8');
    assert.ok(!term.includes('--force-window=yes'));
    const win = mpvArgs('u', { mode: 'window' });
    assert.ok(win.includes('--force-window=yes'));
    assert.ok(!win.some((a) => a.startsWith('--vo=')));
  });
});

// The checkout root (cli/test -> repo), whatever the clone or worktree is named.
const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');

describe('web command', () => {
  it('finds the repository root from inside the checkout', () => {
    const root = findRepoRoot(HERE);
    assert.equal(root, REPO_ROOT);
    assert.equal(findRepoRoot(tmpdir(), 'file:///nowhere/x.mjs'), null);
  });
  it('opens the hosted dashboard when not in a checkout or with --hosted', async () => {
    const opened = [];
    let out = '';
    const code = await runWeb({ options: { hosted: true }, stdout: (s) => (out += s), open: (u) => opened.push(u) });
    assert.equal(code, 0);
    assert.deepEqual(opened, ['https://www.worldmonitor.app/dashboard']);
    assert.match(out, /Opening https:\/\/www\.worldmonitor\.app\/dashboard/);
  });
  it('starts the dev server from a checkout and opens the printed local URL', async () => {
    const opened = [];
    const { EventEmitter } = await import('node:events');
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.kill = () => {};
    let spawned = null;
    const spawnImpl = (cmd, args, opts) => {
      spawned = { cmd, args, opts };
      setTimeout(() => {
        child.stdout.emit('data', Buffer.from('  ➜  Local:   \x1b[36mhttp://localhost:5173/\x1b[0m\n'));
        child.emit('exit', 0);
      }, 5);
      return child;
    };
    const code = await runWeb({ options: { port: 5173 }, stdout: () => {}, open: (u) => opened.push(u), spawnImpl, cwd: HERE });
    assert.equal(code, 0);
    assert.deepEqual(opened, ['http://localhost:5173/']);
    assert.deepEqual(spawned.args.slice(0, 3), ['run', 'dev', '--']);
    assert.equal(spawned.opts.cwd, REPO_ROOT);
    assert.equal(spawned.opts.shell, false);
  });
  it('runs npm.cmd through a shell on Windows and rejects a non-numeric port', async () => {
    let spawned = null;
    const { EventEmitter } = await import('node:events');
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.kill = () => {};
    const spawnImpl = (cmd, args, opts) => {
      spawned = { cmd, args, opts };
      setTimeout(() => child.emit('exit', 0), 1);
      return child;
    };
    const quiet = { stdout: () => {}, stderr: () => {}, open: () => {}, cwd: HERE };
    assert.equal(await runWeb({ ...quiet, options: { port: '4000', noOpen: true }, spawnImpl, platform: 'win32' }), 0);
    assert.equal(spawned.cmd, 'npm.cmd');
    assert.equal(spawned.opts.shell, true);
    spawned = null;
    let err = '';
    assert.equal(await runWeb({ ...quiet, stderr: (s) => (err += s), options: { port: '4000&calc' }, spawnImpl, platform: 'win32' }), 2);
    assert.equal(spawned, null);
    assert.match(err, /Invalid port/);
  });
  it('reports a synchronous spawn failure instead of throwing', async () => {
    let err = '';
    const spawnImpl = () => {
      throw Object.assign(new Error('spawn EINVAL'), { code: 'EINVAL' });
    };
    const code = await runWeb({ options: { noOpen: true }, stdout: () => {}, stderr: (s) => (err += s), open: () => {}, spawnImpl, cwd: HERE });
    assert.equal(code, 1);
    assert.match(err, /EINVAL/);
  });
  it('leaves opening to the CLI, reads a URL split across chunks, and removes its signal handlers', async () => {
    const opened = [];
    const { EventEmitter } = await import('node:events');
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.kill = () => {};
    let spawned = null;
    const before = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
    const spawnImpl = (cmd, args, opts) => {
      spawned = { cmd, args, opts };
      setTimeout(() => {
        child.stdout.emit('data', Buffer.from('  ➜  Local:   http://local'));
        child.stdout.emit('data', Buffer.from('host:5173/\n'));
        child.emit('exit', 0);
      }, 5);
      return child;
    };
    const code = await runWeb({ options: { port: 5173 }, stdout: () => {}, open: (u) => opened.push(u), spawnImpl, cwd: HERE, env: { PATH: '/bin' } });
    assert.equal(code, 0);
    assert.deepEqual(opened, ['http://localhost:5173/']);
    assert.equal(spawned.opts.env.BROWSER, 'none', 'Vite must not open a second tab or ignore --no-open');
    assert.equal(spawned.opts.env.PATH, '/bin');
    assert.deepEqual([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')], before);
  });
});

describe('opening links', () => {
  const recorder = () => {
    const calls = [];
    const spawnImpl = (cmd, args) => {
      calls.push({ cmd, args });
      return { on() {}, unref() {} };
    };
    return { calls, spawnImpl };
  };
  it('never routes a feed link through cmd.exe on Windows', () => {
    const { calls, spawnImpl } = recorder();
    const url = 'https://example.com/a?x=1&calc.exe';
    assert.equal(openExternal(url, { platform: 'win32', spawnImpl }).ok, true);
    assert.equal(calls.length, 1);
    assert.notEqual(calls[0].cmd.toLowerCase(), 'cmd');
    assert.deepEqual(calls[0].args, ['url.dll,FileProtocolHandler', url]);
  });
  it('refuses links that are not http(s)', () => {
    const { calls, spawnImpl } = recorder();
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', '--help', 'not a url']) {
      assert.equal(openExternal(url, { platform: 'linux', spawnImpl }).ok, false, url);
    }
    assert.equal(calls.length, 0);
  });
  it('survives an asynchronous mpv window spawn error', async () => {
    const { EventEmitter } = await import('node:events');
    const child = new EventEmitter();
    child.unref = () => {};
    const res = playInWindow('https://x/y.m3u8', { player: { mpv: '/missing/mpv' }, spawnImpl: () => child });
    assert.equal(res.ok, true);
    // With no 'error' listener this emit would throw ERR_UNHANDLED_ERROR.
    assert.doesNotThrow(() => child.emit('error', new Error('spawn ENOENT')));
  });
});
