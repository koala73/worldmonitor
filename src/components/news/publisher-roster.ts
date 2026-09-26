import { declaredSourceTier } from '@/config/feeds';
import { t } from '@/services/i18n';
import {
  TIER_DOCS_HREF,
  type Corroboration,
  type DeclaredTier,
  type PublisherRoster,
} from '@/utils/corroboration-flag';
import { h } from '@/utils/dom-utils';
import { escapeHtml } from '@/utils/sanitize';
import { mostSevereRiskBadge, type SourceProvenanceBadge } from './source-provenance';

export type TierChip = { readonly label: string; readonly title: string; readonly className: string };

export type PublisherRosterRow = {
  readonly name: string;
  readonly chip: TierChip;
  /** Every feed label seen for this publisher with its own declared tier, so the chip traces to a label. */
  readonly feeds: string;
  readonly risk: SourceProvenanceBadge | null;
};

export type PublisherRosterView = {
  readonly summary: string;
  readonly rows: readonly PublisherRosterRow[];
  readonly legend: string;
  readonly docsLabel: string;
  readonly docsHref: string;
};

export function tierChip(tier: DeclaredTier | null): TierChip {
  return tier === null
    ? {
      label: t('components.corroboration.tierChipUndeclared'),
      title: t('components.corroboration.tierTitleUndeclared'),
      className: 'tier-chip tier-none',
    }
    : {
      label: t('components.corroboration.tierChip', { tier }),
      title: t(`components.corroboration.tierTitle${tier}`),
      className: `tier-chip tier-${tier}`,
    };
}

/** null when there is nothing to list: unknown, or single-publisher, where the pill and the row already name the source. */
export function describePublisherRoster(c: Corroboration, roster: PublisherRoster): PublisherRosterView | null {
  if (c.state === 'unknown' || c.state === 'single-publisher' || roster.length === 0) return null;
  const tier1 = roster.filter((publisher) => publisher.tier === 1).length;
  const publishers = t('components.corroboration.rosterPublishers', { count: c.publishers });
  const reported = tier1 > 0
    ? t('components.corroboration.rosterSummaryTier1', { publishers, tier1 })
    : t('components.corroboration.rosterSummary', { publishers });
  const summary = c.publishers > roster.length
    ? `${reported} ${t('components.corroboration.rosterListed', { listed: roster.length })}`
    : reported;
  return {
    summary,
    rows: roster.map((publisher) => ({
      name: publisher.name,
      chip: tierChip(publisher.tier),
      feeds: t('components.corroboration.rosterFeeds', {
        labels: publisher.labels.map((label) => `${label} (${tierChip(declaredSourceTier(label)).label})`).join(', '),
      }),
      risk: mostSevereRiskBadge(publisher.labels),
    })),
    legend: t('components.corroboration.rosterLegend'),
    docsLabel: t('components.corroboration.tierDocsLink'),
    docsHref: TIER_DOCS_HREF,
  };
}

const badgeHtml = (badge: { className: string; title: string; label: string }) =>
  `<span class="${escapeHtml(badge.className)}" title="${escapeHtml(badge.title)}">${escapeHtml(badge.label)}</span>`;

export function renderPublisherRosterHtml(view: PublisherRosterView): string {
  const rows = view.rows.map((row) => '<li>'
    + `<span class="publisher-name">${escapeHtml(row.name)}</span>${badgeHtml(row.chip)}${row.risk ? badgeHtml(row.risk) : ''}`
    + `<span class="publisher-feeds">${escapeHtml(row.feeds)}</span></li>`).join('');
  return `<details class="publisher-roster"><summary>${escapeHtml(view.summary)}</summary><ol>${rows}</ol>`
    + `<p class="tier-legend">${escapeHtml(view.legend)} `
    + `<a href="${escapeHtml(view.docsHref)}" target="_blank" rel="noopener noreferrer">${escapeHtml(view.docsLabel)}</a></p></details>`;
}

/** The same markup as renderPublisherRosterHtml, built as nodes for DOM-builder panels. */
export function renderPublisherRosterElement(view: PublisherRosterView): HTMLElement {
  const badge = (b: { className: string; title: string; label: string }) => h('span', { className: b.className, title: b.title }, b.label);
  return h('details', { className: 'publisher-roster' },
    h('summary', null, view.summary),
    h('ol', null, ...view.rows.map((row) => h('li', null,
      h('span', { className: 'publisher-name' }, row.name),
      badge(row.chip),
      row.risk ? badge(row.risk) : null,
      h('span', { className: 'publisher-feeds' }, row.feeds)))),
    h('p', { className: 'tier-legend' }, `${view.legend} `,
      h('a', { href: view.docsHref, target: '_blank', rel: 'noopener noreferrer' }, view.docsLabel)));
}
