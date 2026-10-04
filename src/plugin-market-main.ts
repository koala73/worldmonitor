import './styles/plugin-market.css';
import { setTrustedHtml, trustedHtml } from '@/utils/dom-utils';
import { terminalChart } from '@/utils/terminal-chart';
import { miniSparkline } from '@/utils/sparkline';

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
const text = (value: unknown): string => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
const number = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const groups = [
  { key: 'stocks-bootstrap', list: 'quotes', label: 'Equities' },
  { key: 'commodities-bootstrap', list: 'quotes', label: 'Commodities' },
  { key: 'crypto', list: 'quotes', label: 'Crypto' },
  { key: 'gulf-quotes', list: 'quotes', label: 'Gulf' },
  { key: 'sectors', list: 'sectors', label: 'Sectors' },
  { key: 'projection', list: 'quotes', label: 'Projected quotes' },
] as const;

function mount(): void {
  const content = document.getElementById('marketContent')!;
  const status = document.getElementById('marketStatus')!;
  const usage = document.getElementById('marketUsage')!;
  const snapshot = document.getElementById('marketSnapshot')!;
  const send = (message: object) => window.parent.postMessage({ jsonrpc: '2.0', ...message }, '*');
  const node = (tag: string, className: string, value = ''): HTMLElement => {
    const element = document.createElement(tag);
    element.className = className;
    element.textContent = value;
    return element;
  };
  const theme = (context: unknown): void => {
    const value = record(context).theme;
    if (value === 'light' || value === 'dark') document.documentElement.dataset.theme = value;
  };
  const format = (value: number | null): string =>
    value == null ? '—' : value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  const renderQuote = (quote: RecordValue): HTMLElement => {
    const name = text(quote.name);
    const symbol = text(quote.display) || text(quote.displaySymbol) || text(quote.symbol) || text(quote.ticker) || name || 'Unknown asset';
    const change = number(quote.change);
    const series = Array.isArray(quote.sparkline)
      ? quote.sparkline.filter((value): value is number => number(value) != null) : [];
    const charted = series.length >= 2;
    const row = node(charted ? 'details' : 'div', 'quote');
    const heading = node(charted ? 'summary' : 'div', '');
    const line = node('div', 'quote-line');
    const identity = node('div', 'qidentity');
    identity.append(node('span', 'qsym', symbol));
    if (charted) {
      const preview = node('span', '');
      setTrustedHtml(preview, trustedHtml(miniSparkline(series, change), 'SVG geometry from finite numeric points'));
      identity.append(preview);
    }
    line.append(identity, node('span', 'qprice', format(number(quote.price))),
      node('span', 'qchg' + (change == null ? '' : change >= 0 ? ' up' : ' down'),
        change == null ? '—' : (change > 0 ? '+' : '') + change.toFixed(2) + '%'));
    heading.append(line);
    if (name && name !== symbol) heading.append(node('div', 'qname', name));
    row.append(heading);
    if (charted) {
      const chart = node('div', 'market-chart');
      row.append(chart);
      row.addEventListener('toggle', () => {
        if (!row.hasAttribute('open') || chart.childElementCount) return;
        setTrustedHtml(chart, trustedHtml(terminalChart(series, { change, ariaLabel: symbol + ' loaded intraday price chart' }), 'Shared chart renderer escapes the label and uses finite numeric points'));
        chart.append(node('p', 'qcoverage', 'Loaded intraday series. ' + series.length + ' observed points. Expansion reuses this snapshot.'));
      });
    } else {
      row.append(node('p', 'qcoverage', 'Intraday chart unavailable in this snapshot.'));
    }
    return row;
  };

  const render = (result: RecordValue): void => {
    content.replaceChildren();
    const structured = record(result.structuredContent);
    const projected = Object.prototype.hasOwnProperty.call(structured, 'projection');
    const value = projected ? structured.projection : structured;
    let payload = Array.isArray(value) ? { data: { projection: { quotes: value } } } :
      record(value);
    if (projected && (Array.isArray(payload.quotes) || Array.isArray(record(payload.quotes).sample))) {
      payload = { ...payload, data: { projection: payload } };
    } else if (projected && (Array.isArray(payload.sample) || typeof payload.symbol === 'string' || typeof payload.name === 'string')) {
      payload = { data: { projection: { quotes: Array.isArray(payload.sample) ? payload : [payload] } } };
    }
    if (!Object.keys(payload).length && Array.isArray(result.content)) {
      for (const item of result.content) {
        if (record(item).type !== 'text') continue;
        try { payload = record(JSON.parse(text(record(item).text))); } catch { continue; }
        if (Object.keys(payload).length) break;
      }
    }
    const allocation = record(record(result._meta)['worldmonitor/usage']);
    const remaining = number(allocation.remaining);
    usage.hidden = allocation.unit !== 'requests' || !text(allocation.resetsAt) ||
      (allocation.remaining !== null && (remaining == null || remaining < 0));
    usage.textContent = usage.hidden ? '' : (remaining == null ? 'Unlimited panel requests.' : remaining + ' panel requests remaining.') +
      ' Resets ' + text(allocation.resetsAt) + '. Navigation and chart expansion reuse loaded data.';
    snapshot.textContent = text(payload.cached_at) ? 'Snapshot ' + text(payload.cached_at) + (payload.stale ? ' (stale)' : '') : '';
    if (result.isError || payload.error || payload._budget_exceeded || payload._jmespath_error || !Object.keys(payload).length) {
      status.textContent = text(payload.error) || (payload._budget_exceeded ? 'Response too large. Narrow the market request.' :
        payload._jmespath_error ? 'Projection unavailable. Remove the projection and retry.' : 'Market data unavailable. Ask again to retry.');
      return;
    }
    const data = Object.keys(record(payload.data)).length ? record(payload.data) : payload;
    const fear = record(data['fear-greed']);
    const composite = record(fear.composite);
    const score = number(composite.score) ?? number(fear.composite);
    if (score != null) {
      const fearCard = node('div', 'fg-card');
      const color = score >= 55 ? 'var(--green)' : score <= 45 ? 'var(--red)' : 'var(--muted)';
      const scoreNode = node('div', 'fg-score', String(Math.round(score)));
      scoreNode.style.color = color;
      const fearMeta = node('div', 'fg-meta');
      fearMeta.append(node('h2', '', 'Fear & Greed'), node('div', 'fg-label', text(composite.label)));
      const track = node('div', 'fg-track');
      const bar = node('span', '');
      bar.style.width = Math.max(0, Math.min(100, score)) + '%';
      bar.style.background = color;
      track.append(bar);
      fearMeta.append(track);
      fearCard.append(scoreNode, fearMeta);
      content.append(fearCard);
    }
    let count = 0;
    for (const group of groups) {
      if (!(group.key in data)) continue;
      const source = record(data[group.key]);
      const collection = source[group.list];
      const budgeted = record(collection);
      const items = Array.isArray(collection) ? collection : Array.isArray(budgeted.sample) ? budgeted.sample : null;
      const section = node('section', 'mgroup');
      section.append(node('h2', 'sec-label', group.label));
      if (source.rateLimited === true) section.append(node('p', 'qcoverage', 'Provider rate limit reported for this snapshot.'));
      if (text(source.skipReason)) section.append(node('p', 'qcoverage', 'Source coverage: ' + text(source.skipReason)));
      if (text(source.asOf)) section.append(node('p', 'qcoverage', 'Observed ' + text(source.asOf)));
      if (!items) section.append(node('p', 'qcoverage', 'Source data unavailable.'));
      else {
        const quotes = items.filter(item => Object.keys(record(item)).length);
        const total = number(budgeted.count) ?? number(budgeted.total);
        section.append(node('p', 'qcoverage', total != null && total > quotes.length
          ? 'Showing ' + quotes.length + ' of ' + total + ' quotes from the response sample.'
          : quotes.length + ' loaded quotes.'));
        for (const item of quotes) { section.append(renderQuote(record(item))); count++; }
        if (!quotes.length) section.append(node('p', 'qcoverage', 'No quotes in this response. The curated snapshot does not establish why a requested symbol is absent.'));
      }
      content.append(section);
    }
    status.textContent = count ? count + ' loaded quotes. Select a chart row to expand its details.' :
      projected ? 'This projection contains no quote groups. Request market data without this projection.' : 'No market quotes available in this response.';
  };

  window.addEventListener('message', event => {
    if (event.source !== window.parent) return;
    const message = record(event.data);
    if (message.jsonrpc !== '2.0') return;
    if (message.id === 1) {
      if (message.error) { status.textContent = 'The host connection is unavailable. Reload to retry.'; return; }
      theme(record(message.result).hostContext);
      send({ method: 'ui/notifications/initialized', params: {} });
    } else if (message.method === 'ui/notifications/tool-result') {
      const params = record(message.params);
      render(record(params.result ?? params));
    } else if (message.method === 'ui/notifications/host-context-changed') {
      theme(record(message.params).hostContext ?? message.params);
    }
  });
  const resize = new ResizeObserver(() => send({
    method: 'ui/notifications/size-changed', params: { height: document.documentElement.scrollHeight },
  }));
  resize.observe(document.body);
  window.addEventListener('pagehide', () => resize.disconnect(), { once: true });
  send({ id: 1, method: 'ui/initialize', params: {
    protocolVersion: '2026-01-26', appInfo: { name: 'worldmonitor-market-radar', version: '2.0.0' }, appCapabilities: {},
  } });
}
if (document.documentElement.dataset.wmPluginManagedBoot === 'true') {
  const attempt = new URL(import.meta.url).searchParams.get('wm-plugin-boot');
  const mountEvent = attempt && /^\d+$/.test(attempt) ? 'wm-plugin-boot-' + attempt : 'wm-plugin-mount';
  document.addEventListener(mountEvent, mount, { once: true });
} else {
  mount();
}
