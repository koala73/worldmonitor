// Every place we publish the MCP URL must give the one URL a connector can
// use (#9722 onboarding item, related #8451).
//
// The hosted transport answers on exactly MCP_CANONICAL_ENDPOINT. The same MCP
// paths on any production alias host (www, api, and the variant subdomains)
// answer 410 / -32000 `canonical_endpoint_required` to a connector's POST, so
// a first connection configured from one of those URLs fails before it starts.
// The apex `/api/mcp` path is the internal route: it has its own OAuth
// protected-resource identifier, so a connector pointed at it authorizes for a
// different resource. `http://` URLs redirect, and a redirected POST becomes a
// GET.
//
// tests/agent-corpus-canonical-host.test.mjs guards apex-vs-www hygiene for the
// crawlable corpus (public/, blog source, Mintlify pages). This file covers the
// rest of what users and agents read: in-app connector setup, the welcome and
// pricing pages, plugin and registry manifests, READMEs, the CLI, and docs. It
// scans every tracked text file instead of a list, so a new surface is covered
// the day it is added. Only tests and internal notes may quote a wrong URL.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  MCP_CANONICAL_ENDPOINT,
  MCP_PRODUCT_PATHS,
  MCP_PRODUCTION_ALIAS_LABELS,
} from '../shared/mcp-host-policy.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Hosts are case-insensitive and the server normalizes them
// (normalizeMcpHost: lowercase, trailing dots and port dropped), so the host
// part matches every spelling the server treats as the same host. Paths are
// matched exactly, as isMcpAliasRequest matches them.
const caseless = (s) =>
  [...s].map((c) => (/[a-z]/i.test(c) ? `[${c.toLowerCase()}${c.toUpperCase()}]` : escapeRegExp(c))).join('');
const HOST_TAIL = '\\.*(?::\\d+)?';

// Longest first so `/.well-known/mcp.json` is not read as `/.well-known/mcp`.
const PATHS = [...MCP_PRODUCT_PATHS].sort((a, b) => b.length - a.length).map(escapeRegExp).join('|');
const ALIASES = MCP_PRODUCTION_ALIAS_LABELS.map(caseless).join('|');
const APEX = caseless('worldmonitor.app');
const SCHEME = '[hH][tT][tT][pP][sS]?://';
// The policy matches the path exactly, so a longer path such as
// `/.well-known/mcp/docs-server-card.json` or `/mcp-server.md` is a different
// resource. A trailing sentence period still ends the URL.
const PATH_END = '(?![A-Za-z0-9_\\-/]|\\.[A-Za-z0-9])';

const WRONG_MCP_URLS = [
  {
    label: 'an alias host that answers 410 canonical_endpoint_required',
    re: new RegExp(`${SCHEME}(?:${ALIASES})\\.${APEX}${HOST_TAIL}(?:${PATHS})${PATH_END}`, 'g'),
  },
  {
    label: 'the internal /api/mcp path, which has a different OAuth resource',
    re: new RegExp(`${SCHEME}${APEX}${HOST_TAIL}/api/mcp${PATH_END}`, 'g'),
  },
  {
    label: 'plain http, which redirects and turns a POST into a GET',
    re: new RegExp(`[hH][tT][tT][pP]://${APEX}${HOST_TAIL}(?:${PATHS})${PATH_END}`, 'g'),
  },
  {
    label: 'a host spelling that is not the canonical one (case, port or trailing dot)',
    re: new RegExp(`[hH][tT][tT][pP][sS]://(?!worldmonitor\\.app/)${APEX}${HOST_TAIL}/mcp${PATH_END}`, 'g'),
  },
];

function findWrongMcpUrls(text) {
  const hits = [];
  for (const { label, re } of WRONG_MCP_URLS) {
    for (const match of text.matchAll(re)) hits.push({ url: match[0], label });
  }
  return hits;
}

// Tests quote wrong URLs to exercise the 410 path. Solutions, research,
// brainstorms, plans and archives are internal notes, not setup instructions.
const EXEMPT = [
  /^tests\//,
  /^e2e\//,
  /\.test\.[cm]?[jt]sx?$/,
  /^docs\/(?:solutions|research|brainstorms|plans|archive)\//,
];
const BINARY = /\.(?:png|jpe?g|gif|webp|avif|ico|icns|pdf|woff2?|ttf|otf|mp4|webm|zip|gz|br|pmtiles|wasm|parquet|bin)$/i;

function trackedTextFiles() {
  return execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0')
    .filter((file) => file && !BINARY.test(file) && !EXEMPT.some((re) => re.test(file)));
}

