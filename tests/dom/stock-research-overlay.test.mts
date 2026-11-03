/**
 * Behavioral coverage for the stock research overlay.
 *
 * `tests/stock-workspace-route.test.mts` covers the pure route helpers only.
 * Nothing exercised the overlay itself, so the premium gate, the headline
 * sanitization, the Back handling and the error branch were all unverified —
 * and the PR's one manual check ("open /stocks/AAPL on a local dashboard") was
 * never run.
 *
 * `sanitizeUrl` is deliberately NOT mocked: whether a hostile headline link
 * reaches the rendered href is the behaviour under test. Only the RPC client
 * and the entitlement lookup are stubbed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hasPremiumAccess = vi.fn<() => boolean>(() => true);
const analyzeStock = vi.fn();

vi.mock('@/services/panel-gating', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/panel-gating')>()),
  hasPremiumAccess: () => hasPremiumAccess(),
}));

vi.mock('@/services/generated-rpc-clients', () => ({
  MarketServiceClient: class {
    analyzeStock(...args: unknown[]) {
      return analyzeStock(...args);
    }
  },
}));

vi.mock('@/services/premium-fetch', () => ({ premiumFetch: vi.fn() }));
vi.mock('@/services/rpc-client', () => ({ getRpcBaseUrl: () => 'https://rpc.test' }));

const {
  closeStockResearchOverlay,
  navigateToStockResearch,
  openStockResearchOverlay,
} = await import('@/features/stock-research/stock-research-overlay');

function analysis(headlines: Array<Record<string, unknown>> = []) {
  return {
    available: true,
    fallback: false,
    provider: 'openrouter',
    model: '',
    ratingSummary: 'Rating summary',
    summary: 'Summary',
    newsSentiment: 0.25,
    headlines,
  };
}

const overlay = () => document.querySelector('.stock-research-overlay');
const analyzeSection = () => document.querySelector('.stock-research-analyze') as HTMLElement | null;

beforeEach(() => {
  hasPremiumAccess.mockReturnValue(true);
  analyzeStock.mockReset();
  analyzeStock.mockResolvedValue(analysis());
  document.body.replaceChildren();
  window.history.replaceState({}, '', '/dashboard');
});

afterEach(() => {
  closeStockResearchOverlay();
  document.body.replaceChildren();
});

describe('stock research overlay premium gate', () => {
  it('renders the locked state and never calls the premium RPC', async () => {
    hasPremiumAccess.mockReturnValue(false);
    await openStockResearchOverlay('AAPL');

    expect(analyzeSection()?.dataset.analyzeState).toBe('locked');
    expect(analyzeStock).not.toHaveBeenCalled();
    // No analysis value may reach the DOM in the locked state, including via
    // attributes rather than visible text.
    expect(document.body.innerHTML).not.toContain('Rating summary');
  });

  it('drives loading -> ready and renders the analysis for an entitled user', async () => {
    await openStockResearchOverlay('AAPL');
    expect(analyzeStock).toHaveBeenCalledTimes(1);
    expect(analyzeSection()?.dataset.analyzeState).toBe('ready');
    expect(analyzeSection()?.textContent).toContain('Rating summary');
  });

  it('flips to the error state when the RPC rejects', async () => {
    analyzeStock.mockRejectedValue(new Error('boom'));
    await openStockResearchOverlay('AAPL');
    expect(analyzeSection()?.dataset.analyzeState).toBe('error');
    expect(analyzeSection()?.textContent).toContain('unavailable');
  });

  it('surfaces a timeout instead of sitting on the loading state forever', async () => {
    // A timeout arrives as an AbortError, same as our own teardown. Only the
    // teardown may be swallowed — swallowing both strands the overlay on
    // "Loading analysis…" with no way out.
    analyzeStock.mockRejectedValue(
      Object.assign(new DOMException('The operation was aborted.', 'AbortError')),
    );
    await openStockResearchOverlay('AAPL');
    expect(analyzeSection()?.dataset.analyzeState).toBe('error');
  });

  it('stays silent when the overlay is torn down mid-request', async () => {
    let rejectFirst: ((reason: unknown) => void) | undefined;
    analyzeStock.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectFirst = reject; }));
    const pending = openStockResearchOverlay('AAPL');

    closeStockResearchOverlay();
    rejectFirst?.(new DOMException('The operation was aborted.', 'AbortError'));
    await pending;

    // The overlay is gone; nothing should have been rendered into a detached node.
    expect(overlay()).toBeNull();
  });
});

describe('stock research overlay headline sanitization', () => {
  it('drops a javascript: headline link instead of rendering it as an href', async () => {
    analyzeStock.mockResolvedValue(analysis([
      { title: 'Poisoned', source: 'Wire', link: 'javascript:alert(1)', alignedTradingDate: '' },
    ]));
    await openStockResearchOverlay('AAPL');

    const anchors = [...document.querySelectorAll('.stock-research-news a')];
    for (const anchor of anchors) {
      expect(anchor.getAttribute('href') ?? '').not.toMatch(/^javascript:/i);
    }
    // The headline text still renders; only the unusable link is dropped.
    expect(analyzeSection()?.textContent).toContain('Poisoned');
  });

  it('keeps an ordinary https headline link clickable', async () => {
    analyzeStock.mockResolvedValue(analysis([
      { title: 'Real', source: 'Wire', link: 'https://example.com/a', alignedTradingDate: '' },
    ]));
    await openStockResearchOverlay('AAPL');

    const anchor = document.querySelector('.stock-research-news a');
    expect(anchor?.getAttribute('href')).toContain('https://example.com/a');
  });
});

describe('stock research overlay tape claim', () => {
  it('renders no tape badge while quote provenance is unknown', async () => {
    await openStockResearchOverlay('AAPL');
    // A badge here would be a confident claim about a quote this surface
    // cannot classify (ListMarketQuotes is seed-first).
    expect(document.querySelector('.stock-research-tape')).toBeNull();
  });
});

describe('stock research overlay history handling', () => {
  it('closes on browser Back instead of stranding a focus-trapped modal', async () => {
    navigateToStockResearch('AAPL');
    await vi.waitFor(() => expect(overlay()).not.toBeNull());
    expect(window.location.pathname).toBe('/stocks/AAPL');

    window.history.back();
    await vi.waitFor(() => {
      expect(window.location.pathname).not.toBe('/stocks/AAPL');
      expect(overlay()).toBeNull();
    });
  });

  it('returns to the originating URL on close, not to the marketing root', async () => {
    window.history.replaceState({}, '', '/dashboard?panel=markets');
    navigateToStockResearch('AAPL');
    await vi.waitFor(() => expect(overlay()).not.toBeNull());

    closeStockResearchOverlay();
    expect(window.location.pathname).toBe('/dashboard');
    expect(overlay()).toBeNull();
  });

  it('preserves history.state so a sibling overlay keeps its Back marker', async () => {
    window.history.replaceState({ __wmOverlay: { id: 'settings', token: 't1' } }, '', '/dashboard');
    navigateToStockResearch('AAPL');
    await vi.waitFor(() => expect(overlay()).not.toBeNull());

    closeStockResearchOverlay();
    expect((window.history.state as Record<string, unknown> | null)?.__wmOverlay)
      .toEqual({ id: 'settings', token: 't1' });
  });
});

describe('stock research overlay overlapping opens', () => {
  it('lets the newest open win when a stale request resolves later', async () => {
    let resolveFirst: ((value: unknown) => void) | undefined;
    analyzeStock
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce({ ...analysis(), ratingSummary: 'SECOND' });

    const first = openStockResearchOverlay('AAPL');
    await openStockResearchOverlay('MSFT');
    expect(analyzeSection()?.textContent).toContain('SECOND');

    // The superseded response must not paint over the live overlay.
    resolveFirst?.({ ...analysis(), ratingSummary: 'FIRST' });
    await first;
    expect(analyzeSection()?.textContent).toContain('SECOND');
    expect(analyzeSection()?.textContent).not.toContain('FIRST');
  });
});

describe('stock research overlay discloses AI-vs-template provenance (#5498)', () => {
  const provenance = () => analyzeSection()?.querySelector('[data-analysis-provenance]') as HTMLElement | null;

  it('labels a rules-based fallback template as such, above the summary', async () => {
    analyzeStock.mockResolvedValue({ ...analysis(), provider: 'rules', fallback: true, model: '' });
    await openStockResearchOverlay('AAPL');

    expect(analyzeSection()?.dataset.analysisProvenance).toBe('rules-fallback');
    expect(provenance()?.dataset.analysisProvenance).toBe('rules-fallback');
    expect(provenance()?.textContent).toContain('Rules-based template');
    // The disclosure precedes the prose it qualifies.
    const section = analyzeSection()!;
    const order = [...section.querySelectorAll('p')].map((p) => p.textContent ?? '');
    expect(order.findIndex((t) => t.includes('Rules-based template'))).toBeLessThan(order.findIndex((t) => t.includes('Rating summary')));
  });

  it('treats provider "rules" as a fallback even if the flag is missing', async () => {
    analyzeStock.mockResolvedValue({ ...analysis(), provider: 'rules', fallback: undefined });
    await openStockResearchOverlay('AAPL');
    expect(analyzeSection()?.dataset.analysisProvenance).toBe('rules-fallback');
  });

  it('labels the full-template response after blank model rating summaries as rules (#9338)', async () => {
    const ratingSummary = 'BABA screens as hold with a bullish setup and a 60/100 score.';
    analyzeStock.mockResolvedValue({
      ...analysis(),
      provider: 'rules',
      model: '',
      fallback: true,
      ratingSummary,
      summary: 'BABA screens as buy with a bullish setup and a 70/100 score.',
      newsSentiment: undefined,
    });
    await openStockResearchOverlay('BABA');

    expect(provenance()?.dataset.analysisProvenance).toBe('rules-fallback');
    expect(provenance()?.textContent).toContain('Rules-based template');
    expect(provenance()?.textContent).not.toMatch(/AI commentary ·/);
    expect(analyzeSection()?.querySelectorAll('p')[1]?.textContent).toBe(ratingSummary);
    expect(analyzeSection()?.querySelector('[data-news-overlay]')).toBeNull();
  });

  it('labels a recovered provider rating summary as model commentary (#9338)', async () => {
    analyzeStock.mockResolvedValue({
      ...analysis(),
      provider: 'generic',
      model: 'test-recovery-model',
      ratingSummary: 'Model rating summary.',
      summary: 'Model technical summary.',
    });
    await openStockResearchOverlay('BABA');

    expect(provenance()?.dataset.analysisProvenance).toBe('model');
    expect(provenance()?.textContent).toContain('AI commentary · generic (test-recovery-model)');
    expect(analyzeSection()?.querySelectorAll('p')[1]?.textContent).toBe('Model rating summary.');
    expect(analyzeSection()?.textContent).not.toContain('Rules-based template');
  });

  it('labels model-generated commentary with its provider and model', async () => {
    analyzeStock.mockResolvedValue({ ...analysis(), provider: 'openrouter', model: 'meta-llama/llama-3.3-70b', fallback: false });
    await openStockResearchOverlay('AAPL');

    expect(analyzeSection()?.dataset.analysisProvenance).toBe('model');
    expect(provenance()?.textContent).toContain('AI commentary');
    expect(provenance()?.textContent).toContain('openrouter');
    expect(provenance()?.textContent).toContain('meta-llama/llama-3.3-70b');
    expect(analyzeSection()?.textContent).not.toContain('Rules-based template');
  });

  it('escapes provider and model strings', async () => {
    analyzeStock.mockResolvedValue({ ...analysis(), provider: '<img src=x onerror=alert(1)>', model: '</p><script>1</script>', fallback: false });
    await openStockResearchOverlay('AAPL');

    expect(analyzeSection()?.querySelector('img, script')).toBeNull();
    expect(provenance()?.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('renders an unavailable state, not a template label, when the server computed nothing', async () => {
    // buildEmptyAnalysisResponse: Yahoo history timeout, a no-history symbol,
    // or an empty symbol. It carries fallback: true, but no indicators were
    // computed, so "assembled from the indicators" would be false.
    analyzeStock.mockResolvedValue({
      available: false,
      fallback: true,
      provider: '',
      model: '',
      summary: '',
      ratingSummary: '',
      headlines: [],
    });
    await openStockResearchOverlay('AAPL');

    expect(analyzeSection()?.dataset.analyzeState).toBe('unavailable');
    expect(analyzeSection()?.dataset.analysisProvenance).toBeUndefined();
    expect(document.querySelector('[data-analysis-provenance]')).toBeNull();
    expect(analyzeSection()?.textContent).not.toContain('Rules-based template');
    expect(analyzeSection()?.textContent).not.toContain('No analysis summary.');
    expect(analyzeSection()?.textContent).toContain('No analysis is available for AAPL right now.');
  });

  it('renders no provenance line in the locked or error states', async () => {
    hasPremiumAccess.mockReturnValue(false);
    await openStockResearchOverlay('AAPL');
    expect(document.querySelector('[data-analysis-provenance]')).toBeNull();
    closeStockResearchOverlay();

    hasPremiumAccess.mockReturnValue(true);
    analyzeStock.mockRejectedValue(new Error('boom'));
    await openStockResearchOverlay('AAPL');
    expect(document.querySelector('[data-analysis-provenance]')).toBeNull();
  });
});

describe('stock research overlay chart width', () => {
  const stock = {
    symbol: 'AAPL',
    name: 'Apple Inc.',
    display: 'AAPL',
    price: 231.42,
    change: 1.18,
    sparkline: [220, 222, 221, 224, 226, 231.42],
  };
  const chartSvg = () => document.querySelector('.stock-research-chart svg');

  function stubChartHostWidth(width: number) {
    // happy-dom has no layout; give only the chart host a measured width.
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get(this: HTMLElement) {
        return this.classList.contains('stock-research-chart') ? width : 0;
      },
    });
    return () => {
      if (original) Object.defineProperty(HTMLElement.prototype, 'clientWidth', original);
    };
  }

  it('renders the chart at the room width on a narrow screen so labels keep their size', async () => {
    const restore = stubChartHostWidth(296);
    try {
      await openStockResearchOverlay('AAPL', stock);
      expect(chartSvg()?.getAttribute('width')).toBe('296');
      expect(chartSvg()?.getAttribute('aria-label')).toBe('AAPL price chart');
    } finally {
      restore();
    }
  });

  it('caps the chart at 640px when the room is wider', async () => {
    const restore = stubChartHostWidth(874);
    try {
      await openStockResearchOverlay('AAPL', stock);
      expect(chartSvg()?.getAttribute('width')).toBe('640');
    } finally {
      restore();
    }
  });

  it('falls back to 640px when the room has no measured width', async () => {
    await openStockResearchOverlay('AAPL', stock);
    expect(chartSvg()?.getAttribute('width')).toBe('640');
  });

  it('keeps the no-series message when there is nothing to plot', async () => {
    await openStockResearchOverlay('AAPL', { ...stock, sparkline: [231.42] });
    expect(chartSvg()).toBeNull();
    expect(document.querySelector('.stock-research-chart')?.textContent).toContain('No plottable Yahoo series');
  });
});
