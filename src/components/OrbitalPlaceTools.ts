import type { GeoPoint } from '../../shared/orbital/pass-geometry.js';
import { searchPlaces, type PlaceResult } from '@/services/orbital/place-search';
import { t } from '@/services/i18n';
import { requestDevicePosition } from '@/utils/user-location';
import { roundShareCoordinate } from '@/utils/urlState';
import { h, replaceChildren } from '@/utils/dom-utils';

export interface OrbitalPlaceToolsCallbacks {
  /** `name` is the searched place, or null for coordinates and the device location. */
  onPick: (point: GeoPoint, name: string | null) => void;
  /** The link for the open lookup, or null when no place is open. */
  shareLink: () => string | null;
}

/** Place search and locate controls for the lookup sheet's search row, and the share copy fallback. */
export class OrbitalPlaceTools {
  readonly element: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly status: HTMLElement;
  private readonly results: HTMLElement;
  private readonly shareStatus: HTMLElement;
  private readonly shareField: HTMLInputElement;
  private readonly note: HTMLElement;
  private readonly noteText: HTMLElement;
  private search: AbortController | null = null;

  constructor(private readonly callbacks: OrbitalPlaceToolsCallbacks) {
    const hintId = 'orbital-watch-search-hint';
    this.input = h('input', {
      type: 'search', className: 'ow-search-input', name: 'place', autocomplete: 'off', enterkeyhint: 'search',
      maxlength: '200', placeholder: t('orbitalWatch.search.placeholder'), 'aria-label': t('orbitalWatch.search.label'), 'aria-describedby': hintId,
    }) as HTMLInputElement;
    const form = h('form', { className: 'ow-search', role: 'search', onSubmit: (event: Event) => { event.preventDefault(); void this.submit(); } },
      this.input,
      h('button', { type: 'submit', className: 'ow-search-submit' }, t('orbitalWatch.search.submit')),
      h('button', { type: 'button', className: 'ow-locate', onClick: () => void this.locate() }, t('orbitalWatch.search.locate')));
    this.status = h('p', { className: 'ow-search-status', role: 'status' });
    this.results = h('ul', { className: 'ow-search-results', 'aria-label': t('orbitalWatch.search.results') });
    this.shareStatus = h('span', { className: 'ow-share-status', role: 'status' });
    this.shareField = h('input', { type: 'text', className: 'ow-share-link', readonly: true, hidden: true, 'aria-label': t('orbitalWatch.share.link') }) as HTMLInputElement;
    this.noteText = h('span');
    this.note = h('div', { className: 'ow-note', role: 'note', hidden: true },
      this.noteText,
      h('button', { type: 'button', className: 'ow-note-dismiss', 'aria-label': t('orbitalWatch.share.dismiss'), onClick: () => this.clearNote() }, '×'));
    this.element = h('div', { className: 'ow-tools' },
      form,
      h('p', { className: 'ow-search-hint', id: hintId }, t('orbitalWatch.search.hint')),
      this.status,
      this.results,
      this.shareStatus,
      this.shareField,
      this.note);
  }

  focusSearch(): void {
    this.input.focus();
  }

  clearShare(): void {
    this.shareStatus.textContent = '';
    this.shareField.hidden = true;
  }

  showNote(text: string): void {
    this.noteText.textContent = text;
    this.note.hidden = false;
  }

  clearNote(): void {
    this.note.hidden = true;
    this.noteText.textContent = '';
  }

  reset(): void {
    this.search?.abort();
    this.search = null;
    this.input.value = '';
    this.status.textContent = '';
    replaceChildren(this.results);
    this.clearNote();
    this.clearShare();
  }

  private pick(point: GeoPoint, name: string | null = null): void {
    this.search?.abort();
    this.search = null;
    replaceChildren(this.results);
    this.status.textContent = '';
    this.callbacks.onPick(point, name);
  }

  private async submit(): Promise<void> {
    this.search?.abort();
    const controller = new AbortController();
    this.search = controller;
    replaceChildren(this.results);
    this.status.textContent = t('orbitalWatch.search.searching');
    let outcome: Awaited<ReturnType<typeof searchPlaces>>;
    try {
      outcome = await searchPlaces(this.input.value, controller.signal);
    } catch {
      return;
    }
    if (controller.signal.aborted) return;
    this.search = null;
    switch (outcome.kind) {
      case 'empty':
        this.status.textContent = t('orbitalWatch.search.tooShort');
        return;
      case 'invalid-coordinates':
        this.status.textContent = t('orbitalWatch.search.invalidCoordinates');
        return;
      case 'failed':
        this.status.textContent = t('orbitalWatch.search.failed');
        return;
      case 'local':
        if (outcome.results.length === 1) {
          this.pick(outcome.results[0]!.point);
          return;
        }
        this.showResults(outcome.results);
        return;
      case 'searched':
        this.showResults(outcome.results);
    }
  }

  private showResults(results: PlaceResult[]): void {
    this.status.textContent = results.length === 0 ? t('orbitalWatch.search.noResults') : '';
    replaceChildren(this.results, ...results.map((result) => h('li', null,
      h('button', { type: 'button', className: 'ow-search-result', onClick: () => this.pick(result.point, result.kind === 'coordinates' ? null : result.name) },
        h('span', { className: 'ow-search-result-name' }, result.name),
        result.kind ? h('span', { className: 'ow-search-result-kind' }, result.kind) : null))));
  }

  private async locate(): Promise<void> {
    this.search?.abort();
    const controller = new AbortController();
    this.search = controller;
    replaceChildren(this.results);
    this.status.textContent = t('orbitalWatch.search.locating');
    const position = await requestDevicePosition();
    if (controller.signal.aborted) return;
    this.search = null;
    if (position.ok) {
      // The full-view route keeps the point in the address bar, so a device fix is cut to the share grid first.
      this.pick({ lat: roundShareCoordinate(position.lat), lon: roundShareCoordinate(position.lon) });
      return;
    }
    this.status.textContent = t(position.reason === 'denied' ? 'orbitalWatch.search.locationDenied' : 'orbitalWatch.search.locationUnavailable');
  }

  /** Copies the share link, and shows it to copy by hand when the clipboard refuses. Resolves to whether it was copied. */
  async share(): Promise<boolean> {
    const link = this.callbacks.shareLink();
    if (!link) return false;
    try {
      await navigator.clipboard.writeText(link);
      this.shareField.hidden = true;
      this.shareStatus.textContent = t('orbitalWatch.share.copied');
      return true;
    } catch {
      this.shareField.value = link;
      this.shareField.hidden = false;
      this.shareField.select();
      this.shareStatus.textContent = t('orbitalWatch.share.copyManually');
      return false;
    }
  }
}
