import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const readSrc = (relPath) => readFileSync(resolve(root, relPath), 'utf-8');

const liveNewsSrc = readSrc('src/components/LiveNewsPanel.ts') + readSrc('src/services/live-channels.ts');
const channelsWindowSrc = readSrc('src/live-channels-window.ts');
const sidecarSrc = readSrc('src-tauri/sidecar/local-api-server.mjs');
const vercelConfig = JSON.parse(readSrc('vercel.json'));
const tauriConfig = JSON.parse(readSrc('src-tauri/tauri.conf.json'));

const globalCsp = vercelConfig.headers
  .find((entry) => entry.source.includes('?!docs|embed'))
  ?.headers
  ?.find((header) => header.key === 'Content-Security-Policy')
  ?.value ?? '';
const tauriCsp = tauriConfig.app.security.csp;
const getCspDirective = (csp, directive) =>
  csp.match(new RegExp(`${directive}\\s+([^;]+)`))?.[1]?.split(/\s+/) ?? [];

// Stream entries and their integrity checks live in tests/live-video-catalog.test.mts; playback
// behaviour is pinned by tests/dom/live-news-live-verification.test.mts.

const extractArrayIds = (arrayName) => {
  const pattern = new RegExp(`const ${arrayName}[^=]*=[^\\[]*\\[([\\s\\S]*?)\\];`);
  const match = liveNewsSrc.match(pattern);
  if (!match) return [];
  return [...match[1].matchAll(/id:\s*'([^']+)'/g)].map(m => m[1]);
};

const fullIds = extractArrayIds('FULL_LIVE_CHANNELS');
const techIds = extractArrayIds('TECH_LIVE_CHANNELS');
const optionalIds = extractArrayIds('OPTIONAL_LIVE_CHANNELS');

// ── 1. Channel data integrity ──

describe('channel data integrity', () => {
  it('does not ship CNBC, whose only YouTube live stream is a documentary marathon', () => {
    assert.ok(![...fullIds, ...techIds, ...optionalIds].includes('cnbc'), 'cnbc must not be a built-in Live News channel');
    assert.doesNotMatch(liveNewsSrc, /'cnbc'/, 'no channel list or region list may still name cnbc');
  });

  it('no channel ID appears in multiple arrays with conflicting definitions', () => {
    const allIds = [...fullIds, ...techIds, ...optionalIds];
    const counts = {};
    for (const id of allIds) counts[id] = (counts[id] || 0) + 1;
    for (const [id, count] of Object.entries(counts)) {
      if (count > 1) {
        const defs = [...liveNewsSrc.matchAll(new RegExp(`id:\\s*'${id}'[^}]*}`, 'g'))].map(m => m[0]);
        const handles = defs.map(d => d.match(/handle:\s*'([^']+)'/)?.[1]);
        const uniqueHandles = new Set(handles);
        assert.equal(uniqueHandles.size, 1,
          `Channel '${id}' has conflicting handles across arrays: ${[...uniqueHandles].join(', ')}`);
      }
    }
  });

  it('TRT World handle is @TRTWorld (not @taborrtworld)', () => {
    const trt = liveNewsSrc.match(/id:\s*'trt-world'[^}]*}/);
    assert.ok(trt, 'trt-world channel not found');
    assert.match(trt[0], /handle:\s*'@TRTWorld'/,
      'TRT World handle should be @TRTWorld');
  });

  it('euronews handle is @euronews (not typo)', () => {
    const match = liveNewsSrc.match(/id:\s*'euronews'[^}]*}/);
    assert.ok(match, 'euronews channel not found');
    assert.match(match[0], /handle:\s*'@euronews'/,
      'euronews handle should be @euronews');
  });
});

// ── 2. Playback goes only through the verified live video session ──

