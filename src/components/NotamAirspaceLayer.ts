import { fetchNotamAirspace, type NotamAirspaceRestriction } from '@/services/notam-airspace';
import { startSmartPollLoop, type SmartPollLoopHandle } from '@/services/runtime';

// The seeder publishes every 5 minutes; polling faster only re-reads the CDN copy.
const POLL_INTERVAL_MS = 5 * 60_000;

/**
 * Fetches FAA NMS airspace restrictions while the notamAirspace layer is on
 * and hands them to the renderer. Off means no requests and an empty layer.
 * A failed refresh keeps the last snapshot on the map.
 */
export class NotamAirspaceLayer {
  private loop?: SmartPollLoopHandle;
  private enabled = false;

  constructor(private paint: (restrictions: NotamAirspaceRestriction[]) => void) {}

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    if (!enabled) {
      this.loop?.stop();
      this.loop = undefined;
      this.paint([]);
      return;
    }
    this.loop = startSmartPollLoop(async ({ signal }) => {
      const snapshot = await fetchNotamAirspace();
      if (!this.enabled || signal?.aborted || !snapshot) return;
      this.paint(snapshot.notams);
    }, { intervalMs: POLL_INTERVAL_MS, pauseWhenHidden: true, refreshOnVisible: true, runImmediately: true });
  }

  destroy(): void {
    this.setEnabled(false);
  }
}
