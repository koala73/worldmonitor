import {
  parseMissionPresetId,
  type MissionPresetId,
} from './mission-domain';

export const CHECKOUT_SURFACES = [
  'dashboard',
  'dashboard-resume',
  'mission-preview',
] as const;

export type CheckoutSurface = (typeof CHECKOUT_SURFACES)[number];

export interface CheckoutAttribution {
  missionId?: string;
  panelKey?: string;
}

export const MISSION_PREVIEW_TARGETS = {
  'crisis-desk': 'cii',
  'supply-chain-risk': 'supply-chain',
  'energy-security': 'pipeline-status',
  'osint-newsroom': 'gdelt-intel',
  'macro-market-watch': 'macro-signals',
} as const;

export type MissionPreviewId = keyof typeof MISSION_PREVIEW_TARGETS;

export type MissionPreviewAttribution = {
  [MissionId in MissionPreviewId]: {
    kind: 'mission-preview';
    missionId: MissionId;
    panelKey: (typeof MISSION_PREVIEW_TARGETS)[MissionId];
  }
}[MissionPreviewId];

export type CheckoutOrigin =
  | { kind: 'dashboard'; missionId?: MissionPresetId }
  | MissionPreviewAttribution;

export interface CheckoutContext {
  eventSurface: CheckoutSurface;
  origin: CheckoutOrigin;
}

export const CHECKOUT_MISSION_PARAM = 'wm_checkout_mission';
export const CHECKOUT_PANEL_PARAM = 'wm_checkout_panel';
export const CHECKOUT_HANDOFF_PARAM = 'wm_checkout_handoff';
export const CHECKOUT_RETURN_SOURCE_PARAM = 'wm_src';
export const DESKTOP_CHECKOUT_HANDOFF = 'desktop';
export const CHECKOUT_DESKTOP_ACCOUNT_PARAM = 'wm_checkout_account';
export const CHECKOUT_ATTEMPT_STORAGE_KEY = 'wm-last-checkout-attempt';
export const CHECKOUT_ATTEMPT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface CheckoutAttemptRecord {
  version: 2;
  productId: string;
  referralCode?: string;
  discountCode?: string;
  startedAt: number;
  context: CheckoutContext;
}

const CHECKOUT_SURFACE_SET = new Set<string>(CHECKOUT_SURFACES);
const PANEL_KEY_PATTERN = /^[a-z][a-zA-Z0-9-]{0,39}$/;

export function isCheckoutSurface(value: unknown): value is CheckoutSurface {
  return typeof value === 'string' && CHECKOUT_SURFACE_SET.has(value);
}

export function parseCheckoutPanelKey(value: unknown): string | null {
  return typeof value === 'string' && PANEL_KEY_PATTERN.test(value) ? value : null;
}

export function parseMissionPreviewAttribution(
  missionValue: unknown,
  panelValue: unknown,
): MissionPreviewAttribution | null {
  const missionId = parseMissionPresetId(missionValue);
  const panelKey = parseCheckoutPanelKey(panelValue);
  if (!missionId || !panelKey || !(missionId in MISSION_PREVIEW_TARGETS)) return null;
  if (MISSION_PREVIEW_TARGETS[missionId as MissionPreviewId] !== panelKey) return null;
  return {
    kind: 'mission-preview',
    missionId: missionId as MissionPreviewId,
    panelKey: panelKey as MissionPreviewAttribution['panelKey'],
  } as MissionPreviewAttribution;
}

export function parseMissionPreviewAttributionFromSearch(
  search: string,
): MissionPreviewAttribution | null {
  const params = new URLSearchParams(search);
  return parseMissionPreviewAttribution(
    params.get(CHECKOUT_MISSION_PARAM),
    params.get(CHECKOUT_PANEL_PARAM),
  );
}

export function resolveCheckoutContext(input: {
  surface?: unknown;
  attribution?: CheckoutAttribution | null;
  ambientMissionId?: unknown;
}): CheckoutContext {
  const eventSurface = isCheckoutSurface(input.surface) ? input.surface : 'dashboard';
  const preview = parseMissionPreviewAttribution(
    input.attribution?.missionId,
    input.attribution?.panelKey,
  );
  if (preview) return { eventSurface, origin: preview };

  const ambientMissionId = parseMissionPresetId(input.ambientMissionId);
  return {
    eventSurface,
    origin: ambientMissionId
      ? { kind: 'dashboard', missionId: ambientMissionId }
      : { kind: 'dashboard' },
  };
}

