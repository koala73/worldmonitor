import { getCurrentLanguageTag, getLocale, t } from '@/services/i18n';
import { PanelGateReason } from '@/services/panel-gating';
import { lockSvg, upgradeSvg } from '@/components/gate-icons';
import { billingAwareGateCopy, type GateCopy } from '@/components/ExportGateControl';
import { iso2ToCountryName } from '@/utils/country-codes';
import { scopeStatus, type TabScope } from '../../shared/tab-scope';

/**
 * Text shared by the focus bar and the focus editor (#10453). Kept apart from
 * both so the bar, which ships in the dashboard entry, does not pull in the
 * lazily loaded editor.
 */

let namesTag: string | null = null;
let names: Intl.DisplayNames | null = null;

/** A country's name in the UI language, falling back to English, then the code. */
export function focusCountryName(code: string): string {
  const tag = getCurrentLanguageTag();
  if (tag !== namesTag) {
    namesTag = tag;
    try {
      names = new Intl.DisplayNames([tag], { type: 'region' });
    } catch {
      names = null;
    }
  }
  try {
    const name = names?.of(code);
    if (name && name !== code) return name;
  } catch {
    // Unknown region code for this runtime.
  }
  return iso2ToCountryName(code);
}

// Typed locally: the project's `lib` predates ES2021, where these were added.
type ListFormatCtor = new (locale: string, options: { style: 'short'; type: 'unit' }) => {
  format(items: readonly string[]): string;
};
type RangeFormat = Intl.DateTimeFormat & { formatRange?: (start: Date, end: Date) => string };

/** "Thailand, Vietnam, Indonesia" in the UI language's list style. */
export function formatCountryList(codes: readonly string[]): string {
  const labels = codes.map(focusCountryName);
  const ListFormat = (Intl as unknown as { ListFormat?: ListFormatCtor }).ListFormat;
  try {
    if (ListFormat) return new ListFormat(getLocale(), { style: 'short', type: 'unit' }).format(labels);
  } catch {
    // Unsupported locale: fall through.
  }
  return labels.join(', ');
}

function utcDate(day: string): Date {
  return new Date(`${day}T00:00:00Z`);
}

const DAY_FORMAT: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', timeZone: 'UTC' };

function formatDay(day: string): string {
  return new Intl.DateTimeFormat(getLocale(), DAY_FORMAT).format(utcDate(day));
}

function formatRange(start: string, end: string): string {
  const format: RangeFormat = new Intl.DateTimeFormat(getLocale(), DAY_FORMAT);
  try {
    if (format.formatRange) return format.formatRange(utcDate(start), utcDate(end));
  } catch {
    // Fall through to the plain form.
  }
  return t('focus.range', { start: format.format(utcDate(start)), end: format.format(utcDate(end)) });
}

/**
 * The window part of the bar, or null for a focus without dates. Dates are
 * calendar days compared in UTC, as `scopeStatus` does.
 */
export function focusWindowText(scope: TabScope, now: Date): { text: string; ended: boolean } | null {
  const status = scopeStatus(scope, now);
  if (status === 'none') return null;
  if (status === 'ended') return { text: t('focus.windowEnded', { date: formatDay(scope.end!) }), ended: true };
  if (status === 'upcoming') return { text: t('focus.windowStarts', { date: formatDay(scope.start!) }), ended: false };
  if (scope.start && scope.end) return { text: formatRange(scope.start, scope.end), ended: false };
  if (scope.end) return { text: t('focus.windowUntil', { date: formatDay(scope.end) }), ended: false };
  return { text: t('focus.windowFrom', { date: formatDay(scope.start!) }), ended: false };
}

/**
 * Copy for an account that may not set a focus, shaped like `tabCapGateCopy`
 * so every locked surface reads the same: billing-aware reasons first (a
 * customer with paid evidence never sees a fresh upsell), then sign-in for a
 * visitor, then the upgrade.
 */
export function focusGateCopy(reason: PanelGateReason): GateCopy {
  const billing = billingAwareGateCopy(reason);
  if (billing) return billing;
  if (reason === PanelGateReason.ANONYMOUS) {
    return { icon: lockSvg, desc: t('focus.gateSignedOutDesc'), cta: t('premium.signIn') };
  }
  return { icon: upgradeSvg, desc: t('focus.gateUpgradeDesc'), cta: t('focus.gateUpgradeCta') };
}
