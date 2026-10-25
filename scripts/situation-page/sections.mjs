// The live sections of /monitor-the-situation/. The corpus build renders each
// one from the frozen weekly pulse; the routing middleware fetches each
// section's public reading at request time and swaps that section alone, so a
// failed or stale source leaves the others current and never invents a value.
//
// Pure module: no Node or DOM APIs, so middleware.ts can bundle it.

import { dedupeByArticleUrl } from '../../shared/article-identity.js';
import { isVerifiableArticleUrl } from '../../shared/article-url.js';
import { chokepointStatusViewModel } from '../crawlable-live-tools.mjs';
import {
  escapeHtml,
  formatStaticDateTime,
  liveSectionMarkers,
  metric,
  renderLiveSection,
  requireFreshTimestamp,
  UnpublishableReading,
} from '../live-pages/common.mjs';
import { internetOutagesAnswer, internetOutagesBody, internetOutagesPage } from '../live-pages/internet-outages.mjs';
import { slugify } from '../slugify.mjs';

export const SITUATION_PAGE_PATH = '/monitor-the-situation/';

/**
 * @typedef {{ slug: string, title: string, statusPath: string,
 *   record(payload: unknown, now?: number): object,
 *   published(livePulse: object, context?: object): object | null,
 *   renderSection(reading: object | null, options: { live: boolean }): string }} SituationSection
 * `record` turns a public RPC payload into the reading, or throws
 * UnpublishableReading when the payload is stale or empty. `published` reads
 * the same shape out of the frozen pulse, or null when the pulse holds none.
 */

/** The marker slug of a section, `<!--wm-live:situation-<slug>-->`. */
export function situationMarker(section) {
  return `situation-${section.slug}`;
}

export function situationMarkers(section) {
  return liveSectionMarkers(situationMarker(section));
}

