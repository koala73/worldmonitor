import { describe, expect, it } from 'vitest';
import { completedRetailersStatement, RESUME_WINDOW_HOURS, retailersToScrape } from './scrape-resume.js';

// A deploy that lands mid-scrape stops the container (seed-consumer-prices,
// 2026-10-24 02:09Z): retailers that finished keep their terminal run, the
// rest are left at status='running'. The next cron tick of the same day must
// scrape only the retailers that never reached a terminal run.
describe('retailersToScrape', () => {
  const configs = [
    { slug: 'carrefour_ae', enabled: true },
    { slug: 'coles_au', enabled: true },
    { slug: 'kroger_us', enabled: true },
    { slug: 'waitrose_gb', enabled: true },
    { slug: 'old_retailer', enabled: false },
  ];

  it('skips retailers with a completed or partial run in this cycle', () => {
    const done = new Set(['carrefour_ae', 'kroger_us']);
    expect(retailersToScrape(configs, done).map((c) => c.slug)).toEqual(['coles_au', 'waitrose_gb', 'old_retailer']);
  });

  it('scrapes every retailer when nothing has finished yet', () => {
    expect(retailersToScrape(configs, new Set()).map((c) => c.slug)).toEqual(configs.map((c) => c.slug));
  });

  it('keeps disabled retailers so their active flag still syncs to the database', () => {
    const done = new Set(configs.map((c) => c.slug));
    expect(retailersToScrape(configs, done).map((c) => c.slug)).toEqual(['old_retailer']);
  });
});

describe('completedRetailersStatement', () => {
  it('counts only completed and partial runs inside the resume window', () => {
    const { sql, params } = completedRetailersStatement();
    expect(sql).toMatch(/status IN \('completed', 'partial'\)/);
    expect(sql).not.toMatch(/'running'|'failed'/);
    expect(sql).toMatch(/started_at > NOW\(\) - make_interval\(hours => \$1\)/);
    expect(params).toEqual([RESUME_WINDOW_HOURS]);
  });

  // The cycle's ticks run 02:00-05:00 UTC, so a run can start as late as about
  // 05:15. The window must cover the whole same-day cycle and still expire
  // before the next day's 02:00 tick, or a retailer would never scrape again.
  it('spans one cycle and ends before the next one starts', () => {
    expect(RESUME_WINDOW_HOURS).toBeGreaterThanOrEqual(4);
    expect(RESUME_WINDOW_HOURS).toBeLessThan(24 - 3.25);
  });
});