describe('wrong-MCP-URL matcher', () => {
  it('flags every alias host on every MCP product path', () => {
    for (const label of MCP_PRODUCTION_ALIAS_LABELS) {
      for (const path of MCP_PRODUCT_PATHS) {
        const url = `https://${label}.worldmonitor.app${path}`;
        assert.deepEqual(findWrongMcpUrls(`Add ${url} as a connector.`).map((h) => h.url), [url]);
      }
    }
  });

  it('flags alias hosts in any case, with a port or a trailing dot, as the server normalizes them', () => {
    for (const url of [
      'https://WWW.worldmonitor.app/mcp',
      'https://www.WorldMonitor.App/mcp',
      'https://www.worldmonitor.app:443/mcp',
      'https://api.worldmonitor.app./mcp',
      'HTTPS://Energy.worldmonitor.app:8443/api/mcp',
    ]) {
      assert.deepEqual(findWrongMcpUrls(`Connect to ${url}.`).map((h) => h.url), [url], url);
    }
  });

  it('flags a non-canonical spelling of the apex endpoint itself', () => {
    for (const url of [
      'https://WorldMonitor.app/mcp',
      'https://worldmonitor.app:443/mcp',
      'https://worldmonitor.app./mcp',
      'https://worldmonitor.app:443/api/mcp',
      'HTTPS://worldmonitor.app:8443/mcp',
      'Https://worldmonitor.app./mcp',
    ]) {
      assert.ok(findWrongMcpUrls(`"url": "${url}"`).length > 0, url);
    }
  });

  it('flags the internal /api/mcp path and plain http', () => {
    assert.equal(findWrongMcpUrls('"url": "https://worldmonitor.app/api/mcp"').length, 1);
    assert.equal(findWrongMcpUrls('connect to http://worldmonitor.app/mcp.').length, 1);
    assert.equal(findWrongMcpUrls('url = "https://www.worldmonitor.app/mcp?x=1"').length, 1);
  });

  it('leaves the canonical endpoint and longer paths alone', () => {
    for (const text of [
      `"url": "${MCP_CANONICAL_ENDPOINT}"`,
      `Connect to ${MCP_CANONICAL_ENDPOINT}.`,
      'https://www.worldmonitor.app/mcp-server.md',
      'https://www.worldmonitor.app/.well-known/mcp/docs-server-card.json',
      'https://www.worldmonitor.app/docs/mcp',
      'https://worldmonitor.app/mcp/oauth',
      'https://worldmonitor.app/.well-known/mcp.json',
    ]) {
      assert.deepEqual(findWrongMcpUrls(text), [], text);
    }
  });
});

describe('published MCP URLs are the canonical endpoint (#9722)', () => {
  it('no tracked user-facing file publishes a non-canonical MCP URL', () => {
    const offenders = [];
    for (const file of trackedTextFiles()) {
      let text;
      try {
        text = readFileSync(join(ROOT, file), 'utf8');
      } catch {
        continue; // deleted in the working tree, or a submodule path
      }
      // Case-insensitive, like the matcher: `WorldMonitor.App/mcp` is the same host.
      if (!/worldmonitor\.app/i.test(text)) continue;
      text.split('\n').forEach((line, index) => {
        for (const hit of findWrongMcpUrls(line)) {
          offenders.push(`  ${file}:${index + 1}  ${hit.url}  (${hit.label})`);
        }
      });
    }
    assert.deepEqual(
      offenders,
      [],
      `a connector configured from these URLs fails its first connection; publish ${MCP_CANONICAL_ENDPOINT}:\n` +
        offenders.join('\n'),
    );
  });

  // The places a user copies the URL from when setting up a connector. Each
  // must carry the canonical endpoint itself, not merely avoid a wrong one.
  it('connector setup surfaces carry the canonical endpoint', () => {
    const plugin = JSON.parse(readFileSync(join(ROOT, 'claude-plugin/.mcp.json'), 'utf8'));
    assert.equal(plugin.mcpServers.worldmonitor.url, MCP_CANONICAL_ENDPOINT);

    const registry = JSON.parse(readFileSync(join(ROOT, 'server.json'), 'utf8'));
    assert.ok(registry.remotes?.length, 'server.json lists its remotes');
    for (const remote of registry.remotes) assert.equal(remote.url, MCP_CANONICAL_ENDPOINT);

    for (const file of [
      'src/components/UnifiedSettings.ts',
      'pro-test/src/welcome/Agents.tsx',
      'claude-plugin/README.md',
      '.antigravity-plugin/README.md',
      'README.md',
    ]) {
      assert.ok(
        readFileSync(join(ROOT, file), 'utf8').includes(MCP_CANONICAL_ENDPOINT),
        `${file} should show ${MCP_CANONICAL_ENDPOINT}`,
      );
    }
  });
});
