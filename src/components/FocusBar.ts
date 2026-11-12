import { t } from '@/services/i18n';
import type { ResolvedScope } from '@/services/tab-focus';
import type { GateCopy } from '@/components/ExportGateControl';
import { setTrustedHtml, trustedHtml } from '@/utils/dom-utils';
import { focusCountryName, focusWindowText, formatCountryList } from './focus-format';

export interface FocusBarCallbacks {
  onEdit(): void;
  onClear(): void;
  /**
   * Hand the focus to the travel risk assessment (#10451). The action shows
   * only when both are given and `canDraftAssessment` says the plan holds the
   * grant, read at every render so a lapsed grant removes it.
   */
  canDraftAssessment?(): boolean;
  onDraftAssessment?(): void;
}

let nextId = 0;

const FOCUS_ACTIONS = ['focus-bar-draft', 'focus-bar-edit', 'focus-bar-clear'] as const;

/**
 * The bar at the top of a focused tab (#10453): "Focused on Thailand,
 * Vietnam, Indonesia + 9 neighbours · Nov 14 – 18", with Edit and Clear. It is
 * always visible while the tab has a focus, so a filtered dashboard is never
 * mistaken for the whole world, and hidden otherwise.
 *
 * A window that has passed is stated ("Window ended Nov 18"); nothing is
 * hidden or archived because of it.
 *
 * Pure DOM construction, so country names need no escaping.
 */
export class FocusBar {
  private readonly element: HTMLElement;
  private readonly detailsId = `focus-bar-details-${++nextId}`;
  private expanded = false;
  private lastKey: string | null = null;
  private gate: HTMLElement | null = null;
  private current: ResolvedScope | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly onVisible = (): void => {
    if (document.visibilityState === 'visible' && this.current && !this.element.hidden && !this.gate) this.render(this.current);
  };

  constructor(
    private readonly callbacks: FocusBarCallbacks,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.element = document.createElement('section');
    this.element.className = 'focus-bar';
    this.element.setAttribute('aria-label', t('focus.barLabel'));
    this.element.hidden = true;
    document.addEventListener('visibilitychange', this.onVisible);
  }

  getElement(): HTMLElement {
    return this.element;
  }

  destroy(): void {
    this.clearRefresh();
    document.removeEventListener('visibilitychange', this.onVisible);
    this.element.remove();
  }

  private clearRefresh(): void {
    if (this.refreshTimer !== null) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
  }

