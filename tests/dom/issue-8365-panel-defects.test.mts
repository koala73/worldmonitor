import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';

vi.mock('@/services/storage', () => ({
  getSnapshotTimestamps: vi.fn(async () => [1_000, 2_000]),
  getSnapshotAt: vi.fn(),
}));

vi.mock('@/services/infrastructure', () => ({
  fetchServiceStatuses: vi.fn(),
}));

vi.mock('@/services/live-channels', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/live-channels')>();
  return {
    ...actual,
    loadChannelsFromStorage: vi.fn(() => actual.loadChannelsFromStorage()),
    getDefaultLiveChannels: vi.fn(() => actual.getDefaultLiveChannels()),
  };
});

vi.mock('@/services/rpc-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/rpc-client')>();
  return {
    ...actual,
    rpcFetch: () => new Promise(() => {}),
  };
});

vi.mock('@/services/story-renderer', () => ({
  renderStoryToCanvas: vi.fn(),
}));

const { deductSituation } = vi.hoisted(() => ({ deductSituation: vi.fn() }));
vi.mock('@/services/generated-rpc-clients', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/generated-rpc-clients')>(),
  IntelligenceServiceClient: class { deductSituation = deductSituation; },
}));

import { etfNetFlowLabel } from '@/components/ETFFlowsPanel';
import { fsiLabelDisplay } from '@/components/FSIPanel';
import { EnergyCrisisPanel } from '@/components/EnergyCrisisPanel';
import { DeductionPanel } from '@/components/DeductionPanel';
import { LiveNewsPanel } from '@/components/LiveNewsPanel';
import { PlaybackControl } from '@/components/PlaybackControl';
import { ServiceStatusPanel } from '@/components/ServiceStatusPanel';
import { TechEventsPanel } from '@/components/TechEventsPanel';
import { TradePolicyPanel } from '@/components/TradePolicyPanel';
import { closeStoryModal, openStoryModal } from '@/components/StoryModal';
import type { StoryData } from '@/services/story-data';
import { fetchServiceStatuses } from '@/services/infrastructure';
import { getDefaultLiveChannels, loadChannelsFromStorage } from '@/services/live-channels';
import { renderStoryToCanvas } from '@/services/story-renderer';
import { getSnapshotAt, getSnapshotTimestamps } from '@/services/storage';
import en from '@/locales/en.json';

beforeAll(async () => {
  await initTestI18n();
});

