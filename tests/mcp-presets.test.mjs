/**
 * Static validation for MCP preset definitions in src/services/mcp-store.ts.
 *
 * These tests run in CI without network access and catch:
 *  - Missing required fields
 *  - Private/invalid serverUrls
 *  - Duplicate serverUrls
 *  - Known-dead or outdated URLs
 *  - Invalid defaultArgs structure
 *
 * Live connectivity tests are skipped unless LIVE_MCP_TESTS=1 is set.
 */

import { strict as assert } from 'node:assert';
import { after, describe, it } from 'node:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

import { extractPresets, isTemplatePreset, probePreset } from '../scripts/lib/mcp-preset-liveness.mjs';

const presets = extractPresets(readFileSync(resolve(root, 'src/services/mcp-store.ts'), 'utf8'));

// Known-dead or moved URLs that must NOT appear in presets
const BANNED_URLS = [
  'https://slack.mcp.cloudflare.com/mcp',       // wrong — Cloudflare-hosted Slack doesn't exist
  'https://maps.mcp.cloudflare.com/mcp',         // wrong — Cloudflare-hosted Maps doesn't exist
  'https://mcp-fetch.cloudflare.com/mcp',        // wrong — old Browser Fetch URL
  'https://server.smithery.ai/@amadevs/mcp-server-overpass/mcp', // 404 on Smithery
  'https://weatherforensics.dev/mcp/free', // vendor backend unavailable; replaced by Open-Meteo
];

// Private/RFC1918 host patterns (SSRF risk)
const BLOCKED_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^::1$/,
  /^fd[0-9a-f]{2}:/i,
  /^fe80:/i,
];

