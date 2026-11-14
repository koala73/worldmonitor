import type { GeoPoint } from '../../shared/orbital/pass-geometry.js';
import { t } from '@/services/i18n';
import { h } from '@/utils/dom-utils';

const FOCUSABLE = 'button:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function formatPoint(point: GeoPoint): string {
  const lat = `${Math.abs(point.lat).toFixed(3)}°${point.lat >= 0 ? 'N' : 'S'}`;
  const lon = `${Math.abs(point.lon).toFixed(3)}°${point.lon >= 0 ? 'E' : 'W'}`;
  return `${lat} ${lon}`;
}

export function closeButton(): HTMLElement {
  return h('button', { type: 'button', className: 'oiv-close', 'aria-label': t('orbitalWatch.viewer.close'), dataset: { action: 'close' } },
    h('span', { className: 'oiv-label' }, t('orbitalWatch.viewer.closeLabel')), h('kbd', null, 'ESC'), h('span', { 'aria-hidden': 'true' }, '×'));
}

export function reticle(): HTMLElement {
  return h('span', { className: 'oiv-reticle', 'aria-hidden': 'true' });
}

/** Keeps Tab inside a modal dialog. */
export function trapTab(event: KeyboardEvent, dialog: HTMLElement): void {
  if (event.key !== 'Tab') return;
  const focusable = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)];
  if (focusable.length === 0) return;
  const first = focusable[0]!;
  const last = focusable[focusable.length - 1]!;
  if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}