afterEach(() => {
  closeStoryModal();
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('issue 8365 panel labels', () => {
  it('labels a neutral ETF net flow as neutral', () => {
    expect(etfNetFlowLabel('NEUTRAL')).toBe('NET NEUTRAL');
    expect(etfNetFlowLabel('NET INFLOW')).toBe('NET INFLOW');
    expect(etfNetFlowLabel('NET OUTFLOW')).toBe('NET OUTFLOW');
  });

  it('translates the seeder High Stress bucket', () => {
    expect(fsiLabelDisplay('High Stress')).toBe('Severe Stress');
    expect(fsiLabelDisplay('Severe Stress')).toBe('Severe Stress');
  });

  it('describes the live HYG/TLT formula instead of KCFSI', () => {
    const tooltip = en.components.fsi.infoTooltip;
    expect(tooltip).toMatch(/HYG/);
    expect(tooltip).toMatch(/TLT/);
    expect(tooltip).toMatch(/not the Kansas City Fed/);
    expect(tooltip).not.toMatch(/KCFSI/);
  });
});

describe('TradePolicyPanel principal reset', () => {
  it('drops cached responses and rebuilds controls after an unlocked account switch', async () => {
    vi.useFakeTimers();
    const panel = new TradePolicyPanel();
    document.body.append(panel.getElement());
    const fields = ['restrictionsData', 'tariffsData', 'flowsData', 'barriersData', 'revenueData', 'comtradeData'];
    const view = panel as unknown as Record<string, unknown>;
    const oldLoad = panel.beginDataLoad();
    for (const field of fields) view[field] = { owner: 'previous-account' };
    panel.clearSensitiveContent();
    panel.unlockPanel();
    expect(panel.acceptsDataLoad(oldLoad)).toBe(false);
    expect(panel.acceptsDataLoad(panel.beginDataLoad())).toBe(true);
    await vi.advanceTimersByTimeAsync(200);
    for (const field of fields) expect(view[field]).toBeNull();
    expect(panel.getElement().querySelector('.panel-tab[data-tab="restrictions"]')).not.toBeNull();
    expect(panel.getElement().textContent).not.toContain('previous-account');
    panel.destroy();
  });
});

describe('DeductionPanel principal reset', () => {
  it('discards an old analysis and restores an empty usable form', async () => {
    const pending = deferred<{ analysis: string }>();
    deductSituation.mockReturnValueOnce(pending.promise);
    const panel = new DeductionPanel();
    document.body.append(panel.getElement());
    const view = panel as unknown as { handleSubmit: (event: Event) => Promise<void> };
    const input = panel.getElement().querySelector<HTMLTextAreaElement>('.deduction-input')!;
    const geo = panel.getElement().querySelector<HTMLInputElement>('.deduction-geo-input')!;
    input.value = 'Private question';
    geo.value = 'Private context';
    const request = view.handleSubmit(new Event('submit'));
    panel.clearSensitiveContent();
    panel.unlockPanel();
    pending.resolve({ analysis: 'Private answer' });
    await request;
    expect(input.value).toBe('');
    expect(geo.value).toBe('');
    expect(panel.getElement().textContent).not.toContain('Private answer');
    expect(panel.getElement().querySelector<HTMLButtonElement>('.deduction-submit-btn')!.disabled).toBe(false);
    panel.destroy();
  });

  it('aborts the previous account in-flight request instead of only discarding it', async () => {
    let requestSignal: AbortSignal | undefined;
    deductSituation.mockImplementationOnce((_req: unknown, options?: { signal?: AbortSignal }) => {
      requestSignal = options?.signal;
      return new Promise(() => {});
    });
    const panel = new DeductionPanel();
    document.body.append(panel.getElement());
    const view = panel as unknown as { handleSubmit: (event: Event) => Promise<void> };
    panel.getElement().querySelector<HTMLTextAreaElement>('.deduction-input')!.value = 'Private question';
    void view.handleSubmit(new Event('submit'));
    await vi.waitFor(() => expect(deductSituation).toHaveBeenCalled());
    expect(requestSignal).toBeInstanceOf(AbortSignal);
    expect(requestSignal?.aborted).toBe(false);
    panel.clearSensitiveContent();
    expect(requestSignal?.aborted).toBe(true);
    panel.destroy();
  });
});

describe('EnergyCrisisPanel filter binding', () => {
  it('binds filter clicks on the stable content node after a debounced render', async () => {
    vi.useFakeTimers();
    const panel = new EnergyCrisisPanel();
    document.body.appendChild(panel.getElement());
    const view = panel as unknown as {
      loading: boolean;
      data: {
        policies: Array<Record<string, string>>;
        sourceUrl: string;
        updatedAt: string;
      };
      render: () => void;
    };
    view.loading = false;
    view.data = {
      policies: [{
        category: 'conservation',
        sector: 'transport',
        status: 'active',
        country: 'France',
        countryCode: 'FR',
        measure: 'Cap speed',
        dateAnnounced: '2026-01-01',
      }],
      sourceUrl: 'https://www.iea.org/tracker',
      updatedAt: '2026-01-02T00:00:00.000Z',
    };
    view.render();
    await vi.advanceTimersByTimeAsync(200);

    panel.getElement().querySelector<HTMLButtonElement>('[data-filter="conservation"]')?.click();
    await vi.advanceTimersByTimeAsync(200);

    expect(panel.getElement().querySelector('.ecp-filter-active')?.getAttribute('data-filter')).toBe('conservation');
    panel.destroy();
  });
});

describe('PlaybackControl stale snapshots', () => {
  it('keeps the newest timestamp list when an earlier open resolves last', async () => {
    const older = deferred<number[]>();
    const newer = deferred<number[]>();
    vi.mocked(getSnapshotTimestamps).mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const control = new PlaybackControl();
    document.body.appendChild(control.getElement());
    const toggle = control.getElement().querySelector<HTMLButtonElement>('.playback-toggle')!;
    toggle.click();
    toggle.click();
    toggle.click();
    newer.resolve([3_000, 1_000, 2_000]);
    await Promise.resolve();
    older.resolve([1_000]);
    await Promise.resolve();
    const slider = control.getElement().querySelector<HTMLInputElement>('.playback-slider')!;
    expect(slider.max).toBe('2');
    expect(slider.value).toBe('2');
    vi.mocked(getSnapshotAt).mockResolvedValueOnce(null);
    slider.value = '2';
    slider.dispatchEvent(new Event('input'));
    expect(getSnapshotAt).toHaveBeenLastCalledWith(3_000);
    control.exitPlayback();
  });

  it('ignores a snapshot that resolves after Live', async () => {
    const pending = deferred<{ clusters: [] }>();
    vi.mocked(getSnapshotAt).mockReturnValueOnce(pending.promise as never);
    const control = new PlaybackControl();
    document.body.appendChild(control.getElement());
    const applied: Array<unknown> = [];
    control.onSnapshot((snapshot) => { applied.push(snapshot); });

    control.getElement().querySelector<HTMLButtonElement>('.playback-toggle')?.click();
    await vi.waitFor(() => {
      expect(control.getElement().querySelector('.playback-panel')?.classList.contains('hidden')).toBe(false);
    });

    const slider = control.getElement().querySelector<HTMLInputElement>('.playback-slider');
    expect(slider).not.toBeNull();
    slider!.value = '0';
    slider!.dispatchEvent(new Event('input'));
    control.getElement().querySelector<HTMLButtonElement>('[data-action="live"]')?.click();
    pending.resolve({ clusters: [] });
    await Promise.resolve();
    await Promise.resolve();

    expect(applied).not.toContainEqual({ clusters: [] });
    expect(control.isInPlaybackMode()).toBe(false);
    expect(document.body.classList.contains('playback-mode')).toBe(false);
    expect(control.getElement().querySelector('.playback-time')?.textContent).toBe('LIVE');
  });
});

describe('LiveNewsPanel channel refresh', () => {
  it('switches away from a deleted channel before the tab is updated', () => {
    const panel = new LiveNewsPanel();
    document.body.appendChild(panel.getElement());
    const view = panel as unknown as {
      activeChannel: { id: string; name: string };
      switchChannel: (channel: { id: string }) => Promise<void>;
    };
    view.activeChannel = { id: 'playing', name: 'Playing' };
    const order: string[] = [];
    vi.spyOn(view, 'switchChannel').mockImplementation(async (channel) => {
      order.push(`${channel.id}:${view.activeChannel.id}`);
    });
    vi.mocked(loadChannelsFromStorage).mockReturnValue([{ id: 'replacement', name: 'Replacement' }]);

    panel.refreshChannelsFromStorage();

    expect(order).toEqual(['replacement:playing']);
    panel.destroy();
  });

  it('renders a placeholder instead of throwing when no channels remain', () => {
    vi.mocked(loadChannelsFromStorage).mockReturnValue([]);
    vi.mocked(getDefaultLiveChannels).mockReturnValue([]);
    const panel = new LiveNewsPanel();
    document.body.appendChild(panel.getElement());

    expect(() => panel.refreshChannelsFromStorage()).not.toThrow();
    expect(panel.getElement().querySelector('.live-news-placeholder')).not.toBeNull();
    panel.destroy();
  });

  it('removes channel drag listeners on destroy', () => {
    vi.mocked(loadChannelsFromStorage).mockReturnValue([{ id: 'one', name: 'One' }]);
    vi.mocked(getDefaultLiveChannels).mockReturnValue([{ id: 'one', name: 'One' }]);
    const panel = new LiveNewsPanel();
    document.body.appendChild(panel.getElement());
    const button = panel.getElement().querySelector('.live-channel-btn');
    expect(button).not.toBeNull();
    button!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 10 }));
    const remove = vi.spyOn(document, 'removeEventListener');
    panel.destroy();
    const types = remove.mock.calls.map((call) => call[0]);
    expect(types).toContain('mousemove');
    expect(types).toContain('mouseup');
  });
});

