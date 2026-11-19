// /tools/<slug>/ live data pages, built with the reading frozen in the weekly
// pulse. The routing middleware replaces the marked section with the current
// reading at request time (middleware.ts), so crawlers quote today's value.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { LIVE_TOPIC_PAGES } from './live-pages/index.mjs';
import { LIVE_PAGE_RELATED, renderLiveDataLinks } from './live-pages/related-links.mjs';
import { renderWorldMapSvg, WORLD_MAP_INPUT_PATHS } from './live-pages-world-map.mjs';

export const LIVE_TOPIC_PAGES_CONTENT_VERSION = '2026-11-07';
export const LIVE_TOPIC_PAGES_INPUT_PATHS = Object.freeze([
  'scripts/build-live-topic-pages.mjs',
  'scripts/live-pages',
  ...WORLD_MAP_INPUT_PATHS,
]);

export function renderLiveTopicPage({ page, record, baseUrl, lastmod, tpl }) {
  const { escapeHtml, absoluteUrl, breadcrumbLd, pageDocument } = tpl;
  const url = absoluteUrl(baseUrl, page.path);
  const section = page.renderSection(record, { live: false });
  // A figure is built once and sits outside the live section, so the routing
  // middleware never re-renders it (a map's geometry stays out of the Edge
  // bundle); the section restyles it.
  const figure = page.renderFigure ? `${page.renderFigure({ worldMapSvg: renderWorldMapSvg })}\n` : '';
  const body = `      <p class="eyebrow">Live data</p>
      <h1>${escapeHtml(page.h1)}</h1>
      <p class="lede">${escapeHtml(page.description)}</p>
${figure}${section}
${page.explainer}
${renderLiveDataLinks(LIVE_PAGE_RELATED[page.slug] ?? [], escapeHtml, 'Related live data')}
      <h2>See it on the dashboard</h2>
      <p>The same data appears in the ${escapeHtml(page.dashboardPanel)} view of the <a href="/dashboard">World Monitor dashboard</a>, next to the map, alerts and related panels. Other live checks are listed on the <a href="/tools/">live tools page</a>.</p>`;
  return pageDocument({
    baseUrl,
    path: page.path,
    title: page.title,
    description: page.description,
    lastmod,
    ogType: 'website',
    // The FAQ markup is inside the live section, so it changes with the reading.
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'WebPage',
      '@id': `${url}#webpage`,
      name: page.h1,
      description: page.description,
      url,
      inLanguage: 'en-US',
      dateModified: lastmod,
    },
    breadcrumbs: breadcrumbLd(baseUrl, [
      { name: 'Home', path: '/' },
      { name: 'Live tools', path: '/tools/' },
      { name: page.h1, path: page.path },
    ]),
    body,
    inlineScript: page.script ?? '',
  });
}

export function writeLiveTopicPages({ outDir, baseUrl, lastmod, liveTopics = {}, tpl }) {
  for (const page of LIVE_TOPIC_PAGES) {
    const dir = join(outDir, ...page.path.split('/').filter(Boolean));
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'index.html'),
      renderLiveTopicPage({ page, record: liveTopics[page.slug] ?? null, baseUrl, lastmod, tpl }),
    );
  }
}
