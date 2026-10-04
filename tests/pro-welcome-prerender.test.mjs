import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { latestValidGithubStarsSnapshot } from '../scripts/github-stars-snapshot.mjs';
import { guardProBuiltOutput, shouldSkipProBuiltOutput } from './_lib/pro-built-output.mjs';

let cachedWelcomeHtml;
const welcomeHtml = () =>
  (cachedWelcomeHtml ??= readFileSync(new URL('../public/pro/welcome.html', import.meta.url), 'utf8'));
const enLocale = () =>
  JSON.parse(readFileSync(new URL('../pro-test/src/locales/en.json', import.meta.url), 'utf8'));
// The FAQ answers interpolate the same build-measured figures the page renders.
const proofFacts = () =>
  JSON.parse(readFileSync(new URL('../pro-test/src/generated/depth-stats.json', import.meta.url), 'utf8'));
const fillProofFacts = (text, facts) => text.replace(/\{\{(\w+)\}\}/g, (_, key) => String(facts[key]));
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

// Index scanners rather than regex replacement for reading section text. The
// input is our own build output, but a single-pass `.replace` can leave a
// partial tag behind (CodeQL js/incomplete-multi-character-sanitization) and a
// case-sensitive `<script` pattern misses `<SCRIPT>` (js/bad-tag-filter).

// Drop every <script>/<style> element (any case, closing tag may carry
// whitespace or attributes). An unterminated element drops the rest.
function withoutElements(html, tagNames) {
  const lower = html.toLowerCase();
  let out = '';
  let i = 0;
  while (i < html.length) {
    const lt = lower.indexOf('<', i);
    if (lt === -1) return out + html.slice(i);
    const name = tagNames.find((tag) => lower.startsWith(tag, lt + 1));
    if (!name) {
      out += html.slice(i, lt + 1);
      i = lt + 1;
      continue;
    }
    out += html.slice(i, lt);
    const close = lower.indexOf(`</${name}`, lt + 1);
    const end = close === -1 ? -1 : lower.indexOf('>', close);
    if (end === -1) return out;
    i = end + 1;
  }
  return out;
}

// Replace each `<...>` tag with `separator`, keeping text between tags. A `<`
// with no later `>` (or an empty `<>`) stays literal, as with /<[^>]+>/g.
function tagsToText(html, separator) {
  let out = '';
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    const gt = lt === -1 ? -1 : html.indexOf('>', lt + 1);
    if (lt === -1 || gt === -1) return out + html.slice(i);
    if (gt === lt + 1) {
      out += html.slice(i, gt + 1);
    } else {
      out += html.slice(i, lt) + separator;
    }
    i = gt + 1;
  }
  return out;
}

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
  const facts = proofFacts();
  const faqPage = welcomeJsonLdBlocks().find((block) => block['@type'] === 'FAQPage');

  assert.ok(faqPage, 'welcome.html should include FAQPage JSON-LD');
  assert.equal(faqPage.mainEntity.length, WELCOME_FAQ_COUNT);
  for (let n = 1; n <= WELCOME_FAQ_COUNT; n += 1) {
    const entry = faqPage.mainEntity[n - 1];
    assert.equal(entry.name, en.welcome.faq[`q${n}`]);
    assert.equal(entry.acceptedAnswer?.text, fillProofFacts(en.welcome.faq[`a${n}`], facts));
  }
  assert.doesNotMatch(welcomeHtml(), /\{\{\w+\}\}/, 'no raw {{placeholder}} may reach the published page');
  // The chokepoint answer must state the measured count, not a placeholder.
  assert.match(faqPage.mainEntity[3].acceptedAnswer.text, new RegExp(`^Yes\\. ${facts.chokepoints} chokepoints`));
  // The structured answer to the Liveuamap question must carry the compare
  // destination itself, not only the DOM anchor derived from it (#7746).
  assert.match(faqPage.mainEntity[4].acceptedAnswer.text, /worldmonitor\.app\/compare\/liveuamap-alternatives/);
});

