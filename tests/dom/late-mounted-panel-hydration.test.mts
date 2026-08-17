import { beforeAll, describe, expect, it, vi } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';

/**
 * Deferred panels below the IntersectionObserver margin (700px on mobile) are
 * constructed and mounted MINUTES after the boot data pass that is supposed to
 * fill them. Both panels here shipped a hole in that window:
 *
 *   - Threat Timeline: data-loader dropped the clustering result on the floor
 *     when `ctx.panels['threat-timeline']` was still undefined, so the panel
 *     mounted onto its constructor's "Waiting for intelligence insight data."
 *     empty state and stayed there.
 *   - AI Strategic Posture: its constructor starts the fetch, but the render
 *     bailed on `!element.isConnected` — and the element is only inserted into
 *     the grid AFTER the constructor returns. A cache-warm fetch resolves in a
 *     microtask, i.e. before the insert, so the panel sat on "Scanning
 *     Theaters" until the 15-minute scheduled refresh.
 *
 * Both are reproduced here through the real production call paths, in the real
 * order: construct detached → data arrives → insert → notifyConnected().
 */

const fixtures = vi.hoisted(() => ({
  posture: {
    postures: [
      {
        theaterId: 'taiwan-theater',
        theaterName: 'Taiwan Strait',
        shortName: 'TAIWAN',
        targetNation: 'Taiwan',
        fighters: 0,
        tankers: 0,
        awacs: 0,
        reconnaissance: 0,
        transport: 0,
        bombers: 0,
        drones: 0,
        totalAircraft: 14,
        destroyers: 0,
        frigates: 0,
        carriers: 0,
        submarines: 0,
        patrol: 0,
        auxiliaryVessels: 0,
        totalVessels: 0,
        byOperator: {},
        postureLevel: 'normal' as const,
        strikeCapable: false,
        trend: 'stable' as const,
        changePercent: 0,
        summary: '',
        headline: 'Normal activity - Taiwan Strait',
        centerLat: 24,
        centerLon: 122.5,
        bounds: { north: 30, south: 18, east: 130, west: 115 },
      },
    ],
    totalFlights: 14,
    timestamp: '2026-08-13T03:45:00.000Z',
    cached: true,
  },
}));

vi.mock('@/services/insights-loader', () => ({
  getServerInsights: vi.fn(() => null),
  fetchServerInsights: vi.fn(async () => null),
}));

vi.mock('@/services/cached-theater-posture', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/cached-theater-posture')>(),
  // Resolves on the microtask queue — the cache-warm shape that loses the race
  // against the grid insert.
  fetchCachedTheaterPosture: vi.fn(async () => fixtures.posture),
}));

vi.mock('@/services/military-vessels-lazy', () => ({
  getMilitaryVesselsModule: vi.fn(async () => ({
    fetchMilitaryVessels: async () => ({ vessels: [] }),
  })),
  isVesselRuntimeStoppedError: () => false,
}));

import { enqueuePanelCall, replayPendingCalls } from '@/app/pending-panel-data';
import { ThreatTimelinePanel } from '@/components/ThreatTimelinePanel';
import { StrategicPosturePanel } from '@/components/StrategicPosturePanel';
import type { ClusteredEvent } from '@/types';

beforeAll(async () => {
  await initTestI18n();
});

function recentCluster(): ClusteredEvent {
  const lastUpdated = new Date(Date.now() - 60 * 60 * 1000);
  return {
    id: 'cluster-strait',
    primaryTitle: 'Naval buildup reported in the Taiwan Strait',
    primarySource: 'Test Wire',
    primaryLink: 'https://example.com/strait',
    sourceCount: 4,
    uniquePublisherCount: 3,
    topSources: [],
    allItems: [],
    firstSeen: lastUpdated,
    lastUpdated,
    isAlert: true,
    threat: { level: 'critical', category: 'military', source: 'classifier' },
    velocity: {
      sourcesPerHour: 4,
      level: 'elevated',
      trend: 'rising',
      sentiment: 'negative',
      sentimentScore: -0.4,
    },
  } as unknown as ClusteredEvent;
}

/**
 * Wait until `text` is committed into the panel's DOM.
 *
 * Polls rather than sleeping a fixed span: `Panel` debounces content writes by
 * 150ms, and a fixed sleep long enough to cover that on a loaded machine adds
 * seconds of dead wall-clock to a suite whose other files run on a 5s per-test
 * timeout — the pre-push gate runs them all in parallel, so dead time here
 * shows up as timeouts elsewhere. Throws on the deadline so a genuine failure
 * still fails loudly instead of falling through to a confusing assertion.
 */
async function waitForText(element: HTMLElement, text: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (element.textContent?.includes(text)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for panel content to contain: ${text}`);
}

describe('threat timeline mounting after the clustering pass', () => {
  it('renders clusters queued while the panel was still a deferred shell', async () => {
    const panel = new ThreatTimelinePanel();
    const element = panel.getElement();
    await waitForText(element, 'Waiting for intelligence insight data.');

    // data-loader's callPanel() when ctx.panels['threat-timeline'] is undefined.
    enqueuePanelCall('threat-timeline', 'refresh', [[recentCluster()]]);

    // panel-layout replays BEFORE inserting the element into the grid, so the
    // render has to survive being painted into a detached subtree.
    await replayPendingCalls('threat-timeline', panel);
    document.body.append(element);
    panel.notifyConnected();
    await waitForText(element, 'Naval buildup reported in the Taiwan Strait');

    expect(element.textContent).not.toContain('Waiting for intelligence insight data.');
    expect(element.textContent).toContain('Naval buildup reported in the Taiwan Strait');

    panel.destroy();
  });
});

describe('strategic posture mounting after its own fetch resolves', () => {
  it('renders theaters when the fetch lands before the grid insert', async () => {
    const panel = new StrategicPosturePanel();
    const element = panel.getElement();

    // The fetch resolves here, while the element is still detached — exactly
    // what panel-layout does between `new PanelClass()` and mountPanelElement().
    // Waiting for the loading copy to COMMIT is what proves the fetch had its
    // chance to land and the panel is still on the skeleton.
    await waitForText(element, 'Scanning Theaters');

    document.body.append(element);
    panel.notifyConnected();
    await waitForText(element, 'Taiwan Strait');

    expect(element.textContent).not.toContain('Scanning Theaters');

    panel.destroy();
  });

  it('still renders on the ordinary path where the element is inserted first', async () => {
    const panel = new StrategicPosturePanel();
    const element = panel.getElement();
    document.body.append(element);
    panel.notifyConnected();
    await waitForText(element, 'Taiwan Strait');

    expect(element.textContent).toContain('Taiwan Strait');

    panel.destroy();
  });
});
