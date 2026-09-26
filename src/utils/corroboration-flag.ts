import { t } from '@/services/i18n';
import { escapeHtml } from '@/utils/sanitize';
import type { Corroboration } from '../../server/_shared/corroboration';

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