describe('MCP Presets — static validation', () => {
  it('extracts a non-empty preset list from mcp-store.ts', () => {
    assert.ok(presets.length > 0, 'MCP preset extraction must not be empty');
  });

  it('all presets have required string fields: name, serverUrl, defaultTool', () => {
    const missing = presets.filter(p => !p.name || !p.serverUrl || !p.defaultTool);
    assert.deepEqual(missing, [], `Presets missing required fields: ${missing.map(p => p.name).join(', ')}`);
  });

  it('all serverUrls use https:// protocol', () => {
    const nonHttps = presets.filter(p => {
      try { return new URL(p.serverUrl).protocol !== 'https:'; }
      catch { return true; }
    });
    assert.deepEqual(nonHttps, [], `Presets with non-https serverUrl: ${nonHttps.map(p => p.name).join(', ')}`);
  });

  it('no duplicate serverUrls', () => {
    const seen = new Set();
    const dupes = [];
    for (const p of presets) {
      if (seen.has(p.serverUrl)) dupes.push(p.name);
      seen.add(p.serverUrl);
    }
    assert.deepEqual(dupes, [], `Duplicate serverUrls for: ${dupes.join(', ')}`);
  });

  it('no serverUrls point to private/RFC1918 hosts', () => {
    const ssrf = presets.filter(p => {
      try {
        const host = new URL(p.serverUrl).hostname;
        return BLOCKED_HOST_PATTERNS.some(pat => pat.test(host));
      } catch { return false; }
    });
    assert.deepEqual(ssrf, [], `Presets with private-host serverUrls (SSRF risk): ${ssrf.map(p => p.name).join(', ')}`);
  });

  it('no known-dead or banned serverUrls', () => {
    const dead = presets.filter(p => BANNED_URLS.includes(p.serverUrl));
    assert.deepEqual(dead, [], `Presets using known-dead URLs: ${dead.map(p => p.name).join(', ')}`);
  });

  it('all serverUrls are parseable URLs', () => {
    const broken = presets.filter(p => { try { new URL(p.serverUrl); return false; } catch { return true; } });
    assert.deepEqual(broken, [], `Presets with unparseable serverUrls: ${broken.map(p => p.name).join(', ')}`);
  });

  it('expected free presets are present', () => {
    const names = new Set(presets.map(p => p.name));
    for (const expected of ['Parallel Search', 'Robtex', 'Pyth Price Feeds', 'Open-Meteo']) {
      assert.ok(names.has(expected), `Expected preset "${expected}" not found`);
    }
  });

  it('expected commercial presets are present', () => {
    const names = new Set(presets.map(p => p.name));
    for (const expected of ['Exa Search', 'Tavily Search', 'Slack', 'GitHub', 'Stripe', 'Sentry', 'Datadog', 'Linear']) {
      assert.ok(names.has(expected), `Expected preset "${expected}" not found`);
    }
  });

  it('Slack serverUrl points to mcp.slack.com (not cloudflare)', () => {
    const slack = presets.find(p => p.name === 'Slack');
    assert.ok(slack, 'Slack preset not found');
    assert.equal(slack.serverUrl, 'https://mcp.slack.com/mcp');
  });

  it('Google Maps serverUrl points to mapstools.googleapis.com', () => {
    const maps = presets.find(p => p.name === 'Google Maps');
    assert.ok(maps, 'Google Maps preset not found');
    assert.equal(maps.serverUrl, 'https://mapstools.googleapis.com/mcp');
  });

  it('Parallel Search uses the public Search MCP endpoint and web_search tool', () => {
    const parallel = presets.find(p => p.name === 'Parallel Search');
    assert.ok(parallel, 'Parallel Search preset not found');
    assert.equal(parallel.serverUrl, 'https://search.parallel.ai/mcp');
    assert.equal(parallel.defaultTool, 'web_search');
  });

  it('Datadog serverUrl includes /api/unstable/mcp-server/mcp', () => {
    const dd = presets.find(p => p.name === 'Datadog');
    assert.ok(dd, 'Datadog preset not found');
    assert.ok(dd.serverUrl.includes('/api/unstable/mcp-server/mcp'), `Datadog URL is outdated: ${dd.serverUrl}`);
  });

  it('Browser Fetch serverUrl points to browser.mcp.cloudflare.com', () => {
    const bf = presets.find(p => p.name === 'Browser Fetch');
    assert.ok(bf, 'Browser Fetch preset not found');
    assert.equal(bf.serverUrl, 'https://browser.mcp.cloudflare.com/mcp');
  });

  it('Open-Meteo uses the historical weather tool without authentication', () => {
    const weather = presets.find(p => p.name === 'Open-Meteo');
    assert.ok(weather, 'Open-Meteo preset not found');
    assert.equal(weather.defaultTool, 'openmeteo_get_historical');
    assert.equal(weather.authNote, undefined);
  });

  it('Open-Meteo uses the community hosted MCP endpoint, not the REST API', () => {
    const weather = presets.find(p => p.name === 'Open-Meteo');
    assert.ok(weather, 'Open-Meteo preset not found');
    assert.equal(weather.serverUrl, 'https://open-meteo.caseyjhand.com/mcp');
  });

  it('LunarCrush defaultTool is Cryptocurrencies (not List)', () => {
    const lc = presets.find(p => p.name === 'LunarCrush');
    assert.ok(lc, 'LunarCrush preset not found');
    assert.equal(lc.defaultTool, 'Cryptocurrencies');
  });

  it('Cloudflare Radar serverUrl points to radar.mcp.cloudflare.com/sse', () => {
    const cf = presets.find(p => p.name === 'Cloudflare Radar');
    assert.ok(cf, 'Cloudflare Radar preset not found');
    assert.equal(cf.serverUrl, 'https://radar.mcp.cloudflare.com/sse');
  });
});

// ── Live connectivity tests (opt-in) ─────────────────────────────────────────
// Run with: LIVE_MCP_TESTS=1 node --test tests/mcp-presets.test.mjs

const LIVE = process.env.LIVE_MCP_TESTS === '1';
const livePresets = presets.filter(preset => !isTemplatePreset(preset));

describe(`MCP Presets — live connectivity (${LIVE ? 'ENABLED' : 'SKIPPED — set LIVE_MCP_TESTS=1'})`, { skip: !LIVE, concurrency: 4 }, () => {
  const results = [];
  after(() => {
    if (process.env.MCP_PRESET_REPORT) {
      writeFileSync(process.env.MCP_PRESET_REPORT, JSON.stringify({
        checkedAt: new Date().toISOString(), expectedCount: livePresets.length, results,
      }, null, 2));
    }
  });

  for (const preset of livePresets) {
    it(`${preset.name} (${preset.serverUrl}) is reachable`, async () => {
      const result = await probePreset(preset);
      results.push(result);
      assert.ok(result.ok, `${result.name} (${result.serverUrl}): ${result.observed}`);
    });
  }
});
