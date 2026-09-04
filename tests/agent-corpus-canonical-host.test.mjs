// Every worldmonitor.app URL we publish to agents and crawlers must name the
// host that actually serves it.
//
// The apex `worldmonitor.app` 301s to `www` through a Cloudflare Dynamic
// Redirect rule whose exemption list is documented in ARCHITECTURE.md §2 and is
// load-bearing: `/.well-known/*`, `/robots.txt`, `/security.txt`, `/mcp`,
// `/mcp/*` and `/oauth/*` are served on the apex and must NEVER be rewritten to
// www — dropping `/mcp*` breaks every apex-URL MCP client, and dropping
// `/oauth/*` turns a registration POST into a GET and kills it with 405
// (#4938). Everything else redirects.
//
// #7660 measured the cost: 26 of the 76 World Monitor URLs in llms.txt and
// llms-full.txt were apex, so 34% of our AI-facing link surface taught crawlers
// a redirecting URL, and Google fetches these files. Search Console's "Page
// with redirect" bucket was rising through 1,271 at the time. This file is the
// build assertion that issue asked for, widened from the two llms files to the
// whole published corpus because the same pattern was in all of it.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = join(ROOT, 'public');

// Paths the Cloudflare rule exempts — apex is correct and required for these.
const APEX_SERVED = [
  /^\/mcp(?:\/|$)/,
  /^\/oauth\//,
  /^\/\.well-known\//,
  /^\/robots\.txt$/,
  /^\/security\.txt$/,
];

// Bare-origin apex strings that are identifiers, not links. An OAuth issuer /
// protected-resource identifier is compared byte-for-byte by clients, so
// rewriting it to www breaks the flow it documents; world-monitor.md's brand
// table names the apex precisely because it is describing the apex.
const APEX_IDENTIFIERS = [/"(?:issuer|resource)":/, /^\| Apex domain \|/];

// Directories owned by other builds (Astro blog, pro-test) — their host
// hygiene is guarded by their own suites.
const SKIP_DIRS = new Set(['blog', 'pro', 'node_modules']);
const SCANNED_EXTENSIONS = /\.(?:txt|md|json|yaml|yml|xml)$/;
// `.well-known` documents are served extensionless by RFC 8615 convention
// (`/.well-known/api-catalog` is a linkset of 12 published URLs), so the
// extension filter would silently skip exactly the discovery surface this
// guard exists to protect.
const WELL_KNOWN_DIR = join(PUBLIC_DIR, '.well-known');
// A key-distribution record, not a document of links.
const NOT_A_DOCUMENT = new Set([join(WELL_KNOWN_DIR, 'mcp-registry-auth')]);

// Matches the origin plus its path, stopping before markdown/prose delimiters
// so a trailing sentence period is not read as part of the path.
const APEX_URL_RE = /https:\/\/worldmonitor\.app(\/[^\s)"'`<>,;\\]*)?/g;

function scanFiles(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      scanFiles(full, acc);
      continue;
    }
    if (NOT_A_DOCUMENT.has(full)) continue;
    if (SCANNED_EXTENSIONS.test(entry) || full.startsWith(WELL_KNOWN_DIR)) acc.push(full);
  }
  return acc;
}

function apexOffenders() {
  const offenders = [];
  for (const file of scanFiles(PUBLIC_DIR)) {
    const rel = relative(ROOT, file);
    readFileSync(file, 'utf-8')
      .split('\n')
      .forEach((line, index) => {
        APEX_URL_RE.lastIndex = 0;
        for (const match of line.matchAll(APEX_URL_RE)) {
          const path = match[1] ?? '';
          if (path && APEX_SERVED.some((re) => re.test(path))) continue;
          if (!path && APEX_IDENTIFIERS.some((re) => re.test(line.trim()))) continue;
          offenders.push({ file: rel, line: index + 1, url: match[0] });
        }
      });
  }
  return offenders;
}