describe('Live News playback', () => {
  it('plays through openLiveVideo and builds no player or stream of its own', () => {
    assert.match(liveNewsSrc, /openLiveVideo\(/);
    assert.doesNotMatch(liveNewsSrc, /YT\.Player|window\.YT|import\('hls\.js'\)|\/api\/hls-proxy/,
      'LiveNewsPanel must not mount YouTube or HLS players outside the live video session');
  });

  it('never looks up a channel handle to find its live video', () => {
    assert.doesNotMatch(liveNewsSrc, /\/api\/youtube\/live\?channel=/);
    assert.doesNotMatch(channelsWindowSrc, /\/api\/youtube\/live\?channel=/);
    assert.equal(existsSync(resolve(root, 'src/services/live-news.ts')), false,
      'the handle-scraping client service is retired');
  });

  it('switchChannel starts no media before the preview-only return', () => {
    const switchMethod = liveNewsSrc.slice(
      liveNewsSrc.indexOf('private switchChannel'),
      liveNewsSrc.indexOf('private nextChannel'),
    );
    const shouldStartPos = switchMethod.indexOf('const shouldStartMedia');
    const previewOnlyPos = switchMethod.indexOf('if (!shouldStartMedia)');
    const placeholderPos = switchMethod.indexOf('this.renderPlaceholder()');
    const beginPos = switchMethod.indexOf("this.beginPlayback('explicit')");
    assert.ok(shouldStartPos > 0, 'switchChannel must compute whether media should start');
    assert.ok(previewOnlyPos > shouldStartPos, 'switchChannel must branch on shouldStartMedia');
    assert.ok(placeholderPos > previewOnlyPos, 'switchChannel preview-only branch must render the placeholder');
    assert.ok(beginPos > placeholderPos, 'switchChannel must not start playback before the preview-only return');
    assert.doesNotMatch(switchMethod, /openLiveVideo|renderPlayer/, 'switchChannel must start media only through the controller');
    assert.match(switchMethod, /this\.syncOfflineButtonMarks\(\)/,
      'preview-only switch must re-sync offline marks from failure memory');
    assert.doesNotMatch(switchMethod, /classList\.remove\('offline'\)/,
      'preview-only switch must not wipe offline marks on every channel button');
  });

  it('gives each custom channel its own live-video failure-memory slot', () => {
    const sourceFn = liveNewsSrc.slice(
      liveNewsSrc.indexOf('function liveVideoSourceFor'),
      liveNewsSrc.indexOf('function hasBuiltinStreams'),
    );
    assert.match(sourceFn, /slot: `live-news\/\$\{channel\.id\}`/);
    assert.doesNotMatch(sourceFn, /slot: 'live-news\/custom'/);
  });

  it('session callbacks are ignored once a newer player replaced them', () => {
    const renderPlayer = liveNewsSrc.slice(
      liveNewsSrc.indexOf('private renderPlayer'),
      liveNewsSrc.indexOf('private ensurePlayerContainer'),
    );
    assert.match(renderPlayer, /const generation = \+\+this\.playerGeneration/);
    assert.match(renderPlayer, /onState: \(state\) => \{\s*if \(isCurrent\(\)\) this\.onVideoState\(channel, state\);/);
    // The synchronous handoff (keep only the newest session) is pinned by the DOM test in
    // tests/dom/live-news-live-verification.test.mts that starts past a channel with no stream.
  });
});

// ── 3. Sidecar YouTube embed endpoint ──

describe('sidecar youtube-embed endpoint', () => {
  it('registers /api/youtube-embed route', () => {
    assert.match(sidecarSrc, /\/api\/youtube-embed/,
      'Sidecar must handle /api/youtube-embed');
  });

  it('validates videoId format', () => {
    assert.match(sidecarSrc, /\[A-Za-z0-9_-\]\{11\}/,
      'Must validate videoId is exactly 11 chars');
  });

  it('rejects invalid videoId with 400', () => {
    assert.match(sidecarSrc, /status:\s*400/,
      'Invalid videoId must return 400');
  });

  it('whitelists video quality values', () => {
    assert.match(sidecarSrc, /small.*medium.*large.*hd720.*hd1080/,
      'Must whitelist quality parameter values');
  });

  it('is exempt from auth gate (before auth middleware)', () => {
    const embedPos = sidecarSrc.indexOf('/api/youtube-embed');
    const authPos = sidecarSrc.indexOf('Global auth gate');
    assert.ok(embedPos > 0 && authPos > 0, 'Both positions must exist');
    assert.ok(embedPos < authPos,
      'youtube-embed must be BEFORE auth gate (iframe src cannot carry auth headers)');
  });

  it('uses mute param (not hardcoded) in playerVars', () => {
    const embedSection = sidecarSrc.slice(
      sidecarSrc.indexOf('/api/youtube-embed'),
      sidecarSrc.indexOf('Global auth gate'),
    );
    assert.match(embedSection, /mute:\$\{mute\}/,
      'playerVars.mute must use the mute param, not hardcoded mute:1');
    assert.doesNotMatch(embedSection, /playerVars:\{[^}]*mute:1[^}]*\}/,
      'playerVars must NOT hardcode mute:1');
  });

  it('has postMessage bridge for play/pause/mute/unmute', () => {
    const embedSection = sidecarSrc.slice(
      sidecarSrc.indexOf('/api/youtube-embed'),
      sidecarSrc.indexOf('Global auth gate'),
    );
    assert.match(embedSection, /case'play':.*playVideo/,
      'postMessage bridge must handle play command');
    assert.match(embedSection, /case'pause':.*pauseVideo/,
      'postMessage bridge must handle pause command');
    assert.match(embedSection, /case'mute':.*\.mute\(\)/,
      'postMessage bridge must handle mute command');
    assert.match(embedSection, /case'unmute':.*\.unMute\(\)/,
      'postMessage bridge must handle unmute command');
  });

  it('has play overlay for autoplay failures', () => {
    const embedSection = sidecarSrc.slice(
      sidecarSrc.indexOf('/api/youtube-embed'),
      sidecarSrc.indexOf('Global auth gate'),
    );
    assert.match(embedSection, /play-overlay/,
      'Embed must include a play overlay for WKWebView autoplay fallback');
    assert.match(embedSection, /setTimeout.*started.*overlay/s,
      'Play overlay must show after timeout if video has not started');
  });

  it('sends yt-ready postMessage to parent on ready', () => {
    const embedSection = sidecarSrc.slice(
      sidecarSrc.indexOf('/api/youtube-embed'),
      sidecarSrc.indexOf('Global auth gate'),
    );
    assert.match(embedSection, /postToParent\(\{type:'yt-ready'\}/,
      'Must route yt-ready through the origin-checked parent bridge');
  });

  it('passes the desktop parent origin to the sidecar bridge', () => {
    assert.match(
      readSrc('src/services/live-video/session.ts'),
      /params\.set\('parentOrigin',\s*window\.location\.origin\)/,
      'the live video session must identify its parent origin to the sidecar bridge',
    );
  });
});

// ── 4. CSP allows HLS media and desktop sidecar iframe ──

describe('CSP configuration', () => {
  it('web header media-src allows https: for CDN HLS streams', () => {
    assert.ok(getCspDirective(globalCsp, 'media-src').includes('https:'),
      'web CSP media-src must allow HTTPS for direct HLS CDN streams');
  });

  it('Tauri CSP frame-src allows localhost sidecar iframe origins', () => {
    const frameSrc = getCspDirective(tauriCsp, 'frame-src');
    assert.ok(frameSrc.includes('http://127.0.0.1:*'),
      'Tauri CSP frame-src must allow 127.0.0.1 sidecar iframe origins');
    assert.ok(frameSrc.includes('http://localhost:*'),
      'Tauri CSP frame-src must allow localhost sidecar iframe origins');
  });

  it('Tauri CSP media-src allows localhost sidecar and HTTPS HLS media', () => {
    const mediaSrc = getCspDirective(tauriCsp, 'media-src');
    assert.ok(mediaSrc.includes('https:'),
      'Tauri CSP media-src must allow HTTPS for direct HLS CDN streams');
    assert.ok(mediaSrc.includes('http://127.0.0.1:*'),
      'Tauri CSP media-src must allow 127.0.0.1 sidecar media origins');
    assert.ok(mediaSrc.includes('http://localhost:*'),
      'Tauri CSP media-src must allow localhost sidecar media origins');
  });
});
