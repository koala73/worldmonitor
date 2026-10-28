import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EmergencySnapshot } from '../../shared/aircraft-emergencies';

const poll = vi.hoisted(() => ({
  tasks: [] as Array<(ctx: { signal?: AbortSignal }) => Promise<void>>,
  next: { observations: [], feeds: [] } as EmergencySnapshot,
}));

vi.mock('@/services/runtime', () => ({
  startSmartPollLoop: (task: (ctx: { signal?: AbortSignal }) => Promise<void>) => {
    poll.tasks.push(task);
    return { stop: vi.fn() };
  },
}));
vi.mock('@/services/aircraft-emergencies', () => ({ fetchAircraftEmergencies: async () => poll.next }));

import { EMERGENCY_CODES } from '../../shared/aircraft-emergencies';
import { AircraftEmergencyLayer } from '@/components/AircraftEmergencyLayer';

const feeds = (status: 'available' | 'unavailable') =>
  EMERGENCY_CODES.map(squawk => ({ source: 'adsb.lol', squawk, status, fetchedAt: Date.now(), message: '' }));
const panel = (container: HTMLElement) => container.querySelector<HTMLElement>('.aircraft-emergency-layer')!;

describe('aircraft emergency panel stays quiet when there is nothing to report', () => {
  afterEach(() => { poll.tasks.length = 0; });

  it('hides the panel while loading and when every feed is fresh with no matching squawks', async () => {
    const container = document.body.appendChild(document.createElement('div'));
    const layer = new AircraftEmergencyLayer(container, () => {});
    layer.setEnabled(true);
    expect(panel(container).hidden).toBe(true);

    poll.next = { observations: [], feeds: feeds('available') };
    await poll.tasks[0]!({});
    expect(panel(container).hidden).toBe(true);

    // Re-asserting the enabled state must not reopen a quiet panel.
    layer.setEnabled(true);
    expect(panel(container).hidden).toBe(true);
    layer.destroy();
  });

  it('opens the panel when a matching squawk is reported', async () => {
    const container = document.body.appendChild(document.createElement('div'));
    const layer = new AircraftEmergencyLayer(container, () => {});
    layer.setEnabled(true);
    const now = Date.now();
    poll.next = {
      feeds: feeds('available'),
      observations: [{
        address: 'abc123', squawk: '7700', source: 'adsb.lol', observedAt: now,
        position: { lat: 10, lon: 20, observedAt: now },
        callsign: 'TEST1', registration: '', aircraftType: '', description: '', militaryFlag: 'unknown',
      }],
    };
    await poll.tasks[0]!({});
    expect(panel(container).hidden).toBe(false);
    expect(panel(container).textContent).toContain('1 reported aircraft');
    layer.destroy();
  });

  // An empty map must not read as "no emergencies" when the feeds are down.
  it('opens the panel when the feeds are unavailable', async () => {
    const container = document.body.appendChild(document.createElement('div'));
    const layer = new AircraftEmergencyLayer(container, () => {});
    layer.setEnabled(true);
    poll.next = { observations: [], feeds: feeds('unavailable') };
    await poll.tasks[0]!({});
    expect(panel(container).hidden).toBe(false);
    expect(panel(container).textContent).toContain('Aircraft data unavailable or stale.');
    layer.destroy();
  });
});
