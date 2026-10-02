import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, it } from 'node:test';
import { load } from 'js-yaml';
import middleware from '../middleware';
import agentRequestPolicy from '../shared/agent-request-policy.json';
import { decodeHtmlEntities } from '../src/utils/html-entities';
import { guardProBuiltOutput, shouldSkipProBuiltOutput } from './_lib/pro-built-output.mjs';

describe('public agent documents', () => {
  // auth.md is intentionally heading-led for scanner compatibility. Its title,
  // description, and canonical identity are guarded in the dedicated auth suite.
  const files = readdirSync(new URL('../public/', import.meta.url)).filter(
    (file) => file.endsWith('.md') && file !== 'auth.md',
  );
  files.push('api/download.md');
  for (const file of files) {
    it(`${file} opens with document metadata`, () => {
      const document = readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8');
      const frontmatter = document.match(/^---\n([\s\S]*?)\n---\n/);
      assert.ok(frontmatter, file);
      const metadata = load(frontmatter[1]) as Record<string, string>;
      assert.ok(metadata.title?.length > 0);
      assert.ok(metadata.description?.length > 0);
      assert.equal(new URL(metadata.canonical).origin, 'https://www.worldmonitor.app');
    });
  }
});

describe('agent homepage routing', () => {
  guardProBuiltOutput();
  for (const agent of agentRequestPolicy.userAgents) {
    it(`${agent} receives the Markdown document even with Accept: text/html`, async () => {
      for (const host of ['worldmonitor.app', 'www.worldmonitor.app']) {
        for (const method of ['GET', 'HEAD']) {
          const response = await middleware(new Request(`https://${host}/`, {
            method, headers: { 'User-Agent': `${agent}/1.0`, Accept: 'text/html' },
          }));
          assert.ok(response);
          assert.equal(response.headers.get('x-middleware-rewrite'), `https://${host}/pro/home.md`);
          assert.match(response.headers.get('content-type')!, /text\/markdown/);
          for (const header of ['Cache-Control', 'CDN-Cache-Control', 'Vercel-CDN-Cache-Control']) {
            assert.match(response.headers.get(header)!, /no-store/);
          }
          assert.equal(response.headers.get('vary'), 'User-Agent, Accept');
        }
      }
    });
  }

  it('serves the same complete homepage for crawler and Accept negotiation', { skip: shouldSkipProBuiltOutput() }, async () => {
    const html = readFileSync(new URL('../public/pro/welcome.html', import.meta.url), 'utf8');
    const depth = JSON.parse(readFileSync(new URL('../pro-test/src/generated/depth-stats.json', import.meta.url), 'utf8'));
    const { htmlToMarkdown } = await import('../api/_md-url-twin');
    const sections = [...html.matchAll(/<section\b[^>]*>[\s\S]*?<\/section>/g)]
      .map(section => htmlToMarkdown(section[0], 'World Monitor').replace(/^# World Monitor\n\n/, ''));
    assert.ok(sections.length > 0, 'the proof must exercise rendered homepage sections');
    let canonicalMarkdown: string | undefined;
    for (const headers of [
      { 'User-Agent': 'Mozilla/5.0', Accept: 'text/markdown' },
      ...agentRequestPolicy.userAgents.map(ua => ({ 'User-Agent': `${ua}/1.0`, Accept: 'text/html' })),
    ]) {
      const response = await middleware(new Request('https://www.worldmonitor.app/', { headers }));
      assert.ok(response, 'explicit markdown requests must be routed');
      const destination = new URL(response.headers.get('x-middleware-rewrite')!);
      const markdown = readFileSync(new URL(`../public${destination.pathname}`, import.meta.url), 'utf8');
      canonicalMarkdown ??= markdown;
      assert.equal(markdown, canonicalMarkdown);
      assert.match(markdown, /Under the hood/);
      assert.match(markdown, /^canonical: "https:\/\/www\.worldmonitor\.app\/"$/m);
      for (const value of Object.values(depth)) {
        const token = new RegExp(`\\b${value}\\b`);
        assert.match(html, token);
        assert.match(markdown, token);
      }
      // Compare each rendered teaser section, including its values and capture date.
      for (const section of sections) {
        assert.ok(markdown.includes(section), 'all rendered homepage sections must survive');
      }
    }
  });

  it('publishes clean homepage markdown with every rendered stat pair', { skip: shouldSkipProBuiltOutput() }, () => {
    const html = readFileSync(new URL('../public/pro/welcome.html', import.meta.url), 'utf8');
    const markdown = readFileSync(new URL('../public/pro/home.md', import.meta.url), 'utf8');
    assert.equal([...markdown.matchAll(/^# /gm)].length, 1);
    assert.doesNotMatch(markdown, /&(?:#(?:x[0-9a-f]+|\d+)|[a-z]+);/i);
    assert.doesNotMatch(markdown, /[?&]utm_/i);
    const band = html.match(/<section\b[^>]*\bid="depth"[^>]*>[\s\S]*?<\/section>/)?.[0];
    assert.ok(band);
    const pairs = [...band.matchAll(/<dt\b[^>]*>([^<]+)<\/dt>\s*<dd\b[^>]*>([^<]+)<\/dd>/g)];
    assert.equal(pairs.length, 15, 'exercise every rendered stat, not just standalone numbers');
    const section = markdown.slice(markdown.indexOf('Under the hood'));
    const rows = section.match(/^- [^\n]+: \d+$/gm) ?? [];
    assert.equal(rows.length, pairs.length);
    for (const [, label, value] of pairs) {
      const pair = `${decodeHtmlEntities(label)}: ${value}`;
      assert.ok(rows.includes(`- ${pair}`), pair);
    }
  });

  it('routes the advertised suffix to the complete negotiated document before the generic twin', async () => {
    const config = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
    const aliasIndex = config.rewrites.findIndex((rule: { source: string }) => rule.source === '/index.md');
    const twinIndex = config.rewrites.findIndex((rule: { destination: string }) => rule.destination.startsWith('/api/md-twin?'));
    const negotiated = await middleware(new Request('https://www.worldmonitor.app/', { headers: { Accept: 'text/markdown' } }));
    assert.ok(aliasIndex >= 0 && aliasIndex < twinIndex);
    assert.equal(config.rewrites[aliasIndex].destination, new URL(negotiated!.headers.get('x-middleware-rewrite')!).pathname);
  });

  it('honors explicit markdown media types and preserves HTML preferences', async () => {
    for (const accept of [
      'text/markdown', 'TEXT/MARKDOWN; charset=utf-8', 'text/html;q=0.5, text/markdown',
      'text/markdown;q=0.2, text/html;q=0, */*;q=0.9',
      'text/markdown;q=0.2, text/*;q=0, */*;q=0.9',
    ]) {
      for (const method of ['GET', 'HEAD']) {
        const response = await middleware(new Request('https://www.worldmonitor.app/', {
          method, headers: { 'User-Agent': 'Mozilla/5.0', Accept: accept },
        }));
        assert.equal(response?.headers.get('x-middleware-rewrite'), 'https://www.worldmonitor.app/pro/home.md');
        assert.equal(response?.headers.get('vary'), 'User-Agent, Accept');
        assert.match(response?.headers.get('cache-control') ?? '', /no-store/);
      }
    }
    for (const accept of [
      'text/html', '*/*', 'text/*', 'text/markdown;q=0', 'text/markdown;q=0.2, text/html', 'text/markdown-extra',
      'text/*, text/markdown;q=0',
      'text/markdown;q=0, text/*',
      'text/*;q=0.8, text/markdown;q=0.1, text/html;q=0.5',
      'text/markdown;q=0.2, */*;q=0.9',
      '*/*;q=0.9, text/markdown;q=0.2',
    ]) {
      assert.equal(await middleware(new Request('https://www.worldmonitor.app/', {
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: accept },
      })), undefined);
    }
  });

  it('preserves JSON agent mode, browsers, search crawlers, variants, and other paths', async () => {
    for (const [url, ua] of [
      ['https://www.worldmonitor.app/?mode=agent', 'ClaudeBot/1.0'],
      ['https://www.worldmonitor.app/', 'Mozilla/5.0'],
      ['https://www.worldmonitor.app/', 'Googlebot/2.1'],
      ['https://www.worldmonitor.app/', 'OAI-SearchBot/1.0'],
      ['https://www.worldmonitor.app/', 'Claude-SearchBot/1.0'],
      ['https://www.worldmonitor.app/', 'Bingbot/2.0'],
      ['https://www.worldmonitor.app/', 'NotClaudeBot/1.0'],
      ['https://www.worldmonitor.app/dashboard', 'ClaudeBot/1.0'],
      ['https://tech.worldmonitor.app/', 'ClaudeBot/1.0'],
    ]) {
      assert.equal(await middleware(new Request(url, { headers: { 'User-Agent': ua } })), undefined);
    }
  });

  it('keeps legacy map links on the dashboard redirect', async () => {
    const response = await middleware(new Request('https://www.worldmonitor.app/?lat=1&lon=2', {
      headers: { 'User-Agent': 'ClaudeBot/1.0' },
    }));
    assert.equal(response?.status, 308);
    assert.equal(response?.headers.get('location'), 'https://www.worldmonitor.app/dashboard');
  });
});

describe('API User-Agent denial', () => {
  for (const ua of ['', 'ora-agent', 'curl/8.1.2', 'ClaudeBot/1.0']) {
    it(`keeps the denial and returns recovery details for ${ua || 'missing UA'}`, async () => {
      const response = await middleware(new Request('https://www.worldmonitor.app/api/unknown', {
        headers: { 'User-Agent': ua },
      }));
      assert.equal(response?.status, 403);
      assert.match(response!.headers.get('content-type')!, /application\/json/);
      const body = await response!.json();
      assert.equal(body.error, 'Forbidden');
      assert.equal(body.code, 'agent_request_blocked');
      assert.ok(body.message);
      assert.match(body.hint, /User-Agent.*X-WorldMonitor-Key.*auth\.md/);
    });
  }
});
