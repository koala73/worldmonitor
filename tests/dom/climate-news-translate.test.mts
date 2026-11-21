// #10054: Climate News cards rendered source headlines and summaries with no
// way to read them in the UI language, while the neighbouring News panel has
// had a per-headline translate control for a long time. The panel also
// hard-coded English relative times ("2h ago") into every locale.
//
// These cards are wrapped in an <a> when the item carries a URL, so the
// control has to suppress navigation as well as act.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const lang = vi.hoisted(() => ({ current: 'de', tag: 'de-DE' }));
const translator = vi.hoisted(() => ({
  calls: [] as Array<{ text: string; target: string }>,
  reply: (text: string) => `[de] ${text}`,
}));

vi.mock('@/services/i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/i18n')>();
  return {
    ...actual,
    getCurrentLanguage: () => lang.current,
    getCurrentLanguageTag: () => lang.tag,
  };
});

vi.mock('@/services/summarization', () => ({
  translateText: async (text: string, target: string) => {
    translator.calls.push({ text, target });
    return translator.reply(text);
  },
}));

vi.mock('@/services/bootstrap', () => ({ getHydratedData: () => undefined }));

const listClimateNews = vi.hoisted(() => vi.fn());
vi.mock('@/services/generated-rpc-clients', () => ({
  ClimateServiceClient: class { listClimateNews = listClimateNews; },
}));

import { ClimateNewsPanel } from '@/components/ClimateNewsPanel';

const ITEM = {
  title: 'Arctic sea ice hits a record low',
  summary: 'Researchers report the lowest winter maximum in the satellite record.',
  sourceName: 'Carbon Brief',
  url: 'https://example.org/arctic',
  publishedAt: Date.now() - 2 * 60 * 60 * 1000,
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
const button = () => document.querySelector<HTMLElement>('.climate-news-card__translate');
const titleText = () => document.querySelector('.climate-news-card__title')!.textContent;
const summaryText = () => document.querySelector('.climate-news-card__summary')!.textContent;

beforeEach(() => {
  lang.current = 'de';
  lang.tag = 'de-DE';
  translator.calls.length = 0;
  translator.reply = (text: string) => `[de] ${text}`;
  document.body.innerHTML = '';
});

afterEach(() => { vi.clearAllMocks(); });

describe('Climate News translate control (#10054)', () => {
  it('offers the control when the UI language is not English', async () => {
    await mountPanel();
    expect(button()).not.toBeNull();
    expect(button()!.textContent).toBe('文');
  });

  it('does not offer it to an English reader, whose feed is already English', async () => {
    lang.current = 'en';
    lang.tag = 'en-US';
    await mountPanel();
    expect(document.querySelector('.climate-news-card')).not.toBeNull();
    expect(button()).toBeNull();
  });

  it('translates the title and the summary into the UI language on request', async () => {
    await mountPanel();
    button()!.click();
    await vi.waitFor(() => expect(titleText()).toBe(`[de] ${ITEM.title}`));
    expect(summaryText()).toContain('[de]');
    // The full tag, so a zh reader is not handed Simplified for Traditional.
    expect(translator.calls.every((call) => call.target === 'de-DE')).toBe(true);
  });

  it('restores the published text on a second press', async () => {
    await mountPanel();
    button()!.click();
    await vi.waitFor(() => expect(titleText()).toBe(`[de] ${ITEM.title}`));

    button()!.click();
    expect(titleText()).toBe(ITEM.title);
    expect(summaryText()).toBe(
      document.querySelector('.climate-news-card__summary')!.textContent,
    );
    expect(button()!.textContent).toBe('文');
  });

  it('never navigates the card it sits inside', async () => {
    await mountPanel();
    expect(card().tagName).toBe('A');
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    button()!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('leaves the card in its published language when a translation fails', async () => {
    translator.reply = () => null as unknown as string;
    await mountPanel();
    button()!.click();
    await vi.waitFor(() => expect(button()!.textContent).toBe('文'));
    // All or nothing: a half-translated card reads as a source that mixed
    // languages rather than a translation that partly failed.
    expect(titleText()).toBe(ITEM.title);
    expect(button()!.classList.contains('translated')).toBe(false);
  });

  it('renders the timestamp through the localized formatter, not English literals', async () => {
    await mountPanel();
    const time = document.querySelector('.climate-news-card__time')!.textContent ?? '';
    expect(time).not.toMatch(/\d+[mhd] ago|just now/);
    expect(time.length).toBeGreaterThan(0);
  });
});
