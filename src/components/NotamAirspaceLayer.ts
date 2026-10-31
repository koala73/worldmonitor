import { currentRestrictions, fetchNotamAirspace, type NotamAirspaceRestriction } from '@/services/notam-airspace';
import { startSmartPollLoop, type SmartPollLoopHandle } from '@/services/runtime';

// The seeder publishes every 5 minutes; polling faster only re-reads the CDN copy.
const POLL_INTERVAL_MS = 5 * 60_000;

/**
 * Fetches FAA NMS airspace restrictions while the Aviation (flights) layer is on
 * and hands them to the renderer. Off means no requests and an empty layer.
 * A failed refresh keeps the last snapshot, re-filtered on every tick so
 * NOTAMs that have ended since it was published drop off the map.
 */
export class NotamAirspaceLayer {
  private loop?: SmartPollLoopHandle;
  private enabled = false;
  private latest: NotamAirspaceRestriction[] | null = null;

  constructor(private paint: (restrictions: NotamAirspaceRestriction[]) => void) {}

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    if (!enabled) {
      this.loop?.stop();
      this.loop = undefined;
      this.latest = null;
      this.paint([]);
      return;
    }
    this.loop = startSmartPollLoop(async ({ signal }) => {
      const snapshot = await fetchNotamAirspace();
      if (!this.enabled || signal?.aborted) return;
      if (snapshot) this.latest = snapshot.notams;
      if (this.latest) this.paint(currentRestrictions(this.latest, Date.now()));
    }, { intervalMs: POLL_INTERVAL_MS, pauseWhenHidden: true, refreshOnVisible: true, runImmediately: true });
  }

  destroy(): void {
    this.setEnabled(false);
  }
}
