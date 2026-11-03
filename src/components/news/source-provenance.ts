import {
  PERSPECTIVE_LABEL_CAVEAT,
  composeProvenanceSummary,
  computeCredibilityScore,
  describePropagandaBadge,
  getProvenanceFacts,
  getSourcePropagandaRisk,
  getSourceTier,
  getSourceTierBadgeTitle,
  getSourceType,
  resolveRegisteredTelegramSourceName,
  resolveTelegramSourceName,
} from '@/config/feeds';
import type { PropagandaRisk } from '@/types';
import { escapeHtml } from '@/utils/sanitize';

export { resolveRegisteredTelegramSourceName, resolveTelegramSourceName };

export interface PrimarySourceProvenanceHtml {
  riskBadge: string;
  tierBadge: string;
  facts: string;
}

export interface SourceProvenanceBadge {
  className: string;
  title: string;
  label: string;
}

export interface PrimarySourceProvenanceBadges {
  risk: SourceProvenanceBadge | null;
  tier: SourceProvenanceBadge | null;
  facts: SourceProvenanceBadge[];
}

/**
 * Structured provenance badges for a display-name lookup.
 * Shared by the NewsPanel HTML renderer and TelegramIntelPanel DOM renderer
 * so both surfaces stay on the same CSS classes.
 */
export function getPrimarySourceProvenanceBadges(sourceName: string): PrimarySourceProvenanceBadges {
  const sourceType = getSourceType(sourceName);
  const profile = getSourcePropagandaRisk(sourceName);
  const riskDescription = describePropagandaBadge(profile, sourceType);
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

  const factTitle = `${composeProvenanceSummary(profile, sourceType)} ${PERSPECTIVE_LABEL_CAVEAT}`;
  const facts = getProvenanceFacts(profile, sourceType).map((fact) => ({
    className: `provenance-fact ${fact.kind}`,
    title: factTitle,
    label: fact.label,
  }));

  return { risk, tier: tierBadge, facts };
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
  const { risk, tier, facts } = getPrimarySourceProvenanceBadges(sourceName);
  return {
    riskBadge: risk
      ? `<span class="${risk.className}" title="${escapeHtml(risk.title)}">${escapeHtml(risk.label)}</span>`
      : '',
    tierBadge: tier
      ? `<span class="${tier.className}" title="${escapeHtml(tier.title)}">${tier.label}</span>`
      : '',
    facts: facts
      .map((fact) => `<span class="${fact.className}" title="${escapeHtml(fact.title)}">${escapeHtml(fact.label)}</span>`)
      .join(''),
  };
}

/** A corroborating source's risk marker, ranked so a publisher with several feeds shows its most severe. */
export interface CorroboratingRiskBadge extends SourceProvenanceBadge {
  readonly severity: number;
}

/** State media above caution above unreviewed above a reviewed government marker above a perspective fact. */
const RISK_SEVERITY: Readonly<Record<PropagandaRisk | 'fact', number>> = {
  high: 4,
  medium: 3,
  unknown: 2,
  low: 1,
  fact: 0,
};

/** The compact risk marker shown beside a corroborating source; null when there is nothing to disclose. */
export function getCorroboratingSourceRiskBadge(sourceName: string): CorroboratingRiskBadge | null {
  const profile = getSourcePropagandaRisk(sourceName);
  const sourceType = getSourceType(sourceName);
  const description = describePropagandaBadge(profile, sourceType);
  if (description) {
    return {
      className: `propaganda-badge ${description.risk}`,
      title: description.title,
      label: description.shortLabel,
      severity: RISK_SEVERITY[description.risk],
    };
  }
  if (getProvenanceFacts(profile, sourceType).length > 0) {
    return {
      className: 'provenance-fact-marker',
      title: `${composeProvenanceSummary(profile, sourceType)} ${PERSPECTIVE_LABEL_CAVEAT}`,
      label: '◐',
      severity: RISK_SEVERITY.fact,
    };
  }
  return null;
}

/** The most severe marker among a publisher's feeds; the first seen wins a tie. */
export function mostSevereRiskBadge(sourceNames: readonly string[]): CorroboratingRiskBadge | null {
  let worst: CorroboratingRiskBadge | null = null;
  for (const name of sourceNames) {
    const badge = getCorroboratingSourceRiskBadge(name);
    if (badge && (worst === null || badge.severity > worst.severity)) worst = badge;
  }
  return worst;
}
