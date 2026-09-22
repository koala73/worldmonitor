import { t } from '@/services/i18n';
import { enqueueSentryCall } from '@/bootstrap/sentry-defer';
import { h } from '@/utils/dom-utils';
import { WEB_APP_ORIGIN } from '@/config/web-origin';
import { BRIEF_TOPICS, type BriefTopic, type BriefSectionState } from './country-brief-presentation';
import briefCss from '@/styles/country-deep-dive.css?inline';
import { CHOKEPOINT_REGISTRY } from '@/config/chokepoint-registry';
import { TRADE_ROUTES } from '@/config/trade-routes';
import { createOperationalExposureForm, renderOperationalWorksheet, type OperationalWorksheetSession } from './OperationalExposureForm';

const operationalSession: OperationalWorksheetSession = {};

export interface BriefOutputSection {
  id: string;
  title: string;
  topics: readonly BriefTopic[];
  state: BriefSectionState;
  content: HTMLElement;
}

export interface BriefOutputSnapshot {
  country: string;
  code: string;
  capturedAt: string;
  sections: BriefOutputSection[];
  story: { title: string; content: HTMLElement }[];
}

export function freezeBriefContent(source: HTMLElement): HTMLElement {
  const clone = source.cloneNode(true) as HTMLElement;
  const idMap = new Map<string, string>();
  for (const element of [clone, ...clone.querySelectorAll<HTMLElement>('*')]) {
    if (element.id) {
      const id = `export-${element.id}`;
      idMap.set(element.id, id);
      element.id = id;
    }
    element.removeAttribute('hidden');
    element.removeAttribute('tabindex');
    element.removeAttribute('aria-busy');
    if (element instanceof HTMLDetailsElement) element.open = true;
  }
  for (const element of clone.querySelectorAll<HTMLElement>('*')) {
    for (const attribute of ['aria-labelledby', 'aria-controls', 'for']) {
      const value = element.getAttribute(attribute);
      if (value) element.setAttribute(attribute, value.split(' ').map(id => idMap.get(id) ?? id).join(' '));
    }
    for (const attribute of ['fill', 'clip-path', 'mask', 'filter']) {
      const value = element.getAttribute(attribute);
      if (value?.startsWith('url(#')) {
        const id = value.slice(5, -1);
        if (idMap.has(id)) element.setAttribute(attribute, `url(#${idMap.get(id)})`);
      }
    }
    if (element.getAttribute('role') === 'tablist') element.removeAttribute('role');
  }
  for (const link of clone.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    const href = link.getAttribute('href')!;
    if (href.startsWith('#')) link.setAttribute('href', `#${idMap.get(href.slice(1)) ?? href.slice(1)}`);
    else link.href = new URL(href, WEB_APP_ORIGIN).href;
  }
  for (const details of clone.querySelectorAll<HTMLElement>('script, iframe, object, embed, .cdp-summary-only, .cdp-card-help, .resilience-widget__help, .resilience-widget__retry, .cdp-inline-action')) details.remove();
  const controls = source.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select');
  clone.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select').forEach((control, index) => {
    const original = controls[index];
    const value = original instanceof HTMLSelectElement ? original.selectedOptions[0]?.textContent ?? original.value : original?.value;
    control.replaceWith(h('span', { className: 'cdp-export-control-value' }, value ?? ''));
  });
  for (const button of clone.querySelectorAll<HTMLButtonElement>('button')) {
    const label = h('div', { className: button.className, ...(button.id ? { id: button.id } : {}) });
    label.append(...Array.from(button.childNodes));
    button.replaceWith(label);
  }
  clone.hidden = false;
  return clone;
}

