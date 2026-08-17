/**
 * The two NewsPanel call sites that send a language to the LLM.
 *
 * Separate file from `i18n-zh-tw-behaviour.test.mts` because reaching them
 * needs `@/services` mocked at the module level, and that barrel is on the
 * import path of half the things the other file exercises.
 *
 * What makes these different from the other accessor swaps: the tag is not
 * read here, it is SENT. `translateText(text, lang)` and `generateSummary(…,
 * lang, …)` both put it in front of a model as the language to write in, so a
 * stripped `zh` produces Simplified prose for a Traditional reader no matter
 * how correct the UI around it is. The same value keys the summary cache, so
 * the two scripts have to miss each other's entries as well.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { useChineseCatalogue } from './helpers/i18n.mts';

// Parameters are declared so the assertions below can index the recorded call
// by position — `vi.fn(async () => …)` records an empty tuple type.
const translateText = vi.fn(async (_text: string, _targetLang: string) => '翻譯結果');
const generateSummary = vi.fn(
  async (_headlines: string[], _onProgress: undefined, _panelId: string, _lang: string, _options?: unknown) =>
    ({ summary: '摘要', provider: 'test', model: 'test', cached: false }),
);

// A full stub rather than `importOriginal`: the real barrel starts workers and
// network clients on import, none of which these two paths touch.
vi.mock('@/services', () => ({
  analysisWorker: { clusterNews: vi.fn(async () => []) },
  enrichWithVelocityML: vi.fn(async (clusters: unknown) => clusters),
  getClusterAssetContext: vi.fn(() => null),
  MAX_DISTANCE_KM: 100,
  activityTracker: {
    register: vi.fn(),
    unregister: vi.fn(),
    onChange: vi.fn(),
    markAsSeen: vi.fn(),
    markItemsSeen: vi.fn(),
    updateItems: vi.fn(() => []),
    getPreviousVisitTime: vi.fn(() => 0),
    shouldHighlight: vi.fn(() => false),
    isNewItem: vi.fn(() => false),
  },
  generateSummary,
  translateText,
  preloadRelatedAssetTables: vi.fn(async () => {}),
}));

/** The private methods under test, reached without widening the public API. */
interface NewsPanelInternals {
  handleTranslate(element: HTMLElement, text: string): Promise<void>;
  handleSummarize(): Promise<void>;
  currentHeadlines: string[];
  currentBodies: string[];
  lastHeadlineSignature: string;
}

let NewsPanel: typeof import('@/components/NewsPanel')['NewsPanel'];

beforeAll(async () => {
  await useChineseCatalogue('zh-TW');
  ({ NewsPanel } = await import('@/components/NewsPanel'));
});

beforeEach(() => {
  document.body.innerHTML = '';
  localStorage.clear();
  translateText.mockClear();
  generateSummary.mockClear();
});

function newPanel(): NewsPanelInternals {
  const panel = new NewsPanel('news', 'News');
  // Both handlers bail on `!this.element?.isConnected` after the await, which
  // is the guard against writing into a panel the user has since closed.
  document.body.appendChild(panel.getElement());
  return panel as unknown as NewsPanelInternals;
}

/** A headline row shaped the way `handleTranslate` walks it. */
function headlineRow(): HTMLElement {
  const item = document.createElement('div');
  item.className = 'item';
  const title = document.createElement('div');
  title.className = 'item-title';
  title.textContent = 'Sanctions package agreed';
  const button = document.createElement('button');
  button.className = 'item-translate-btn';
  item.append(title, button);
  document.body.appendChild(item);
  return button;
}

describe('headline translation target', () => {
  it('asks for Traditional Chinese, not the stripped code', async () => {
    await useChineseCatalogue('zh-TW');
    const panel = newPanel();

    await panel.handleTranslate(headlineRow(), 'Sanctions package agreed');

    expect(translateText).toHaveBeenCalledWith('Sanctions package agreed', 'zh-TW');
  });

  it('still asks for Simplified when that is the catalogue', async () => {
    await useChineseCatalogue('zh');
    const panel = newPanel();

    await panel.handleTranslate(headlineRow(), 'Sanctions package agreed');

    expect(translateText).toHaveBeenCalledWith('Sanctions package agreed', 'zh');
  });
});

describe('panel summary target and cache key', () => {
  async function summarize(panel: NewsPanelInternals): Promise<void> {
    panel.currentHeadlines = ['Sanctions package agreed', 'Talks resume in Vienna'];
    panel.currentBodies = [];
    panel.lastHeadlineSignature = 'sig-1';
    await panel.handleSummarize();
  }

  it('sends the full tag as the language to write in', async () => {
    await useChineseCatalogue('zh-TW');
    await summarize(newPanel());

    expect(generateSummary).toHaveBeenCalledTimes(1);
    expect(generateSummary.mock.calls[0]?.[3]).toBe('zh-TW');
  });

  it('caches under a key the other script cannot read', async () => {
    await useChineseCatalogue('zh-TW');
    await summarize(newPanel());
    const traditionalKeys = Object.keys(localStorage).filter((k) => k.startsWith('panel_summary_'));

    await useChineseCatalogue('zh');
    generateSummary.mockClear();
    await summarize(newPanel());
    const allKeys = Object.keys(localStorage).filter((k) => k.startsWith('panel_summary_'));

    // The Simplified run must have gone to the model rather than reading the
    // Traditional summary back out of storage.
    expect(generateSummary).toHaveBeenCalledTimes(1);
    expect(traditionalKeys).toHaveLength(1);
    expect(traditionalKeys[0]).toMatch(/_zh-TW$/);
    expect(allKeys).toHaveLength(2);
  });
});
