import '../styles/main.css';
import { initI18n } from '@/services/i18n';
import { EconomicCorrelationPanel } from '@/components/EconomicCorrelationPanel';
import { EscalationCorrelationPanel } from '@/components/EscalationCorrelationPanel';
import { h } from '@/utils/dom-utils';

// Real panels, hydration transport, timers, and browser storage. Only the HTTP
// response is controlled; fixture controls exercise reconnect and page reload.
const originalFetch = globalThis.fetch;
let mode = sessionStorage.getItem('correlation-fixture-mode') ?? 'healthy';
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
  if (url.pathname === '/api/bootstrap' && url.searchParams.get('keys') === 'correlationCards') {
    const counter = document.getElementById('requests');
    if (counter) counter.textContent = String(Number(counter.textContent) + 1);
    if (mode === 'failure') return Response.json({ error: 'fixture interruption' }, { status: 503 });
    const computedAt = Date.now() - 60_000;
    return Response.json({ data: { correlationCards: {
      computedAt,
      military: [], escalation: [], disaster: [],
      economic: mode === 'empty' ? [] : [{
        id: 'fixture-economic', domain: 'economic', title: 'Energy trade restrictions',
        score: 42, timestamp: computedAt, countries: ['US'], trend: 'stable',
        location: { lat: 38.9, lon: -77.0, label: 'Synthetic location' },
        signals: [
          { type: 'sanctions_news', source: 'fixture', severity: 45, timestamp: computedAt, label: 'Synthetic sanctions announcement' },
          { type: 'commodity_spike', source: 'fixture', severity: 40, timestamp: computedAt, label: 'Synthetic energy price movement' },
        ],
        assessment: 'Synthetic test data. Two related signals were observed in the latest update.',
      }],
    } }, missing: [] });
  }
  return originalFetch(input, init);
};

await initI18n();
const app = document.getElementById('app')!;
Object.assign(app.style, { padding: '24px', maxWidth: '820px', margin: '0 auto', minHeight: '100vh', overflow: 'auto' });
const stateLabel = h('span', { id: 'fixture-state' }, mode);
function responseButton(label: string, nextMode: string): HTMLElement {
  const button = h('button', { type: 'button', style: 'padding:8px 12px;cursor:pointer;' }, label);
  button.addEventListener('click', () => {
    mode = nextMode;
    sessionStorage.setItem('correlation-fixture-mode', mode);
    stateLabel.textContent = mode;
    window.dispatchEvent(new Event('online'));
  });
  return button;
}
const reload = h('button', { type: 'button', style: 'padding:8px 12px;cursor:pointer;' }, 'Reload with saved data');
reload.addEventListener('click', () => location.reload());
app.append(
  h('h1', { style: 'font-size:20px;margin:0 0 12px;' }, 'Correlation recovery verification'),
  h('p', { style: 'margin:0 0 16px;opacity:0.7;font-size:12px;' }, 'Synthetic HTTP responses · Real panel components and persistent cache'),
  h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;' },
    responseButton('Healthy response', 'healthy'), responseButton('Fail data request', 'failure'),
    responseButton('Confirmed empty response', 'empty'), reload),
  h('p', { style: 'font-size:11px;margin-bottom:20px;' }, 'Response: ', stateLabel, ' · Requests: ', h('span', { id: 'requests' }, '0')),
);
for (const PanelClass of [EconomicCorrelationPanel, EscalationCorrelationPanel]) {
  const panel = new PanelClass();
  Object.assign(panel.getElement().style, { minHeight: '230px', marginBottom: '20px', width: '100%' });
  app.appendChild(panel.getElement());
  panel.notifyConnected();
  window.addEventListener('pagehide', () => panel.destroy(), { once: true });
}