  /** The window text is judged by UTC day: redraw just after the next UTC midnight. */
  private scheduleRefresh(resolved: ResolvedScope): void {
    this.clearRefresh();
    if (!resolved.scope.start && !resolved.scope.end) return;
    const now = this.now();
    const nextMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
    const delay = Math.min(Math.max(nextMidnight - now.getTime() + 1000, 1000), 2 ** 31 - 1);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      if (this.current === resolved && !this.element.hidden && !this.gate) this.render(resolved);
    }, delay);
  }

  /** Show the active focus, or hide the bar when there is none. */
  render(resolved: ResolvedScope | null): void {
    this.gate = null;
    this.current = resolved;
    this.clearRefresh();
    if (!resolved) {
      this.element.hidden = true;
      this.element.replaceChildren();
      this.lastKey = null;
      this.expanded = false;
      return;
    }
    // A different focus starts collapsed; a re-render of the same one keeps
    // whatever the user opened.
    const key = JSON.stringify(resolved.scope);
    if (key !== this.lastKey) this.expanded = false;
    this.lastKey = key;

    const { scope, chosen, neighbours } = resolved;
    const windowText = focusWindowText(scope, this.now());
    this.element.hidden = false;
    this.element.classList.toggle('ended', windowText?.ended === true);

    const icon = document.createElement('span');
    icon.className = 'focus-bar-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = '◎';

    const summary = document.createElement('span');
    summary.className = 'focus-bar-summary';
    summary.textContent = t('focus.summary', { countries: formatCountryList(chosen) });

    const text = document.createElement('div');
    text.className = 'focus-bar-text';
    text.append(icon, summary);

    const details = this.buildDetails(chosen, neighbours);
    if (!scope.neighbours) {
      const off = document.createElement('span');
      off.className = 'focus-bar-neighbours-off';
      off.textContent = t('focus.neighboursOff');
      text.append(off);
    } else if (neighbours.length > 0) {
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'focus-bar-neighbours-toggle';
      toggle.textContent = t('focus.plusNeighbours', { count: neighbours.length });
      toggle.setAttribute('aria-controls', this.detailsId);
      toggle.setAttribute('aria-expanded', String(this.expanded));
      toggle.addEventListener('click', () => {
        this.expanded = !this.expanded;
        toggle.setAttribute('aria-expanded', String(this.expanded));
        details.hidden = !this.expanded;
      });
      text.append(toggle);
    }
    if (windowText) {
      const win = document.createElement('span');
      win.className = `focus-bar-window${windowText.ended ? ' ended' : ''}`;
      win.textContent = windowText.text;
      text.append(win);
    }

    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'focus-bar-btn focus-bar-edit';
    edit.textContent = t('focus.edit');
    edit.addEventListener('click', () => this.callbacks.onEdit());

    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'focus-bar-btn focus-bar-clear';
    clear.textContent = t('focus.clear');
    clear.setAttribute('aria-label', t('focus.clearAria'));
    clear.addEventListener('click', () => this.callbacks.onClear());

    const actions = document.createElement('div');
    actions.className = 'focus-bar-actions';
    const { canDraftAssessment, onDraftAssessment } = this.callbacks;
    if (canDraftAssessment && onDraftAssessment && canDraftAssessment()) {
      const draft = document.createElement('button');
      draft.type = 'button';
      draft.className = 'focus-bar-btn focus-bar-draft';
      draft.textContent = t('focus.draftAssessment');
      draft.setAttribute('aria-label', t('focus.draftAssessmentAria'));
      draft.addEventListener('click', () => onDraftAssessment());
      actions.append(draft);
    }
    actions.append(edit, clear);

    const row = document.createElement('div');
    row.className = 'focus-bar-row';
    row.append(text, actions);

    // A redraw replaces the buttons; a keyboard user who was on one of them
    // stays on its replacement.
    const focusedAction = FOCUS_ACTIONS.find((cls) => document.activeElement?.classList.contains(cls)
      && this.element.contains(document.activeElement));
    this.element.replaceChildren(row, details);
    if (focusedAction) this.element.querySelector<HTMLElement>(`.${focusedAction}`)?.focus();
    this.scheduleRefresh(resolved);
  }

  /**
   * The upsell for an account that may not set a focus (it can still clear
   * one, e.g. a shared dashboard). Inline rather than a popover: the bar is
   * full width and may wrap at phone widths.
   */
  showGate(copy: GateCopy, onAction: () => void): void {
    this.gate?.remove();
    const gate = document.createElement('div');
    gate.className = 'focus-bar-gate';
    gate.setAttribute('role', 'status');

    const icon = document.createElement('span');
    icon.className = 'focus-bar-gate-icon tab-cap-notice-icon';
    icon.setAttribute('aria-hidden', 'true');
    setTrustedHtml(icon, trustedHtml(copy.icon, 'static inline icon markup'));

    const desc = document.createElement('span');
    desc.className = 'focus-bar-gate-desc';
    desc.id = `${this.detailsId}-gate`;
    desc.textContent = copy.desc;

    const cta = document.createElement('button');
    cta.type = 'button';
    cta.className = 'focus-bar-gate-cta tab-cap-notice-cta';
    cta.textContent = copy.cta;
    cta.setAttribute('aria-describedby', desc.id);
    cta.addEventListener('click', () => {
      gate.remove();
      this.gate = null;
      onAction();
    });

    gate.append(icon, desc, cta);
    this.element.append(gate);
    this.gate = gate;
    cta.focus();
  }

  private buildDetails(chosen: readonly string[], neighbours: readonly string[]): HTMLElement {
    const details = document.createElement('div');
    details.className = 'focus-bar-details';
    details.id = this.detailsId;
    details.hidden = !this.expanded;
    details.append(
      this.buildGroup(t('focus.chosenLabel'), chosen, 'chosen'),
      ...(neighbours.length > 0 ? [this.buildGroup(t('focus.neighboursLabel'), neighbours, 'neighbour')] : []),
    );
    return details;
  }

  private buildGroup(label: string, codes: readonly string[], kind: 'chosen' | 'neighbour'): HTMLElement {
    const group = document.createElement('div');
    group.className = 'focus-bar-group';
    const heading = document.createElement('span');
    heading.className = 'focus-bar-group-label';
    heading.textContent = label;
    const list = document.createElement('ul');
    list.className = 'focus-bar-countries';
    for (const code of codes) {
      const item = document.createElement('li');
      item.className = `focus-bar-country ${kind}`;
      const name = focusCountryName(code);
      item.textContent = name;
      if (kind === 'neighbour') item.setAttribute('aria-label', t('focus.neighbourItem', { name }));
      list.append(item);
    }
    group.append(heading, list);
    return group;
  }
}
