import { afterEach, describe, expect, it, vi } from 'vitest';

const poll = vi.hoisted(() => ({ tasks: [] as Array<(ctx: { signal?: AbortSignal }) => Promise<void>> }));

vi.mock('@/services/runtime', () => ({
  startSmartPollLoop: (task: (ctx: { signal?: AbortSignal }) => Promise<void>) => {
    poll.tasks.push(task);
    return { stop: vi.fn() };
  },
}));
vi.mock('@/services/aircraft-emergencies', async () => {
  const { EMERGENCY_CODES } = await import('../../shared/aircraft-emergencies');
  return {
    fetchAircraftEmergencies: async () => ({
      observations: [],
      feeds: EMERGENCY_CODES.map(squawk => ({ source: 'adsb.lol', squawk, status: 'available', fetchedAt: Date.now(), message: '' })),
    }),
  };
});

import { AircraftEmergencyLayer } from '@/components/AircraftEmergencyLayer';

const status = (container: HTMLElement) => container.querySelector('.aircraft-emergency-layer p')?.textContent;

describe('aircraft emergency layer re-enable', () => {
  afterEach(() => { vi.useRealTimers(); poll.tasks.length = 0; });

  it('shows loading, not a stale outage, when re-enabled after the previous snapshot aged out', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    const container = document.createElement('div');
    const layer = new AircraftEmergencyLayer(container, () => {});

    layer.setEnabled(true);
    await poll.tasks[0]!({});
    expect(status(container)).toBe('No matching squawks reported by this feed');

    layer.setEnabled(false);
    vi.setSystemTime(Date.now() + 130_000);
    layer.setEnabled(true);

    expect(status(container)).toBe('Loading aircraft feeds…');
    await poll.tasks[1]!({});
    expect(status(container)).toBe('No matching squawks reported by this feed');
    layer.destroy();
  });
});
