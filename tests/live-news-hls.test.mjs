import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const readSrc = (relPath) => readFileSync(resolve(root, relPath), 'utf-8');

const liveNewsSrc = readSrc('src/components/LiveNewsPanel.ts');
const liveNewsSvc = readSrc('src/services/live-news.ts');
const youtubeApi = readSrc('api/youtube/live.js');
const sidecarSrc = readSrc('src-tauri/sidecar/local-api-server.mjs');
const indexHtml = readSrc('index.html');

// ── Extract channel IDs and DIRECT_HLS_MAP keys from source ──

const extractArrayIds = (arrayName) => {
  const pattern = new RegExp(`const ${arrayName}[^=]*=[^\\[]*\\[([\\s\\S]*?)\\];`);
  const match = liveNewsSrc.match(pattern);
  if (!match) return [];
  return [...match[1].matchAll(/id:\s*'([^']+)'/g)].map(m => m[1]);
};

const fullIds = extractArrayIds('FULL_LIVE_CHANNELS');
const techIds = extractArrayIds('TECH_LIVE_CHANNELS');
const optionalIds = extractArrayIds('OPTIONAL_LIVE_CHANNELS');
const allChannelIds = new Set([...fullIds, ...techIds, ...optionalIds]);

const hlsMapMatch = liveNewsSrc.match(/const DIRECT_HLS_MAP[^{]*\{([\s\S]*?)\};/);
const hlsMapEntries = hlsMapMatch
  ? [...hlsMapMatch[1].matchAll(/'([^']+)':\s*'([^']+)'/g)].map(m => ({ id: m[1], url: m[2] }))
  : [];

const hlsMapIds = new Set(hlsMapEntries.map(e => e.id));

// ── 1. DIRECT_HLS_MAP integrity ──

describe('DIRECT_HLS_MAP integrity', () => {
  it('has at least 6 entries', () => {
    assert.ok(hlsMapEntries.length >= 6, `Expected ≥6 entries, got ${hlsMapEntries.length}`);
  });

  it('every key maps to an existing channel definition', () => {
    for (const { id } of hlsMapEntries) {
      assert.ok(allChannelIds.has(id), `DIRECT_HLS_MAP key '${id}' has no matching channel`);
    }
  });

  it('every mapped channel has a fallbackVideoId', () => {
    for (const { id } of hlsMapEntries) {
      const channelDef = liveNewsSrc.match(new RegExp(`id:\\s*'${id}'[^}]*}`));
      assert.ok(channelDef, `Channel '${id}' definition not found`);
      assert.match(channelDef[0], /fallbackVideoId:\s*'[^']+'/,
        `Channel '${id}' in DIRECT_HLS_MAP lacks fallbackVideoId`);
    }
  });

  it('all HLS URLs use HTTPS', () => {
    for (const { id, url } of hlsMapEntries) {
      assert.ok(url.startsWith('https://'), `HLS URL for '${id}' is not HTTPS: ${url}`);
    }
  });

  it('all HLS URLs end with .m3u8', () => {
    for (const { id, url } of hlsMapEntries) {
      assert.ok(url.endsWith('.m3u8'), `HLS URL for '${id}' does not end with .m3u8: ${url}`);
    }
  });

  it('no duplicate channel IDs in the map', () => {
    const ids = hlsMapEntries.map(e => e.id);
    assert.equal(ids.length, new Set(ids).size, 'Duplicate IDs in DIRECT_HLS_MAP');
  });
});

// ── 2. Channel data integrity ──

