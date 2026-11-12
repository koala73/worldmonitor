/**
 * The focus UI the layout loads on demand (#10453): the bar, the gate copy,
 * the country-list formatter and the per-panel "Not filtered" notice. Most
 * visitors never focus a tab, so none of this ships in the App chunk; the
 * layout imports it the first time a tab is focused or Focus is pressed.
 */

import type { Panel } from './Panel';
import type { ResolvedScope } from '@/services/tab-focus';
import { getPanelScopeBehaviour } from '@/config/panel-scope';
import { scopeNoticeFor } from './panel-scope-notice';

export { FocusBar } from './FocusBar';
export { copyAssessmentRequest } from './focus-handoff';
export { focusGateCopy, formatCountryList } from './focus-format';

/** Show or hide one panel's "Not filtered" chip for the given focus. */
export function applyScopeNotice(key: string, panel: Panel, resolved: ResolvedScope | null): void {
  if (typeof panel.setScopeNotice !== 'function') return;
  panel.setScopeNotice(scopeNoticeFor(getPanelScopeBehaviour(key), panel, resolved));
}