// AI answers quote one passage, not the stat rail beside it, so each
// question-headed passage must carry its own measured figure.
test('question-headed welcome passages state their own measured figures', { skip }, () => {
  const facts = proofFacts();
  const { content } = welcomeRoot();
  const passageAfter = (heading) => {
    const at = content.indexOf(`>${heading}</h2>`);
    assert.ok(at >= 0, `missing heading: ${heading}`);
    return content.slice(at).match(/<p[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? '';
  };
  const whatIs = passageAfter('What is World Monitor?');
  assert.match(whatIs, new RegExp(`${facts.feeds} news and OSINT feeds from ${facts.providers} attributed providers`));
  assert.match(whatIs, new RegExp(`${facts.mapLayers} map layer types`));
  // Resilience is Pro-locked, so the free-start answer must not promise every counted layer.
  assert.match(passageAfter('How do I start watching the world map?'), new RegExp(`${facts.mapLayers} map layer types, every one except Resilience free to switch on`));
  assert.match(passageAfter('How do I build on World Monitor from my own stack?'), new RegExp(`${facts.mcpTools} live tools`));
  assert.match(content, new RegExp(`${facts.mcpTools} MCP tools`));
});

// geo.new scores a plain count 0 on statistics and a block under ~40 words 60
// on self-containment, so these two first-five cards carry a percentage or the
// length that earns those dimensions. The figures come from copy-stats.json.
test('first-five probe cards state measured figures at citation length', { skip }, () => {
  const facts = proofFacts();
  const copy = JSON.parse(readFileSync(new URL('../pro-test/src/generated/copy-stats.json', import.meta.url), 'utf8'));
  const { content } = welcomeRoot();
  const cardText = (heading) => {
    const at = content.indexOf(`>${heading}</h3>`);
    assert.ok(at >= 0, `missing card: ${heading}`);
    return tagsToText(content.slice(at).match(/<p[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? '', '').replace(/&#x27;/g, "'");
  };
  const tenth = cardText('You&#x27;ve seen maybe a tenth of it');
  assert.match(tenth, new RegExp(`^When the map opens on desktop, ${copy.defaultOnLayers} of its ${facts.mapLayers} map layer types, about ${copy.defaultOnLayerPct}%, are switched on\\.`));
  const country = cardText('Click any country');
  for (const [name, text] of [['tenth', tenth], ['country', country]]) {
    assert.ok(text.split(/\s+/).length >= 40, `${name} card is under 40 words: ${text}`);
  }
});

// geo.new credits only prices, percentages and dates on statistics, so each of
// these sections carries a real one: the $0 plan, the generated Pro price, and
// the GPS thresholds at 40+ words.
test('sections state a price or percentage the audit credits', { skip }, () => {
  const copy = JSON.parse(readFileSync(new URL('../pro-test/src/generated/copy-stats.json', import.meta.url), 'utf8'));
  const { content } = welcomeRoot();
  const passageAfter = (heading) => {
    const at = content.indexOf(`>${heading}</h`);
    assert.ok(at >= 0, `missing heading: ${heading}`);
    return tagsToText(content.slice(at).match(/<p[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? '', '');
  };
  assert.match(passageAfter('What is World Monitor?'), /^World Monitor is a free \(\$0\), open-source/);
  assert.match(passageAfter('How do I start watching the world map?'), /in any browser for \$0, with no account/);
  const build = passageAfter('How do I build on World Monitor from my own stack?');
  assert.ok(build.includes(`MCP access comes with Pro, from $${copy.proMonthlyPrice}/mo.`), build);
  const gps = passageAfter('GPS jamming zones');
  assert.match(gps, /at least 2% of aircraft/);
  assert.ok(gps.split(/\s+/).length >= 40, `GPS card is under 40 words: ${gps}`);
});

// The FAQ figures live inside <details> answers, which geo.new did not credit
// to the heading (the FAQ scored weakest, 37/100, though its first answer
// opens with $0). The heading therefore needs its own paragraph, directly
// under the <h2> and before the first <details>.
test('FAQ heading carries its own figure paragraph before the answers', { skip }, () => {
  const { content } = welcomeRoot();
  const at = content.indexOf('>What are common questions about World Monitor?</h2>');
  assert.ok(at >= 0, 'missing FAQ heading');
  const beforeAnswers = content.slice(at, content.indexOf('<details', at));
  const subtitle = tagsToText(beforeAnswers.match(/<p[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? '', '');
  assert.match(subtitle, new RegExp(`^${WELCOME_FAQ_COUNT} straight answers on price, data, alerts and AI access\\.`));
  assert.match(subtitle, /costs \$0/);
  assert.match(subtitle, /AGPL-3\.0/);
});

// The geo.new CIT-02/03 audit judges each H2 section by its opening, roughly
// the first 60 words, so a figure buried in the fifth FAQ answer does not
// count. Every H2 section, the noscript fallback included, must open with one.
test('every H2 section states a figure within its first 60 words', { skip }, () => {
  const facts = proofFacts();
  const html = withoutElements(welcomeHtml(), ['script', 'style']);
  const parts = html.split(/<h2[^>]*>([\s\S]*?)<\/h2>/);
  assert.ok(parts.length > 20, 'expected the welcome page H2 sections');
  for (let i = 1; i < parts.length; i += 2) {
    const heading = tagsToText(parts[i], '').trim();
    const opening = tagsToText(parts[i + 1], ' ').split(/\s+/).filter(Boolean).slice(0, 60).join(' ');
    assert.match(opening, /\d/, `"${heading}" opens without a figure: ${opening}`);
  }
  assert.match(welcomeHtml(), new RegExp(`${facts.feeds} news and OSINT feeds — onto one live map with ${facts.mapLayers} map layer types`));
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
  // Comparison links must remain real anchors in the static FAQ;
  // it has to survive prerender so non-JS crawlers see it (#7746).
  const faqStart = rootContent.indexOf('id="faq"');
  assert.ok(faqStart >= 0, 'the FAQ section must be prerendered');
  const faqContent = rootContent.slice(faqStart);
  assert.match(faqContent, /href="\/compare\/best-geopolitical-risk-dashboards\/"[^>]*>worldmonitor\.app\/compare\/best-geopolitical-risk-dashboards<\/a>/);
  assert.match(faqContent, /href="\/compare\/liveuamap-alternatives\/"[^>]*>worldmonitor\.app\/compare\/liveuamap-alternatives<\/a>/);
  // Untagged since #8603: middleware 308s utm_* away, so every one of these
  // was a redirect hop. Each link is still identified individually, by the
  // Umami target or link text that replaced its utm tag as the attribution.
  assert.match(rootContent, /href="\/sources\/"[^>]*data-umami-event-target="welcome-sources-proof"/);
  assert.match(rootContent, /href="\/sources\/"[^>]*data-umami-event-target="welcome-sources-depth"/);
  assert.match(rootContent, /href="\/sources\/"[^>]*>Sources<\/a>/);
  assert.doesNotMatch(rootContent, /href="\/sources\/\?/);
  assert.match(rootContent, /Map layer types/);
  const navContent = rootContent.slice(
    rootContent.indexOf('<nav'),
    rootContent.indexOf('</nav>') + '</nav>'.length,
  );
  assert.match(navContent, /href="\/blog\/"/);
  assert.match(navContent, />Blog<\/a>/);
  assert.match(navContent, /href="\/sources\/"[^>]*>Attributed providers<\/a>/);
  assert.match(navContent, /id="welcome-tablet-navigation"/);
  assert.match(navContent, />Menu</);
  const headlineIndex = rootContent.indexOf('By the time it&#x27;s news,');
  assert.ok(headlineIndex > 0, 'welcome headline should be in the prerendered root');
  const heroSection = rootContent.slice(0, rootContent.indexOf('<section class="py-16'));
  assert.doesNotMatch(heroSection, /opacity:0/);
  assert.match(rootContent, /<img[^>]+src="\/pro\/assets\/worldmonitor-7-mar-2026-[^"]+\.jpg"[^>]+fetchPriority="high"/);
});

test('built welcome root hides no SSR content and links every primary reference page', { skip }, () => {
  const { content: rootContent } = welcomeRoot();
  // Content styled invisible or off-position before hydration reads to crawlers as cloaking.
  const hiddenContentNodes = [...rootContent.matchAll(/<[a-z][a-z0-9:-]*\b[^>]*\bstyle="([^"]*)"[^>]*>/gi)]
    .filter(([tag, style]) =>
      !/\baria-hidden="true"/i.test(tag)
      && /(?:opacity:\s*0(?![\d.])|transform:\s*translate(?:3d|[xyz])?\()/i.test(style),
    )
    .map(([tag]) => tag);
  assert.deepEqual(hiddenContentNodes, [], 'the welcome root must not hide or translate SSR content before hydration');
  assert.match(rootContent, /ACLED/);
  assert.match(rootContent, /NASA FIRMS/);
  // Exact href of a real anchor: a substring match would accept data-href=,
  // non-anchor elements, or a longer path such as /countries/old.
  const anchorHrefs = new Set(
    [...rootContent.matchAll(/<a\b[^>]*>/gi)]
      .map(([tag]) => /\shref="([^"]*)"/i.exec(tag)?.[1])
      .filter((href) => href !== undefined),
  );
  for (const href of [
    '/countries/',
    '/chokepoints/',
    '/crises/',
    '/tools/',
    '/blog/',
    'https://www.worldmonitor.app/docs/documentation',
    '/pro#pricing',
    'https://github.com/koala73/worldmonitor',
  ]) {
    assert.ok(anchorHrefs.has(href), `visible welcome content should contain an <a href="${href}">`);
  }
});

test('built welcome page prerenders task routes and agent discovery links', { skip }, () => {
  const { content: rootContent } = welcomeRoot();
  const heroIndex = rootContent.indexOf('By the time it&#x27;s news,');
  const taskIndex = rootContent.indexOf('What are you trying to find out?');
  // Keep in sync with welcome.live.title in pro-test/src/locales/en.json (#7381).
  const liveIndex = rootContent.indexOf('What live data is this page showing right now?');
  assert.ok(heroIndex >= 0, 'hero should remain in the prerendered root');
  assert.ok(taskIndex > heroIndex, 'task routes should follow the hero');
  assert.ok(liveIndex > taskIndex, 'live proof should follow the task routes');

  const taskLinks = [
    ['crises', 'welcome-task-verify'],
    ['chokepoints', 'welcome-task-chokepoint'],
    ['countries', 'welcome-task-country-risk'],
  ];
  for (const [route, target] of taskLinks) {
    assert.match(
      rootContent,
      new RegExp(`href="/${route}/"[^>]*data-umami-event="welcome-cta"[^>]*data-umami-event-target="${target}"`),
    );
  }
  assert.doesNotMatch(rootContent, /href="\/(?:crises|chokepoints|countries)\/\?/);

  // #8603 replaced the utm_content tag on these with an Umami attribute. The
  // noise-key 308 is bot-gated (middleware.ts), so a human always kept the
  // param and the analytics cost of dropping it falls entirely on human
  // traffic — these four are the ones that carried nothing else.
  // Order-independent: framer-motion forwards these through to the DOM element
  // and does not promise to preserve prop order, so both attributes are matched
  // within one anchor tag rather than in sequence.
  const anchorTags = rootContent.match(/<a\b[^>]*>/g) ?? [];
  assert.ok(anchorTags.length > 20, `expected the prerendered anchors, saw ${anchorTags.length}`);
  for (const target of [
    'welcome-depth-n1',
    'welcome-depth',
    'welcome-f5m',
    'welcome-moment-m1',
    'welcome-moment-m4',
  ]) {
    assert.ok(
      anchorTags.some((tag) => tag.includes(`data-umami-event-target="${target}"`) && tag.includes('data-umami-event="welcome-cta"')),
      `the ${target} CTA must keep an attribution attribute after losing its utm tag`,
    );
  }

  const navContent = rootContent.slice(
    rootContent.indexOf('<nav'),
    rootContent.indexOf('</nav>') + '</nav>'.length,
  );
  assert.match(navContent, /href="#agents"[^>]*>For AI agents<\/a>/);

  const agentSection = rootContent.slice(rootContent.indexOf('<section id="agents"'));
  const agentLinks = [
    /href="\/llms\.txt"[^>]*data-umami-event="welcome-cta"[^>]*data-umami-event-target="welcome-agent-briefing"/,
    /href="https:\/\/worldmonitor\.app\/mcp"[^>]*data-umami-event="welcome-cta"[^>]*data-umami-event-target="welcome-agent-mcp"/,
    // #8603: the bare api host root is a 308 to the www homepage, so the card
    // now links the API reference itself, and its displayed string tracks the
    // destination — see the display assertion below.
    /href="https:\/\/www\.worldmonitor\.app\/docs\/api-reference"[^>]*data-umami-event="welcome-cta"[^>]*data-umami-event-target="welcome-agent-api"/,
    /href="\/\?mode=agent"[^>]*data-umami-event="welcome-cta"[^>]*data-umami-event-target="welcome-agent-view"/,
  ];
  for (const linkPattern of agentLinks) {
    assert.match(agentSection, linkPattern);
  }
  // This block is what an LLM summarising the section reads, so the string a
  // card displays has to be the URL it actually opens. Every card is checked,
  // not just the one #8603 repointed.
  for (const [href, display] of [
    ['/llms.txt', '/llms.txt'],
    ['https://worldmonitor.app/mcp', 'worldmonitor.app/mcp'],
    ['https://www.worldmonitor.app/docs/api-reference', 'worldmonitor.app/docs/api-reference'],
    ['/?mode=agent', '/?mode=agent'],
  ]) {
    const escapeRe = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Two bounds, both load-bearing. `[^>]*>` forces the match past the end
    // of the opening tag, because an absolute href CONTAINS its own display
    // string (https://www.worldmonitor.app/docs/api-reference contains
    // worldmonitor.app/docs/api-reference) and without it this passed
    // vacuously against the very attribute it exists to compare. Refusing to
    // cross the closing tag keeps it inside the one card, so it cannot pass on
    // a neighbouring card's display string either.
    assert.match(
      agentSection.replace(/&#x2F;/g, '/').replace(/&amp;/g, '&'),
      new RegExp(`href="${escapeRe(href)}"[^>]*>(?:(?!</a>)[\\s\\S])*?${escapeRe(display)}`),
      `the agent card for ${href} must display its own destination`,
    );
  }
});

test('built welcome SoftwareApplication carries the snapshot star InteractionCounter', { skip }, () => {
  const snapshot = latestValidGithubStarsSnapshot();
  const application = welcomeJsonLdBlocks().find((block) => block['@type'] === 'SoftwareApplication');
  assert.ok(application, 'welcome.html should include SoftwareApplication JSON-LD');
  assert.deepEqual(application.interactionStatistic, {
    '@type': 'InteractionCounter',
    interactionType: 'https://schema.org/LikeAction',
    name: 'GitHub stars',
    userInteractionCount: snapshot.stargazers_count,
  });
  assert.doesNotMatch(welcomeHtml(), /%GITHUB_STARS_INTERACTION%/);
});

test('hero proof rail renders measured numerals with extractable labels', { skip }, () => {
  const facts = JSON.parse(readFileSync(new URL('../shared/product-facts.generated.json', import.meta.url), 'utf8'));
  const { content } = welcomeRoot();
  for (const [value, label] of [
    [String(facts.heroProofStats.mapLayers), 'Map layer types'],
    [String(facts.heroProofStats.feeds), 'News &amp; OSINT feeds'],
    [String(facts.heroProofStats.providers), 'Attributed providers'],
    [String(facts.heroProofStats.alertOrigins), 'Independent alert origins'],
  ]) {
    assert.ok(content.includes(`>${value}</div>`), `hero rail must render the numeral ${value}`);
    assert.ok(content.includes(label), `hero rail must label the numeral ${label}`);
  }
  const railStart = content.indexOf('sm:max-w-3xl grid-cols-2');
  assert.ok(railStart > 0, 'hero proof rail markup must be present');
  const rail = content.slice(railStart, content.indexOf('mt-8 flex', railStart));
  assert.doesNotMatch(rail, />(Shared|Curated|Attributed)</, 'hero numeral slots must not render adjectives');
});

test('homepage answers "What is World Monitor?" and carries page date metadata', { skip }, () => {
  const html = welcomeHtml();
  const heading = html.match(/<h2[^>]*>What is World Monitor\?<\/h2>\s*<p[^>]*>([\s\S]*?)<\/p>/);
  assert.ok(heading, 'homepage must define World Monitor under an answer-style H2');
  const words = heading[1].replace(/<[^>]+>/g, '').trim().split(/\s+/).length;
  assert.ok(words >= 40 && words <= 60, `definition must be 40-60 words, got ${words}`);
  assert.match(html, /<meta name="lastmod" content="\d{4}-\d{2}-\d{2}"\s*\/>/);
});

test('built welcome teaser strip badges the snapshot as a published pulse (#7654)', { skip }, () => {
  // The prerender bakes the fallback rows, which are a frozen capture of real
  // published data (#7608) — a crawler must read them as an attributable
  // snapshot, never a sample.
  const { content: rootContent } = welcomeRoot();
  assert.match(rootContent, /data-live-updated/, 'strip badges must carry the corpus live-updated marker');
  assert.match(rootContent, /Published pulse \w{3} \d{1,2}, \d{4}/, 'strip badges must name the freeze date');
  assert.match(rootContent, /Enable JavaScript to refresh/, 'strip must carry the corpus refresh affordance');
  assert.doesNotMatch(rootContent, />Sample</, 'no card may badge real snapshot rows as a sample');
});

test('built welcome lastmod tracks the teaser strip snapshot (#7654)', { skip }, () => {
  const teasers = JSON.parse(readFileSync(new URL('../pro-test/src/generated/teasers.json', import.meta.url), 'utf8'));
  assert.match(
    welcomeHtml(),
    new RegExp(`<meta name="lastmod" content="${teasers.capturedAt}"`),
    'served homepage lastmod must be the snapshot capture date behind the strip',
  );
});
