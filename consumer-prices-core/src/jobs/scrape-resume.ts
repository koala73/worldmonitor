// The daily scrape runs on several cron ticks (02:00-05:00 UTC). A tick only
// scrapes the retailers that have no terminal run in this cycle, so a deploy
// that stops the container mid-scrape costs one tick, not the day's data.
// 20h covers every tick of one cycle and expires before the next day's 02:00.
export const RESUME_WINDOW_HOURS = 20;

export function completedRetailersStatement(windowHours = RESUME_WINDOW_HOURS) {
  return {
    sql: `SELECT DISTINCT r.slug
     FROM scrape_runs sr
     JOIN retailers r ON r.id = sr.retailer_id
     WHERE sr.status IN ('completed', 'partial')
       AND sr.started_at > NOW() - make_interval(hours => $1)`,
    params: [windowHours],
  };
}

// Disabled retailers stay in the list: scrapeRetailer syncs their active flag
// to the database before returning.
export function retailersToScrape<T extends { slug: string; enabled: boolean }>(
  configs: T[],
  completedSlugs: ReadonlySet<string>,
): T[] {
  return configs.filter((config) => !config.enabled || !completedSlugs.has(config.slug));
}
