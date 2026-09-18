const PLAYER_ORIGIN = 'https://webcams.windy.com';
const PLAYER_PATH = '/webcams/public/embed/player';
const WEBCAM_ID = /^[\w-]{1,64}$/;
const PLAYER_PERIODS = new Set(['day', 'month', 'year', 'lifetime', 'live']);

export interface PinnedWebcam {
  webcamId: string;
  title: string;
  lat: number;
  lng: number;
  category: string;
  country: string;
  playerUrl: string;
  active: boolean;
  pinnedAt: number;
}

export function resolveWebcamPlayerUrl(webcamId: string, playerUrl: unknown): string | null {
  if (!WEBCAM_ID.test(webcamId) || webcamId !== webcamId.trim()) return null;
  const fallback = `${PLAYER_ORIGIN}${PLAYER_PATH}/${webcamId}/day`;
  if (typeof playerUrl !== 'string' || !playerUrl) return fallback;
  try {
    const url = new URL(playerUrl);
    if (url.origin !== PLAYER_ORIGIN || url.username || url.password) return fallback;
    const path = url.pathname;
    const queryIds = url.searchParams.getAll('webcamId');
    const queryPeriods = url.searchParams.getAll('playerType');
    if (queryIds.some(id => id !== webcamId) || queryIds.length > 1
      || queryPeriods.some(period => !PLAYER_PERIODS.has(period)) || queryPeriods.length > 1) return fallback;
    const suffix = path.slice(PLAYER_PATH.length).split('/');
    const validPath = path.startsWith(`${PLAYER_PATH}/`) && suffix.length === 3
      && suffix[1] === webcamId && PLAYER_PERIODS.has(suffix[2] ?? '');
    const validQuery = path === PLAYER_PATH && queryIds.length === 1;
    return validPath || validQuery ? url.href : fallback;
  } catch {
    return fallback;
  }
}

/** Parse at consumption, since cloud restore and imports can bypass pinWebcam. */
export function normalizePinnedWebcam(value: unknown): PinnedWebcam | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.webcamId !== 'string' || typeof row.title !== 'string'
    || typeof row.category !== 'string' || typeof row.country !== 'string'
    || typeof row.lat !== 'number' || !Number.isFinite(row.lat) || Math.abs(row.lat) > 90
    || typeof row.lng !== 'number' || !Number.isFinite(row.lng) || Math.abs(row.lng) > 180
    || typeof row.active !== 'boolean' || typeof row.pinnedAt !== 'number'
    || !Number.isFinite(row.pinnedAt) || row.pinnedAt < 0
    || (row.playerUrl !== undefined && typeof row.playerUrl !== 'string')) return null;
  const playerUrl = resolveWebcamPlayerUrl(row.webcamId, row.playerUrl);
  if (!playerUrl) return null;
  return {
    webcamId: row.webcamId, title: row.title, lat: row.lat, lng: row.lng,
    category: row.category, country: row.country, playerUrl,
    active: row.active, pinnedAt: row.pinnedAt,
  };
}
