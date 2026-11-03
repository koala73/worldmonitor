// /agent: the page that tells AI agents how to connect to World Monitor.
// Pins the approved product description, the tool-count wording, the skills list
// against skills/, SEO registration and the no-utm rule for internal links.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { STATIC_ROUTE_MANIFEST } from '../scripts/build-sitemap.mjs';
import { UMAMI_SCRIPT_TAG } from '../scripts/build-research-reports.mjs';
import { TOOL_LIST_RESPONSE } from '../api/mcp/registry/index.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(ROOT, path), 'utf8');
const PAGE = read('public/agent/index.html');
const SCRIPT = read('public/agent/agent.js');
const URL_CANONICAL = 'https://www.worldmonitor.app/agent/';
const APPROVED_DESCRIPTION = 'World Monitor: real-time geopolitical intelligence dashboard. A free live map of conflicts, shipping, flights, markets and cyber, with an API and MCP server.';

const metaDescription = (html) => html.match(/<meta name="description" content="([^"]*)"/)?.[1] ?? null;

describe('/agent page content', () => {
  it('shows the approved description word for word', () => {
    assert.ok(PAGE.includes(`<p class="lede" id="approved-description">${APPROVED_DESCRIPTION}</p>`));
  });

  it('says "90+ MCP tools", never an exact count, and the claim holds', () => {
    assert.match(PAGE, /90\+ MCP tools/);
    assert.doesNotMatch(PAGE, /\b\d{2,3} (?:MCP )?tools\b/, 'no exact tool count');
    assert.ok(TOOL_LIST_RESPONSE.length >= 90, `registry has ${TOOL_LIST_RESPONSE.length} tools; the page promises 90+`);
  });

  it('has a setup section for every client the page names', () => {
    for (const id of ['claude', 'chatgpt', 'cursor', 'gemini', 'grok-bot', 'generic']) {
      assert.match(PAGE, new RegExp(`<article class="client" id="${id}">`), id);
    }
    assert.match(PAGE, /claude mcp add --transport http worldmonitor https:\/\/worldmonitor\.app\/mcp/);
    assert.match(PAGE, /gemini mcp add --transport http worldmonitor https:\/\/worldmonitor\.app\/mcp/);
    assert.match(PAGE, /&quot;url&quot;: &quot;https:\/\/worldmonitor\.app\/mcp&quot;/);
  });

  it('lists exactly the published skills and the one-command install', () => {
    const published = readdirSync(join(ROOT, 'skills'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(ROOT, 'skills', entry.name, 'SKILL.md')))
      .map((entry) => entry.name)
      .sort();
    const listed = [...PAGE.matchAll(/<li><code>([a-z0-9-]+)<\/code>/g)].map((match) => match[1]).sort();
    assert.deepEqual(listed, published, 'skill list on /agent must match skills/');
    assert.match(PAGE, /npx skills add koala73\/worldmonitor<\/code>/);
    for (const skill of [...PAGE.matchAll(/--skill ([a-z0-9-]+)/g)].map((match) => match[1])) {
      assert.ok(published.includes(skill), `example skill ${skill} must exist`);
    }
  });

  it('keeps the internal engineering skills out of the skills CLI', () => {
    for (const name of readdirSync(join(ROOT, '.agents/skills'))) {
      const path = join(ROOT, '.agents/skills', name, 'SKILL.md');
      if (!existsSync(path)) continue;
      assert.match(read(`.agents/skills/${name}/SKILL.md`), /^---\n[\s\S]*?\nmetadata:\n {2}internal: true\n[\s\S]*?---\n/, `${name} must set metadata.internal`);
    }
  });

  it('uses no robot emoji and no utm tags, and tracks clicks with Umami attributes only', () => {
    assert.doesNotMatch(PAGE, /\u{1F916}/u);
    assert.doesNotMatch(PAGE, /utm_/);
    assert.doesNotMatch(PAGE, /href="[^"]*[?&]ref=/, 'same-site links carry no query tag');
    assert.ok(PAGE.includes(UMAMI_SCRIPT_TAG), 'the shared first-party Umami tag');
    const scripts = [...PAGE.matchAll(/<script\b[^>]*>/gi)].map((match) => match[0]);
    assert.equal(scripts.length, 2, 'only the page script and Umami');
    for (const tag of scripts) assert.match(tag, /nonce="wm-static-bootstrap"/);
    assert.ok((PAGE.match(/data-umami-event="agent-copy-command"/g) ?? []).length >= 8);
  });
});

describe('/agent page SEO registration', () => {
  it('has a canonical, a unique 150-160 character meta description, and a title', () => {
    assert.match(PAGE, new RegExp(`<link rel="canonical" href="${URL_CANONICAL}">`));
    const description = metaDescription(PAGE);
    assert.ok(description, 'meta description');
    assert.ok(description.length >= 150 && description.length <= 160, `meta description is ${description.length} chars`);
    assert.ok(description.endsWith('.'));
    assert.notEqual(description, APPROVED_DESCRIPTION, 'the approved line is the homepage meta; reuse would duplicate it');
    const committedHtml = execFileSync('git', ['ls-files', '*.html'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
    for (const file of committedHtml) {
      if (file === 'public/agent/index.html') continue;
      assert.notEqual(metaDescription(read(file)), description, `${file} has the same meta description`);
    }
  });

  it('is in the sitemap manifest and the committed sitemap', () => {
    assert.ok(STATIC_ROUTE_MANIFEST.some((route) => route.loc === URL_CANONICAL));
    assert.ok(read('public/sitemap-main.xml').includes(`<loc>${URL_CANONICAL}</loc>`));
  });

  it('is linked from llms.txt and agents.md', () => {
    const llmsLinks = [...read('public/llms.txt').matchAll(/\]\((https:\/\/[^)\s]+)\)/g)].map((match) => match[1]);
    assert.ok(llmsLinks.some((href) => href === URL_CANONICAL), 'llms.txt must link /agent/');
    const agentsUrls = [...read('public/agents.md').matchAll(/https:\/\/[^\s)<>`]+/g)].map((match) => match[0]);
    assert.ok(agentsUrls.some((href) => href === URL_CANONICAL), 'agents.md must name /agent/');
  });

  it('redirects the bare path to the trailing-slash page', () => {
    const vercel = JSON.parse(read('vercel.json'));
    assert.ok(vercel.redirects.some((r) => r.source === '/agent' && r.destination === '/agent/' && r.permanent === true));
  });
});

describe('/agent ref capture is the shared module', () => {
  it('ships a byte-for-byte copy of shared/agent-client-source.js', () => {
    assert.equal(
      read('public/agent/agent-client-source.js'),
      read('shared/agent-client-source.js'),
      'run: cp shared/agent-client-source.js public/agent/agent-client-source.js',
    );
  });

  it('loads the page script as a module that imports the copy', () => {
    assert.match(PAGE, /<script type="module" nonce="wm-static-bootstrap" src="\/agent\/agent\.js"><\/script>/);
    assert.match(SCRIPT, /from '\.\/agent-client-source\.js';/);
    assert.match(SCRIPT, /captureAgentRefFromSearch\(window\.location\.search, agentRefCookieStorage\(document, window\.location\)\)/);
  });
});
