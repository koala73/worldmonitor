// Generator for /monitor-the-situation/: one page that answers the query
// "monitor the situation" with the live board itself. The three live sections
// come from scripts/situation-page/sections.mjs and are re-rendered by the
// routing middleware at request time; the crisis list is the registry with
// its frozen HAPI figures. Template helpers are injected by
// build-crawlable-corpus.mjs, the single owner of the corpus HTML shell.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CHOKEPOINT_REGISTRY } from '../src/config/chokepoint-registry.ts';
import { SITUATION_PAGE_PATH, situationSections } from './situation-page/sections.mjs';

const SITUATION_SECTIONS = situationSections(CHOKEPOINT_REGISTRY);

export { SITUATION_PAGE_PATH };

/** Bump when the page copy changes so its lastmod advances without touching every sibling. */
export const SITUATION_CONTENT_VERSION = '2026-10-24';

/** Every file whose change alters this page's HTML, for its lastmod clock. */
export const SITUATION_PAGE_INPUT_PATHS = Object.freeze([
  'scripts/build-situation-page.mjs',
  'scripts/situation-page',
  'scripts/live-pages',
]);

/**
 * The regions a crisis tracker is filed under. Each `id` is the anchor of a
 * region section, so a "monitor the situation middle east" query has a target.
 * A tracker's region comes from `region` in shared/crawlable-crises.json; the
 * registry loader rejects any value outside this list.
 */
export const CRISIS_REGIONS = Object.freeze([
  { id: 'middle-east', label: 'Middle East' },
  { id: 'europe', label: 'Europe' },
  { id: 'africa', label: 'Africa' },
  { id: 'asia', label: 'Asia' },
  { id: 'americas', label: 'Americas' },
]);

export const CRISIS_REGION_IDS = Object.freeze(CRISIS_REGIONS.map((region) => region.id));

const H1 = 'Monitor the situation';
const TITLE = 'Monitor the Situation: Live World Board | World Monitor';
const DESCRIPTION = 'A free live board of what is happening in the world now: breaking headlines, 14 crisis trackers by region, shipping chokepoint status and internet outages, each with the time it was last read.';

const OBSERVATION_PERIOD_RE = /^\d{4}-\d{2}(-\d{2})?$/;
const MONTH_FORMAT = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });

function referenceMonth(period) {
  const timestamp = Date.parse(`${String(period).slice(0, 7)}-01T00:00:00Z`);
  return Number.isFinite(timestamp) ? MONTH_FORMAT.format(new Date(timestamp)) : String(period);
}

/**
 * The frozen HAPI line for one tracker, or null when the pulse holds no
 * combined figure for it (missing capture, or covered countries reporting
 * different months, which the freeze records as eventsTotal null).
 */
export function crisisFigure(pulse) {
  if (!pulse || pulse.state === 'missing') return null;
  const events = String(pulse.eventsTotal ?? '').trim();
  const fatalities = String(pulse.fatalities ?? '').trim();
  const period = String(pulse.referencePeriod ?? '').trim();
  if (!/^[\d,]+$/.test(events) || !/^[\d,]+$/.test(fatalities) || !OBSERVATION_PERIOD_RE.test(period)) return null;
  return `${events} recorded events and ${fatalities} fatalities in the ${referenceMonth(period)} HAPI summary`;
}

function renderCrisisCard(crisis, pulse, escapeHtml) {
  const figure = crisisFigure(pulse);
  const missing = figure && Array.isArray(pulse.missingCountries) ? pulse.missingCountries : [];
  const unavailable = missing.length ? ` Unavailable in this snapshot: ${escapeHtml(missing.join(', '))}.` : '';
  return `          <li class="situation" id="${escapeHtml(crisis.slug)}">
            <h3><a href="/crises/${escapeHtml(crisis.slug)}/">${escapeHtml(crisis.shortTitle)}</a></h3>
            <p>${escapeHtml(crisis.description)}</p>
            <p class="figure">${figure ? escapeHtml(figure) : 'No combined figure is published for this tracker in the current snapshot'}.${unavailable} Covers ${escapeHtml(crisis.coverage.map((country) => country.name).join(', '))}.</p>
            <p class="links"><a href="/crises/${escapeHtml(crisis.slug)}/">Tracker</a> · <a href="${escapeHtml(crisis.dashboardPath)}">Open on the live map</a></p>
          </li>`;
}

