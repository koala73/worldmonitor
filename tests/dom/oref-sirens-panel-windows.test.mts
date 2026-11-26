import { afterEach, expect, it, vi } from 'vitest';
import english from '@/locales/en.json';
import type { OrefHistoryEntry } from '@/services/oref-alerts';

const state = vi.hoisted(() => ({ count: -1, history: [] as OrefHistoryEntry[] }));

vi.mock('@/components/Panel', () => ({ Panel: class {
  content = document.body.appendChild(document.createElement('div'));
  setCount(n: number) { state.count = n; }
  setNewBadge() {}
  showLoading() {}
  setSafeContent(value: unknown) { this.content.innerHTML = String(value); }
} }));
vi.mock('@/services/i18n', () => ({
  t: (key: string, vars: Record<string, string> = {}) => {
    const template = key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], english);
    return String(template ?? key).replace(/\{\{(\w+)\}\}/g, (_, name) => vars[name] ?? '');
  },
}));
vi.mock('@/services/oref-alerts', () => ({
  fetchOrefHistory: async () => ({ configured: true, history: state.history, historyCount24h: 0, timestamp: '' }),
}));

import { OrefSirensPanel } from '@/components/OrefSirensPanel';

const HOUR = 60 * 60 * 1000;
const wave = (hoursAgo: number, areas: string[]): OrefHistoryEntry => ({
  timestamp: new Date(Date.now() - hoursAgo * HOUR).toISOString(),
  alerts: [{ id: `w${hoursAgo}`, cat: '1', title: 'Rocket and missile fire', data: areas, desc: '', alertDate: '' }],
});
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

afterEach(() => { document.body.replaceChildren(); state.count = -1; state.history = []; });

it('keeps the badge at zero during an all clear with only older history', async () => {
  state.history = [wave(40, ['Even Menahem', 'Shetula'])];
  const panel = new OrefSirensPanel();
  panel.setData({ configured: true, alerts: [], historyCount24h: 0, totalHistoryCount: 2, timestamp: '' });
  await flush();
  expect(document.body.textContent).toContain('No active sirens');
  expect(state.count).toBe(0);
});

it('lists only the waves inside the 24-hour window the summary counts, with their area names', async () => {
  state.history = [wave(40, ['Even Menahem', 'Shetula']), wave(5, ['Ashkelon']), wave(2, ['Sderot', 'Netivot'])];
  const panel = new OrefSirensPanel();
  panel.setData({ configured: true, alerts: [], historyCount24h: 3, totalHistoryCount: 5, timestamp: '' });
  await flush();
  const text = document.body.textContent ?? '';
  expect(text).toContain('3 alerts in 24h — 2 waves');
  expect(text).toContain('Sderot, Netivot');
  expect(text).toContain('Ashkelon');
  expect(text).not.toContain('Even Menahem');
  expect(state.count).toBe(3);
});

it('shows no history section when no wave falls inside the 24-hour window', async () => {
  state.history = [wave(40, ['Even Menahem', 'Shetula'])];
  const panel = new OrefSirensPanel();
  panel.setData({ configured: true, alerts: [], historyCount24h: 0, totalHistoryCount: 2, timestamp: '' });
  await flush();
  expect(document.querySelector('.oref-history-section')).toBeNull();
  expect(document.body.textContent).not.toContain('Even Menahem');
});

it('stops showing the loading placeholder once loaded history has no wave inside the 24-hour window', async () => {
  state.history = [wave(25, ['Even Menahem', 'Shetula'])];
  const panel = new OrefSirensPanel();
  panel.setData({ configured: true, alerts: [], historyCount24h: 2, totalHistoryCount: 2, timestamp: '' });
  await flush();
  expect(document.body.textContent).not.toContain('Loading history');
  expect(document.body.textContent).not.toContain('Even Menahem');
  expect(state.count).toBe(2);
});
