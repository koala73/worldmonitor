/**
 * The focus UI the layout loads on demand (#10453): the bar, the gate copy,
 * the country-list formatter and the per-panel "Not filtered" notice. Most
 * visitors never focus a tab, so none of this ships in the App chunk; the
 * layout imports it the first time a tab is focused or Focus is pressed.
 */

import type { Panel } from './Panel';
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
export async function openTripAssessmentForScope(scope: TabScope): Promise<void> {
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
        omitted: handoff.omitted,
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
