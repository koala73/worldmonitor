import {
  describePropagandaBadge,
  getSourcePropagandaRisk,
  getSourceTier,
  getSourceTierBadgeTitle,
  getSourceType,
  resolveTelegramSourceName,
} from '@/config/feeds';
import { escapeHtml } from '@/utils/sanitize';

export { resolveTelegramSourceName };

export interface PrimarySourceProvenanceHtml {
  riskBadge: string;
  tierBadge: string;
}

export interface SourceProvenanceBadge {
  className: string;
  title: string;
  label: string;
}

export interface PrimarySourceProvenanceBadges {
  risk: SourceProvenanceBadge | null;
  tier: SourceProvenanceBadge | null;
}

/**
 * Structured provenance badges for a display-name lookup.
 * Shared by the NewsPanel HTML renderer and TelegramIntelPanel DOM renderer
 * so both surfaces stay on the same CSS classes.
 */
export function getPrimarySourceProvenanceBadges(sourceName: string): PrimarySourceProvenanceBadges {
  const sourceType = getSourceType(sourceName);
  const riskDescription = describePropagandaBadge(getSourcePropagandaRisk(sourceName), sourceType);
  const risk = riskDescription
    ? {
      className: `propaganda-badge ${riskDescription.risk}`,
      title: riskDescription.title,
      label: riskDescription.label,
    }
    : null;

  const tier = getSourceTier(sourceName);
  const tierLabel = tier === 1 && sourceType === 'wire' ? ' Wire' : '';
  const tierBadge = tier <= 2
    ? {
      className: `tier-badge tier-${tier}`,
      title: getSourceTierBadgeTitle(sourceType),
      label: `${tier === 1 ? '★' : '●'}${tierLabel}`,
    }
    : null;

  return { risk, tier: tierBadge };
}

/**
 * Render the exact provenance badges used beside a cluster's primary source.
 * Kept as a pure helper so fail-closed output can be regression-tested without
 * constructing the full virtualized NewsPanel component.
 */
export function renderPrimarySourceProvenance(sourceName: string): PrimarySourceProvenanceHtml {
  const { risk, tier } = getPrimarySourceProvenanceBadges(sourceName);
  return {
    riskBadge: risk
      ? `<span class="${risk.className}" title="${escapeHtml(risk.title)}">${risk.label}</span>`
      : '',
    tierBadge: tier
      ? `<span class="${tier.className}" title="${escapeHtml(tier.title)}">${tier.label}</span>`
      : '',
  };
}

/** Render the compact risk marker shown for corroborating sources. */
export function renderCorroboratingSourceRisk(sourceName: string): string {
  const description = describePropagandaBadge(
    getSourcePropagandaRisk(sourceName),
    getSourceType(sourceName),
  );
  return description
    ? `<span class="propaganda-badge ${description.risk}" title="${escapeHtml(description.title)}">${description.shortLabel}</span>`
    : '';
}
