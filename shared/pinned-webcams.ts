const PLAYER_ORIGIN = 'https://webcams.windy.com';
const PLAYER_PATH = '/webcams/public/embed/player';
const WEBCAM_ID = /^[\w-]{1,64}$/;
const PLAYER_PERIODS = new Set(['day', 'month', 'year', 'lifetime', 'live']);
export const PINNED_WEBCAMS_KEY = 'wm-pinned-webcams';
export const MAX_PINNED_WEBCAMS = 32;
export const MAX_ACTIVE_WEBCAMS = 4;
export const MAX_PINNED_WEBCAMS_BYTES = 16 * 1024;
const encoder = new TextEncoder();

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

export function normalizePinnedWebcams(raw: unknown): PinnedWebcam[] {
  if (typeof raw !== 'string' || raw.length > MAX_PINNED_WEBCAMS_BYTES
    || encoder.encode(raw).length > MAX_PINNED_WEBCAMS_BYTES) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return []; }
  return normalizePinnedWebcamList(parsed);
}

export function normalizePinnedWebcamList(parsed: unknown): PinnedWebcam[] {
  if (!Array.isArray(parsed)) return [];
  const webcams: PinnedWebcam[] = [];
  const ids = new Set<string>();
  let bytes = 2;
  for (const value of parsed) {
    const webcam = normalizePinnedWebcam(value);
    if (!webcam || ids.has(webcam.webcamId)) continue;
    const size = encoder.encode(JSON.stringify({ ...webcam, active: false })).length + (webcams.length ? 1 : 0);
    if (bytes + size > MAX_PINNED_WEBCAMS_BYTES) continue;
    webcams.push(webcam);
    ids.add(webcam.webcamId);
    bytes += size;
    if (webcams.length === MAX_PINNED_WEBCAMS) break;
  }
  const activeIds = new Set(webcams.filter(cam => cam.active)
    .sort((a, b) => a.pinnedAt - b.pinnedAt)
    .slice(0, MAX_ACTIVE_WEBCAMS).map(cam => cam.webcamId));
  for (const webcam of webcams) webcam.active = activeIds.has(webcam.webcamId);
  return webcams;
}

export function normalizePinnedWebcamsPreference(raw: unknown): string {
  return JSON.stringify(normalizePinnedWebcams(raw));
}

export function normalizeWebcamPreferences(data: unknown): unknown {
  if (!data || typeof data !== 'object' || Array.isArray(data)
    || !Object.prototype.hasOwnProperty.call(data, PINNED_WEBCAMS_KEY)) return data;
  const prefs = data as Record<string, unknown>;
  return { ...prefs, [PINNED_WEBCAMS_KEY]: normalizePinnedWebcamsPreference(prefs[PINNED_WEBCAMS_KEY]) };
}
