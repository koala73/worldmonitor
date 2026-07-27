export const DESK_OVERLAY_URL = 'https://dev.westkite.dev/desk/data/world_case_files.json';

export type DeskOverlayStatus = 'ok' | 'baseline' | 'partial' | 'data_check' | 'unavailable';

export interface DeskOverlayMapLocation {
  label: string;
  lat: number;
  lon: number;
}

export interface DeskOverlayCaseFile {
  id: string;
  category: string;
  severity: 'elevated' | 'observe';
  title: string;
  summary: string;
  impactAreas: string[];
  observedAt: string | null;
  evidenceUrl: string | null;
  deskUrl: string | null;
  mapLocation: DeskOverlayMapLocation | null;
}

export interface DeskOverlayResult {
  status: DeskOverlayStatus;
  generatedAt: string | null;
  caveats: string[];
  caseFiles: DeskOverlayCaseFile[];
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

const REQUIRED_SAFETY_FLAGS = Object.freeze({
  context_only: true,
  research_only: true,
  use_as_execution_signal: false,
  paper_live_approval_signal: false,
  no_broker_connection: true,
  no_order_submission: true,
  no_live_orders: true,
  no_actual_trades: true,
});

/** Fetches a public, Desk-owned overlay with no cookies or ambient credentials. */
export async function loadDeskOverlay({
  fetchImpl = fetch as FetchLike,
  url = DESK_OVERLAY_URL,
}: {
  fetchImpl?: FetchLike;
  url?: string;
} = {}): Promise<DeskOverlayResult> {
  try {
    const response = await fetchImpl(url, {
      cache: 'no-store',
      credentials: 'omit',
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return unavailableResult('Desk Overlay public artifact was unavailable.');
    return parseDeskOverlay(await response.json());
  } catch {
    return unavailableResult('Desk Overlay public artifact could not be loaded.');
  }
}

/** Validates an untrusted public artifact before it reaches globe rendering. */
export function parseDeskOverlay(payload: unknown): DeskOverlayResult {
  if (!isRecord(payload)
    || payload.schema_version !== 'desk-world-case-files/v1'
    || payload.source !== 'desk_worldmonitor_context_hub'
    || !isRecord(payload.data_quality)
    || !hasSafeFlags(payload.safety)
    || !Array.isArray(payload.case_files)) {
    return dataCheckResult('Desk Overlay artifact was malformed or did not preserve context-only safety flags.');
  }

  const status = normalizeStatus(payload.data_quality.status);
  const caveats = stringList(payload.data_quality.caveats);
  if (status !== 'ok') {
    return {
      status,
      generatedAt: stringOrNull(payload.generated_at),
      caveats,
      caseFiles: [],
    };
  }

  return {
    status,
    generatedAt: stringOrNull(payload.generated_at),
    caveats,
    caseFiles: payload.case_files
      .map(normalizeCaseFile)
      .filter((row): row is DeskOverlayCaseFile => row !== null)
      .slice(0, 8),
  };
}

function normalizeCaseFile(value: unknown): DeskOverlayCaseFile | null {
  if (!isRecord(value) || !hasSafeFlags(value)) return null;
  const id = stringOrNull(value.id);
  const title = stringOrNull(value.title);
  const summary = stringOrNull(value.summary);
  if (!id || !title || !summary) return null;

  return {
    id,
    category: stringOrNull(value.category) ?? 'general',
    severity: value.severity === 'elevated' ? 'elevated' : 'observe',
    title,
    summary,
    impactAreas: stringList(value.impact_areas),
    observedAt: stringOrNull(value.observed_at),
    evidenceUrl: safeHttpUrl(value.evidence_url),
    deskUrl: safeDeskUrl(value.desk_url),
    mapLocation: parseMapLocation(value.map_location),
  };
}

function parseMapLocation(value: unknown): DeskOverlayMapLocation | null {
  if (!isRecord(value)) return null;
  const label = stringOrNull(value.label);
  const lat = finiteNumber(value.lat);
  const lon = finiteNumber(value.lon);
  if (!label || lat === null || lon === null || lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { label, lat, lon };
}

function safeHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function safeDeskUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const parsed = new URL(value);
    return parsed.origin === 'https://dev.westkite.dev' && parsed.pathname.startsWith('/desk/') ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function hasSafeFlags(value: unknown): boolean {
  return isRecord(value) && Object.entries(REQUIRED_SAFETY_FLAGS).every(([key, expected]) => value[key] === expected);
}

function normalizeStatus(value: unknown): DeskOverlayStatus {
  return value === 'ok' || value === 'baseline' || value === 'partial' || value === 'data_check' ? value : 'data_check';
}

function unavailableResult(caveat: string): DeskOverlayResult {
  return { status: 'unavailable', generatedAt: null, caveats: [caveat], caseFiles: [] };
}

function dataCheckResult(caveat: string): DeskOverlayResult {
  return { status: 'data_check', generatedAt: null, caveats: [caveat], caseFiles: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim())
    : [];
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
