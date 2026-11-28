import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18next from 'i18next';
import de from '@/locales/de.json';
import { initTestI18n, useChineseCatalogue } from './helpers/i18n.mts';
const translator = vi.hoisted(() => ({
  calls: [] as Array<{ text: string; target: string }>,
  reply: (text: string): string | null | Promise<string> => `[de] ${text}`,
}));

vi.mock('@/services/summarization', () => ({
  translateText: async (text: string, target: string) => {
    translator.calls.push({ text, target });
    return translator.reply(text);
  },
}));

vi.mock('@/services/bootstrap', () => ({ getHydratedData: () => undefined }));

// Translation is a Pro control. hasPremiumAccess answers from four signals,
// so the panel re-checks access whenever any of them fires.
const access = vi.hoisted(() => ({
  premium: true,
  listeners: new Set<() => void>(),
}));
function subscribeAccess(listener: () => void) {
  access.listeners.add(listener);
  return () => { access.listeners.delete(listener); };
}
function setPremium(premium: boolean) {
  access.premium = premium;
  for (const listener of access.listeners) listener();
}
vi.mock('@/services/panel-gating', () => ({ hasPremiumAccess: () => access.premium }));
vi.mock('@/services/auth-state', () => ({ getAuthState: () => ({ user: null }), subscribeAuthState: subscribeAccess }));
vi.mock('@/services/entitlements', () => ({ onEntitlementChange: subscribeAccess }));
vi.mock('@/services/widget-store', () => ({ subscribeWidgetAccess: subscribeAccess }));
vi.mock('@/services/runtime-config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/runtime-config')>()),
  subscribeRuntimeConfig: subscribeAccess,
}));

const listClimateNews = vi.hoisted(() => vi.fn());
vi.mock('@/services/generated-rpc-clients', () => ({
  ClimateServiceClient: class { listClimateNews = listClimateNews; },
}));

import { ClimateNewsPanel } from '@/components/ClimateNewsPanel';

const NOW = new Date('2026-11-27T00:00:00Z');
const ITEM = {
  title: 'Arctic sea ice hits a record low',
  summary: 'Researchers report the lowest winter maximum in the satellite record.',
  sourceName: 'Carbon Brief',
  url: 'https://example.org/arctic',
  publishedAt: NOW.getTime() - 2 * 60 * 60 * 1000,
};

async function mountPanel() {
  listClimateNews.mockResolvedValue({ items: [ITEM] });
  const panel = new ClimateNewsPanel();
  const host = document.body.appendChild(document.createElement('div'));
  host.appendChild(panel.getElement());
  await panel.fetchData();
  // setSafeContent coalesces on a 150 ms timer, so the cards are not in the
  // DOM when fetchData resolves.
  await vi.waitFor(() => expect(document.querySelector('.climate-news-list')).not.toBeNull());
  return panel;
}

const card = () => document.querySelector<HTMLElement>('.climate-news-card')!;
const button = () => document.querySelector<HTMLButtonElement>('.climate-news-card__translate');
const titleText = () => document.querySelector('.climate-news-card__title')!.textContent;
const summaryText = () => document.querySelector('.climate-news-card__summary')!.textContent;

