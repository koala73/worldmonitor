import type { OrbitalTrackSurface } from '@/app/orbital-watch';
import { ORBITAL_SHARE_KEY, parseOrbitalShareFragment, withoutOrbitalShareFragment, type OrbitalShareLink } from '@/utils/urlState';

/**
 * Reads a satellite pass share link from the fragment and removes it from the live URL,
 * so nothing that later reads `location` sees the place. A malformed link is dropped.
 */
export function takeOrbitalShareLink(): OrbitalShareLink | null {
  const { hash } = window.location;
  if (!hash.includes(`${ORBITAL_SHARE_KEY}=`)) return null;
  const link = parseOrbitalShareFragment(hash);
  const url = new URL(window.location.href);
  const rest = withoutOrbitalShareFragment(hash);
  url.hash = rest ? `#${rest}` : '';
  try { history.replaceState(history.state, '', url.toString()); } catch { /* ignore */ }
  return link;
}

/** Opens the link once the map has had time to render, as the other deep links do. Returns a cancel. */
export function scheduleOrbitalShareLink(link: OrbitalShareLink, delayMs: number, isDestroyed: () => boolean, map: () => OrbitalTrackSurface | null = () => null): () => void {
  const timer = window.setTimeout(() => {
    if (isDestroyed()) return;
    void import('@/app/orbital-watch').then(({ openOrbitalShareLink }) =>
      openOrbitalShareLink(link, document.getElementById('mapContainer'), map()));
  }, delayMs);
  return () => window.clearTimeout(timer);
}
