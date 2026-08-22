import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { guardProBuiltOutput, shouldSkipProBuiltOutput } from './_lib/pro-built-output.mjs';

let cachedWelcomeHtml;
const welcomeHtml = () =>
  (cachedWelcomeHtml ??= readFileSync(new URL('../public/pro/welcome.html', import.meta.url), 'utf8'));
const enLocale = () =>
  JSON.parse(readFileSync(new URL('../pro-test/src/locales/en.json', import.meta.url), 'utf8'));
const WELCOME_FAQ_COUNT = 11;
const CANONICAL_ORIGIN = 'https://www.worldmonitor.app/';

let cachedJsonLdBlocks;
const welcomeJsonLdBlocks = () =>
  (cachedJsonLdBlocks ??= [
    ...welcomeHtml().matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g),
  ].map((match) => JSON.parse(match[1])));

// Every assertion here reads the prerendered public/pro/welcome.html, which is
// built by `npm run build:pro` rather than committed (#6898). Skip when the
// checkout has not built it; fail when WM_EXPECT_BUILT_OUTPUT=1 says CI did.
const skip = shouldSkipProBuiltOutput();
guardProBuiltOutput();

const welcomeRoot = () => {
  const rootMatch = welcomeHtml().match(/<div id="root"(?<attrs>[^>]*)>(?<content>[\s\S]*?)<\/body>/);
  assert.ok(rootMatch?.groups, 'welcome page should contain #root before body close');
  return {
    attrs: rootMatch.groups.attrs,
    content: rootMatch.groups.content.split('<noscript>')[0],
  };
};

test('welcome FAQPage JSON-LD matches every visible FAQ entry', { skip }, () => {
  const en = enLocale();
  const faqPage = welcomeJsonLdBlocks().find((block) => block['@type'] === 'FAQPage');

  assert.ok(faqPage, 'welcome.html should include FAQPage JSON-LD');
  assert.equal(faqPage.mainEntity.length, WELCOME_FAQ_COUNT);
  for (let n = 1; n <= WELCOME_FAQ_COUNT; n += 1) {
    const entry = faqPage.mainEntity[n - 1];
    assert.equal(entry.name, en.welcome.faq[`q${n}`]);
    assert.equal(entry.acceptedAnswer?.text, en.welcome.faq[`a${n}`]);
  }
});

test('welcome JSON-LD connects the page, website, application, and publisher', { skip }, () => {
  const html = welcomeHtml();
  const blocks = welcomeJsonLdBlocks();
  const webPage = blocks.find((block) => block['@type'] === 'WebPage');
  const webSite = blocks.find((block) => block['@type'] === 'WebSite');
  const organization = blocks.find((block) => block['@type'] === 'Organization');
  const application = blocks.find((block) => block['@type'] === 'SoftwareApplication');
  const metaDescription = html.match(/<meta name="description" content="([^"]+)"/u)?.[1];

  assert.ok(webPage, 'welcome.html should include WebPage JSON-LD');
  assert.ok(webSite, 'welcome.html should include WebSite JSON-LD');
  assert.ok(organization, 'welcome.html should include Organization JSON-LD');
  assert.ok(application, 'welcome.html should include SoftwareApplication JSON-LD');
  assert.equal(webPage['@id'], `${CANONICAL_ORIGIN}#webpage`);
  assert.equal(webPage.url, CANONICAL_ORIGIN);
  assert.equal(webPage.description, metaDescription);
  assert.deepEqual(webPage.isPartOf, { '@id': `${CANONICAL_ORIGIN}#website` });
  assert.deepEqual(webPage.mainEntity, { '@id': `${CANONICAL_ORIGIN}#software` });
  assert.equal(webSite['@id'], `${CANONICAL_ORIGIN}#website`);
  assert.equal(webSite.url, CANONICAL_ORIGIN);
  assert.deepEqual(webSite.publisher, { '@id': `${CANONICAL_ORIGIN}#organization` });
  assert.equal(organization['@id'], `${CANONICAL_ORIGIN}#organization`);
  assert.equal(organization.url, CANONICAL_ORIGIN);
  assert.equal(application['@id'], `${CANONICAL_ORIGIN}#software`);
  assert.equal(application.url, CANONICAL_ORIGIN);
  assert.deepEqual(application.publisher, { '@id': `${CANONICAL_ORIGIN}#organization` });
});

