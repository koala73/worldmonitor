import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('built welcome page ships the real hero in #root before JavaScript', () => {
  const html = readFileSync(new URL('../public/pro/welcome.html', import.meta.url), 'utf8');
  const rootMatch = html.match(/<div id="root"(?<attrs>[^>]*)>(?<content>[\s\S]*?)<noscript>/);
  assert.ok(rootMatch?.groups, 'welcome page should contain #root before noscript');

  const { attrs, content } = rootMatch.groups;
  assert.match(attrs, /data-wm-prerendered="welcome"/);
  assert.match(attrs, /data-wm-prerender-lang="en"/);
  assert.doesNotMatch(content, /id="seo-prerender"/);
  assert.match(content, /<nav[\s>]/);
  assert.match(content, /By the time it&#x27;s news,[\s\S]*you already knew\./);
  const headlineIndex = content.indexOf('By the time it&#x27;s news,');
  assert.ok(headlineIndex > 0, 'welcome headline should be in the prerendered root');
  assert.doesNotMatch(content.slice(Math.max(0, headlineIndex - 300), headlineIndex), /opacity:0/);
  assert.match(content, /<img[^>]+src="\/pro\/assets\/worldmonitor-7-mar-2026-[^"]+\.jpg"[^>]+fetchPriority="high"/);
});
