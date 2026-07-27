import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const welcomeHtml = () => readFileSync(new URL('../public/pro/welcome.html', import.meta.url), 'utf8');
const enLocale = () =>
  JSON.parse(readFileSync(new URL('../pro-test/src/locales/en.json', import.meta.url), 'utf8'));
const WELCOME_FAQ_COUNT = 10;

test('welcome FAQPage JSON-LD matches every visible FAQ entry', () => {
  const html = welcomeHtml();
  const en = enLocale();
  const jsonLdBlocks = [...html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)]
    .map((match) => JSON.parse(match[1]));
  const faqPage = jsonLdBlocks.find((block) => block['@type'] === 'FAQPage');

  assert.ok(faqPage, 'welcome.html should include FAQPage JSON-LD');
  assert.equal(faqPage.mainEntity.length, WELCOME_FAQ_COUNT);
  for (let n = 1; n <= WELCOME_FAQ_COUNT; n += 1) {
    const entry = faqPage.mainEntity[n - 1];
    assert.equal(entry.name, en.welcome.faq[`q${n}`]);
    assert.equal(entry.acceptedAnswer?.text, en.welcome.faq[`a${n}`]);
  }
});

test('built welcome page ships the real hero in #root before JavaScript', () => {
  const html = welcomeHtml();
  const rootMatch = html.match(/<div id="root"(?<attrs>[^>]*)>(?<content>[\s\S]*?)<\/body>/);
  assert.ok(rootMatch?.groups, 'welcome page should contain #root before body close');

  const { attrs, content } = rootMatch.groups;
  const rootContent = content.split('<noscript>')[0];
  assert.match(attrs, /data-wm-prerendered="welcome"/);
  assert.match(attrs, /data-wm-prerender-lang="en"/);
  assert.doesNotMatch(rootContent, /id="seo-prerender"/);
  assert.equal([...rootContent.matchAll(/<h1\b/g)].length, 1);
  assert.match(rootContent, /<nav[\s>]/);
  assert.match(rootContent, /By the time it&#x27;s news,[\s\S]*you already knew\./);
  assert.match(rootContent, /Launch the dashboard/);
  assert.match(rootContent, /Open source · AGPL-3\.0/);
  assert.match(rootContent, /href="\/blog\/posts\/worldmonitor-is-not-palantir\/"/);
  assert.match(rootContent, /WorldMonitor is not an open-source Palantir/);
  assert.match(rootContent, /Map layers/);
  const navContent = rootContent.slice(
    rootContent.indexOf('<nav'),
    rootContent.indexOf('</nav>') + '</nav>'.length,
  );
  assert.match(navContent, /href="\/blog\/"/);
  assert.match(navContent, />Blog<\/a>/);
  assert.match(navContent, /id="welcome-tablet-navigation"/);
  assert.match(navContent, />Menu</);
  const headlineIndex = rootContent.indexOf('By the time it&#x27;s news,');
  assert.ok(headlineIndex > 0, 'welcome headline should be in the prerendered root');
  const heroSection = rootContent.slice(0, rootContent.indexOf('<section class="py-16'));
  assert.doesNotMatch(heroSection, /opacity:0/);
  assert.match(rootContent, /<img[^>]+src="\/pro\/assets\/worldmonitor-7-mar-2026-[^"]+\.jpg"[^>]+fetchPriority="high"/);
});
