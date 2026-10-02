/**
 * The anchor gate is merge-blocking, so what matters is that it can go RED.
 *
 * The docs corpus is clean, so CI only ever exercises the success exit: a
 * regression that emptied the href scan would keep printing OK while dead
 * anchors shipped. These fixtures are the negative control, in the same shape
 * `tests/main-module-gates.test.mjs` uses for the other check-* gates —
 * fabricate a tree, spawn the script, assert on the exit code and stderr.
 *
 * The ids here are verbatim from a real `mint export`, because the point of
 * the checker is that Mintlify's slug rules cannot be reproduced by hand:
 * `&` and em-dashes survive, ASCII parens are stripped, full-width ones are
 * kept, and CJK is preserved.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '../scripts/check-doc-anchors.mjs');

/** Build an export-shaped tree: { '<page>': '<html>' } -> <page>/index.html. */
function fixture(pages) {
  const dir = mkdtempSync(join(tmpdir(), 'check-doc-anchors-'));
  for (const [page, html] of Object.entries(pages)) {
    const target = page === '' ? dir : join(dir, page);
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'index.html'), html, 'utf8');
  }
  return dir;
}

const run = (dir) => spawnSync(process.execPath, [SCRIPT, ...(dir ? [dir] : [])], { encoding: 'utf8' });

const page = (body) => `<!doctype html><html><body>${body}</body></html>`;

describe('check-doc-anchors', () => {
  it('passes when every in-page and cross-page anchor resolves', () => {
    const dir = fixture({
      'mcp-overview': page('<h2 id="plans-&amp;-limits">Plans &amp; limits</h2><a href="#plans-%26-limits">jump</a>'),
      'mcp-error-catalog': page('<a href="/mcp-overview#plans-%26-limits">plans</a>'),
    });
    try {
      const { status, stdout } = run(dir);
      assert.equal(status, 0, stdout);
      assert.match(stdout, /check-doc-anchors OK/);
      assert.match(stdout, /2 anchors across 2 pages/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails on a dead in-page anchor and names it', () => {
    const dir = fixture({ guide: page('<h2 id="present">Present</h2><a href="#missing">go</a>') });
    try {
      const { status, stderr } = run(dir);
      assert.equal(status, 1);
      assert.match(stderr, /Dead doc anchors: 1 of 1 checked/);
      assert.match(stderr, /\/guide {2}-> {2}#missing/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails on a dead CROSS-PAGE anchor, the class the in-page pass missed', () => {
    // The real regression: docs/mcp-error-catalog.mdx linked
    // /mcp-overview#plans--limits while the emitted id kept the ampersand.
    const dir = fixture({
      'mcp-overview': page('<h2 id="plans-&amp;-limits">Plans &amp; limits</h2>'),
      'mcp-error-catalog': page('<a href="/mcp-overview#plans--limits">plans</a>'),
    });
    try {
      const { status, stderr } = run(dir);
      assert.equal(status, 1);
      assert.match(stderr, /\/mcp-error-catalog {2}-> {2}\/mcp-overview#plans--limits/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves a percent-encoded CJK fragment against the id it names', () => {
    // `每日额度（Pro 套餐）` renders as id="每日额度（pro-套餐）": CJK and
    // full-width parens survive, ASCII is lowercased, spaces become hyphens.
    const id = '每日额度（pro-套餐）';
    const dir = fixture({
      'zh/mcp-overview': page(`<h3 id="${id}">每日额度（Pro 套餐）</h3><a href="#${encodeURIComponent(id)}">go</a>`),
    });
    try {
      const { status, stdout } = run(dir);
      assert.equal(status, 0, stdout);
      assert.match(stdout, /1 anchors across 1 pages/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips a fragment whose target page is outside the export', () => {
    const dir = fixture({ guide: page('<a href="/not-exported#whatever">elsewhere</a>') });
    try {
      const { status, stdout } = run(dir);
      assert.equal(status, 0, stdout);
      assert.match(stdout, /1 pointed outside the export and were skipped/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores platform chrome ids but still checks authored lookalikes', () => {
    // `footer` is the platform's; `footer-notes` is an author's heading and
    // must not be swallowed by a prefix match.
    const dir = fixture({ guide: page('<a href="#footer">chrome</a><a href="#footer-notes">authored</a>') });
    try {
      const { status, stderr } = run(dir);
      assert.equal(status, 1);
      assert.match(stderr, /1 of 1 checked/, 'the chrome anchor is not counted, the authored one is');
      assert.match(stderr, /#footer-notes/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reds when Mintlify stops keeping the ampersand in a slug', () => {
    // The renderer is downloaded at export time, so the CI npm pin does not
    // hold it. This is the canary for a slug-rule change arriving on its own.
    const dir = fixture({ 'mcp-overview': page('<h2 id="plans-limits">Plans &amp; limits</h2>') });
    try {
      const { status, stderr } = run(dir);
      assert.equal(status, 2);
      assert.match(stderr, /Slug rules changed under us/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits 2 without an export directory argument', () => {
    const { status, stderr } = run(null);
    assert.equal(status, 2);
    assert.match(stderr, /usage: node scripts\/check-doc-anchors\.mjs/);
  });

  it('exits 2 when the directory holds no HTML', () => {
    const dir = mkdtempSync(join(tmpdir(), 'check-doc-anchors-empty-'));
    try {
      const { status, stderr } = run(dir);
      assert.equal(status, 2);
      assert.match(stderr, /did the export unpack\?/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
