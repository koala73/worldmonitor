import {
  describePropagandaBadge,
  getSourcePropagandaRisk,
  getSourceTier,
  getSourceTierBadgeTitle,
  getSourceType,
} from '@/config/feeds';
import { escapeHtml } from '@/utils/sanitize';

export interface PrimarySourceProvenanceHtml {
  riskBadge: string;
  tierBadge: string;
}

/**
 * Render the exact provenance badges used beside a cluster's primary source.
 * Kept as a pure helper so fail-closed output can be regression-tested without
 * constructing the full virtualized NewsPanel component.
 */
export function renderPrimarySourceProvenance(sourceName: string): PrimarySourceProvenanceHtml {
  const sourceType = getSourceType(sourceName);
  const riskDescription = describePropagandaBadge(getSourcePropagandaRisk(sourceName), sourceType);
  const riskBadge = riskDescription
    ? `<span class="propaganda-badge ${riskDescription.risk}" title="${escapeHtml(riskDescription.title)}">${riskDescription.label}</span>`
    : '';

  const tier = getSourceTier(sourceName);
  const tierLabel = tier === 1 && sourceType === 'wire' ? ' Wire' : '';
  const tierBadge = tier <= 2
    ? `<span class="tier-badge tier-${tier}" title="${escapeHtml(getSourceTierBadgeTitle(sourceType))}">${tier === 1 ? '★' : '●'}${tierLabel}</span>`
    : '';

  return { riskBadge, tierBadge };
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