export function renderActiveSituations({ crises, livePulse, escapeHtml }) {
  const regions = CRISIS_REGIONS
    .map((region) => ({ region, crises: crises.filter((crisis) => crisis.region === region.id) }))
    .filter(({ crises: members }) => members.length > 0);
  return regions.map(({ region, crises: members }) => `        <section class="region" id="${region.id}">
          <h3>${escapeHtml(region.label)}</h3>
          <ul class="situations">
${members.map((crisis) => renderCrisisCard(crisis, livePulse?.crises?.[crisis.slug] ?? null, escapeHtml)).join('\n')}
          </ul>
        </section>`).join('\n');
}

const FAQ = Object.freeze([
  {
    question: 'Is there a website to monitor the situation?',
    answer: 'Yes. World Monitor is a free live board of what is happening in the world now. The map and its panels need no account, and this page lists the current situations with the time each reading was taken: headlines, 14 crisis trackers by region, shipping chokepoint status and internet outages.',
  },
  {
    question: 'How do I monitor the situation in the Middle East?',
    answer: 'Start with the Middle East section of this page. It lists the Iran and Israel, Lebanon and Israel, Palestine, Red Sea and Gulf trackers with their latest monthly conflict figures. The Strait of Hormuz and Bab el-Mandeb rows in the chokepoint table show current shipping pressure, and the live map shows the same regions with event-level detail.',
  },
  {
    question: 'What does "monitor the situation" mean?',
    answer: 'To monitor the situation is to keep watching a developing event, usually a conflict, a disaster or a market shock, as new reports arrive. The phrase spread online as a joke about people who refresh the news constantly without being able to change anything. On this page it means the readings above: each one states its source and the time it was taken.',
  },
  {
    question: 'Is World Monitor free?',
    answer: 'The live map and its panels are free and need no account. Alert rules and scheduled digests, which deliver to Slack, Microsoft Teams, Discord, Telegram, email, browser push or a signed webhook, need a paid plan.',
  },
]);

function faqPageLd(faqs) {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqs.map((faq) => ({
      '@type': 'Question',
      name: faq.question,
      acceptedAnswer: { '@type': 'Answer', text: faq.answer },
    })),
  };
}

function renderFaq(escapeHtml) {
  return FAQ.map((faq) => `      <h3>${escapeHtml(faq.question)}</h3>
      <p>${escapeHtml(faq.answer)}</p>`).join('\n');
}

const EXTRA_STYLES = `
      .headlines { margin: 16px 0 0; padding-left: 22px; }
      .headlines li { padding: 6px 0; border-bottom: 1px solid var(--line); color: var(--text); }
      .headlines li:last-child { border-bottom: 0; }
      .headlines small { display: block; color: var(--muted); }
      .region { margin-top: 24px; }
      .region h3 { margin: 0 0 8px; font-size: 18px; }
      .situations { list-style: none; padding: 0; margin: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 14px; }
      .situation { border: 1px solid var(--line); border-radius: 8px; padding: 16px; background: var(--panel); }
      .situation h3 { margin: 0 0 8px; font-size: 17px; }
      .situation p { margin: 0 0 8px; font-size: 14px; }
      .situation .figure { color: var(--text); }
      .situation .links { margin: 0; }
      .routine { padding-left: 22px; color: var(--muted); }
      .routine li { margin-bottom: 8px; }`;

