import { t } from '@/services/i18n';
import { showToast } from '@/utils/toast';
import { REPORT_MAX_COUNTRIES, assessmentRequestText, reportHandoffFromScope } from '../../shared/report-handoff';
import type { TabScope } from '../../shared/tab-scope';
import { focusCountryName } from './focus-format';

/**
 * The focus bar's "Draft assessment" (#10453, phase 3): copy a request that
 * names the focus's countries and dates for the travel risk assessment tool.
 * #10451 has no in-app export yet, so the destination is the user's own AI
 * assistant with the World Monitor MCP connected. The tool's server-side plan
 * check is what gates the draft; this only builds the message.
 *
 * Resolves true when the request reached the clipboard, and says so either
 * way. A focus larger than the report takes copies the first countries and
 * states the limit, rather than dropping the rest without a word.
 */
export async function copyAssessmentRequest(
  scope: TabScope,
  clipboard: Pick<Clipboard, 'writeText'> | null = typeof navigator === 'undefined' ? null : (navigator.clipboard ?? null),
): Promise<boolean> {
  const handoff = reportHandoffFromScope(scope);
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
