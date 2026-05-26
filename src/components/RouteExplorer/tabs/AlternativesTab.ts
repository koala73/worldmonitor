/**
 * Alternatives tab — ranked bypass sea routes. Arrow keys move selection,
 * Enter highlights the selected corridor on the map via a callback.
 * Proposed corridors shown with a label; unavailable ones are greyed out.
 */

import type {
  BypassCorridorOption,
  GetRouteExplorerLaneResponse,
} from '@/generated/server/worldmonitor/supply_chain/v1/service_server';
import { renderRouteCard } from '../components/RouteCard';

export interface AlternativesTabOptions {
  onSelectBypass: (option: BypassCorridorOption) => void;
}

export class AlternativesTab {
  public readonly element: HTMLDivElement;
  private opts: AlternativesTabOptions;
  private seaOptions: BypassCorridorOption[] = [];
  private activeIndex = -1;

  constructor(opts: AlternativesTabOptions) {
    this.opts = opts;
    this.element = document.createElement('div');
    this.element.className = 're-tab re-tab--alternatives';
    this.element.setAttribute('role', 'tabpanel');
    this.element.addEventListener('keydown', this.handleKeydown);
    this.renderEmpty();
  }

  public update(data: GetRouteExplorerLaneResponse | null): void {
    if (!data || data.noModeledLane) {
      this.seaOptions = [];
      this.activeIndex = -1;
      this.renderNoLane();
      return;
    }
    this.seaOptions = data.bypassOptions.filter((o) => o.type !== 'land_bridge');
    this.activeIndex = -1;
    if (this.seaOptions.length === 0) {
      this.renderEmptyAlternatives();
      return;
    }
    this.renderList();
  }

  private renderEmpty(): void {
    this.element.innerHTML =
      '<div class="re-tab__placeholder">Pick a country pair and product to see alternatives.</div>';
  }

  private renderNoLane(): void {
    this.element.innerHTML =
      '<div class="re-tab__empty"><p>No modeled lane. Alternatives require a primary route to divert from.</p></div>';
  }

  private renderEmptyAlternatives(): void {
    this.element.innerHTML =
      '<div class="re-tab__empty"><p>No sea-route alternatives available for this lane\'s primary chokepoint.</p></div>';
  }

  private renderList(): void {
    this.element.innerHTML = '';
    const listEl = document.createElement('div');
    listEl.className = 're-alternatives__list';
    listEl.setAttribute('role', 'listbox');
    listEl.setAttribute('aria-label', 'Alternative sea routes');

    this.seaOptions.forEach((option, idx) => {
      const card = renderRouteCard({
        option,
        index: idx,
        isActive: idx === this.activeIndex,
        onSelect: (o) => {
          this.activeIndex = idx;
          this.renderList();
          this.opts.onSelectBypass(o);
        },
      });
      listEl.append(card);
    });

    this.element.append(listEl);
  }

  private handleKeydown = (e: KeyboardEvent): void => {
    if (this.seaOptions.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = Math.min(this.activeIndex + 1, this.seaOptions.length - 1);
      if (next === this.activeIndex) return;
      this.activeIndex = next;
      this.renderList();
      this.focusActive();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const next = Math.max(this.activeIndex - 1, 0);
      if (next === this.activeIndex) return;
      this.activeIndex = next;
      this.renderList();
      this.focusActive();
    } else if (e.key === 'Enter' && this.activeIndex >= 0) {
      e.preventDefault();
      const option = this.seaOptions[this.activeIndex];
      if (option && option.status !== 'CORRIDOR_STATUS_UNAVAILABLE') {
        this.opts.onSelectBypass(option);
      }
    }
  };

  private focusActive(): void {
    const active = this.element.querySelector('.re-route-card--active') as HTMLElement | null;
    active?.focus();
  }
}
