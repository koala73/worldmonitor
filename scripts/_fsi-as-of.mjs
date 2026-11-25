function fredLatestAt(obs) {
  const at = Date.parse(obs?.at(-1)?.date ?? '');
  return Number.isFinite(at) ? at : null;
}

/**
 * Unix ms of the oldest observation behind the FSI, or null when any input
 * lacks one. The VIX time follows the source fearGreed used: Yahoo when it
 * returned a dated price, else the latest FRED VIXCLS date.
 */
export function fsiAsOf({ hyg, tlt, vixData, vixObs, hyObs }) {
  const vixAt = vixData?.price != null && Number.isFinite(vixData.at) ? vixData.at : fredLatestAt(vixObs);
  const times = [hyg?.at, tlt?.at, vixAt, fredLatestAt(hyObs)];
  return times.every(Number.isFinite) ? Math.min(...times) : null;
}
