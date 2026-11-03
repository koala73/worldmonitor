// Where the /tools/<slug>/ live data pages are linked from inside the
// crawlable corpus. A page links to a live page only when it is about the same
// thing, and each anchor names what the reader gets there.
//
// Pure module: no Node or DOM APIs.

/** A lastmod input of every page family that renders these links. */
export const LIVE_PAGE_LINKS_PATH = 'scripts/live-pages/related-links.mjs';

const LIVE = Object.freeze({
  situation: { href: '/monitor-the-situation/', label: 'Monitor the situation: headlines, crisis trackers, chokepoints and outages on one board' },
  debt: { href: '/tools/national-debt-clock/', label: 'National debt clock: live US and world government debt' },
  outages: { href: '/tools/internet-outages/', label: 'Internet outages right now, by country' },
  markets: { href: '/tools/prediction-markets/', label: 'Prediction market odds on world events today' },
  yieldCurve: { href: '/tools/treasury-yield-curve/', label: 'US Treasury yield curve today' },
  oil: { href: '/tools/crude-oil-inventories/', label: 'US crude oil inventories this week' },
  fearGreed: { href: '/tools/fear-and-greed-index/', label: 'Fear & Greed Index today' },
});

/** Every country profile: both pages cover all countries. The US adds its own markets data. */
export function countryLiveLinks(countryCode) {
  const links = [LIVE.debt, LIVE.outages];
  if (countryCode === 'US') links.push(LIVE.yieldCurve, LIVE.oil, LIVE.fearGreed);
  return links;
}

/** A chokepoint with an EIA oil-transit baseline moves crude, so US stocks are context. */
export function chokepointLiveLinks({ carriesOil }) {
  return carriesOil ? [LIVE.oil] : [];
}

/** Crisis trackers: markets price their outcomes, and conflicts cut connectivity. */
export function crisisLiveLinks({ touchesOilChokepoint }) {
  const links = [LIVE.markets, LIVE.outages];
  if (touchesOilChokepoint) links.push(LIVE.oil);
  return links;
}

/** Live page to live page, and back to the corpus pages that cite it. */
export const LIVE_PAGE_RELATED = Object.freeze({
  'fear-and-greed-index': [LIVE.yieldCurve, LIVE.markets],
  'internet-outages': [LIVE.markets, LIVE.situation, { href: '/crises/', label: 'Crisis trackers' }],
  'prediction-markets': [LIVE.fearGreed, LIVE.outages, LIVE.situation, { href: '/crises/', label: 'Crisis trackers' }],
  'national-debt-clock': [LIVE.yieldCurve, LIVE.fearGreed, { href: '/countries/united-states/', label: 'United States country profile' }],
  'treasury-yield-curve': [LIVE.debt, LIVE.fearGreed, LIVE.oil],
  'crude-oil-inventories': [
    { href: '/chokepoints/strait-of-hormuz/', label: 'Strait of Hormuz tracker' },
    { href: '/chokepoints/bab-el-mandeb/', label: 'Bab el-Mandeb tracker' },
    { href: '/chokepoints/suez-canal/', label: 'Suez Canal tracker' },
    { href: '/chokepoints/strait-of-malacca/', label: 'Strait of Malacca tracker' },
    LIVE.yieldCurve,
  ],
});

/** A navigation block: page word budgets count it separately from prose. */
export function renderLiveDataLinks(links, escapeHtml, heading = 'Live data') {
  if (!links.length) return '';
  return `      <section data-live-data-links>
      <h2>${escapeHtml(heading)}</h2>
      <ul class="related">
${links.map((link) => `        <li><a href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a></li>`).join('\n')}
      </ul>
      </section>`;
}