describe('ServiceStatusPanel empty fleet', () => {
  it('shows an error instead of all-operational when the fetch returns no services', async () => {
    vi.mocked(fetchServiceStatuses).mockResolvedValue({
      success: true,
      timestamp: '2026-09-19T00:00:00.000Z',
      summary: { operational: 0, degraded: 0, outage: 0, unknown: 0 },
      services: [],
    });
    const panel = new ServiceStatusPanel();
    document.body.appendChild(panel.getElement());

    await panel.fetchStatus();

    expect(panel.getElement().querySelector('.all-operational')).toBeNull();
    expect(panel.getElement().textContent).toMatch(/Temporarily unavailable/i);
    panel.destroy();
  });
});

describe('TechEventsPanel map pin', () => {
  it('calls the injected map handler instead of a window event', () => {
    const panel = new TechEventsPanel('events');
    document.body.appendChild(panel.getElement());
    const visited: Array<[number, number]> = [];
    const events: string[] = [];
    window.addEventListener('tech-event-location', () => { events.push('fired'); });
    panel.setMapNavigateHandler((lat, lng) => { visited.push([lat, lng]); });
    const view = panel as unknown as {
      loading: boolean;
      error: string | null;
      viewMode: string;
      events: unknown[];
      render: () => void;
    };
    view.loading = false;
    view.error = null;
    view.viewMode = 'conferences';
    view.events = [{
      id: 'conf-1',
      title: 'Test Conf',
      type: 'conference',
      location: 'Paris',
      startDate: '2099-01-01',
      endDate: '2099-01-02',
      url: 'https://example.com',
      source: 'test',
      description: '',
      coords: { lat: 48.8, lng: 2.3, country: 'FR', original: 'Paris', virtual: false },
    }];
    view.render();

    panel.getElement().querySelector<HTMLButtonElement>('.event-map-link')?.click();

    expect(visited).toEqual([[48.8, 2.3]]);
    expect(events).toEqual([]);
    panel.destroy();
  });
});

