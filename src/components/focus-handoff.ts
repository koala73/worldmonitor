import { t } from '@/services/i18n';
import { showToast } from '@/utils/toast';
import { REPORT_MAX_COUNTRIES, assessmentRequestText, reportHandoffFromScope, type ReportHandoff } from '../../shared/report-handoff';
import type { TabScope } from '../../shared/tab-scope';
import { focusCountryName } from './focus-format';

/**
 * Copy a request that names a focus's countries and dates for the travel risk
 * assessment tool (#10453, phase 3), for the user's own AI assistant with the
 * World Monitor MCP connected. The in-app export is the trip assessment dialog
 * (#10451, phase 2); this stays as its "copy request" link. The tool's
 * server-side plan check is what gates the draft; this only builds the message.
 *
 * Resolves true when the request reached the clipboard, and says so either
 * way. A focus larger than the report takes copies the first countries and
 * states the limit, rather than dropping the rest without a word.
 */
export async function copyAssessmentRequest(
  scope: TabScope,
  clipboard: Pick<Clipboard, 'writeText'> | null = typeof navigator === 'undefined' ? null : (navigator.clipboard ?? null),
): Promise<boolean> {
  return copyHandoffRequest(reportHandoffFromScope(scope), clipboard);
}

/** The same copy for a handoff the person has already edited, as in the trip assessment dialog. */
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
      ? t('focus.draftCopiedPartial', { count: handoff.countries.length, max: REPORT_MAX_COUNTRIES })
      : t('focus.draftCopied'),
  );
  return true;
}
