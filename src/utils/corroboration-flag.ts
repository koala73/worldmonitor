import { t } from '@/services/i18n';
import { escapeHtml } from '@/utils/sanitize';
import type { Corroboration } from '../../server/_shared/corroboration';
import type { NewsCorroboration } from '@/types';

// NewsCorroboration is the types-layer copy of Corroboration; each must accept the other.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const corroborationTypesMatch: Same<NewsCorroboration, Corroboration> = true;
void corroborationTypesMatch;

// The browser's one entry point to the rule, so components never reach into server/.
export {
  assessCorroboration,
  evidenceFromCluster,
  evidenceFromItem,
  evidenceFromStory,
  publisherRoster,
  type Corroboration,
  type Publisher,
  type PublisherRoster,
} from '../../server/_shared/corroboration';
export type { DeclaredTier } from '../../server/_shared/source-tiers';
export { TIER_DOCS_HREF } from './tier-docs';

export type CorroborationFlag = { readonly text: string; readonly hint: string };

/** null for corroborated and unknown: the existing count badges already speak for those. */
export function corroborationFlag(c: Corroboration): CorroborationFlag | null {
  switch (c.state) {
    case 'single-publisher':
      return {
        text: t('components.corroboration.singlePublisher'),
        hint: t('components.corroboration.singlePublisherHint'),
      };
    case 'tier4-only':
      return {
        text: t('components.corroboration.tier4Only'),
        hint: t('components.corroboration.tier4OnlyHint'),
      };
    case 'corroborated':
    case 'unknown':
      return null;
  }
}

/**
 * #9213: a label for every known state, for surfaces with no separate count
 * badge (map popups and tooltips). null for unknown.
 */
export function corroborationLabel(c: Corroboration): CorroborationFlag | null {
  if (c.state === 'corroborated') {
    return { text: t('components.corroboration.rosterPublishers', { count: c.publishers }), hint: '' };
  }
  return corroborationFlag(c);
}

/** corroborationLabel as escaped pill markup; '' for unknown or absent. */
export function corroborationLabelHtml(c: Corroboration | undefined): string {
  const label = c ? corroborationLabel(c) : null;
  if (!label) return '';
  const title = label.hint ? ` title="${escapeHtml(label.hint)}"` : '';
  return `<span class="corroboration-flag"${title}>${escapeHtml(label.text)}</span>`;
}

/** The pill as escaped markup for string-template renderers; '' when there is nothing to disclose. */
export function corroborationFlagHtml(c: Corroboration): string {
  const flag = corroborationFlag(c);
  return flag
    ? `<span class="corroboration-flag" title="${escapeHtml(flag.hint)}">${escapeHtml(flag.text)}</span>`
    : '';
}

/**
 * The publisher count a "N sources" badge shows. It reads the verdict, the same
 * number the publisher roster summary shows, so a card never states two counts.
 * An unknown verdict has no count, so the badge keeps the caller's own.
 */
export function badgePublisherCount(c: Corroboration, fallback: number): number {
  return c.state === 'unknown' ? fallback : c.publishers;
}
