import type { ResolvedScope } from '@/services/tab-focus';
import { t } from '@/services/i18n';
import { escapeHtml } from '@/utils/sanitize';
import { partitionByScope, type ScopeCountries, type ScopePartition } from './panel-scope-partition';
import { h, replaceChildren } from '@/utils/dom-utils';
import { scopeEquals } from '../../shared/tab-scope';
import { focusCountryName, formatCountryList } from './focus-format';

/**
 * Dashboard focus (#10453): how a panel that filters by country narrows its
 * list, and the strip that says what the focus is hiding.
 *
 * Issue rules this module carries for every filtering panel:
 *   - Chosen countries are listed first, then neighbours, marked as such.
 *   - Items in other countries are counted ("12 hidden by focus") and one
 *     click shows them ("Show all", per panel, for this session).
 *   - Items with no country are counted apart ("7 items with no country")
 *     and one click shows them; they are never dropped silently.
 *   - An empty result caused by the focus reads differently from a load
 *     failure (the panel's error state) and from stale data (the header's
 *     cached badge).
 *
 * Panels keep their full dataset and re-render through `view()` when the
 * focus or a toggle changes, so a focus change never refetches.
 */

export { partitionByScope } from './panel-scope-partition';
export type { ScopeCountries, ScopedItem, ScopePartition, ScopeRelation } from './panel-scope-partition';

/** What a row is marked with: a neighbour's name, "No country", or nothing. */
export type ScopeRowTag = 'neighbour' | 'unattributed' | null;

export interface ScopeRow<T> {
  item: T;
  tag: ScopeRowTag;
  /** The neighbour's code when `tag` is 'neighbour'. */
  country: string | null;
  /** 0 chosen (or unfocused), 1 neighbour, 2 no country: the order a panel keeps when it re-sorts. */
  rank: 0 | 1 | 2;
}

export interface ScopeView<T> {
  /** The rows to render, in order. */
  rows: ScopeRow<T>[];
  /** The focus split, or null when the panel is unfocused or showing everything. */
  partition: ScopePartition<T> | null;
  /** The panel has data, and the focus (not the data) leaves nothing to show. */
  emptyByFocus: boolean;
}

function sameResolved(a: ResolvedScope | null, b: ResolvedScope | null): boolean {
  if (!a || !b) return !a && !b;
  return scopeEquals(a.scope, b.scope)
    && a.neighbours.length === b.neighbours.length
    && a.neighbours.every((code, i) => code === b.neighbours[i]);
}

/** "Neighbour: Laos", for a row of a neighbouring country. */
export function neighbourTagText(code: string): string {
  return t('focus.neighbourItem', { name: focusCountryName(code) });
}

/** The row marker as escaped HTML ('' for chosen-country and unfocused rows). */
export function scopeTagHtml(row: Pick<ScopeRow<unknown>, 'tag' | 'country'> | null | undefined): string {
  if (!row?.tag) return '';
  if (row.tag === 'neighbour' && row.country) {
    return `<span class="panel-scope-tag panel-scope-tag-neighbour">${escapeHtml(neighbourTagText(row.country))}</span>`;
  }
  if (row.tag === 'unattributed') {
    return `<span class="panel-scope-tag panel-scope-tag-none">${escapeHtml(t('focus.filter.noCountryTag'))}</span>`;
  }
  return '';
}

/**
 * The focused empty state, as escaped HTML. Neutral and dashed on purpose:
 * a load failure is the panel's red error state and stale data is the
 * header's cached badge, so "nothing here for these countries" must not look
 * like either.
 */
export function focusedEmptyHtml(message: string): string {
  return `<div class="panel-scope-empty" role="status"><span class="panel-scope-empty-title">${escapeHtml(message)}</span><span class="panel-scope-empty-hint">${escapeHtml(t('focus.filter.emptyHint'))}</span></div>`;
}

