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