describe('StoryModal stale canvas', () => {
  it('does not paint a canvas that finishes after the modal moved on', async () => {
    const first = deferred<{ toDataURL: (type: string) => string }>();
    vi.mocked(renderStoryToCanvas)
      .mockReturnValueOnce(first.promise as never)
      .mockResolvedValueOnce({ toDataURL: () => `data:image/png;base64,${btoa('fr')}` } as never);

    openStoryModal(story('US', 'United States'));
    await vi.waitFor(() => {
      expect(renderStoryToCanvas).toHaveBeenCalledTimes(1);
    });
    openStoryModal(story('FR', 'France'));
    await vi.waitFor(() => {
      expect(renderStoryToCanvas).toHaveBeenCalledTimes(2);
    });
    first.resolve({ toDataURL: () => `data:image/png;base64,${btoa('us')}` });
    await Promise.resolve();
    await Promise.resolve();

    const alt = document.querySelector('.story-image')?.getAttribute('alt') ?? '';
    expect(alt).toContain('France');
    expect(alt).not.toContain('United States');
    closeStoryModal();
  });
});

function story(countryCode: string, countryName: string): StoryData {
  return {
    countryCode,
    countryName,
    cii: null,
    news: [],
    theater: null,
    markets: [],
    threats: { critical: 0, high: 0, medium: 0, categories: [] },
    signals: { protests: 0, militaryFlights: 0, militaryVessels: 0, outages: 0, gpsJammingHexes: 0 },
    convergence: null,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
