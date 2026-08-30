import {
  computeCredibilityScore,
  describePropagandaBadge,
  getSourcePropagandaRisk,
  getSourceTier,
  getSourceTierBadgeTitle,
  getSourceType,
  resolveRegisteredTelegramSourceName,
  resolveTelegramSourceName,
} from '@/config/feeds';
import { escapeHtml } from '@/utils/sanitize';

export { resolveRegisteredTelegramSourceName, resolveTelegramSourceName };

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

export function resolveCredibilityScore(
  sourceName: string,
  item?: { credibilityScore?: number; corroborationCount?: number },
): number {
  if (item && Number.isFinite(item.credibilityScore)) {
    return Math.round(item.credibilityScore as number);
  }
  return computeCredibilityScore({
    sourceTier: getSourceTier(sourceName),
    propagandaRisk: getSourcePropagandaRisk(sourceName).risk,
    independentCorroborationCount: item?.corroborationCount ?? 1,
  });
}

/**
 * Compact 0-100 credibility badge. Distinct from the event-risk badge:
 * this is source reliability, not newsworthiness.
 */
export function renderCredibilityBadge(
  sourceName: string,
  item?: { credibilityScore?: number; corroborationCount?: number },
): string {
  const score = resolveCredibilityScore(sourceName, item);
  const band = score < 40 ? 'low' : score < 70 ? 'medium' : 'high';
  const title = `Credibility ${score}/100 — source reliability, not newsworthiness. State-controlled media scores low even when the story is highly newsworthy.`;
  return `<span class="credibility-score-badge band-${band}" title="${escapeHtml(title)}">CRED ${score}</span>`;
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