export function renderSituationPage({ baseUrl, lastmod, tpl, crises, livePulse, hubRows, snapshotPath }) {
  const { escapeHtml, absoluteUrl, breadcrumbLd, pageDocument } = tpl;
  const url = absoluteUrl(baseUrl, SITUATION_PAGE_PATH);
  const sections = Object.fromEntries(SITUATION_SECTIONS.map((section) => [
    section.slug,
    section.renderSection(section.published(livePulse, { hubRows }), { live: false }),
  ]));
  const body = `      <p class="eyebrow">Live board</p>
      <h1>${escapeHtml(H1)}</h1>
      <p class="lede">World Monitor is a free live board of what is happening in the world now: conflicts, shipping chokepoints, internet outages and breaking headlines, with the time each reading was taken. The <a href="/dashboard">live map</a> shows the same data with event-level detail and needs no account.</p>
${sections.headlines}
      <h2 id="active-situations">Active situations</h2>
      <p>The ${crises.length} crisis trackers below have a fixed country scope and a dated monthly conflict summary from the UN OCHA <a href="https://data.humdata.org/hapi">Humanitarian API (HDX HAPI)</a>. Each links to its tracker page and to the same view on the live map. The figures are the ${escapeHtml(String(livePulse.capturedAt))} snapshot and are not forecasts.</p>
${renderActiveSituations({ crises, livePulse, escapeHtml })}
${sections.chokepoints}
${sections.outages}
      <h2 id="how-to">How to monitor the situation</h2>
      <ol class="routine">
        <li>Open the <a href="/dashboard">live map</a>. The map and its panels are free and need no account.</li>
        <li>Pick a situation above and open its tracker page, or the map view it links to, for the event-level detail behind the monthly figure.</li>
        <li>Open a <a href="/countries/">country page</a> for that country's instability and resilience scores and its recent reporting.</li>
        <li>Set an alert rule on a paid plan. Rules filter by event type, severity and country, deliver to Slack, Microsoft Teams, Discord, Telegram, email, browser push or a signed webhook, and run in real time or as a daily, twice-daily or weekly digest. See the <a href="/docs/api-notifications">notifications reference</a>.</li>
        <li>Connect an agent. The <a href="/docs/mcp-overview">MCP server</a>, the REST API, the Python, Go and Ruby SDKs and the npm CLI read the same data; setup steps are on the <a href="/agent/">agent page</a>.</li>
      </ol>
      <h2 id="meaning">What does "monitor the situation" mean?</h2>
      <p>To monitor the situation is to keep watching a developing event, usually a conflict, a disaster or a market shock, as new reports arrive. The phrase spread online as a joke about people who refresh the news constantly without being able to change anything. This page is the version with sources: every reading above names where it came from and when it was taken, and nothing on it is a forecast.</p>
      <h2 id="faq">Questions</h2>
${renderFaq(escapeHtml)}
      <p class="source">Published readings: ${escapeHtml(snapshotPath)}. Live readings replace them at request time from the World Monitor public API; a section whose source is unavailable keeps its published reading. Chokepoint scoring: <a href="/docs/methodology/chokepoints">methodology</a>. Crisis scope: <a href="https://github.com/koala73/worldmonitor/blob/main/shared/crawlable-crises.json">crisis registry</a>.</p>`;
  return pageDocument({
    baseUrl,
    path: SITUATION_PAGE_PATH,
    title: TITLE,
    description: DESCRIPTION,
    lastmod,
    ogType: 'website',
    extraStyles: EXTRA_STYLES,
    jsonLd: [
      {
        '@context': 'https://schema.org',
        '@type': 'WebPage',
        '@id': `${url}#webpage`,
        name: H1,
        description: DESCRIPTION,
        url,
        inLanguage: 'en-US',
        dateModified: lastmod,
      },
      faqPageLd(FAQ),
    ],
    breadcrumbs: breadcrumbLd(baseUrl, [
      { name: 'Home', path: '/' },
      { name: H1, path: SITUATION_PAGE_PATH },
    ]),
    body,
  });
}

export function writeSituationPage({ outDir, ...options }) {
  const dir = join(outDir, ...SITUATION_PAGE_PATH.split('/').filter(Boolean));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.html'), renderSituationPage(options));
}
