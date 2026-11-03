import {
  parseCheckoutContext,
  type CheckoutContext,
} from '../../shared/checkout-attribution';

export const CHECKOUT_RETURN_STATE_KEY = 'wm-checkout-return-v1';
const CHECKOUT_RETURN_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export type CheckoutReturnSource = 'url-return' | 'overlay-flag' | 'desktop-return';

export interface CheckoutReturnState {
  version: 1;
  source: CheckoutReturnSource;
  createdAt: number;
  context: CheckoutContext;
  delivery: {
    missionReturn: 'pending' | 'settled';
    panelFocus: 'not-required' | 'pending' | 'focused';
  };
}

let storageDeniedReturnState: CheckoutReturnState | null | undefined;

function parseCheckoutReturnState(value: unknown): CheckoutReturnState | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<CheckoutReturnState>;
  const context = parseCheckoutContext(candidate.context);
  if (candidate.version !== 1 || !context || typeof candidate.createdAt !== 'number') return null;
  if (
    candidate.source !== 'url-return'
    && candidate.source !== 'overlay-flag'
    && candidate.source !== 'desktop-return'
  ) return null;
  if (Date.now() - candidate.createdAt > CHECKOUT_RETURN_MAX_AGE_MS) return null;
  const missionReturn = candidate.delivery?.missionReturn;
  const panelFocus = candidate.delivery?.panelFocus;
  if (missionReturn !== 'pending' && missionReturn !== 'settled') return null;
  if (panelFocus !== 'not-required' && panelFocus !== 'pending' && panelFocus !== 'focused') return null;
  return {
    version: 1,
    source: candidate.source,
    createdAt: candidate.createdAt,
    context,
    delivery: { missionReturn, panelFocus },
  };
}

function writeCheckoutReturnState(state: CheckoutReturnState | null): void {
  try {
    if (state) window.sessionStorage.setItem(CHECKOUT_RETURN_STATE_KEY, JSON.stringify(state));
    else window.sessionStorage.removeItem(CHECKOUT_RETURN_STATE_KEY);
    storageDeniedReturnState = undefined;
  } catch {
    storageDeniedReturnState = state;
  }
}

export function loadCheckoutReturnState(): CheckoutReturnState | null {
  if (storageDeniedReturnState !== undefined) return storageDeniedReturnState;
  try {
    const raw = window.sessionStorage.getItem(CHECKOUT_RETURN_STATE_KEY);
    if (!raw) return null;
    const state = parseCheckoutReturnState(JSON.parse(raw));
    if (!state) writeCheckoutReturnState(null);
    return state;
  } catch {
    return null;
  }
}

export function armCheckoutReturnState(
  context: CheckoutContext,
  source: CheckoutReturnSource,
): CheckoutReturnState | null {
  const parsedContext = parseCheckoutContext(context);
  if (!parsedContext || !parsedContext.origin.missionId) return null;
  const state: CheckoutReturnState = {
    version: 1,
    source,
    createdAt: Date.now(),
    context: parsedContext,
    delivery: {
      missionReturn: 'pending',
      panelFocus: source !== 'desktop-return' && parsedContext.origin.kind === 'mission-preview'
        ? 'pending'
        : 'not-required',
    },
  };
  writeCheckoutReturnState(state);
  return state;
}

function settleCheckoutReturnState(
  field: 'missionReturn' | 'panelFocus',
  value: 'settled' | 'focused',
): void {
  const state = loadCheckoutReturnState();
  if (!state) return;
  const next: CheckoutReturnState = {
    ...state,
    delivery: { ...state.delivery, [field]: value },
  };
  const missionDone = next.delivery.missionReturn === 'settled';
  const focusDone = next.delivery.panelFocus !== 'pending';
  writeCheckoutReturnState(missionDone && focusDone ? null : next);
}

export function settleMissionReturnDelivery(): void {
  settleCheckoutReturnState('missionReturn', 'settled');
}

export function settleCheckoutReturnFocus(): void {
  settleCheckoutReturnState('panelFocus', 'focused');
}