export function parseCheckoutContext(value: unknown): CheckoutContext | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as { eventSurface?: unknown; origin?: unknown };
  if (!isCheckoutSurface(candidate.eventSurface) || !candidate.origin || typeof candidate.origin !== 'object') {
    return null;
  }
  const origin = candidate.origin as { kind?: unknown; missionId?: unknown; panelKey?: unknown };
  if (origin.kind === 'mission-preview') {
    const preview = parseMissionPreviewAttribution(origin.missionId, origin.panelKey);
    return preview ? { eventSurface: candidate.eventSurface, origin: preview } : null;
  }
  if (origin.kind !== 'dashboard') return null;
  const missionId = parseMissionPresetId(origin.missionId);
  return {
    eventSurface: candidate.eventSurface,
    origin: missionId ? { kind: 'dashboard', missionId } : { kind: 'dashboard' },
  };
}

export function withCheckoutEventSurface(
  context: CheckoutContext,
  eventSurface: CheckoutSurface,
): CheckoutContext {
  return { ...context, eventSurface };
}

/**
 * The desktop app handed checkout to the OS browser (#5911). `account` is
 * `desktopAccountDigest` of the account signed in to the app. It is absent
 * when the app was signed out, or was a build from before #10342, and then
 * /pro cannot tell whether its own session is the same account.
 */
export interface DesktopCheckoutHandoff {
  account?: string;
}

const DESKTOP_ACCOUNT_DIGEST_PATTERN = /^[0-9a-f]{16}$/;

/**
 * A stable, non-reversible stand-in for a Clerk user id. The handoff URL sits
 * in the OS browser's history and in analytics page URLs, and /pro only needs
 * to compare two accounts, never to name one.
 */
export async function desktopAccountDigest(userId: string): Promise<string> {
  const bytes = new TextEncoder().encode(`wm-desktop-checkout:${userId}`);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(hash.subarray(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function stampDesktopCheckoutHandoff(params: URLSearchParams, handoff: DesktopCheckoutHandoff): void {
  params.set(CHECKOUT_HANDOFF_PARAM, DESKTOP_CHECKOUT_HANDOFF);
  if (handoff.account) params.set(CHECKOUT_DESKTOP_ACCOUNT_PARAM, handoff.account);
}

export function parseDesktopCheckoutHandoff(search: string): DesktopCheckoutHandoff | null {
  const params = new URLSearchParams(search);
  if (params.get(CHECKOUT_HANDOFF_PARAM) !== DESKTOP_CHECKOUT_HANDOFF) return null;
  const account = params.get(CHECKOUT_DESKTOP_ACCOUNT_PARAM);
  return account && DESKTOP_ACCOUNT_DIGEST_PATTERN.test(account) ? { account } : {};
}

export function buildAttributedProUrl(
  baseUrl: string,
  attribution?: CheckoutAttribution | null,
  options?: { desktopHandoff?: DesktopCheckoutHandoff },
): string {
  const preview = parseMissionPreviewAttribution(
    attribution?.missionId,
    attribution?.panelKey,
  );
  const url = new URL(baseUrl);
  if (preview) {
    url.searchParams.set(CHECKOUT_MISSION_PARAM, preview.missionId);
    url.searchParams.set(CHECKOUT_PANEL_PARAM, preview.panelKey);
  }
  if (options?.desktopHandoff) stampDesktopCheckoutHandoff(url.searchParams, options.desktopHandoff);
  return url.toString();
}

export function parseCheckoutAttemptRecord(
  value: unknown,
  now: number = Date.now(),
): CheckoutAttemptRecord | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.productId !== 'string' || typeof candidate.startedAt !== 'number') return null;
  if (now - candidate.startedAt > CHECKOUT_ATTEMPT_MAX_AGE_MS) return null;

  let context = parseCheckoutContext(candidate.context);
  if (!context) {
    context = resolveCheckoutContext({
      surface: candidate.analyticsSurface,
      attribution: {
        missionId: typeof candidate.missionId === 'string' ? candidate.missionId : undefined,
        panelKey: typeof candidate.panelKey === 'string' ? candidate.panelKey : undefined,
      },
      ambientMissionId: candidate.missionId,
    });
  }

  return {
    version: 2,
    productId: candidate.productId,
    ...(typeof candidate.referralCode === 'string' ? { referralCode: candidate.referralCode } : {}),
    ...(typeof candidate.discountCode === 'string' ? { discountCode: candidate.discountCode } : {}),
    startedAt: candidate.startedAt,
    context,
  };
}
