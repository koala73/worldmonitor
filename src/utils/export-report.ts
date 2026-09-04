/**
 * PDF data report (plan 2026-07-25-001, KTD7) + the LLM-annotation stripper
 * shared with the JSON/CSV exporters.
 *
 * v1 is a DATA report, not a dashboard screenshot: WebGL canvases serialize
 * blank through `outerHTML` and lazily-mounted panels serialize as
 * placeholders, so a visual clone is deferred. The document is printed through
 * the hidden-iframe pattern cloned from `CountryBriefPage.exportPdf`
 * (src/components/CountryBriefPage.ts:753-791) with two obligations the source
 * pattern does not carry:
 *
 *   1. It renders RAW feed strings (titles, source names) rather than
 *      already-rendered DOM, so every interpolated value goes through
 *      `escapeReportHtml` and every href through `safeReportUrl`.
 *   2. It fails LOUDLY — `printReportDocument` rejects on a null iframe
 *      document or a `print()` throw so the caller can surface a toast. The
 *      source pattern returns silently.
 *
 * Zero runtime imports (type-only imports are erased) so the builder is
 * unit-testable under `tsx --test` without a DOM.
 */

import type { ClusteredEvent, NewsItem } from '@/types';
import type { ExportData } from './export';

// Row caps keep a print job from ballooning to hundreds of pages. JSON export
// remains the full-fidelity path; the report says so in its footer.
const MAX_NEWS_ROWS = 150;
const MAX_CLUSTER_ROWS = 60;
const MAX_GENERIC_ROWS = 60;

// ---------------------------------------------------------------------------
// Sanitization (shared with exportToJSON / exportToCSV)
// ---------------------------------------------------------------------------

/** Strip LLM-derived threat annotations so AI does not feed back into itself. */
function sanitizeNewsItem(item: NewsItem): NewsItem {
  if (item.threat?.source !== 'llm') return item;
  const { threat: _t, ...rest } = item;
  return rest as NewsItem;
}

function sanitizeCluster(cluster: ClusteredEvent): ClusteredEvent {
  return {
    ...cluster,
    threat: cluster.threat?.source === 'llm' ? undefined : cluster.threat,
    allItems: cluster.allItems.map(sanitizeNewsItem),
  };
}

/**
 * Keyword and ML (local model) classifications are retained; only `llm`-sourced
 * ones are dropped. Returns a new object — never mutates live dashboard state.
 */
