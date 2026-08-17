/**
 * Behavioral coverage for the GlobeMap premium layer picker (#6050).
 *
 * The production gate uses the real `hasPremiumAccess` implementation below;
 * only its reactive auth, entitlement, API-key, and widget-store inputs are
 * controlled so each access path can be replayed deterministically.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

type Session = import('@/services/auth-state').AuthSession;

let session: Session = { user: null, isPending: false };
let entitlementTier: number | null = null;
let apiKeyPresent = false;
const authListeners: Array<(state: Session) => void> = [];
const entitlementListeners: Array<(state: unknown) => void> = [];
let authUnsubscribed = 0;
let entitlementUnsubscribed = 0;

vi.mock('@/services/auth-state', () => ({
  getAuthState: () => session,
  subscribeAuthState: (listener: (state: Session) => void) => {
    authListeners.push(listener);
    listener(session);
    return () => {
      authUnsubscribed++;
      const index = authListeners.indexOf(listener);
      if (index >= 0) authListeners.splice(index, 1);
    };
  },
}));

vi.mock('@/services/entitlements', () => ({
  getEntitlementState: () => entitlementTier === null ? null : {
    planKey: entitlementTier > 0 ? 'pro' : 'free',
    features: {
      tier: entitlementTier,
      apiAccess: entitlementTier > 0,
      apiRateLimit: 0,
      maxDashboards: 3,
      prioritySupport: false,
      exportFormats: [],
    },
    validUntil: Date.now() + 86_400_000,
  },
  onEntitlementChange: (listener: (state: unknown) => void) => {
    entitlementListeners.push(listener);
    if (entitlementTier !== null) listener(undefined);
    return () => {
      entitlementUnsubscribed++;
      const index = entitlementListeners.indexOf(listener);
      if (index >= 0) entitlementListeners.splice(index, 1);
    };
  },
  isEntitled: () => entitlementTier !== null && entitlementTier > 0,
}));

vi.mock('@/services/runtime-config', () => ({
  getSecretState: () => ({
    present: apiKeyPresent,
    valid: apiKeyPresent,
    source: apiKeyPresent ? 'env' : 'missing',
  }),
}));

vi.mock('@/services/widget-store', () => ({
  isProUser: () => session.user?.role === 'pro' || (entitlementTier !== null && entitlementTier > 0),
}));

const {
  PremiumLayerGate,
  applyPremiumLayerPresentation,
  getPremiumLayerPresentation,
} = await import('@/components/premium-layer-gate');

beforeEach(() => {
  session = { user: null, isPending: false };
  entitlementTier = null;
  apiKeyPresent = false;
  authListeners.length = 0;
  entitlementListeners.length = 0;
  authUnsubscribed = 0;
  entitlementUnsubscribed = 0;
  document.body.replaceChildren();
});

function makeLayerRow(checked = false): {
  root: HTMLElement;
  label: HTMLElement;
  input: HTMLInputElement;
  labelText: HTMLElement;
} {
  const root = document.createElement('div');
  const label = document.createElement('label');
  label.className = 'layer-toggle';
  label.dataset.layer = 'gpsJamming';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = checked;
  const labelText = document.createElement('span');
  labelText.className = 'toggle-label';
  labelText.textContent = 'GPS Jamming';
  label.append(input, labelText);
  root.appendChild(label);
  document.body.appendChild(root);
  return { root, label, input, labelText };
}

function emitAuth(next: Session): void {
  session = next;
  for (const listener of [...authListeners]) listener(session);
}

function emitEntitlement(tier: number | null): void {
  entitlementTier = tier;
  for (const listener of [...entitlementListeners]) listener(undefined);
}

describe('GlobeMap premium layer initial state', () => {
  it('locks free users, including the enhanced presentation, in the real DOM', () => {
    const { label, input, labelText } = makeLayerRow();
    const enhancedRow = makeLayerRow();
    const proBadge = document.createElement('span');
    proBadge.className = 'layer-pro-badge';
    proBadge.textContent = 'PRO';
    enhancedRow.labelText.append(' ', proBadge);
    const locked = getPremiumLayerPresentation('locked', session);
    const enhanced = getPremiumLayerPresentation('enhanced', session);

    applyPremiumLayerPresentation(label, locked);
    applyPremiumLayerPresentation(enhancedRow.label, enhanced);

    expect(locked).toEqual({ locked: true, enhanced: false });
    expect(enhanced).toEqual({ locked: false, enhanced: true });
    expect(label.classList.contains('layer-toggle-locked')).toBe(true);
    expect(input.disabled).toBe(true);
    expect(labelText.textContent).toBe('GPS Jamming 🔒');
    expect(enhancedRow.input.disabled).toBe(false);
    expect(enhancedRow.labelText.textContent).toBe('GPS Jamming PRO');
  });

  it('unlocks for a Clerk Pro role without an API key', () => {
    session = {
      user: {
        id: 'clerk-pro',
        name: 'Pro User',
        email: 'pro@example.com',
        role: 'pro',
      },
      isPending: false,
    };
    const { label, input, labelText } = makeLayerRow();

    const presentation = getPremiumLayerPresentation('locked', session);
    applyPremiumLayerPresentation(label, presentation);

    expect(apiKeyPresent).toBe(false);
    expect(presentation.locked).toBe(false);
    expect(label.classList.contains('layer-toggle-locked')).toBe(false);
    expect(input.disabled).toBe(false);
    expect(labelText.textContent).toBe('GPS Jamming');
  });

  it('unlocks for a Convex entitlement while Clerk still reports free', () => {
    session = {
      user: {
        id: 'clerk-free',
        name: 'Free User',
        email: 'free@example.com',
        role: 'free',
      },
      isPending: false,
    };
    entitlementTier = 1;
    const { label, input } = makeLayerRow();

    const presentation = getPremiumLayerPresentation('locked', session);
    applyPremiumLayerPresentation(label, presentation);

    expect(session.user?.role).toBe('free');
    expect(presentation.locked).toBe(false);
    expect(input.disabled).toBe(false);
  });
});

describe('GlobeMap premium layer lifecycle', () => {
  it('handles Clerk unlock, Convex-only unlock, downgrade relock, and destroy teardown', () => {
    const { root, label, input } = makeLayerRow();
    let layerEnabled = false;
    const accessLosses: string[] = [];
    const gate = new PremiumLayerGate(root, new Set(['gpsJamming']), {
      isLayerEnabled: () => layerEnabled,
      onAccessLost: layer => {
        layerEnabled = false;
        accessLosses.push(layer);
      },
    });

    expect(input.disabled).toBe(true);
    expect(label.classList.contains('layer-toggle-locked')).toBe(true);

    emitAuth({
      user: {
        id: 'clerk-pro',
        name: 'Pro User',
        email: 'pro@example.com',
        role: 'pro',
      },
      isPending: false,
    });
    expect(input.disabled).toBe(false);
    expect(label.classList.contains('layer-toggle-locked')).toBe(false);
    expect(authUnsubscribed).toBe(0);
    expect(entitlementUnsubscribed).toBe(0);

    emitAuth({
      user: {
        id: 'free-user',
        name: 'Free User',
        email: 'free@example.com',
        role: 'free',
      },
      isPending: false,
    });
    expect(input.disabled).toBe(true);

    emitEntitlement(1);
    expect(input.disabled).toBe(false);
    expect(label.classList.contains('layer-toggle-locked')).toBe(false);

    layerEnabled = true;
    input.checked = true;
    emitEntitlement(0);
    expect(input.checked).toBe(false);
    expect(input.disabled).toBe(true);
    expect(accessLosses).toEqual(['gpsJamming']);
    expect(layerEnabled).toBe(false);

    gate.destroy();
    expect(authUnsubscribed).toBe(1);
    expect(entitlementUnsubscribed).toBe(1);

    emitAuth({ user: { id: 'clerk-pro', name: 'Pro User', email: 'pro@example.com', role: 'pro' }, isPending: false });
    emitEntitlement(1);
    expect(input.disabled).toBe(true);
    expect(accessLosses).toEqual(['gpsJamming']);
  });
});