const reportTheme = `
  :root{color-scheme:light;--bg:#fff;--panel-bg:#fff;--surface:#f4f6f5;--surface-hover:#e8eeea;--border:#ccd6d0;--border-subtle:#e0e6e2;--text:#17251c;--text-secondary:#344a3c;--text-dim:#344a3c;--text-muted:#55645b;--text-faint:#66746c;--green:#16a34a;--accent:#17251c;--semantic-normal:#15803d;--semantic-elevated:#946200;--semantic-high:#b45309;--semantic-critical:#b91c1c}
  *{box-sizing:border-box}body{margin:0;padding:30px;font-family:Arial,sans-serif}.cdp-output-paper{max-width:1100px;margin:auto;overflow-wrap:anywhere}.cdp-output-paper .cdp-expanded-only{display:block}.cdp-output-paper .cdp-summary-only{display:none}.cdp-output-paper [hidden]{display:none}.cdp-output-paper .cdp-card{break-inside:avoid}.cdp-output-paper .cdp-card-body,.cdp-output-paper .cdp-table-scroll,.cdp-output-paper .cdp-maritime-scroll{overflow:visible;max-height:none}.cdp-output-paper table{width:100%;border-collapse:collapse}.cdp-output-paper td,.cdp-output-paper th{padding:10px 8px;border-bottom:1px solid var(--border);text-align:left}.cdp-output-paper .cdp-output-story-slide{break-after:page;padding:32px 0;min-height:500px}.cdp-output-paper .cdp-scorecard-factor-evidence{display:block}.cdp-output-paper .cdp-scorecard-evidence{display:block}.cdp-output-paper .cdp-pro-locked{color:var(--text-muted)}.cdp-output-manifest{font-size:12px;color:var(--text-muted);padding:16px 0;border-bottom:1px solid var(--border);line-height:1.6}h1{font-size:32px}h2{font-size:24px}a{color:var(--green)}@media print{body{padding:0}a{color:inherit}.cdp-output-paper .cdp-card{break-inside:auto}.cdp-card-title{break-after:avoid}}
`;