beforeEach(async () => {
  vi.setSystemTime(NOW);
  await initTestI18n();
  i18next.addResourceBundle('de', 'translation', de);
  await i18next.changeLanguage('de');
  translator.calls.length = 0;
  translator.reply = (text: string) => `[de] ${text}`;
  access.premium = true;
  access.listeners.clear();
  document.body.innerHTML = '';
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('Climate News translate control (#10054)', () => {
  it('offers the control when the UI language is not English', async () => {
    await mountPanel();
    expect(button()).not.toBeNull();
    expect(button()!.textContent).toBe('文');
    expect(button()!.getAttribute('aria-label')).toBe('Übersetzen');
    expect(button()!.title).toBe('Übersetzen');
  });

  it('does not offer it to an English reader, whose feed is already English', async () => {
    await i18next.changeLanguage('en');
    await mountPanel();
    expect(document.querySelector('.climate-news-card')).not.toBeNull();
    expect(button()).toBeNull();
  });

  it('translates the title and the summary into the UI language on request', async () => {
    await useChineseCatalogue('zh-TW');
    translator.reply = (text) => `[zh-TW] ${text}`;
    await mountPanel();
    button()!.click();
    await vi.waitFor(() => expect(titleText()).toBe(`[zh-TW] ${ITEM.title}`));
    expect(summaryText()).toBe(`[zh-TW] ${ITEM.summary}`);
    expect(translator.calls).toEqual([
      { text: ITEM.title, target: 'zh-TW' },
      { text: ITEM.summary, target: 'zh-TW' },
    ]);
  });

  it('restores the published text on a second press', async () => {
    await mountPanel();
    button()!.click();
    await vi.waitFor(() => expect(titleText()).toBe(`[de] ${ITEM.title}`));

    expect(button()!.getAttribute('aria-label')).toBe('Originaltext wiederherstellen');
    expect(button()!.title).toBe('Originaltext wiederherstellen');
    button()!.click();
    expect(titleText()).toBe(ITEM.title);
    expect(summaryText()).toBe(ITEM.summary);
    expect(button()!.getAttribute('aria-label')).toBe('Übersetzen');
  });

  it('offers separate article and translation controls', async () => {
    await mountPanel();
    const link = card().querySelector('a');
    expect(link?.href).toBe(ITEM.url);
    expect(link?.nextElementSibling).toBe(button());
  });

  it('announces a partial failure and leaves both fields in the published language', async () => {
    translator.reply = (text) => text === ITEM.title ? `[de] ${text}` : null;
    await mountPanel();
    button()!.click();
    const status = card().querySelector('[role="status"]');
    await vi.waitFor(() => expect(status?.textContent).toBe(de.components.newsPanel.translationUnavailable));
    expect(titleText()).toBe(ITEM.title);
    expect(summaryText()).toBe(ITEM.summary);

    translator.reply = (text) => `[de] ${text}`;
    button()!.click();
    await vi.waitFor(() => expect(summaryText()).toBe(`[de] ${ITEM.summary}`));
    expect(status?.textContent).toBe('');
  });

  it('keeps an in-flight translation across a refresh and restores it afterwards', async () => {
    let completeTitle!: (value: string) => void;
    translator.reply = (text) => text === ITEM.title
      ? new Promise((resolve) => { completeTitle = resolve; })
      : `[de] ${text}`;
    const panel = await mountPanel();
    button()!.click();
    expect(button()?.getAttribute('aria-disabled')).toBe('true');

    const refresh = async (headline: string) => {
      listClimateNews.mockResolvedValue({ items: [ITEM, { ...ITEM, title: headline, url: 'https://example.org/other' }] });
      await panel.fetchData();
      await vi.waitFor(() => expect(document.querySelector('.climate-news-list')?.textContent).toContain(headline));
    };
    await refresh('New article');
    expect(button()?.getAttribute('aria-disabled')).toBe('true');
    completeTitle(`[de] ${ITEM.title}`);
    await vi.waitFor(() => expect(summaryText()).toBe(`[de] ${ITEM.summary}`));

    await refresh('Another new article');
    expect(titleText()).toBe(`[de] ${ITEM.title}`);
    expect(summaryText()).toBe(`[de] ${ITEM.summary}`);
    expect(translator.calls).toHaveLength(2);
    button()!.click();
    expect(titleText()).toBe(ITEM.title);
    expect(summaryText()).toBe(ITEM.summary);
  });

  it('renders the exact German relative timestamp', async () => {
    await mountPanel();
    expect(card().querySelector('.climate-news-card__time')?.textContent).toBe('vor 2 Stunden');
  });
});

describe('Climate News translation is a Pro feature', () => {
  it('offers no control to a free reader and never calls the translator', async () => {
    access.premium = false;
    await mountPanel();
    expect(card()).not.toBeNull();
    expect(button()).toBeNull();
    expect(card().querySelector('.climate-news-card__time')?.textContent).toBe('vor 2 Stunden');
    expect(translator.calls).toHaveLength(0);
  });

  it('offers the control once Pro access resolves after the first render', async () => {
    access.premium = false;
    await mountPanel();
    expect(button()).toBeNull();
    setPremium(true);
    await vi.waitFor(() => expect(button()).not.toBeNull());
    expect(button()!.getAttribute('aria-label')).toBe('Übersetzen');
  });

  it('removes the control and restores the published text when Pro access ends', async () => {
    await mountPanel();
    button()!.click();
    await vi.waitFor(() => expect(titleText()).toBe(`[de] ${ITEM.title}`));
    setPremium(false);
    await vi.waitFor(() => expect(button()).toBeNull());
    expect(titleText()).toBe(ITEM.title);
    expect(summaryText()).toBe(ITEM.summary);
  });

  it('restores the published text when Pro access ends and returns within one render', async () => {
    await mountPanel();
    button()!.click();
    await vi.waitFor(() => expect(titleText()).toBe(`[de] ${ITEM.title}`));
    setPremium(false);
    setPremium(true);
    await vi.waitFor(() => expect(button()?.getAttribute('aria-label')).toBe('Übersetzen'));
    expect(titleText()).toBe(ITEM.title);
    expect(summaryText()).toBe(ITEM.summary);

    translator.calls.length = 0;
    button()!.click();
    await vi.waitFor(() => expect(translator.calls).toHaveLength(2));
    expect(translator.calls[0]!.text).toBe(ITEM.title);
  });

  it('discards a translation that completes after Pro access ends', async () => {
    let completeTitle!: (value: string) => void;
    translator.reply = (text) => text === ITEM.title
      ? new Promise((resolve) => { completeTitle = resolve; })
      : `[de] ${text}`;
    await mountPanel();
    button()!.click();
    setPremium(false);
    await vi.waitFor(() => expect(button()).toBeNull());
    completeTitle(`[de] ${ITEM.title}`);
    setPremium(true);
    await vi.waitFor(() => expect(button()?.getAttribute('aria-label')).toBe('Übersetzen'));
    expect(titleText()).toBe(ITEM.title);
    expect(summaryText()).toBe(ITEM.summary);
  });

  it('stops listening for access changes once destroyed', async () => {
    const panel = await mountPanel();
    expect(access.listeners.size).toBeGreaterThan(0);
    panel.destroy();
    expect(access.listeners.size).toBe(0);
  });
});
