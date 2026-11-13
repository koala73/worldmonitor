import type { GeoPoint } from '../../shared/orbital/pass-geometry.js';
import { getOrbitalPassClient, type PointPassLookup } from '@/services/orbital/pass-client';
import { ARCHIVE_SEARCHES, findArchiveEvidence } from '@/services/orbital/match';
import { OrbitalWatchPage } from '@/components/OrbitalWatchPage';

let page: OrbitalWatchPage | null = null;
let point: GeoPoint | null = null;
let lookup: PointPassLookup | null = null;
let run: AbortController | null = null;

const isAbort = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';

function cancel(): void {
  run?.abort();
  run = null;
}

async function checkArchives(found: PointPassLookup, signal: AbortSignal): Promise<void> {
  page!.render({ kind: 'passes', lookup: found, archives: { kind: 'checking', total: ARCHIVE_SEARCHES.length, progress: null } });
  const evidence = await findArchiveEvidence(found, {
    signal,
    onProgress: (progress) => {
      if (!signal.aborted) page!.render({ kind: 'passes', lookup: found, archives: { kind: 'checking', total: ARCHIVE_SEARCHES.length, progress } });
    },
  });
  if (!signal.aborted) page!.render({ kind: 'passes', lookup: found, archives: { kind: 'answered', evidence } });
}

async function start(): Promise<void> {
  cancel();
  const controller = new AbortController();
  run = controller;
  const { signal } = controller;
  try {
    if (!lookup) {
      page!.render({ kind: 'computing', done: 0, total: 0 });
      const found = await getOrbitalPassClient().lookup({ point: point! }, {
        signal,
        onProgress: (done, total) => {
          if (!signal.aborted) page!.render({ kind: 'computing', done, total });
        },
      });
      if (signal.aborted) return;
      if (found.catalog.status === 'empty') {
        page!.render({ kind: 'unavailable' });
        return;
      }
      lookup = found;
    }
    await checkArchives(lookup, signal);
  } catch (error) {
    if (!isAbort(error) && !signal.aborted) page!.render({ kind: 'unavailable' });
  }
}

/** Opens the satellite pass lookup for a point. The point stays in the browser. */
export function openOrbitalWatch(at: GeoPoint, returnFocusTo: HTMLElement | null): void {
  page ??= new OrbitalWatchPage({
    onClose: () => {
      cancel();
      lookup = null;
      point = null;
    },
    onRetry: () => void start(),
  });
  point = at;
  lookup = null;
  page.open(at, returnFocusTo);
  void start();
}