// `lang` overrides the viewer's locale for documents whose body is not localized.
// The decision brief renders its headings and narrative in English regardless of
// the shell locale, so inheriting lang="fr" would make the file misdescribe itself
// to screen readers and translation tooling.
function downloadHtml(name: string, article: HTMLElement, title: string, lang?: string): void {
  const doc = document.implementation.createHTMLDocument(title);
  doc.documentElement.lang = lang || document.documentElement.lang || 'en';
  doc.head.prepend(h('meta', { charset: 'utf-8' }));
  doc.head.append(h('meta', { name: 'viewport', content: 'width=device-width,initial-scale=1' }),
    h('meta', { 'http-equiv': 'Content-Security-Policy', content: "default-src 'none'; style-src 'unsafe-inline'; img-src data: https:; base-uri 'none'; form-action 'none'" }),
    h('style', {}, briefCss, reportTheme));
  doc.body.append(article.cloneNode(true));
  const url = URL.createObjectURL(new Blob(['<!doctype html>', doc.documentElement.outerHTML], { type: 'text/html;charset=utf-8' }));
  const link = h('a', { href: url, download: name });
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function createCountryBriefOutput(snapshot: BriefOutputSnapshot, kind: 'story' | 'report', onClose: () => void): HTMLElement {
  const output = h('section', { className: 'cdp-output', 'aria-label': kind === 'story' ? 'Create a country story' : 'Export country report' });
  const close = h('button', { type: 'button', className: 'cdp-action-btn' }, '← Back to brief');
  close.addEventListener('click', onClose);
  const controls = h('div', { className: 'cdp-output-controls' });
  const paper = h('article', { className: 'cdp-output-paper' });
  const status = h('div', { role: 'status', 'aria-live': 'polite', className: 'cdp-output-feedback' });
  let selectedTopic: BriefTopic = 'all';
  let slide = 0;
  const selected = () => snapshot.sections.filter(section => selectedTopic === 'all' || section.topics.includes(selectedTopic));
  const heading = () => h('header', {}, h('p', { className: 'cdp-country-subtitle' }, 'WORLD MONITOR · COUNTRY BRIEF'),
    h('h1', {}, snapshot.country), h('p', { className: 'cdp-measure-note' }, `Captured ${new Date(snapshot.capturedAt).toLocaleString()} · ${snapshot.code}`));
  const renderReport = (): void => {
    const sections = selected();
    const incomplete = sections.filter(section => section.state !== 'ready');
    paper.replaceChildren(heading(), h('div', { className: 'cdp-output-manifest' },
      `${BRIEF_TOPICS[selectedTopic]} · ${sections.length} sections. This snapshot keeps each source date and the currently selected scenario/product. `,
      incomplete.length ? `${incomplete.length} sections incomplete: ${incomplete.map(section => `${section.title} (${section.state})`).join(', ')}.` : 'All selected sections are available.'),
    ...sections.map(section => section.content.cloneNode(true)));
  };
  const renderStory = (): void => {
    const item = snapshot.story[slide]!;
    paper.replaceChildren(heading(), h('div', { className: 'cdp-output-story-slide' },
      h('p', { className: 'cdp-country-subtitle' }, `${slide + 1} / ${snapshot.story.length}`),
      h('h2', {}, item.title), item.content.cloneNode(true)),
    h('p', { className: 'cdp-output-manifest' }, 'A snapshot of this country brief. Source dates and evidence coverage vary. See the full report for supporting details.'));
  };
  if (kind === 'report') {
    const scope = h('select', { 'aria-label': 'Report scope' }) as HTMLSelectElement;
    for (const [topic, label] of Object.entries(BRIEF_TOPICS)) scope.append(h('option', { value: topic, selected: topic === 'all' }, topic === 'overview' ? 'Overview & scores' : label));
    scope.addEventListener('change', () => { selectedTopic = scope.value as BriefTopic; renderReport(); });
    controls.append(h('label', {}, 'Report scope', scope));
    renderReport();
  } else {
    const previous = h('button', { type: 'button', 'aria-label': 'Previous story slide' }, '←');
    const next = h('button', { type: 'button', 'aria-label': 'Next story slide' }, '→');
    const counter = h('span', {}, `1 / ${snapshot.story.length}`);
    const change = (step: number): void => {
      slide = (slide + step + snapshot.story.length) % snapshot.story.length;
      counter.textContent = `${slide + 1} / ${snapshot.story.length}`;
      renderStory();
    };
    previous.addEventListener('click', () => change(-1));
    next.addEventListener('click', () => change(1));
    controls.append(h('p', {}, 'One country snapshot. Review every slide before downloading.'), previous, counter, next);
    renderStory();
  }
  const download = h('button', { type: 'button', className: 'cdp-action-btn cdp-export-primary' }, kind === 'story' ? 'Download story HTML' : 'Download report HTML');
  download.addEventListener('click', () => {
    const article = kind === 'report' ? paper : h('article', { className: 'cdp-output-paper' }, heading(),
      ...snapshot.story.map(item => h('section', { className: 'cdp-output-story-slide' }, h('h2', {}, item.title), item.content.cloneNode(true))));
    downloadHtml(`${snapshot.code.toLowerCase()}-${kind}-${snapshot.capturedAt.slice(0, 10)}.html`, article, `${snapshot.country} · ${kind}`);
    status.textContent = `Downloaded ${kind}. Open the HTML file to print or save as PDF.`;
  });
  controls.append(download, status);
  output.append(h('header', { className: 'cdp-output-header' }, close, h('h2', {}, kind === 'story' ? 'Create a story' : 'Export report')),
    h('div', { className: 'cdp-output-layout' }, controls, paper));
  return output;
}

export function renderDecisionBrief(snapshot: import('@/types/decision-brief').DecisionBriefSnapshot): HTMLElement {
  const fmt = (value: number | null, unit = '') => {
    if (value === null) return 'Unknown';
    const number = value !== 0 && Math.abs(value) < 0.1
      ? value > 0 ? '<0.1' : '>-0.1'
      : value.toLocaleString('en-US', { maximumFractionDigits: 1, minimumFractionDigits: 1 });
    return `${number} ${unit}`.trim();
  };
  const list = (items: string[]) => h('ul', {}, ...items.map(item => h('li', {}, item)));
  const article = h('article', { className: 'cdp-output-paper cdp-decision-paper' },
    h('h1', {}, `${snapshot.selection.countryName} · Decision brief`),
    h('p', {}, `${snapshot.selection.countryCode} · ${snapshot.selection.chokepointId} · ${snapshot.selection.fuelMode} · Captured ${snapshot.capturedAt}`),
    h('h2', {}, 'Conditional impact'), h('p', {}, snapshot.impact),
    h('h2', {}, 'Selected scenarios'),
    ...snapshot.results.map(result => h('p', { 'data-reference': result.reference }, `${result.reference}: ${result.severity}% disruption · ${fmt(result.loss, result.unit)} modeled loss${result.demandPct === null ? '' : ` · ${fmt(result.demandPct, '%')} of recorded demand`} · observed ${result.observedAt ?? 'unknown'}`)),
    h('p', { className: 'cdp-decision-comparison' }, `${snapshot.comparison.delta === null ? '' : `Difference: ${fmt(snapshot.comparison.delta, snapshot.results[0]!.unit)}. `}${snapshot.comparison.reason}`),
    h('h2', {}, 'Next action'), h('p', { className: 'cdp-decision-action' }, snapshot.action.text),
    h('p', {}, `References: ${snapshot.action.references.join(', ')}`),
    h('h3', {}, 'Constraint'), h('p', {}, snapshot.action.constraint),
    h('h3', {}, 'Reassessment trigger'), h('p', {}, snapshot.action.trigger),
    h('h2', {}, 'Evidence'),
    ...snapshot.evidence.map(e => h('p', { id: `decision-${e.id}` }, `[${e.id}] ${e.label}: ${fmt(e.value, e.unit)} · `, h('a', { href: e.sourceUrl, target: '_blank', rel: 'noopener noreferrer' }, e.source), ` · observed ${e.observedAt ?? 'unknown'}`)),
    ...snapshot.captures.map((capture, index) => h('p', {}, `${index === 0 ? 'Baseline' : 'Comparison'} retrieved ${capture.retrievedAt}`)),
    h('h2', {}, 'Assumptions'), list(snapshot.assumptions), h('h2', {}, 'Unknowns'), list(snapshot.unknowns));
  if (snapshot.operationalWorksheet) article.append(renderOperationalWorksheet(snapshot.operationalWorksheet));
  else if (snapshot.operationalWorksheet === null) article.append(h('p', {}, 'Operational worksheet incomplete or invalid. No operational balance is included.'));
  const data = h('script', { type: 'application/json', id: 'decision-brief-snapshot' });
  data.textContent = JSON.stringify(snapshot).replace(/</g, '\\u003c');
  article.append(data);
  return article;
}

export function createDecisionBriefOutput(
  country: { code: string; name: string },
  signal: AbortSignal,
  load: (selection: import('@/types/decision-brief').DecisionBriefSelection, signal: AbortSignal) => Promise<import('@/types/decision-brief').DecisionBriefSnapshot>,
  onClose: () => void,
): HTMLElement {
  const output = h('section', { className: 'cdp-output', 'aria-label': t('components.decisionBrief.title') });
  const close = h('button', { type: 'button', className: 'cdp-action-btn' }, t('components.decisionBrief.back'));
  const controls = h('div', { className: 'cdp-output-controls' });
  const paper = h('div', { className: 'cdp-decision-result' });
  const status = h('p', { role: 'status', 'aria-live': 'polite' }, t('components.decisionBrief.select'));
  const select = (label: string, values: [string, string][], initial: string) => {
    const element = h('select', { 'aria-label': label }) as HTMLSelectElement;
    for (const [value, text] of values) element.append(h('option', { value, selected: value === initial }, text));
    controls.append(h('label', {}, label, element));
    return element;
  };
  const fuel = select(t('components.decisionBrief.fuel'), [['gas', 'Gas (LNG)'], ['oil', 'Oil']], 'gas');
  const route = select(t('components.decisionBrief.chokepoint'), [['hormuz_strait', 'Strait of Hormuz'], ['malacca_strait', 'Strait of Malacca'], ['suez', 'Suez Canal'], ['bab_el_mandeb', 'Bab el-Mandeb']], 'hormuz_strait');
  const severities: [string, string][] = [25, 50, 75, 100].map(n => [String(n), `${n}%`]);
  const baseline = select(t('components.decisionBrief.baseline'), severities, '50');
  const comparison = select(t('components.decisionBrief.comparison'), severities, '100');
  const refresh = h('button', { type: 'button', className: 'cdp-action-btn' }, t('components.decisionBrief.capture')) as HTMLButtonElement;
  const html = h('button', { type: 'button', className: 'cdp-action-btn', disabled: true }, t('components.decisionBrief.downloadHtml')) as HTMLButtonElement;
  const json = h('button', { type: 'button', className: 'cdp-action-btn', disabled: true }, t('components.decisionBrief.downloadJson')) as HTMLButtonElement;
  let snapshot: import('@/types/decision-brief').DecisionBriefSnapshot | null = null;
  let worksheet: import('@/types/operational-balance').OperationalSnapshot | null = null;
  const worksheetForm = createOperationalExposureForm(value => {
    worksheet = value;
    if (snapshot) {
      snapshot = { ...snapshot, operationalWorksheet: worksheet };
      paper.replaceChildren(renderDecisionBrief(snapshot));
    }
  }, operationalSession, signal);
  let request: AbortController | null = null;
  let generation = 0;
  // Re-enabling refresh here is load-bearing: invalidate() bumps the generation, so
  // an in-flight capture aborted by a selection change will decline to re-enable the
  // button it no longer owns, and without this the control would stay dead.
  const invalidate = () => { generation++; request?.abort(); snapshot = null; html.disabled = json.disabled = true; refresh.disabled = false; };
  signal.addEventListener('abort', invalidate, { once: true });
  close.addEventListener('click', () => { invalidate(); onClose(); });
  for (const input of [fuel, route, baseline, comparison]) input.addEventListener('change', () => {
    invalidate(); paper.replaceChildren(); status.textContent = t('components.decisionBrief.changed');
  });
  refresh.addEventListener('click', async () => {
    invalidate();
    const current = generation;
    request = new AbortController();
    // Each capture dispatches two scenario RPCs, and aborting the client does not
    // stop work already dispatched server-side. Without a busy state on the button
    // itself (the status line is a separate element) an impatient double-click
    // silently doubles the cost of every capture.
    refresh.disabled = true;
    paper.replaceChildren(); status.textContent = t('components.decisionBrief.loading');
    try {
      const result = await load({ countryCode: country.code, countryName: country.name, fuelMode: fuel.value as 'gas' | 'oil', chokepointId: route.value, baselinePct: Number(baseline.value), comparisonPct: Number(comparison.value) }, request.signal);
      if (signal.aborted || current !== generation) return;
      snapshot = { ...result, operationalWorksheet: worksheet };
      paper.replaceChildren(renderDecisionBrief(snapshot)); html.disabled = json.disabled = false;
      status.textContent = t('components.decisionBrief.captured');
    } catch (error) {
      if (signal.aborted || current !== generation) return;
      // premiumFetch only reports resolved 5xx responses, so a rejected fetch or a
      // logic bug in the capture/build path would otherwise be invisible.
      console.warn('[CountryBriefOutput] decision brief capture failed', error);
      enqueueSentryCall((Sentry) => {
        Sentry.captureException?.(error instanceof Error ? error : new Error(String(error)), {
          tags: { surface: 'country-deep-dive', widget: 'decision-brief' },
          extra: { countryCode: country.code },
        });
      });
      status.textContent = t('components.decisionBrief.failed');
    } finally {
      // A superseded generation must not re-enable a button the newer request owns.
      if (current === generation) refresh.disabled = false;
    }
  });
  html.addEventListener('click', () => {
    if (snapshot) downloadHtml(`${country.code.toLowerCase()}-decision.html`, renderDecisionBrief(snapshot), `${country.name} Decision brief`, 'en');
  });
  json.addEventListener('click', () => {
    if (!snapshot) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' }));
    h('a', { href: url, download: `${country.code.toLowerCase()}-decision.json` }).click();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  });
  controls.append(refresh, html, json, status);
  output.append(h('header', { className: 'cdp-output-header' }, close, h('h2', {}, t('components.decisionBrief.title'))),
    h('div', { className: 'cdp-output-layout' }, controls, paper), worksheetForm);
  return output;
}

const chokepointName = (id: string) => CHOKEPOINT_REGISTRY.find(cp => cp.id === id)?.displayName ?? id;

// The preview lives inside the country panel; a 25-origin heading would bury the
// next action below several screens of cards. The export carries every origin.
const PREVIEW_CANDIDATES = 10;

type CommodityCandidate = import('@/types/decision-brief').CommodityBriefSnapshot['candidates'][number];

const decimal = (value: number, digits = 0) => value.toLocaleString('en-US', { maximumFractionDigits: digits });
/** World-export totals span 1e5..1e11, so they are abbreviated rather than printed in full. */
const compactUsd = (value: number) => value >= 1e9 ? `$${decimal(value / 1e9, 1)}B`
  : value >= 1e6 ? `$${decimal(value / 1e6, 1)}M`
    : value >= 1e3 ? `$${decimal(value / 1e3, 1)}K` : `$${decimal(value)}`;

/** Rows added to the existing candidate `<dl>`; each states its own "not available" case. */
function candidateEvidenceRows(candidate: CommodityCandidate, hs4: string): [string, string][] {
  const rows: [string, string][] = [['Recorded volume', candidate.netWeightKg === null
    ? 'Volume not reported'
    : `${decimal(candidate.netWeightKg)} kg${candidate.netWeightEstimated ? ' (estimated)' : ''}`]];
  if (candidate.quantity !== null) {
    rows.push(['Reported quantity', `${decimal(candidate.quantity, 2)}${candidate.quantityUnit ? ` ${candidate.quantityUnit}` : ' (unit not reported)'}`]);
  }
  // A rank is only among the reporters that filed its year, so it is printed
  // with that count; a snapshot without the count keeps the bare year.
  const rankBasis = (scale: NonNullable<CommodityCandidate['scale']>) => scale.reporterCount === null
    ? `rank ${scale.rank} (${scale.year})`
    : `rank ${scale.rank} of ${decimal(scale.reporterCount)} reporters filing ${scale.year}`;
  rows.push(['Supplier scale', candidate.scale === null
    ? 'Supplier scale unavailable'
    : `${compactUsd(candidate.scale.worldExportsUsd)} world exports of HS ${hs4}, ${rankBasis(candidate.scale)}${candidate.scale.worldExportsKg === null ? '' : ` · ${decimal(candidate.scale.worldExportsKg)} kg reported`}`]);
  if (candidate.production) {
    const { sharePct, stage, source, restricted } = candidate.production;
    // A redistribution-restricted source is named without its number (R4).
    rows.push(['World production share', restricted ? `share from ${source}, redistribution restricted`
      : sharePct === null ? `Share not published by ${source}`
        : `${decimal(sharePct, 1)}% of world ${stage} output (${source})`]);
  }
  return rows;
}

export function renderCommodityBrief(snapshot: import('@/types/decision-brief').CommodityBriefSnapshot, preview = false): HTMLElement {
  const countries = new Intl.DisplayNames(['en'], { type: 'region' });
  const article = h('article', { className: `cdp-commodity-paper ${preview ? 'cdp-commodity-preview' : 'cdp-output-paper'}`, lang: 'en' },
    h('header', { className: 'cdp-commodity-heading' },
      h('p', { className: 'cdp-commodity-eyebrow' }, `${snapshot.selection.countryName} / HS ${snapshot.hs4}`),
      h('h1', {}, `${snapshot.commodity}: HS ${snapshot.hs4} trade evidence`),
      h('p', { className: 'cdp-commodity-assumption' }, 'Assumed blocked: ', h('strong', {}, chokepointName(snapshot.selection.chokepointId))),
      h('p', { className: 'cdp-commodity-note' }, `Trade basket: ${snapshot.basket}. Shares describe this customs basket, not qualified commodity supply.`),
      h('p', { className: 'cdp-commodity-note' }, snapshot.caveats[0]),
      h('p', { className: 'cdp-commodity-note' }, 'Recorded trade and modeled routes. Capacity, qualification, price and lead time remain unknown.')),
    h('h2', { className: 'cdp-commodity-section-title' }, 'Recorded origin-country comparison'));
  const candidates = h('div', { className: 'cdp-commodity-candidates' });
  const shown = preview ? snapshot.candidates.slice(0, PREVIEW_CANDIDATES) : snapshot.candidates;
  for (const candidate of shown) {
    const evidence = snapshot.evidence.find(e => e.id === candidate.shareReference)!;
    const share = candidate.sharePct === null ? 'Unknown' : candidate.sharePct > 0 && candidate.sharePct < 0.01
      ? '<0.01%' : `${candidate.sharePct.toLocaleString('en-US', { maximumFractionDigits: 2 })}%`;
    const state = candidate.routeState === 'exposed' ? 'Modeled exposure'
      : candidate.routeState === 'unknown' ? 'Route unknown' : 'Blockage not on modeled route';
    candidates.append(h('section', { className: 'cdp-commodity-candidate', 'data-origin': candidate.origin },
      h('div', { className: 'cdp-commodity-candidate-top' },
        h('div', {}, h('h3', {}, countries.of(candidate.origin) ?? candidate.origin),
          h('span', { className: 'cdp-commodity-note' }, `${candidate.origin} · Trade year ${evidence.observedAt ?? 'unknown'}`),
          ...(candidate.transitHub ? [h('span', { className: 'cdp-commodity-hub' }, 'Possible transit hub')] : [])),
        h('div', { className: 'cdp-commodity-share' }, h('strong', {}, share), h('span', {}, 'of import value'))),
      h('span', { className: 'cdp-commodity-route-state', 'data-state': candidate.routeState }, state),
      h('p', { className: 'cdp-commodity-route' }, candidate.routeState === 'unknown' ? 'No modeled maritime path for this country pair.'
        : candidate.transitChokepoints.map(chokepointName).join(' · ') || 'No transit chokepoints identified.'),
      h('details', { className: 'cdp-commodity-details', open: !preview },
        h('summary', {}, 'Route & source details'),
        h('dl', {}, ...[
          ['Provider partner', `${candidate.partnerCode}: ${candidate.partnerScope}`],
          ...candidateEvidenceRows(candidate, snapshot.hs4),
          ['Modeled chokepoints (unordered)', candidate.transitChokepoints.map(chokepointName).join(', ') || 'Unknown / none identified'],
          ['Modeled routes', candidate.routeIds.map(id => TRADE_ROUTES.find(route => route.id === id)?.name ?? id).join(', ') || 'Unknown'],
          ['Affected chokepoints', candidate.routeState === 'unknown' ? 'Unknown' : candidate.affectedChokepoints.map(chokepointName).join(', ') || 'Selected chokepoint absent from modeled path'],
          ['Evidence basis', `${evidence.source}; geographic route model`],
          ['Reference', candidate.shareReference],
          ['Unresolved constraints', candidate.constraints],
        ].flatMap(([label, value]) => [h('dt', {}, label!), h('dd', {}, value!)])),
        h('p', {}, candidate.reason))));
  }
  if (!snapshot.candidates.length) candidates.append(h('p', { className: 'cdp-commodity-empty' }, 'No recorded supplier countries for this selection. See the next action below.'));
  // The coverage lines count every listed origin, not the cards above them.
  if (shown.length < snapshot.candidates.length) candidates.append(h('p', { className: 'cdp-commodity-note cdp-commodity-more' }, `+${snapshot.candidates.length - shown.length} more origins in the export. Coverage figures describe all ${snapshot.candidates.length} listed origins.`));
  article.append(candidates,
    h('section', { className: 'cdp-commodity-action' },
      h('h2', { className: 'cdp-commodity-section-title' }, 'Next action'), h('p', { className: 'cdp-decision-action' }, snapshot.action.text),
      h('details', { className: 'cdp-commodity-details', open: !preview }, h('summary', {}, 'Constraints & reassessment'),
        h('p', {}, `References: ${snapshot.action.references.join(', ') || 'No bilateral evidence available'}`),
        h('h3', {}, 'Constraint'), h('p', {}, snapshot.action.constraint),
        h('h3', {}, 'Reassessment trigger'), h('p', {}, snapshot.action.trigger))),
    h('details', { className: 'cdp-commodity-details cdp-commodity-method', open: !preview },
      h('summary', {}, 'Evidence & limitations'),
      h('h3', {}, 'Evidence coverage'), ...snapshot.coverage.map(text => h('p', {}, text)),
      h('p', {}, snapshot.context), h('p', {}, snapshot.ordering),
      h('p', {}, `Retrieved ${snapshot.capturedAt}`),
      ...snapshot.evidence.map(e => h('p', { id: e.id }, `[${e.id}] ${e.label}: ${e.value === null ? 'Unknown' : e.value} ${e.unit} · `,
        h('a', { href: e.sourceUrl, target: '_blank', rel: 'noopener noreferrer' }, e.source), ` · observed ${e.observedAt ?? 'unknown'}`)),
      h('p', {}, 'Route basis: WorldMonitor country port clusters and trade-route registry; geographic model, observation date unknown.'),
      h('h3', {}, 'Limitations'), h('ul', {}, ...snapshot.caveats.map(c => h('li', {}, c)))));
  const data = h('script', { type: 'application/json', id: 'commodity-brief-snapshot' });
  data.textContent = JSON.stringify(snapshot).replace(/</g, '\\u003c');
  article.append(data);
  return article;
}

export function createCommodityBriefOutput(
  country: { code: string; name: string }, signal: AbortSignal,
  options: readonly { id: string; label: string }[],
  load: (selection: import('@/types/decision-brief').CommodityBriefSelection, signal: AbortSignal) => Promise<import('@/types/decision-brief').CommodityBriefSnapshot>,
  onClose: () => void,
): HTMLElement {
  const title = t('components.decisionBrief.commodityTitle');
  const output = h('section', { className: 'cdp-output cdp-commodity-output', 'aria-label': title });
  const close = h('button', { type: 'button', className: 'cdp-action-btn' }, t('components.decisionBrief.back'));
  const controls = h('div', { className: 'cdp-output-controls' });
  const paper = h('div', { className: 'cdp-decision-result' });
  const commodity = h('select', { 'aria-label': t('components.decisionBrief.commodity') }) as HTMLSelectElement;
  for (const option of options) commodity.append(h('option', { value: option.id }, option.label));
  commodity.value = options.some(option => option.id === 'helium') ? 'helium' : options[0]?.id ?? '';
  const route = h('select', { 'aria-label': t('components.decisionBrief.blockedChokepoint') }) as HTMLSelectElement;
  for (const [id, label] of [['hormuz_strait', 'Strait of Hormuz'], ['suez', 'Suez Canal'], ['cape_of_good_hope', 'Cape of Good Hope'], ['malacca_strait', 'Strait of Malacca'], ['bab_el_mandeb', 'Bab el-Mandeb']]) route.append(h('option', { value: id! }, label!));
  const status = h('p', { role: 'status' }, t('components.decisionBrief.select'));
  const refresh = h('button', { type: 'button', className: 'cdp-action-btn cdp-export-primary' }, t('components.decisionBrief.commodityCapture')) as HTMLButtonElement;
  const html = h('button', { type: 'button', className: 'cdp-action-btn', disabled: true, 'aria-label': t('components.decisionBrief.downloadHtml'), title: t('components.decisionBrief.downloadHtml') }, '↓ HTML') as HTMLButtonElement;
  const json = h('button', { type: 'button', className: 'cdp-action-btn', disabled: true, 'aria-label': t('components.decisionBrief.downloadJson'), title: t('components.decisionBrief.downloadJson') }, '↓ JSON') as HTMLButtonElement;
  let snapshot: import('@/types/decision-brief').CommodityBriefSnapshot | null = null;
  let request: AbortController | null = null;
  let generation = 0;
  const invalidate = () => {
    generation++; request?.abort(); snapshot = null; paper.replaceChildren();
    html.disabled = json.disabled = true; refresh.disabled = false;
  };
  signal.addEventListener('abort', invalidate, { once: true });
  close.addEventListener('click', () => { invalidate(); onClose(); });
  for (const select of [commodity, route]) select.addEventListener('change', () => { invalidate(); status.textContent = t('components.decisionBrief.changed'); });
  refresh.addEventListener('click', async () => {
    if (signal.aborted) return;
    invalidate(); const current = generation;
    request = new AbortController(); refresh.disabled = true;
    status.textContent = t('components.decisionBrief.loading');
    try {
      const result = await load({ countryCode: country.code, countryName: country.name, commodityId: commodity.value, chokepointId: route.value }, AbortSignal.any([signal, request.signal]));
      if (signal.aborted || current !== generation) return;
      snapshot = result; paper.replaceChildren(renderCommodityBrief(result, true)); html.disabled = json.disabled = false;
      status.textContent = t('components.decisionBrief.captured');
    } catch (error) {
      if (signal.aborted || current !== generation) return;
      console.warn('[CountryBriefOutput] commodity capture failed', error);
      status.textContent = t('components.decisionBrief.failed');
    } finally { if (current === generation) refresh.disabled = false; }
  });
  html.addEventListener('click', () => { if (snapshot) downloadHtml(`${country.code.toLowerCase()}-commodity-decision.html`, renderCommodityBrief(snapshot), title, 'en'); });
  json.addEventListener('click', () => {
    if (!snapshot) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' }));
    h('a', { href: url, download: `${country.code.toLowerCase()}-commodity-decision.json` }).click();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  });
  controls.append(h('div', { className: 'cdp-commodity-selectors' },
    h('label', {}, t('components.decisionBrief.commodity'), commodity), h('label', {}, t('components.decisionBrief.blockedChokepoint'), route)),
    h('div', { className: 'cdp-commodity-buttons' }, refresh, html, json), status);
  output.append(h('header', { className: 'cdp-output-header' }, close, h('h2', {}, title)), controls, paper);
  return output;
}
