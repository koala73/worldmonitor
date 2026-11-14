import { t } from '@/services/i18n';
import { showToast } from '@/utils/toast';
import { REPORT_MAX_COUNTRIES, assessmentRequestText, type ReportHandoff } from '../../shared/report-handoff';
import { focusCountryName, formatCountryList } from './focus-format';

/**
 * Copy the edited trip for the user's AI assistant with World Monitor MCP
 * connected. The tool's server-side plan check gates the assessment; this
 * only builds the request. Confirm clipboard success or failure, naming any
 * focus countries the handoff left out.
 */
export async function copyHandoffRequest(
  handoff: ReportHandoff,
  clipboard: Pick<Clipboard, 'writeText'> | null = typeof navigator === 'undefined' ? null : (navigator.clipboard ?? null),
): Promise<boolean> {
  try {
    if (!clipboard) throw new Error('no clipboard');
    await clipboard.writeText(assessmentRequestText(handoff, focusCountryName));
  } catch {
    showToast(t('focus.draftCopyFailed'));
    return false;
  }
  showToast(
    handoff.omitted.length > 0
      ? t('focus.draftCopiedPartial', {
        count: handoff.countries.length,
        max: REPORT_MAX_COUNTRIES,
        omitted: formatCountryList(handoff.omitted),
      })
      : t('focus.draftCopied'),
  );
  return true;
}