export function sanitizeExportData(data: ExportData): ExportData {
  return {
    ...data,
    news: data.news?.map(sanitizeNewsItem),
    newsClusters: data.newsClusters?.map(sanitizeCluster),
    newsByCategory: data.newsByCategory
      ? Object.fromEntries(
          Object.entries(data.newsByCategory).map(([k, items]) => [k, items.map(sanitizeNewsItem)]),
        )
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// Escaping helpers
// ---------------------------------------------------------------------------

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escape any value for HTML text or attribute context. */
export function escapeReportHtml(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

/** Only http(s) URLs survive — anything else (javascript:, data:) is dropped. */
function safeReportUrl(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '';
  if (!/^https?:\/\//i.test(raw)) return '';
  return escapeReportHtml(raw);
}

function isoOrEmpty(value: unknown): string {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value as string | number);
  const time = date.getTime();
  return Number.isFinite(time) ? date.toISOString() : '';
}

function textOrDash(value: unknown): string {
  const clean = escapeReportHtml(value);
  return clean || '—';
}

/** A title cell that links out when the source URL is safe, plain text otherwise. */
function linkCell(title: unknown, link: unknown): string {
  const label = textOrDash(title);
  const href = safeReportUrl(link);
  return href ? `<a href="${href}">${label}</a>` : label;
}

// ---------------------------------------------------------------------------
// Document assembly
// ---------------------------------------------------------------------------

function section(title: string, headers: string[], rows: string[][]): string {
  if (rows.length === 0) return '';
  const head = headers.map((h) => `<th scope="col">${escapeReportHtml(h)}</th>`).join('');
  const body = rows
    .map((cells) => `<tr>${cells.map((cell) => `<td>${cell}</td>`).join('')}</tr>`)
    .join('');
  return `<section class="wm-section"><h2>${escapeReportHtml(title)}</h2>`
    + `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></section>`;
}

function newsRows(items: NewsItem[]): string[][] {
  return items.slice(0, MAX_NEWS_ROWS).map((item) => [
    linkCell(item.title, item.link),
    textOrDash(item.source),
    textOrDash(isoOrEmpty(item.pubDate)),
    item.isAlert ? 'ALERT' : '—',
    textOrDash([item.threat?.level, item.threat?.category].filter(Boolean).join(' / ')),
  ]);
}

function clusterRows(clusters: ClusteredEvent[]): string[][] {
  return clusters.slice(0, MAX_CLUSTER_ROWS).map((cluster) => [
    linkCell(cluster.primaryTitle, cluster.primaryLink),
    textOrDash(cluster.primarySource),
    // #6428: the column is headed "Sources" — publishers, not articles.
    textOrDash(cluster.uniquePublisherCount),
    textOrDash(isoOrEmpty(cluster.lastUpdated)),
    textOrDash([cluster.threat?.level, cluster.threat?.category].filter(Boolean).join(' / ')),
  ]);
}

function intelligenceSections(intel: ExportData['intelligence']): string {
  if (!intel) return '';
  const parts: string[] = [];

  const protests = intel.protests?.events ?? [];
  parts.push(section('Protests', ['Title', 'Country', 'Type', 'Severity', 'Time'],
    protests.slice(0, MAX_GENERIC_ROWS).map((e) => [
      textOrDash(e.title), textOrDash(e.country), textOrDash(e.eventType),
      textOrDash(e.severity), textOrDash(isoOrEmpty(e.time)),
    ])));

  const earthquakes = intel.earthquakes ?? [];
  parts.push(section('Earthquakes', ['Place', 'Magnitude', 'Depth (km)', 'Occurred'],
    earthquakes.slice(0, MAX_GENERIC_ROWS).map((e) => [
      linkCell(e.place, e.sourceUrl), textOrDash(e.magnitude), textOrDash(e.depthKm),
      textOrDash(isoOrEmpty(e.occurredAt * 1000)),
    ])));

  const outages = intel.outages ?? [];
  parts.push(section('Internet outages', ['Title', 'Country', 'Severity', 'Published'],
    outages.slice(0, MAX_GENERIC_ROWS).map((o) => [
      linkCell(o.title, o.link), textOrDash(o.country), textOrDash(o.severity),
      textOrDash(isoOrEmpty(o.pubDate)),
    ])));

  const advisories = intel.advisories ?? [];
  parts.push(section('Security advisories', ['Title', 'Source', 'Level', 'Country', 'Published'],
    advisories.slice(0, MAX_GENERIC_ROWS).map((a) => [
      linkCell(a.title, a.link), textOrDash(a.source), textOrDash(a.level),
      textOrDash(a.country), textOrDash(isoOrEmpty(a.pubDate)),
    ])));

  const flights = intel.military?.flights ?? [];
  parts.push(section('Military flights', ['Callsign', 'Type', 'Operator', 'Country'],
    flights.slice(0, MAX_GENERIC_ROWS).map((f) => [
      textOrDash(f.callsign), textOrDash(f.aircraftType), textOrDash(f.operator),
      textOrDash(f.operatorCountry),
    ])));

  const vessels = intel.military?.vessels ?? [];
  parts.push(section('Military vessels', ['Name', 'MMSI', 'Type', 'Country'],
    vessels.slice(0, MAX_GENERIC_ROWS).map((v) => [
      textOrDash(v.name), textOrDash(v.mmsi), textOrDash(v.vesselType),
      textOrDash(v.operatorCountry),
    ])));

  return parts.join('');
}

const REPORT_STYLES = `
  :root { color-scheme: light; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
         margin: 0; padding: 24px; background: #fff; color: #111; font-size: 12px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  h2 { font-size: 14px; margin: 20px 0 6px; border-bottom: 1px solid #ccc; padding-bottom: 3px; }
  .wm-meta { color: #555; font-size: 11px; margin: 0 0 2px; }
  .wm-footer { margin-top: 24px; color: #666; font-size: 10px; }
  table { width: 100%; border-collapse: collapse; table-layout: fixed; }
  th, td { text-align: left; padding: 4px 6px; border-bottom: 1px solid #e3e3e3;
           vertical-align: top; word-break: break-word; }
  th { font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; color: #555; }
  a { color: #14507d; text-decoration: none; }
  .wm-empty { color: #666; font-style: italic; }
  @media print {
    body { padding: 12px; }
    .wm-section { break-inside: auto; }
    tr { break-inside: avoid; }
    h2 { break-after: avoid; }
  }
`;

export interface DataReportOptions {
  /** Overrides the generated-at stamp (defaults to meta.exportedAt / now). */
  generatedAt?: string;
}

/**
 * Render the export payload as a standalone printable HTML document.
 *
 * Sanitization runs HERE (not at the data-assembly closure in
 * event-handlers.ts) so the PDF path can never skip it — same contract as
 * `exportToJSON` / `exportToCSV`.
 */
export function buildDataReportDocument(data: ExportData, options: DataReportOptions = {}): string {
  // The report renders at most MAX_NEWS_ROWS / MAX_CLUSTER_ROWS of each list
  // and never reads newsByCategory, so sanitize only what it renders. The
  // JSON/CSV exporters keep the full-fidelity `sanitizeExportData` — they
  // serialize everything.
  const clean: ExportData = {
    ...data,
    news: data.news?.slice(0, MAX_NEWS_ROWS).map(sanitizeNewsItem),
    newsClusters: data.newsClusters?.slice(0, MAX_CLUSTER_ROWS).map(sanitizeCluster),
    newsByCategory: undefined,
  };
  const generatedAt = options.generatedAt
    ?? clean.meta?.exportedAt
    ?? isoOrEmpty(clean.timestamp)
    ?? '';

  const sections = [
    section('News clusters', ['Story', 'Lead source', 'Sources', 'Last updated', 'Threat'],
      clusterRows(clean.newsClusters ?? [])),
    section('Headlines', ['Title', 'Source', 'Published', 'Alert', 'Threat'],
      newsRows(clean.news ?? [])),
    section('Markets', ['Symbol', 'Name', 'Price', 'Change'],
      (clean.markets ?? []).slice(0, MAX_GENERIC_ROWS).map((m) => [
        textOrDash(m.symbol), textOrDash(m.name), textOrDash(m.price), textOrDash(m.change),
      ])),
    section('Prediction markets', ['Market', 'Yes price', 'Volume'],
      (clean.predictions ?? []).slice(0, MAX_GENERIC_ROWS).map((p) => [
        textOrDash(p.title), textOrDash(p.yesPrice), textOrDash(p.volume),
      ])),
    intelligenceSections(clean.intelligence),
    section('Cyber threats', ['Indicator', 'Type', 'Severity', 'Country', 'Source'],
      (clean.cyberThreats ?? []).slice(0, MAX_GENERIC_ROWS).map((c) => [
        textOrDash(c.indicator), textOrDash(c.indicatorType), textOrDash(c.severity),
        textOrDash(c.country), textOrDash(c.source),
      ])),
    section('Signal convergence', ['Domain', 'Title', 'Score', 'Trend', 'Countries'],
      (clean.convergenceCards ?? []).slice(0, MAX_GENERIC_ROWS).map((c) => [
        textOrDash(c.domain), textOrDash(c.title), textOrDash(c.score), textOrDash(c.trend),
        textOrDash((c.countries ?? []).join(', ')),
      ])),
    section('Monitors', ['Name', 'Keywords'],
      (clean.monitors ?? []).slice(0, MAX_GENERIC_ROWS).map((m) => [
        textOrDash(m.name), textOrDash((m.keywords ?? []).join(', ')),
      ])),
  ].filter(Boolean).join('');

  const gps = clean.gpsJamming
    ? `<p class="wm-meta">GPS jamming: ${escapeReportHtml(clean.gpsJamming.stats.totalHexes)} zones `
      + `(${escapeReportHtml(clean.gpsJamming.stats.highCount)} high, `
      + `${escapeReportHtml(clean.gpsJamming.stats.mediumCount)} medium) as of `
      + `${escapeReportHtml(clean.gpsJamming.fetchedAt)}.</p>`
    : '';

  const body = sections || '<p class="wm-empty">No dashboard data was available at export time.</p>';

  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">`
    + `<title>WorldMonitor Data Report</title><style>${REPORT_STYLES}</style></head><body>`
    + `<h1>WorldMonitor Data Report</h1>`
    + `<p class="wm-meta">Generated ${escapeReportHtml(generatedAt)}</p>`
    + (clean.meta?.note ? `<p class="wm-meta">${escapeReportHtml(clean.meta.note)}</p>` : '')
    + gps
    + body
    + `<p class="wm-footer">Row counts are capped for print. Use the JSON export for full fidelity. `
    + `LLM-derived threat annotations are excluded from every export.</p>`
    + `</body></html>`;
}

// ---------------------------------------------------------------------------
// Hidden-iframe printing
// ---------------------------------------------------------------------------

/** The slice of `document` the print routine touches — kept tiny so tests can double it. */
interface PrintHostDocument {
  createElement(tag: string): {
    style: { cssText: string };
    setAttribute?(name: string, value: string): void;
    contentDocument: { open(): void; write(html: string): void; close(): void } | null;
    contentWindow: {
      print(): void;
      onafterprint: (() => void) | null;
      /** Fallback when `contentDocument` is null (some webviews). */
      document?: { open(): void; write(html: string): void; close(): void };
    } | null;
  };
  body: { appendChild(node: unknown): void; removeChild(node: unknown): void };
}

export interface ReportPrintDeps {
  /** Defaults to the ambient `document`. */
  doc?: PrintHostDocument | null;
  /** Defaults to `setTimeout`; tests inject an inline runner so no timer leaks. */
  schedule?: (fn: () => void, ms: number) => void;
  /** Delay before `print()` so the iframe finishes laying the document out. */
  printDelayMs?: number;
  /** Failsafe iframe removal when `onafterprint` never fires. */
  cleanupDelayMs?: number;
}

/**
 * Write `html` into an offscreen iframe and print it.
 *
 * Resolves once `print()` has been invoked; REJECTS on every failure path so
 * the caller can surface a toast instead of leaving the user staring at a
 * button that did nothing.
 */
export function printReportDocument(html: string, deps: ReportPrintDeps = {}): Promise<void> {
  const host = deps.doc ?? (typeof document !== 'undefined' ? (document as unknown as PrintHostDocument) : null);
  if (!host) return Promise.reject(new Error('[export-report] no document available for printing'));

  const schedule = deps.schedule ?? ((fn: () => void, ms: number) => { setTimeout(fn, ms); });
  const printDelayMs = deps.printDelayMs ?? 300;
  const cleanupDelayMs = deps.cleanupDelayMs ?? 5000;

  const iframe = host.createElement('iframe');
  iframe.style.cssText = 'position:fixed;left:-9999px;width:0;height:0;border:none';
  iframe.setAttribute?.('aria-hidden', 'true');
  host.body.appendChild(iframe);

  let removed = false;
  const cleanup = (): void => {
    if (removed) return;
    removed = true;
    try {
      host.body.removeChild(iframe);
    } catch {
      // Already detached (navigation, double onafterprint) — nothing to do.
    }
  };

  const frameDoc = iframe.contentDocument ?? iframe.contentWindow?.document ?? null;
  const frameWin = iframe.contentWindow;
  if (!frameDoc || !frameWin) {
    cleanup();
    return Promise.reject(new Error('[export-report] print iframe exposed no document'));
  }

  return new Promise<void>((resolve, reject) => {
    try {
      frameDoc.open();
      frameDoc.write(html);
      frameDoc.close();
    } catch (err) {
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    frameWin.onafterprint = cleanup;
    schedule(() => {
      try {
        frameWin.print();
      } catch (err) {
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      schedule(cleanup, cleanupDelayMs);
      resolve();
    }, printDelayMs);
  });
}