describe('channel data integrity', () => {
  it('all FULL_LIVE_CHANNELS have fallbackVideoId', () => {
    for (const id of fullIds) {
      const match = liveNewsSrc.match(new RegExp(`id:\\s*'${id}'[^}]*}`, 's'));
      assert.ok(match, `Channel '${id}' not found`);
      assert.match(match[0], /fallbackVideoId:\s*'[^']+'/,
        `FULL channel '${id}' missing fallbackVideoId`);
    }
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

// ── 3. renderNativeHlsPlayer safety checks ──

describe('renderNativeHlsPlayer safety', () => {
  it('validates HLS URL starts with https://', () => {
    assert.match(liveNewsSrc, /hlsUrl\.startsWith\('https:\/\/'\)/,
      'Must validate HLS URL is HTTPS before creating video element');
  });

  it('captures activeChannel ref for race safety in error handler', () => {
    assert.match(liveNewsSrc, /const failedChannel\s*=\s*this\.activeChannel/,
      'Error handler must capture channel ref to avoid race conditions');
  });

  it('sets cooldown on HLS failure', () => {
    assert.match(liveNewsSrc, /this\.hlsFailureCooldown\.set\(failedChannel\.id/,
      'Must set cooldown timestamp on failure');
  });

  it('checks activeChannel identity before fallback', () => {
    assert.match(liveNewsSrc, /this\.activeChannel\.id\s*===\s*failedChannel\.id/,
      'Must verify channel hasn\'t changed before falling back');
  });

  it('explicitly stops video element on error', () => {
    assert.match(liveNewsSrc, /video\.pause\(\);\s*\n\s*video\.removeAttribute\('src'\)/,
      'Must pause and clear src on error for explicit cleanup');
  });
});

// ── 4. getDirectHlsUrl cooldown logic ──

describe('getDirectHlsUrl cooldown', () => {
  it('checks cooldown map before returning URL', () => {
    assert.match(liveNewsSrc, /this\.hlsFailureCooldown\.get\(channelId\)/,
      'Must check cooldown before returning HLS URL');
  });

  it('uses HLS_COOLDOWN_MS for timeout comparison', () => {
    assert.match(liveNewsSrc, /Date\.now\(\)\s*-\s*failedAt\s*<\s*this\.HLS_COOLDOWN_MS/,
      'Must compare against HLS_COOLDOWN_MS');
  });

  it('cooldown is at least 1 minute', () => {
    const match = liveNewsSrc.match(/HLS_COOLDOWN_MS\s*=\s*(\d+)\s*\*\s*(\d+)\s*\*\s*(\d+)/);
    assert.ok(match, 'HLS_COOLDOWN_MS not found');
    const ms = Number(match[1]) * Number(match[2]) * Number(match[3]);
    assert.ok(ms >= 60_000, `Cooldown too short: ${ms}ms (need ≥60s)`);
  });
});

// ── 5. Player decision tree ordering ──

describe('player decision tree', () => {
  it('switchChannel checks direct HLS before videoId validation', () => {
    const switchMethod = liveNewsSrc.slice(
      liveNewsSrc.indexOf('private async switchChannel'),
      liveNewsSrc.indexOf('private showOfflineMessage'),
    );
    const hlsPos = switchMethod.indexOf('getDirectHlsUrl(channel.id)');
    const videoIdPos = switchMethod.indexOf("!/^[\\w-]{10,12}$/.test(channel.videoId)");
    assert.ok(hlsPos > 0, 'getDirectHlsUrl not found in switchChannel');
    assert.ok(videoIdPos > 0, 'videoId validation not found in switchChannel');
    assert.ok(hlsPos < videoIdPos,
      'Direct HLS check must come BEFORE videoId validation in switchChannel');
  });

  it('initializePlayer checks direct HLS before videoId validation', () => {
    const initMethod = liveNewsSrc.slice(
      liveNewsSrc.indexOf('private async initializePlayer'),
      liveNewsSrc.indexOf('private startBotCheckTimeout'),
    );
    const hlsPos = initMethod.indexOf('getDirectHlsUrl(this.activeChannel.id)');
    const videoIdPos = initMethod.indexOf("!/^[\\w-]{10,12}$/.test(this.activeChannel.videoId)");
    assert.ok(hlsPos > 0, 'getDirectHlsUrl not found in initializePlayer');
    assert.ok(videoIdPos > 0, 'videoId validation not found in initializePlayer');
    assert.ok(hlsPos < videoIdPos,
      'Direct HLS check must come BEFORE videoId validation in initializePlayer');
  });
});

// ── 6. resolveChannelVideo skips YouTube API for direct HLS ──

describe('resolveChannelVideo optimization', () => {
  it('skips fetchLiveVideoInfo for desktop direct-HLS channels', () => {
    const resolve = liveNewsSrc.slice(
      liveNewsSrc.indexOf('private async resolveChannelVideo'),
      liveNewsSrc.indexOf('private async switchChannel'),
    );
    const directHlsPos = resolve.indexOf('getDirectHlsUrl(channel.id)');
    const fetchPos = resolve.indexOf('fetchLiveVideoInfo');
    assert.ok(directHlsPos > 0, 'getDirectHlsUrl not in resolveChannelVideo');
    assert.ok(fetchPos > 0, 'fetchLiveVideoInfo not in resolveChannelVideo');
    assert.ok(directHlsPos < fetchPos,
      'Direct HLS early return must come before fetchLiveVideoInfo call');
  });
});

// ── 7. YouTube API: hlsUrl extraction ──

describe('YouTube API hlsManifestUrl extraction', () => {
  it('extracts hlsManifestUrl from page HTML', () => {
    assert.match(youtubeApi, /hlsManifestUrl/,
      'API must extract hlsManifestUrl');
  });

  it('unescapes \\u0026 in HLS URL', () => {
    assert.match(youtubeApi, /\\\\u0026/,
      'Must unescape \\u0026 to & in HLS URLs');
  });

  it('only sets hlsUrl when videoId is present', () => {
    assert.match(youtubeApi, /hlsMatch\s*&&\s*videoId/,
      'hlsUrl must only be set when a live videoId was found');
  });

  it('includes hlsUrl in response JSON', () => {
    assert.match(youtubeApi, /JSON\.stringify\(\{[^}]*hlsUrl/,
      'Response must include hlsUrl field');
  });
});

// ── 8. live-news.ts service ──

describe('fetchLiveVideoInfo service', () => {
  it('exports fetchLiveVideoInfo function', () => {
    assert.match(liveNewsSvc, /export async function fetchLiveVideoInfo/,
      'Must export fetchLiveVideoInfo');
  });

  it('returns hlsUrl from API response', () => {
    assert.match(liveNewsSvc, /hlsUrl\s*=\s*data\.hlsUrl/,
      'Must propagate hlsUrl from API response');
  });

  it('caches hlsUrl alongside videoId', () => {
    assert.match(liveNewsSvc, /liveVideoCache\.set\([^)]*hlsUrl/,
      'Cache must store hlsUrl');
  });

  it('returns null hlsUrl on error', () => {
    assert.match(liveNewsSvc, /return\s*\{\s*videoId:\s*null,\s*hlsUrl:\s*null\s*\}/,
      'Error path must return null for both videoId and hlsUrl');
  });

  it('keeps deprecated fetchLiveVideoId for backwards compat', () => {
    assert.match(liveNewsSvc, /@deprecated/,
      'fetchLiveVideoId should be marked deprecated');
    assert.match(liveNewsSvc, /export async function fetchLiveVideoId/,
      'fetchLiveVideoId must still be exported');
  });
});

// ── 9. Sidecar YouTube embed endpoint ──

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
    assert.match(embedSection, /postMessage\(\{type:'yt-ready'\}/,
      'Must send yt-ready message to parent window');
  });
});

// ── 10. Optional channels with fallbackVideoId ──

describe('optional channels fallback coverage', () => {
  const highPriorityOptional = ['livenow-fox', 'abc-news', 'nbc-news', 'wion'];

  for (const id of highPriorityOptional) {
    it(`${id} has fallbackVideoId`, () => {
      const match = liveNewsSrc.match(new RegExp(`id:\\s*'${id}'[^}]*}`));
      assert.ok(match, `Channel '${id}' not found in OPTIONAL_LIVE_CHANNELS`);
      assert.match(match[0], /fallbackVideoId:\s*'[A-Za-z0-9_-]{11}'/,
        `Optional channel '${id}' must have a valid 11-char fallbackVideoId`);
    });
  }

  it('channels with useFallbackOnly also have fallbackVideoId', () => {
    const useFallbackMatches = [...liveNewsSrc.matchAll(/id:\s*'([^']+)'[^}]*useFallbackOnly:\s*true[^}]*}/g)];
    for (const m of useFallbackMatches) {
      const channelId = m[1];
      assert.match(m[0], /fallbackVideoId:\s*'[^']+'/,
        `Channel '${channelId}' has useFallbackOnly but no fallbackVideoId`);
    }
  });
});

// ── 11. CSP allows sidecar iframe ──

describe('CSP configuration', () => {
  it('frame-src allows http://127.0.0.1:*', () => {
    assert.match(indexHtml, /frame-src[^;]*http:\/\/127\.0\.0\.1:\*/,
      'CSP frame-src must allow sidecar localhost origin for YouTube embed iframe');
  });

  it('media-src allows https: for CDN HLS streams', () => {
    assert.match(indexHtml, /media-src[^;]*https:/,
      'CSP media-src must allow HTTPS for direct HLS CDN streams');
  });
});