/** The reading for a section, or null when the payload cannot be published as current. */
export function situationReading(section, payload, now = Date.now()) {
  try {
    return section.record(payload, now);
  } catch (error) {
    if (error instanceof UnpublishableReading) return null;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Headlines

const LISTED_HEADLINES = 8;
// The digest replays accepted content for at most six hours after a failed
// rebuild (stale_age_seconds in list_feed_digest.proto); past that the service
// itself reports unavailable, so an older generated_at is never current.
const HEADLINES_MAX_AGE_MS = 6 * 3_600_000;

function headlineRow(item) {
  const title = String(item?.title || '').trim();
  const source = String(item?.source || '').trim();
  const url = String(item?.link || '').trim();
  const publishedAt = Number(item?.publishedAt);
  if (!title || !source || !isVerifiableArticleUrl(url)) return null;
  if (publishedAt <= 0 || Number.isNaN(new Date(publishedAt).getTime())) return null;
  return {
    row: { title, source, url, publishedAt: new Date(publishedAt).toISOString() },
    importance: Number(item?.importanceScore) || 0,
    publishedAtMs: publishedAt,
  };
}

/** The same publishability bar as the weekly freeze: masthead, https publisher URL, publication time. */
export function headlinesRecord(payload, now = Date.now()) {
  const categories = payload && typeof payload === 'object' ? payload.categories : null;
  if (!categories || typeof categories !== 'object') throw new UnpublishableReading('headlines: no digest categories');
  if (payload.coverage?.state === 'unavailable') throw new UnpublishableReading('headlines: digest unavailable');
  const asOf = requireFreshTimestamp(payload.generatedAt, { now, maxAgeMs: HEADLINES_MAX_AGE_MS, label: 'headlines' });
  const ranked = Object.values(categories)
    .flatMap((bucket) => (Array.isArray(bucket?.items) ? bucket.items : []))
    .map(headlineRow)
    .filter((entry) => entry !== null)
    .sort((a, b) => b.importance - a.importance || b.publishedAtMs - a.publishedAtMs || a.row.title.localeCompare(b.row.title));
  const rows = dedupeByArticleUrl(ranked, (entry) => entry.row.url).slice(0, LISTED_HEADLINES).map((entry) => entry.row);
  if (rows.length === 0) throw new UnpublishableReading('headlines: no publishable items');
  return { asOf, rows };
}

function headlinesPublished(livePulse) {
  const rows = Array.isArray(livePulse?.headlines) ? livePulse.headlines : [];
  const capturedAtMs = Number(livePulse?.capturedAtMs);
  if (rows.length === 0 || !Number.isFinite(capturedAtMs) || capturedAtMs <= 0) return null;
  return { asOf: new Date(capturedAtMs).toISOString(), rows: rows.slice(0, LISTED_HEADLINES) };
}

function headlinesAnswer(reading) {
  if (!reading) return 'World Monitor has no current headline reading.';
  const latest = reading.rows[0];
  const count = reading.rows.length === 1 ? '1 headline' : `${reading.rows.length} headlines`;
  return `As of ${formatStaticDateTime(reading.asOf)}, World Monitor's news digest ranks ${count} from curated publisher feeds. The top story is "${latest.title}" (${latest.source}, ${formatStaticDateTime(latest.publishedAt)}).`;
}

function headlinesBody(reading) {
  if (!reading) return '        <p class="tool-note">Open the live dashboard for the news feed.</p>';
  const items = reading.rows
    .map((row) => `          <li><a href="${escapeHtml(row.url)}">${escapeHtml(row.title)}</a> <small>${escapeHtml(row.source)} · <time datetime="${escapeHtml(row.publishedAt)}">${escapeHtml(formatStaticDateTime(row.publishedAt))}</time></small></li>`)
    .join('\n');
  return `        <ol class="headlines">\n${items}\n        </ol>`;
}

export const headlinesSection = Object.freeze({
  slug: 'headlines',
  title: 'Headlines now',
  statusPath: '/api/news/v1/list-feed-digest?variant=full&lang=en&public=1',
  record: headlinesRecord,
  published: headlinesPublished,
  renderSection(reading, { live }) {
    return renderLiveSection({
      slug: situationMarker(this),
      question: this.title,
      record: reading,
      live,
      answer: headlinesAnswer(reading),
      bodyHtml: headlinesBody(reading),
      asOf: reading?.asOf,
      sourceHtml: 'Source: World Monitor news digest, ranked from curated publisher feeds. Each headline links to its publisher.',
      faq: false,
    });
  },
});

// ---------------------------------------------------------------------------
// Chokepoints

function chokepointTargets(chokepointRegistry) {
  return Object.freeze(chokepointRegistry.map((entry) => ({
    id: entry.id,
    displayName: entry.displayName,
    slug: slugify(entry.displayName),
  })));
}

function chokepointRow(target, { score, status, congestion, asOf }) {
  return { ...target, score, status, congestion, asOf };
}

function chokepointsReading(rows) {
  const asOf = rows.map((row) => row.asOf).sort().at(-1);
  const sorted = [...rows].sort((a, b) => b.score - a.score || a.displayName.localeCompare(b.displayName));
  return { asOf, rows: sorted, red: sorted.filter((row) => row.status === 'Red').length };
}

/**
 * Every registry chokepoint from one status payload. The view model throws for
 * anything it cannot vouch for (missing row, stale capture, out-of-range
 * score); a board that cannot show every waterway shows the published one.
 */
export function chokepointsRecord(payload, now, targets) {
  const rows = targets.map((target) => {
    let view;
    try {
      view = chokepointStatusViewModel(payload, target.id, now);
    } catch (error) {
      throw new UnpublishableReading(`chokepoints: ${error instanceof Error ? error.message : String(error)}`);
    }
    return chokepointRow(target, {
      score: Number(view.disruptionScore),
      status: view.status,
      congestion: view.congestion ?? 'Not reported',
      asOf: new Date(view.fetchedAt).toISOString(),
    });
  });
  return chokepointsReading(rows);
}

/** From the hub rows the corpus build has already validated against the pulse. */
function chokepointsPublished(_livePulse, { hubRows } = {}) {
  if (!Array.isArray(hubRows) || hubRows.length === 0) return null;
  return chokepointsReading(hubRows.map((row) => chokepointRow(
    { id: row.chokepoint.id, displayName: row.chokepoint.displayName, slug: row.chokepoint.slug },
    { score: row.score, status: row.status, congestion: row.congestion, asOf: row.asOf },
  )));
}

function chokepointsAnswer(reading) {
  if (!reading) return 'World Monitor has no current chokepoint reading.';
  const top = reading.rows[0];
  const redClause = reading.red === 0
    ? 'none is in the red band'
    : `${reading.red} ${reading.red === 1 ? 'is' : 'are'} in the red band`;
  return `As of ${formatStaticDateTime(reading.asOf)}, World Monitor scores ${reading.rows.length} shipping chokepoints; ${redClause}. The highest disruption score is ${top.displayName} at ${top.score} of 100 (${top.status}).`;
}

function chokepointsBody(reading) {
  if (!reading) return '        <p class="tool-note">Open the chokepoint hub for the published status table.</p>';
  const rows = reading.rows
    .map((row) => `            <tr><td><a href="/chokepoints/${escapeHtml(row.slug)}/">${escapeHtml(row.displayName)}</a></td><td>${escapeHtml(String(row.score))}</td><td>${escapeHtml(row.status)}</td><td>${escapeHtml(row.congestion)}</td><td><time datetime="${escapeHtml(row.asOf)}">${escapeHtml(formatStaticDateTime(row.asOf))}</time></td></tr>`)
    .join('\n');
  return `        <div class="grid">
${metric('Waterways scored', String(reading.rows.length))}
${metric('In the red band', String(reading.red))}
${metric('Highest score', `${reading.rows[0].score}`, reading.rows[0].displayName)}
        </div>
        <div class="table-scroll">
          <table>
            <caption>Disruption score by chokepoint, highest first. The band is a pressure signal, not a declaration that a waterway is open or closed.</caption>
            <thead><tr><th scope="col">Chokepoint</th><th scope="col">Score</th><th scope="col">Band</th><th scope="col">AIS congestion</th><th scope="col">Source time</th></tr></thead>
            <tbody>
${rows}
            </tbody>
          </table>
        </div>`;
}

/**
 * The registry comes in from the caller because this module is bundled into
 * the Edge middleware, which cannot follow a `.ts` import from JavaScript.
 * middleware.ts imports it as TypeScript; the Node corpus build loads the
 * `.ts` file through tsx.
 */
function chokepointsSection(chokepointRegistry) {
  const targets = chokepointTargets(chokepointRegistry);
  return Object.freeze({
    slug: 'chokepoints',
    title: 'Shipping chokepoints now',
    statusPath: '/api/supply-chain/v1/get-chokepoint-status?public=1',
    record: (payload, now = Date.now()) => chokepointsRecord(payload, now, targets),
    published: chokepointsPublished,
    renderSection(reading, { live }) {
      return renderLiveSection({
        slug: situationMarker(this),
        question: this.title,
        record: reading,
        live,
        answer: chokepointsAnswer(reading),
        bodyHtml: chokepointsBody(reading),
        asOf: reading?.asOf,
        sourceHtml: 'Source: World Monitor chokepoint status (navigational warnings, AIS disruptions and congestion, IMF PortWatch transits). Scoring: <a href="/docs/methodology/chokepoints">chokepoint methodology</a>. Hub: <a href="/chokepoints/">all chokepoints</a>.',
        faq: false,
      });
    },
  });
}

// ---------------------------------------------------------------------------
// Internet outages

const LISTED_OUTAGE_ROWS = 5;

export const outagesSection = Object.freeze({
  slug: 'outages',
  title: 'Internet outages now',
  statusPath: internetOutagesPage.statusPath,
  record: internetOutagesPage.record,
  published(livePulse) {
    return livePulse?.liveTopics?.[internetOutagesPage.slug] ?? null;
  },
  renderSection(reading, { live }) {
    return renderLiveSection({
      slug: situationMarker(this),
      question: this.title,
      record: reading,
      live,
      answer: internetOutagesAnswer(reading),
      bodyHtml: internetOutagesBody(reading, { rows: LISTED_OUTAGE_ROWS }),
      asOf: reading?.asOf,
      sourceHtml: 'Source: Cloudflare Radar outage center (<a href="https://radar.cloudflare.com/outage-center" rel="nofollow">radar.cloudflare.com</a>). Full list: <a href="/tools/internet-outages/">internet outages tracker</a>.',
      faq: false,
    });
  },
});

/** The page's live sections in page order. */
export function situationSections(chokepointRegistry) {
  return Object.freeze([headlinesSection, chokepointsSection(chokepointRegistry), outagesSection]);
}