describe('published agent corpus names the serving host (#7660)', () => {
  it('publishes no apex URL that redirects to www', () => {
    const offenders = apexOffenders();
    assert.deepEqual(
      offenders,
      [],
      'these published URLs 301 to www, so every crawler and agent that follows ' +
        'them spends a fetch on a redirect and lands in Search Console\'s "Page ' +
        'with redirect" bucket:\n' +
        offenders.map((o) => `  ${o.file}:${o.line}  ${o.url}`).join('\n')
    );
  });

  it('keeps the apex-served discovery paths on the apex', () => {
    // The inverse guard. A well-meaning sweep that rewrote these to www would
    // break MCP clients and OAuth registration, and nothing else would notice
    // until the live smoke ran.
    const llms = readFileSync(join(PUBLIC_DIR, 'llms.txt'), 'utf-8');
    // The endpoint itself, not its sibling documents: `/mcp-server.md` is an
    // ordinary www page, so the boundary has to be a real URL delimiter.
    const MCP_ENDPOINT = (host) =>
      new RegExp(`https://${host.replace(/\./g, '\\.')}/mcp(?=[/?#)\\s"'\`]|$)`, 'm');
    assert.match(llms, MCP_ENDPOINT('worldmonitor.app'));
    assert.doesNotMatch(
      llms,
      MCP_ENDPOINT('www.worldmonitor.app'),
      'the MCP endpoint canonical is apex (ARCHITECTURE.md §2); www would fragment discovery'
    );

    const serverCard = readFileSync(join(PUBLIC_DIR, '.well-known/mcp/server-card.json'), 'utf-8');
    const card = JSON.parse(serverCard);
    assert.equal(card.url, 'https://worldmonitor.app/mcp');
    assert.equal(card.transport.endpoint, 'https://worldmonitor.app/mcp');
    assert.equal(
      card.authentication.resource,
      'https://worldmonitor.app',
      'the OAuth protected-resource identifier is compared byte-for-byte by clients'
    );
  });

  // The same defect, one surface over: a published Mintlify page is crawlable
  // HTML, so an apex link in its prose is another redirect Googlebot pays for.
  // Fenced code is exempt on purpose — a fence quotes what the runtime actually
  // emits (an API response body's `upgradeUrl`, a CORS `Origin:` header), and
  // rewriting those would make the documentation wrong rather than better.
  describe('published Mintlify pages', () => {
    const config = JSON.parse(readFileSync(join(ROOT, 'docs/docs.json'), 'utf-8'));
    const navLeaves = new Set();
    (function walk(node) {
      if (Array.isArray(node)) return node.forEach(walk);
      if (node && typeof node === 'object') return Object.values(node).forEach(walk);
      if (typeof node === 'string') navLeaves.add(node);
    })(config.navigation ?? config);

    // Nav strings include group labels, so only the ones that resolve to a file
    // are pages. Deduped by resolved path: a case-insensitive filesystem makes
    // the "Overview" group label resolve to docs/overview.mdx.
    const pages = [
      ...new Set(
        [...navLeaves]
          .map((leaf) => ['.mdx', '.md'].map((ext) => join(ROOT, 'docs', leaf + ext)).find(existsSync))
          .filter(Boolean)
      ),
    ];

    it('resolves a real page set from docs.json', () => {
      assert.ok(pages.length > 100, `expected the docs nav to resolve many pages, got ${pages.length}`);
      for (const required of ['docs/agent-discovery.mdx', 'docs/pricing.mdx', 'docs/zh/accounts.mdx']) {
        assert.ok(pages.includes(join(ROOT, required)), `${required} must be in the published set`);
      }
    });

    it('links to www outside fenced code', () => {
      const offenders = [];
      for (const page of pages) {
        let inFence = false;
        readFileSync(page, 'utf-8')
          .split('\n')
          .forEach((line, index) => {
            if (/^\s*(?:```|~~~)/.test(line)) {
              inFence = !inFence;
              return;
            }
            if (inFence) return;
            for (const match of line.matchAll(APEX_URL_RE)) {
              const path = match[1] ?? '';
              if (path && APEX_SERVED.some((re) => re.test(path))) continue;
              offenders.push(`  ${relative(ROOT, page)}:${index + 1}  ${match[0]}`);
            }
          });
      }
      assert.deepEqual(offenders, [], `published docs pages linking to a redirecting apex URL:\n${offenders.join('\n')}`);
    });

    it('documents a discovery root that actually carries the Link header', () => {
      // The apex root is not on the exemption list: it answers 301 with no
      // `Link:` header at all, so an agent following the documented command
      // verbatim gets nothing. Verified live 2026-09-04 (#7660).
      for (const page of ['docs/agent-discovery.mdx', 'docs/zh/agent-discovery.mdx']) {
        const body = readFileSync(join(ROOT, page), 'utf-8');
        assert.match(body, /curl -sI https:\/\/www\.worldmonitor\.app\/ \| grep -i '\^link:'/, page);
        assert.doesNotMatch(body, /curl -sI https:\/\/worldmonitor\.app\//, page);
      }
    });
  });

  it('scans the files the issue named', () => {
    // Guards the scanner itself: a glob or extension change that silently
    // stopped covering the corpus would make this suite pass vacuously.
    const scanned = new Set(scanFiles(PUBLIC_DIR).map((f) => relative(ROOT, f)));
    for (const required of [
      'public/llms.txt',
      'public/llms-full.txt',
      'public/api/llms.txt',
      'public/developers/llms.txt',
      'public/ai-search.md',
      'public/agents.md',
      'public/world-monitor.md',
      'public/plugin.json',
      'public/agent.txt',
      'public/.well-known/ai-catalog.json',
      'public/.well-known/mcp/server-card.json',
      'public/.well-known/agent-skills/index.json',
      'public/.well-known/api-catalog',
      'public/.well-known/agent-card.json',
    ]) {
      assert.ok(scanned.has(required), `${required} must be covered by the apex scan`);
    }
  });
});
