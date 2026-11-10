import { getLocale, t } from '@/services/i18n';
import { escapeHtml } from '@/utils/sanitize';
import { sparklineSpanLabel, type SparklineSpan } from '@/utils/sparkline-span';

/** The time a quote sparkline covers, as a line to place under it, or "" when unknown. */
export function sparklineSpanHtml(quote: SparklineSpan): string {
  const label = sparklineSpanLabel(quote, {
    locale: getLocale(),
    since: (date) => t('components.deckgl.tooltip.sinceDate', { date }),
  });
  return label ? `<div class="commodity-span">${escapeHtml(label)}</div>` : '';
}
