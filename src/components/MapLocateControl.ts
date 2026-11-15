import { t } from '@/services/i18n';
import { h } from '@/utils/dom-utils';
import { requestDevicePosition } from '@/utils/user-location';
import { roundShareCoordinate } from '@/utils/urlState';
import { showMapContextMenu, type MapContextMenuItem } from './MapContextMenu';

export interface LocatedPoint {
  lat: number;
  lon: number;
}

export interface MapLocateControlCallbacks {
  /** Centres the map on the located point once it has an action; an empty point leaves the map where it was. */
  centre: (point: LocatedPoint) => void;
  /** The menu entries for the located point; empty when nothing applies there. */
  actions: (point: LocatedPoint) => MapContextMenuItem[] | Promise<MapContextMenuItem[]>;
}

export type MapLocateState = 'idle' | 'locating' | 'located' | 'denied' | 'unavailable' | 'empty';

const MENU_WIDTH = 200;
const SVG_NS = 'http://www.w3.org/2000/svg';

function locateIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.5');
  const ring = document.createElementNS(SVG_NS, 'circle');
  ring.setAttribute('cx', '8');
  ring.setAttribute('cy', '8');
  ring.setAttribute('r', '4.5');
  const dot = document.createElementNS(SVG_NS, 'circle');
  dot.setAttribute('cx', '8');
  dot.setAttribute('cy', '8');
  dot.setAttribute('r', '1.5');
  dot.setAttribute('fill', 'currentColor');
  const ticks = document.createElementNS(SVG_NS, 'path');
  ticks.setAttribute('d', 'M8 0.75v2.5M8 12.75v2.5M0.75 8h2.5M12.75 8h2.5');
  svg.append(ring, dot, ticks);
  return svg;
}

/**
 * The map's locate button. Location is requested only when it is pressed, and the
 * fix is cut to the 0.01° share grid before anything else sees it: the exact
 * position is not kept, logged or sent.
 */
export class MapLocateControl {
  readonly element: HTMLElement;
  private readonly button: HTMLButtonElement;
  private readonly status: HTMLElement;
  private request = 0;
  private destroyed = false;

  constructor(private readonly callbacks: MapLocateControlCallbacks) {
    const label = t('components.map.locate');
    this.button = h('button', {
      type: 'button',
      className: 'map-control-btn map-btn map-locate-btn',
      title: label,
      'aria-label': label,
      'aria-haspopup': 'menu',
      onClick: () => void this.locate(),
    }) as HTMLButtonElement;
    this.button.append(locateIcon());
    this.status = h('p', { className: 'map-locate-status', role: 'status', hidden: true });
    this.element = h('div', { className: 'map-locate' }, this.button, this.status);
    this.setState('idle');
  }

  get state(): MapLocateState {
    return (this.element.dataset.state as MapLocateState | undefined) ?? 'idle';
  }

  async locate(): Promise<void> {
    const request = ++this.request;
    this.setState('locating');
    const position = await requestDevicePosition();
    if (this.destroyed || request !== this.request) return;
    if (!position.ok) {
      this.setState(position.reason);
      return;
    }
    const point = { lat: roundShareCoordinate(position.lat), lon: roundShareCoordinate(position.lon) };
    let actions: MapContextMenuItem[];
    try {
      actions = await this.callbacks.actions(point);
    } catch {
      if (this.destroyed || request !== this.request) return;
      this.setState('unavailable');
      return;
    }
    if (this.destroyed || request !== this.request) return;
    if (actions.length === 0) {
      this.setState('empty');
      return;
    }
    this.callbacks.centre(point);
    this.setState('located');
    const rect = this.button.getBoundingClientRect();
    showMapContextMenu(Math.max(8, rect.left - MENU_WIDTH - 6), rect.top, actions);
  }

  destroy(): void {
    this.destroyed = true;
    this.element.remove();
  }

  private setState(state: MapLocateState): void {
    this.element.dataset.state = state;
    const busy = state === 'locating';
    this.button.disabled = busy;
    this.button.setAttribute('aria-busy', String(busy));
    const message = {
      idle: '',
      located: '',
      locating: t('components.mapLocate.locating', { defaultValue: 'Locating…' }),
      denied: t('components.mapLocate.denied', { defaultValue: 'Location access denied. Use Search to find a place.' }),
      unavailable: t('components.mapLocate.unavailable', { defaultValue: 'Location not found. Use Search to find a place.' }),
      empty: t('components.mapLocate.noCountry', { defaultValue: 'No country at your location. Use Search to find a place.' }),
    }[state];
    this.status.textContent = message;
    this.status.hidden = message === '';
  }
}
