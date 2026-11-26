/**
 * Demand readout wiring for server-side playback (#11410): the real playback
 * control and country history section report what the user did, and nothing
 * for what the code did on its own (the section auto-selects the latest day).
 * Storage, the history fetch and the analytics sink are the only mocks.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { initTestI18n } from './helpers/i18n.mts';

const trackPlaybackAction = vi.fn();
const trackCountryHistoryAction = vi.fn();
const trackCountryHistoryUpsellClick = vi.fn();
vi.mock('@/services/analytics', () => ({ trackPlaybackAction, trackCountryHistoryAction, trackCountryHistoryUpsellClick }));

let timestamps: number[] = [];
let storageAvailable = true;
vi.mock('@/services/storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/storage')>()),
  isStorageAvailable: vi.fn(async () => storageAvailable),
  getSnapshotTimestamps: vi.fn(async () => timestamps),
  getSnapshotAt: vi.fn(async () => null),
}));
vi.mock('@/services/country-history', () => ({ fetchCountryHistory: vi.fn() }));
vi.mock('@/services/entitlements', () => ({ onEntitlementChange: () => () => {} }));

const { PlaybackControl } = await import('@/components/PlaybackControl');
const { CountryHistory } = await import('@/components/CountryHistory');
const { fetchCountryHistory } = await import('@/services/country-history');

const history = (allowedDays: number) => ({
  country: 'US', requestedDays: 7, allowedDays, effectiveDays: 7, returnedDays: 2, stale: false, upstreamUnavailable: false, fetchedAt: Date.now(),
  points: [
    { date: '2026-11-24', capturedAt: 1795564800000, cii: { score: 30, version: 'v15', observedAt: 1795564800000 }, topEvents: [], keySignals: [], ciiVersionBreak: false, resilienceVersionBreak: false },
    { date: '2026-11-25', capturedAt: 1795651200000, cii: { score: 32, version: 'v15', observedAt: 1795651200000 }, topEvents: [], keySignals: [], ciiVersionBreak: false, resilienceVersionBreak: false },
  ],
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeAll(async () => { await initTestI18n(); });
beforeEach(() => {
  trackPlaybackAction.mockClear();
  trackCountryHistoryAction.mockClear();
  trackCountryHistoryUpsellClick.mockClear();
  vi.mocked(fetchCountryHistory).mockReset();
  timestamps = [];
  storageAvailable = true;
  document.body.replaceChildren();
});

describe('playback demand events', () => {
  it('reports open with the local snapshot count, then step and live', async () => {
    timestamps = [1_000, 2_000, 3_000];
    const control = new PlaybackControl();
    const root = control.getElement();
    document.body.append(root);

    root.querySelector<HTMLButtonElement>('.playback-toggle')!.click();
    await settle();
    expect(trackPlaybackAction).toHaveBeenCalledTimes(1);
    expect(trackPlaybackAction).toHaveBeenLastCalledWith('open', 3);

    const slider = root.querySelector<HTMLInputElement>('.playback-slider')!;
    slider.value = '0';
    slider.dispatchEvent(new Event('input'));
    expect(trackPlaybackAction).toHaveBeenLastCalledWith('step');

    root.querySelector<HTMLButtonElement>('[data-action="next"]')!.click();
    expect(trackPlaybackAction).toHaveBeenLastCalledWith('step');

    root.querySelector<HTMLButtonElement>('.playback-live')!.click();
    expect(trackPlaybackAction).toHaveBeenLastCalledWith('live');
  });

  function mountControl() {
    const control = new PlaybackControl();
    const root = control.getElement();
    document.body.append(root);
    return {
      root,
      toggle: root.querySelector<HTMLButtonElement>('.playback-toggle')!,
      button: (action: string) => root.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)!,
    };
  }

  it('reports a blocked database as blocked, not as an empty history', async () => {
    storageAvailable = false;
    timestamps = [1_000];
    const ui = mountControl();
    await new Promise((resolve) => { ui.toggle.click(); setTimeout(resolve, 0); });
    expect(trackPlaybackAction).toHaveBeenCalledWith('open', null);
    expect(trackPlaybackAction).not.toHaveBeenCalledWith('open', 0);
  });

  it('does not count a step or a return to live that changes nothing', async () => {
    timestamps = [1_000, 2_000];
    const ui = mountControl();
    ui.toggle.click();
    await settle();
    trackPlaybackAction.mockClear();

    // Opens live on the newest snapshot: Live is a no-op, and end and next do
    // not move the index. (End does replay that newest snapshot, so a Live
    // click after it is a real return and is not asserted here.)
    ui.root.querySelector<HTMLButtonElement>('.playback-live')!.click();
    ui.button('end').click();
    ui.button('next').click();
    expect(trackPlaybackAction).not.toHaveBeenCalled();

    ui.button('prev').click();
    expect(trackPlaybackAction).toHaveBeenLastCalledWith('step');
  });

  it('does not count stepping through an empty history', async () => {
    const ui = mountControl();
    ui.toggle.click();
    await settle();
    trackPlaybackAction.mockClear();
    for (const action of ['start', 'prev', 'next', 'end']) ui.button(action).click();
    expect(trackPlaybackAction).not.toHaveBeenCalled();
  });
});

describe('country history demand events', () => {
  it('ignores the automatic latest-day selection and reports a user date click', async () => {
    vi.mocked(fetchCountryHistory).mockResolvedValue(history(7));
    const mount = document.createElement('div');
    document.body.append(mount);
    const widget = new CountryHistory(mount, 'US', new AbortController().signal);
    await vi.waitFor(() => expect(mount.querySelector('[data-history-date="2026-11-25"]')?.getAttribute('aria-pressed')).toBe('true'));
    expect(trackCountryHistoryAction).not.toHaveBeenCalled();

    (mount.querySelector('[data-history-date="2026-11-24"]') as HTMLButtonElement).click();
    expect(trackCountryHistoryAction).toHaveBeenCalledWith('date-select');
    expect(mount.querySelector('.country-history-detail')?.textContent).toContain('CII 30');
    widget.destroy();
  });

  it('reports the upsell click with the viewer allowance', async () => {
    vi.mocked(fetchCountryHistory).mockResolvedValue(history(7));
    const mount = document.createElement('div');
    document.body.append(mount);
    const widget = new CountryHistory(mount, 'US', new AbortController().signal);
    const upsell = await vi.waitFor(() => {
      const link = mount.querySelector<HTMLAnchorElement>('.panel-locked-cta');
      expect(link).not.toBeNull();
      return link!;
    });
    upsell.addEventListener('click', (event) => event.preventDefault());
    upsell.click();
    expect(trackCountryHistoryUpsellClick).toHaveBeenCalledWith(7);
    trackCountryHistoryUpsellClick.mockClear();
    // Middle-click opens a new tab and fires auxclick, not click.
    upsell.dispatchEvent(new MouseEvent('auxclick', { button: 1, bubbles: true }));
    expect(trackCountryHistoryUpsellClick).toHaveBeenCalledWith(7);
    widget.destroy();
  });

  it('reports a window change with the chosen length', async () => {
    vi.mocked(fetchCountryHistory).mockResolvedValue(history(90));
    const mount = document.createElement('div');
    document.body.append(mount);
    const widget = new CountryHistory(mount, 'US', new AbortController().signal);
    const select = await vi.waitFor(() => {
      const element = mount.querySelector('select');
      expect(element).not.toBeNull();
      return element!;
    });
    select.value = '30';
    select.dispatchEvent(new Event('change'));
    expect(trackCountryHistoryAction).toHaveBeenCalledWith('window-change', { days: 30 });
    widget.destroy();
  });
});
