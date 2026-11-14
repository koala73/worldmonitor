import type { ImageryChangeContext } from '@/generated/client/worldmonitor/intelligence/v1/service_client';

export const IMAGERY_CONTEXT_EXCLUSION = 'Satellite context only. It is not part of the instability score.';
export const IMAGERY_CONTEXT_METHODOLOGY_HREF = '/docs/methodology/cii-risk-scores#context-shown-beside-the-score';

/** The line shown beside a country's score, or null when no watched site has a confirmed change. */
export function imageryChangeSummary(context: ImageryChangeContext | null | undefined): string | null {
  const sites = context?.confirmedSites ?? [];
  if (sites.length === 0) return null;
  const named = sites.map((site) => `${site.name} (confirmed ${new Date(site.confirmedAt).toISOString().slice(0, 10)})`).join('; ');
  return `Imagery statistics changed at ${sites.length} of ${context!.watchedSiteCount} watched sites: ${named}.`;
}