/** The same empty state as an element, for panels that build DOM rather than HTML. */
export function focusedEmptyNode(message: string): HTMLElement {
  return h('div', { className: 'panel-scope-empty', role: 'status' },
    h('span', { className: 'panel-scope-empty-title' }, message),
    h('span', { className: 'panel-scope-empty-hint' }, t('focus.filter.emptyHint')),
  );
}

/** The row marker as an element ('null' for chosen-country and unfocused rows). */
export function scopeTagNode(row: Pick<ScopeRow<unknown>, 'tag' | 'country'> | null | undefined): HTMLElement | null {
  if (!row?.tag) return null;
  if (row.tag === 'neighbour' && row.country) {
    return h('span', { className: 'panel-scope-tag panel-scope-tag-neighbour' }, neighbourTagText(row.country));
  }
  if (row.tag === 'unattributed') {
    return h('span', { className: 'panel-scope-tag panel-scope-tag-none' }, t('focus.filter.noCountryTag'));
  }
  return null;
}

type StripAction = 'show-all' | 'apply' | 'show-unattributed' | 'hide-unattributed';

export interface PanelScopeFilterOptions {
  /** The panel's content element; the strip is inserted just above it. */
  content: HTMLElement;
  /** Re-render the panel from the data it already holds. */
  onChange: () => void;
}

/**
 * One panel's focus state: the active scope, its session-only "Show all" and
 * "Show items with no country" toggles (both reset when the focus changes),
 * and the strip above the panel's content.
 */
export class PanelScopeFilter {
  private resolved: ResolvedScope | null = null;
  private showAll = false;
  private showUnattributed = false;
  private readonly strip: HTMLElement;
  private readonly onChange: () => void;

  constructor(options: PanelScopeFilterOptions) {
    this.onChange = options.onChange;
    this.strip = h('div', { className: 'panel-scope-strip', 'data-scope-strip': '' });
    this.strip.hidden = true;
    options.content.before(this.strip);
    this.strip.addEventListener('click', (event) => {
      const button = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>('button[data-scope-action]');
      if (!button || !this.strip.contains(button)) return;
      event.stopPropagation();
      this.act(button.dataset.scopeAction as StripAction);
    });
  }

  /** Take a new focus. Returns false when nothing changed (no re-render needed). */
  public setScope(next: ResolvedScope | null): boolean {
    if (sameResolved(this.resolved, next)) return false;
    this.resolved = next;
    this.showAll = false;
    this.showUnattributed = false;
    return true;
  }

  public get scope(): ResolvedScope | null {
    return this.resolved;
  }

  /** A focus applies and this panel has not been switched to "Show all". */
  public get filtering(): boolean {
    return this.resolved !== null && !this.showAll;
  }

  /** The rows to render for `items` under the current focus and toggles. */
  public view<T>(items: readonly T[], getCountry: (item: T) => ScopeCountries): ScopeView<T> {
    if (!this.filtering) {
      return { rows: items.map((item) => ({ item, tag: null, country: null, rank: 0 })), partition: null, emptyByFocus: false };
    }
    const partition = partitionByScope(items, getCountry, this.resolved);
    const rows: ScopeRow<T>[] = partition.shown.map(({ item, relation, country }) => (
      relation === 'neighbour'
        ? { item, tag: 'neighbour', country, rank: 1 }
        : { item, tag: null, country, rank: 0 }
    ));
    if (this.showUnattributed) {
      for (const item of partition.unattributed) rows.push({ item, tag: 'unattributed', country: null, rank: 2 });
    }
    return { rows, partition, emptyByFocus: rows.length === 0 && items.length > 0 };
  }

