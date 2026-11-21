/**
 * The focus UI the layout loads on demand (#10453): the bar, the gate copy,
 * the country-list formatter and the per-panel "Not filtered" notice. Most
 * visitors never focus a tab, so none of this ships in the App chunk; the
 * layout imports it the first time a tab is focused or Focus is pressed.
 */

import type { Panel } from './Panel';
import { t } from '@/services/i18n';
import { showToast } from '@/utils/toast';
import type { ResolvedScope } from '@/services/tab-focus';
import type { TabScope } from '../../shared/tab-scope';
import { getPanelScopeBehaviour } from '@/config/panel-scope';
import { scopeNoticeFor } from './panel-scope-notice';

export { FocusBar } from './FocusBar';
export { focusGateCopy, formatCountryList } from './focus-format';

/** Show or hide one panel's "Not filtered" chip for the given focus. */
export function applyScopeNotice(key: string, panel: Panel, resolved: ResolvedScope | null): void {
  if (typeof panel.setScopeNotice !== 'function') return;
  panel.setScopeNotice(scopeNoticeFor(getPanelScopeBehaviour(key), panel, resolved));
}

/**
 * Open the trip assessment dialog (#10451, phase 2) prefilled from a focus.
 * The dialog and its service load here, on the first press, so neither is in
 * the chunk the focus bar ships in.
 */
let tripAssessmentLoading = false;

export async function openTripAssessmentForScope(scope: TabScope): Promise<void> {
  // One dialog at a time. A second press while the first is still loading, or
  // while it is open, must not stack a second form over the first: closing one
  // would reveal the other with different edits in it. The open dialog is found
  // in the DOM rather than remembered, so it cannot go stale.
  const open = document.querySelector<HTMLElement>('.trip-assessment');
  if (open) {
    open.querySelector<HTMLElement>('.trip-assessment-label')?.focus();
    return;
  }
  if (tripAssessmentLoading) return;
  tripAssessmentLoading = true;
  try {
    await openTripAssessmentDialog(scope);
  } catch {
    // A dynamic import that rejects (a deploy swapped the chunk, the network
    // dropped) would otherwise vanish: the press does nothing and says nothing.
    showToast(t('tripAssessment.errLoad'));
  } finally {
    tripAssessmentLoading = false;
  }
}

async function openTripAssessmentDialog(scope: TabScope): Promise<void> {
  const [{ openTripAssessment }, { draftFromHandoff, parseCities }, { copyHandoffRequest }, { reportHandoffFromScope }] = await Promise.all([
    import('./TripAssessmentDialog'),
    import('@/services/travel-risk-export'),
    import('./focus-handoff'),
    import('../../shared/report-handoff'),
  ]);
  const handoff = reportHandoffFromScope(scope);
  openTripAssessment({
    initial: draftFromHandoff(handoff),
    omitted: handoff.omitted,
    // What was typed in the dialog, not the focus it started from: the same
    // trip the export builds, cities and dates and label included.
    onCopyRequest: (draft) => {
      void copyHandoffRequest({
        countries: draft.countries.map((c) => c.code),
        // Only what is still left out: a country the analyst swapped in for a
        // selected one must not be listed as both selected and not part of the request.
        omitted: handoff.omitted.filter((code) => !draft.countries.some((c) => c.code === code)),
        dateFrom: draft.dateFrom || null,
        dateTo: draft.dateTo || null,
        taskLabel: draft.taskLabel.trim() || null,
        details: Object.fromEntries(draft.countries.map((c) => [c.code, {
          cities: parseCities(c.cities),
          arrive: c.arrive || null,
          depart: c.depart || null,
        }])),
      });
    },
  });
}
