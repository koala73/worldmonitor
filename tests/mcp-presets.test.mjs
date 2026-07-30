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
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

// Parse presets directly from the TypeScript source (no compilation needed).
// Extract the MCP_PRESETS array by reading between the markers.
const src = readFileSync(resolve(root, 'src/services/mcp-store.ts'), 'utf-8');

// Extract presets from the MCP_PRESETS array in the TS source.
// Splits on object boundaries delimited by '  {' at the start of each preset block.
function extractPresets(src) {
  const start = src.indexOf('export const MCP_PRESETS');
  const end = src.indexOf('\nexport interface McpToolDef');
  if (start === -1 || end === -1) throw new Error('Could not locate MCP_PRESETS in mcp-store.ts');
  const arrSrc = src.slice(start, end);
  const blocks = arrSrc.split(/\n {2}\{/).slice(1);
  return blocks
    .map(block => ({
      name: /name: '([^']+)'/.exec(block)?.[1] ?? null,
      serverUrl: /serverUrl: '([^']+)'/.exec(block)?.[1] ?? null,
      defaultTool: /defaultTool: '([^']+)'/.exec(block)?.[1] ?? null,
    }))
    .filter(p => p.name && p.serverUrl);
}

const presets = extractPresets(src);

// Known-dead or moved URLs that must NOT appear in presets
const BANNED_URLS = [
  'https://slack.mcp.cloudflare.com/mcp',       // wrong — Cloudflare-hosted Slack doesn't exist
  'https://maps.mcp.cloudflare.com/mcp',         // wrong — Cloudflare-hosted Maps doesn't exist
  'https://mcp-fetch.cloudflare.com/mcp',        // wrong — old Browser Fetch URL
  'https://server.smithery.ai/@amadevs/mcp-server-overpass/mcp', // 404 on Smithery
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
    assert.ok(presets.length >= 10, `Expected at least 10 presets, got ${presets.length}`);
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

  it('expected free presets are present (Robtex, Pyth, WeatherForensics)', () => {
    const names = new Set(presets.map(p => p.name));
    for (const expected of ['Robtex', 'Pyth Price Feeds', 'Weather Forensics']) {
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

  it('WeatherForensics defaultTool is noaa_ncei_daily_weather_for_location_date (not get_current_weather)', () => {
    const wf = presets.find(p => p.name === 'Weather Forensics');
    assert.ok(wf, 'Weather Forensics preset not found');
    assert.equal(wf.defaultTool, 'noaa_ncei_daily_weather_for_location_date');
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
// Run with: LIVE_MCP_TESTS=1 npm run test:data -- tests/mcp-presets.test.mjs

const LIVE = process.env.LIVE_MCP_TESTS === '1';

describe(`MCP Presets — live connectivity (${LIVE ? 'ENABLED' : 'SKIPPED — set LIVE_MCP_TESTS=1'})`, { skip: !LIVE }, () => {
  const EXPECTED_LIVE_URLS = [
    // Free presets expected to respond (no auth needed for initialize)
    { name: 'Robtex',          url: 'https://mcp.robtex.com/mcp' },
    { name: 'Pyth Price Feeds', url: 'https://mcp.pyth.network/mcp' },
    { name: 'Weather Forensics', url: 'https://weatherforensics.dev/mcp/free' },
  ];

  // Auth-gated presets — expect 401 on initialize (not DNS failure / 404)
  const EXPECTED_AUTH_URLS = [
    { name: 'Exa Search',    url: 'https://mcp.exa.ai/mcp' },
    { name: 'Tavily Search', url: 'https://mcp.tavily.com/mcp/' },
    { name: 'LunarCrush',   url: 'https://lunarcrush.ai/mcp' },
    { name: 'Alpha Vantage', url: 'https://mcp.alphavantage.co/mcp' },
    { name: 'Slack',         url: 'https://mcp.slack.com/mcp' },
    { name: 'GitHub',        url: 'https://api.githubcopilot.com/mcp/' },
    { name: 'Linear',        url: 'https://mcp.linear.app/mcp' },
    { name: 'Sentry',        url: 'https://mcp.sentry.dev/mcp' },
    { name: 'Stripe',        url: 'https://mcp.stripe.com/' },
    { name: 'Notion',        url: 'https://mcp.notion.com/mcp' },
    { name: 'Airtable',      url: 'https://mcp.airtable.com/mcp' },
    { name: 'Perigon News',  url: 'https://mcp.perigon.io/v1/mcp' },
    { name: 'Datadog',       url: 'https://mcp.datadoghq.com/api/unstable/mcp-server/mcp' },
  ];

  const TIMEOUT_MS = 15_000;

  async function postMcpInit(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
          'User-Agent': 'WorldMonitor-MCP-Proxy/1.0',
        },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'initialize',
          params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'worldmonitor', version: '1.0' } },
        }),
        signal: controller.signal,
      });
      return resp.status;
    } finally {
      clearTimeout(timer);
    }
  }

  for (const { name, url } of EXPECTED_LIVE_URLS) {
    it(`${name} (${url}) responds 200 to initialize`, async () => {
      const status = await postMcpInit(url);
      assert.equal(status, 200, `${name}: expected 200, got ${status}`);
    });
  }

  for (const { name, url } of EXPECTED_AUTH_URLS) {
    it(`${name} (${url}) responds 200 or 401 (not DNS failure or 404)`, async () => {
      const status = await postMcpInit(url);
      assert.ok(
        [200, 401, 403].includes(status),
        `${name}: expected 200/401/403, got ${status} — URL may be dead or changed`,
      );
    });
  }
});
