import { getLocale, t } from '@/services/i18n';
import { escapeHtml } from '@/utils/sanitize';
import { sparklineSpanLabel, type SparklineSpan } from '@/utils/sparkline-span';

/** The time a quote sparkline covers ("24h", "since Sun 23:00 UTC"), or "" when unknown. */
export function sparklineSpanText(quote: SparklineSpan): string {
  return sparklineSpanLabel(quote, {
    locale: getLocale(),
    since: (date) => t('components.deckgl.tooltip.sinceDate', { date }),
  });
}

/** The same label as a line to place under the sparkline, or "" when unknown. */
export function sparklineSpanHtml(quote: SparklineSpan): string {
  const label = sparklineSpanText(quote);
  return label ? `<div class="commodity-span">${escapeHtml(label)}</div>` : '';
}
