import { beforeAll, afterEach, expect, it, vi } from 'vitest';
import { MapPopup } from '@/components/MapPopup';
import type { CyberThreat } from '@/types';
import { initTestI18n } from './helpers/i18n.mts';

beforeAll(initTestI18n);
afterEach(() => { document.body.innerHTML = ''; vi.unstubAllGlobals(); });
const threat: CyberThreat = { id: 'fixture', indicator: '2.249.90.120', indicatorType: 'ip',
  type: 'malware_host', source: 'urlhaus', country: 'SE', lat: 59.3, lon: 18,
  severity: 'high', malwareFamily: 'MOZI', tags: ['malware_download'], lastSeen: '2026-11-01T12:00:00Z' };
function open(value = threat) {
  const container = document.createElement('div');
  document.body.append(container);
  const popup = new MapPopup(container);
  popup.show({ type: 'cyberThreat', data: value, x: 100, y: 100 });
  return popup;
}
it('qualifies the first-seen date and omits family explanations without a family', () => {
  const popup = open({ ...threat, malwareFamily: undefined, firstSeen: '2026-11-01T12:00:00Z' });
  const body = document.querySelector('.popup-body')!;
  expect(body.textContent).toContain('earliest available indicator date across feeds or World Monitor observations');
  expect(body.textContent).toContain('download');
  expect(body.textContent).not.toContain('family label');
  popup.hide();
});
it('uses all classification tags for explanations while limiting visible chips to six', () => {
  const popup = open({ ...threat, malwareFamily: undefined,
    tags: ['tag1', 'tag2', 'tag3', 'tag4', 'tag5', 'tag6', 'malware_download'] });
  expect(document.querySelectorAll('.popup-tag')).toHaveLength(6);
  expect(document.querySelector('.popup-body')!.textContent).toContain('the source reports a malware download location');
  popup.hide();
});
it('loads network information only on expansion and escapes provider fields', async () => {
  const fetcher = vi.fn(async () => Response.json({ status: 'available', ip: threat.indicator,
    asns: [{ asn: 3301, holder: '<img src=x onerror=alert(1)>' }], hostnames: ['example.telia.com'],
    prefix: '2.248.0.0/14', isLessSpecific: true, lookupAt: '2026-11-06T10:00:00Z', routingAt: '' }));
  vi.stubGlobal('fetch', fetcher);
  const popup = open();
  expect(fetcher).not.toHaveBeenCalled();
  const details = document.querySelector<HTMLDetailsElement>('.cyber-network-info')!;
  expect(details).not.toBeNull();
  details.open = true;
  details.dispatchEvent(new Event('toggle'));
  await vi.waitFor(() => expect(details.textContent).toContain('AS3301'));
  expect(details.textContent).toContain('<img src=x onerror=alert(1)>');
  expect(details.querySelector('img')).toBeNull();
  expect(details.textContent).toContain('not identify the attacker');
  details.open = false;
  details.dispatchEvent(new Event('toggle'));
  details.open = true;
  details.dispatchEvent(new Event('toggle'));
  expect(fetcher).toHaveBeenCalledTimes(1);
  popup.hide();
});
it('preserves domain and URL indicators without resolving them', () => {
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  for (const indicatorType of ['domain', 'url'] as const) {
    const popup = open({ ...threat, indicatorType, indicator: indicatorType === 'domain' ? 'example.com' : 'https://example.com/a' });
    expect(document.querySelector('.cyber-network-info')).toBeNull();
    expect(document.querySelector('.map-popup')!.textContent).toContain(indicatorType.toUpperCase());
    popup.hide();
  }
  expect(fetcher).not.toHaveBeenCalled();
});
it('does not put a late response into a replacement popup', async () => {
  let resolve!: (value: Response) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(done => { resolve = done; })));
  const popup = open();
  const details = document.querySelector<HTMLDetailsElement>('.cyber-network-info')!;
  details.open = true;
  details.dispatchEvent(new Event('toggle'));
  await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
  popup.show({ type: 'cyberThreat', data: { ...threat, indicator: '1.1.1.1' }, x: 100, y: 100 });
  resolve(Response.json({ status: 'available', asns: [{ asn: 3301, holder: 'Telia' }], ip: threat.indicator }));
  await new Promise(done => setTimeout(done, 0));
  expect(document.querySelector('.map-popup')!.textContent).not.toContain('AS3301');
  popup.hide();
});

it.each([
  ['disabled', 'not enabled'], ['invalid', 'public IP'], ['unavailable', 'lookup failed'],
  ['rate_limited', 'temporarily limited'], ['no_data', 'no network information'],
  ['partial', 'Some network information'],
])('shows the %s result without changing threat evidence', async (status, message) => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ status, ip: threat.indicator, asns: [],
    prefix: '', hostnames: [], lookupAt: '', routingAt: '' })));
  const popup = open();
  const details = document.querySelector<HTMLDetailsElement>('.cyber-network-info')!;
  details.open = true;
  details.dispatchEvent(new Event('toggle'));
  await vi.waitFor(() => expect(details.textContent).toContain(message));
  expect(document.querySelector('.popup-body')!.textContent).toContain('URLhaus');
  expect(document.querySelector('.popup-body')!.textContent).toContain('MOZI');
  if (status === 'no_data' || status === 'partial') expect(details.textContent).toContain('Not available');
  popup.hide();
});

it('reports clipboard failure without discarding the network result', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ status: 'available', ip: threat.indicator,
    asns: [{ asn: 3301, holder: 'Telia' }], prefix: '', hostnames: [], lookupAt: '', routingAt: '' })));
  vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));
  const popup = open();
  const details = document.querySelector<HTMLDetailsElement>('.cyber-network-info')!;
  details.open = true;
  details.dispatchEvent(new Event('toggle'));
  await vi.waitFor(() => expect(details.textContent).toContain('AS3301'));
  details.querySelector<HTMLButtonElement>('[data-copy-network="AS3301"]')!.click();
  await vi.waitFor(() => expect(details.textContent).toContain('Copy failed'));
  expect(details.textContent).toContain('Telia');
  popup.hide();
});