  /**
   * Draw the strip for a view (null hides it: no focus, loading, or a load
   * failure, where counts would claim more than the panel knows). `note`
   * replaces the counts, for a panel tab that does not filter. `warning` is
   * shown IN ADDITION to the counts and controls, for a list that is known to
   * be incomplete: the reveal buttons must stay reachable.
   */
  public renderStrip(view: ScopeView<unknown> | null, note?: string, warning?: string): void {
    const resolved = this.resolved;
    if (!resolved || (!view && !note)) {
      this.hideStrip();
      return;
    }
    const parts: HTMLElement[] = [];
    if (note) {
      parts.push(h('span', { className: 'panel-scope-strip-label' }, this.scopeLabel(resolved)));
      parts.push(h('span', { className: 'panel-scope-strip-note' }, note));
    } else if (this.showAll) {
      parts.push(h('span', { className: 'panel-scope-strip-label' }, t('focus.filter.focusOff')));
      parts.push(this.button('apply', t('focus.filter.applyFocus'), t('focus.filter.applyFocusAria')));
    } else {
      parts.push(h('span', { className: 'panel-scope-strip-label' }, this.scopeLabel(resolved)));
      const partition = view?.partition;
      if (partition && partition.hiddenCount > 0) {
        const count = partition.hiddenCount;
        parts.push(h('span', { className: 'panel-scope-strip-count' },
          h('span', null, t('focus.filter.hidden', { count })),
          this.button('show-all', t('focus.filter.showAll'), t('focus.filter.showAllAria', { count })),
        ));
      }
      if (partition && partition.unattributed.length > 0) {
        const count = partition.unattributed.length;
        parts.push(h('span', { className: 'panel-scope-strip-count' },
          h('span', null, t('focus.filter.unattributed', { count })),
          this.showUnattributed
            ? this.button('hide-unattributed', t('focus.filter.hide'), t('focus.filter.hideUnattributedAria', { count }))
            : this.button('show-unattributed', t('focus.filter.show'), t('focus.filter.showUnattributedAria', { count })),
        ));
      }
    }
    if (warning && !note) parts.push(h('span', { className: 'panel-scope-strip-note panel-scope-strip-warning', role: 'status' }, warning));
    replaceChildren(this.strip, ...parts);
    this.strip.dataset.state = note ? 'note' : this.showAll ? 'all' : 'filtering';
    this.strip.hidden = false;
  }

  public hideStrip(): void {
    this.strip.hidden = true;
    replaceChildren(this.strip);
    delete this.strip.dataset.state;
  }

  public destroy(): void {
    this.strip.remove();
  }

  private scopeLabel(resolved: ResolvedScope): string {
    const countries = formatCountryList(resolved.chosen);
    return resolved.neighbours.length > 0
      ? t('focus.filter.showingNeighbours', { countries })
      : t('focus.filter.showing', { countries });
  }

  private button(action: StripAction, label: string, ariaLabel: string): HTMLButtonElement {
    const button = h('button', { type: 'button', className: 'panel-scope-strip-btn' }, label) as HTMLButtonElement;
    button.dataset.scopeAction = action;
    button.setAttribute('aria-label', ariaLabel);
    return button;
  }

  private act(action: StripAction): void {
    switch (action) {
      case 'show-all': this.showAll = true; break;
      case 'apply': this.showAll = false; break;
      case 'show-unattributed': this.showUnattributed = true; break;
      case 'hide-unattributed': this.showUnattributed = false; break;
      default: return;
    }
    this.onChange();
    // The clicked button is replaced by its counterpart; keep keyboard focus on
    // that one, not on whichever strip button comes first.
    const counterpart: Partial<Record<StripAction, StripAction>> = {
      'show-all': 'apply',
      apply: 'show-all',
      'show-unattributed': 'hide-unattributed',
      'hide-unattributed': 'show-unattributed',
    };
    const target = counterpart[action];
    const next = (target && this.strip.querySelector<HTMLButtonElement>(`button[data-scope-action="${target}"]`))
      || this.strip.querySelector<HTMLButtonElement>('button[data-scope-action]');
    next?.focus({ preventScroll: true });
  }
}