test('built welcome page ships the real hero in #root before JavaScript', { skip }, () => {
  const { attrs, content: rootContent } = welcomeRoot();
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
  assert.match(rootContent, /Which World Monitor license do I need\?/);
  assert.match(rootContent, /API Business lets that organization embed World Monitor data/);
  assert.match(rootContent, /href="\/docs\/terms"[^>]*>worldmonitor\.app\/docs\/terms<\/a>/);
  assert.match(rootContent, /href="\/sources\/\?utm_source=welcome-hero"/);
  assert.match(rootContent, /href="\/sources\/\?utm_source=welcome-depth"/);
  assert.match(rootContent, /href="\/sources\/\?utm_source=welcome-footer"[^>]*>Sources<\/a>/);
  assert.match(rootContent, /Map layers/);
  const navContent = rootContent.slice(
    rootContent.indexOf('<nav'),
    rootContent.indexOf('</nav>') + '</nav>'.length,
  );
  assert.match(navContent, /href="\/blog\/"/);
  assert.match(navContent, />Blog<\/a>/);
  assert.match(navContent, /href="\/sources\/\?utm_source=welcome-nav"[^>]*>Sources<\/a>/);
  assert.match(navContent, /id="welcome-tablet-navigation"/);
  assert.match(navContent, />Menu</);
  const headlineIndex = rootContent.indexOf('By the time it&#x27;s news,');
  assert.ok(headlineIndex > 0, 'welcome headline should be in the prerendered root');
  const heroSection = rootContent.slice(0, rootContent.indexOf('<section class="py-16'));
  assert.doesNotMatch(heroSection, /opacity:0/);
  assert.match(rootContent, /<img[^>]+src="\/pro\/assets\/worldmonitor-7-mar-2026-[^"]+\.jpg"[^>]+fetchPriority="high"/);
});

test('built welcome page prerenders task routes and agent discovery links', { skip }, () => {
  const { content: rootContent } = welcomeRoot();
  const heroIndex = rootContent.indexOf('By the time it&#x27;s news,');
  const taskIndex = rootContent.indexOf('What are you trying to find out?');
  const liveIndex = rootContent.indexOf('This page is plugged into the same APIs as the dashboard.');
  assert.ok(heroIndex >= 0, 'hero should remain in the prerendered root');
  assert.ok(taskIndex > heroIndex, 'task routes should follow the hero');
  assert.ok(liveIndex > taskIndex, 'live proof should follow the task routes');

  const taskLinks = [
    ['crises', 'task-verify', 'welcome-task-verify'],
    ['chokepoints', 'task-chokepoint', 'welcome-task-chokepoint'],
    ['countries', 'task-country-risk', 'welcome-task-country-risk'],
  ];
  for (const [route, content, target] of taskLinks) {
    assert.match(
      rootContent,
      new RegExp(`href="/${route}/\\?utm_source=welcome&amp;utm_content=${content}"[^>]*data-umami-event="welcome-cta"[^>]*data-umami-event-target="${target}"`),
    );
  }
  assert.doesNotMatch(rootContent, /href="\/(?:crises|chokepoints|countries)\/\?[^"#]*(?:ref|wm_referral)=/);

  const navContent = rootContent.slice(
    rootContent.indexOf('<nav'),
    rootContent.indexOf('</nav>') + '</nav>'.length,
  );
  assert.match(navContent, /href="#agents"[^>]*>For AI agents<\/a>/);

  const agentSection = rootContent.slice(rootContent.indexOf('<section id="agents"'));
  const agentLinks = [
    /href="\/llms\.txt"[^>]*data-umami-event="welcome-cta"[^>]*data-umami-event-target="welcome-agent-briefing"/,
    /href="https:\/\/worldmonitor\.app\/mcp"[^>]*data-umami-event="welcome-cta"[^>]*data-umami-event-target="welcome-agent-mcp"/,
    /href="https:\/\/api\.worldmonitor\.app"[^>]*data-umami-event="welcome-cta"[^>]*data-umami-event-target="welcome-agent-api"/,
    /href="\/\?mode=agent"[^>]*data-umami-event="welcome-cta"[^>]*data-umami-event-target="welcome-agent-view"/,
  ];
  for (const linkPattern of agentLinks) {
    assert.match(agentSection, linkPattern);
  }
});
