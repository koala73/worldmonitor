import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { GridClockSnapshot } from '../../shared/grid-disruption-clock';

const transport = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@/services/grid-disruption-clock', () => ({ fetchGridDisruptionClock: transport.fetch }));

import { GridDisruptionClockPanel } from '@/components/GridDisruptionClockPanel';
import { initTestI18n } from './helpers/i18n.mts';

let panel: GridDisruptionClockPanel | undefined;
beforeAll(initTestI18n);
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(new Date('2026-11-14T12:00:00Z'));
  transport.fetch.mockReset();
});
afterEach(() => {
  panel?.destroy();
  panel = undefined;
  document.body.replaceChildren();
  vi.useRealTimers();
});

async function mount(warningDuration = 90_000) {
  const now = Date.now();
  const source = { kind: 'grid' as const, sourceName: 'Test operator', sourceUrl: 'https://example.org/grid' };
  const snapshot: GridClockSnapshot = { regions: ['CA', 'TN'].map(code => ({
    code: code as 'CA' | 'TN',
    current: { observedAt: now - 59 * 60_000, customersOut: 0, customersTracked: null,
      coverageKey: code, coverageLabel: 'Test coverage', sourceName: 'Test utility', sourceUrl: 'https://example.org/utility' },
    history: [], warningsCheckedAt: now,
    warningSources: [{ ...source, checkedAt: now, status: 'available' }],
    warnings: [{ ...source, title: 'Test warning', issuedAt: now, expiresAt: now + warningDuration }],
  })) };
  transport.fetch.mockResolvedValue(snapshot);
  panel = new GridDisruptionClockPanel();
  const root = panel.getElement();
  document.body.appendChild(root);
  await panel.fetchData();
  return root;
}

it('advances elapsed time and expires warnings and freshness without fetching', async () => {
  const root = await mount();
  const age = () => root.querySelector('.grid-clock-age strong')!.textContent;
  expect(age()).toContain('0');
  expect(root.querySelector('.grid-clock')!.getAttribute('data-phase')).toBe('watch');
  vi.advanceTimersByTime(60_000);
  expect(age()).toContain('1');
  expect(root.textContent).toContain('Test warning');
  vi.advanceTimersByTime(60_000);
  expect(root.textContent).not.toContain('Test warning');
  expect(root.querySelector('.grid-clock')!.getAttribute('data-phase')).toBe('unknown');
  expect(root.textContent).toContain('Customers out at last report');
  expect(transport.fetch).toHaveBeenCalledTimes(1);
});

it('preserves disclosures and focus, and stops ticking after destruction', async () => {
  const baselineTimers = vi.getTimerCount();
  const root = await mount(10 * 60_000);
  root.querySelector('details')!.open = true;
  root.querySelector<HTMLButtonElement>('[data-region="TN"]')!.focus();
  vi.advanceTimersByTime(60_000);
  expect(root.querySelector('details')!.open).toBe(true);
  expect((document.activeElement as HTMLElement).dataset.region).toBe('TN');
  const coverageLink = root.querySelector<HTMLAnchorElement>('details a')!;
  expect(root.querySelectorAll(`a[href="${coverageLink.href}"]`).length).toBeGreaterThan(1);
  coverageLink.focus();
  vi.advanceTimersByTime(60_000);
  expect(document.activeElement).toBe(root.querySelector('details a'));
  root.querySelector('summary')!.focus();
  vi.advanceTimersByTime(60_000);
  expect(document.activeElement?.tagName).toBe('SUMMARY');
  const link = root.querySelector<HTMLAnchorElement>('a')!;
  const href = link.href;
  link.focus();
  vi.advanceTimersByTime(60_000);
  expect((document.activeElement as HTMLAnchorElement).href).toBe(href);
  panel!.destroy();
  panel = undefined;
  expect(vi.getTimerCount()).toBe(baselineTimers);
  const content = root.innerHTML;
  vi.advanceTimersByTime(60_000);
  expect(root.innerHTML).toBe(content);
});

it('keeps history open and focused when a refresh changes its summary count', async () => {
  const root = await mount();
  const snapshot = await transport.fetch.mock.results[0]!.value as GridClockSnapshot;
  const region = snapshot.regions[0]!;
  region.history.push({ ...region.current!, observedAt: Date.now() - 70 * 60_000 });
  await panel!.fetchData();
  const history = () => root.querySelector<HTMLDetailsElement>('[data-clock-disclosure="history"]')!;
  history().open = true;
  history().querySelector('summary')!.focus();
  const previousLabel = document.activeElement!.textContent;
  region.history.push({ ...region.current!, observedAt: Date.now() - 65 * 60_000 });
  await panel!.fetchData();
  expect(history().open).toBe(true);
  expect(document.activeElement).toBe(history().querySelector('summary'));
  expect(document.activeElement!.textContent).not.toBe(previousLabel);
  expect(history().querySelectorAll('li')).toHaveLength(2);
});
