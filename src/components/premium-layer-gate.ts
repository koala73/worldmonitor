import { getAuthState, subscribeAuthState, type AuthSession } from '@/services/auth-state';
import { onEntitlementChange } from '@/services/entitlements';
import { hasPremiumAccess } from '@/services/panel-gating';

const LOCK_ICON = '\uD83D\uDD12';

export type PremiumLayerKind = 'locked' | 'enhanced' | undefined;

export interface PremiumLayerPresentation {
  locked: boolean;
  enhanced: boolean;
}

/**
 * Resolve the initial picker state from the same access predicate used by the
 * rest of the application. The GlobeMap markup and the reactive gate both use
 * this policy so a Clerk role or Convex entitlement cannot drift apart from
 * the initial render.
 */
export function getPremiumLayerPresentation(
  premium: PremiumLayerKind,
  authState: AuthSession,
): PremiumLayerPresentation {
  const hasAccess = hasPremiumAccess(authState);
  return {
    locked: premium === 'locked' && !hasAccess,
    enhanced: premium === 'enhanced' && !hasAccess,
  };
}

function removeLockIcon(label: HTMLElement): void {
  const labelText = label.querySelector('.toggle-label');
  if (!labelText) return;
  for (const node of Array.from(labelText.childNodes)) {
    if (node.nodeType !== 3) continue;
    node.textContent = node.textContent?.replace(new RegExp(`\\s*${LOCK_ICON}\\s*$`), '') ?? '';
  }
}

/** Apply the locked/unlocked DOM state without rebuilding the layer picker. */
export function applyPremiumLayerPresentation(
  label: HTMLElement,
  presentation: PremiumLayerPresentation,
): void {
  label.classList.toggle('layer-toggle-locked', presentation.locked);
  const input = label.querySelector('input') as HTMLInputElement | null;
  if (input) input.disabled = presentation.locked;

  const labelText = label.querySelector('.toggle-label');
  if (!labelText) return;
  removeLockIcon(label);
  if (presentation.locked) labelText.appendChild(document.createTextNode(` ${LOCK_ICON}`));
}

export interface PremiumLayerGateOptions {
  isLayerEnabled: (layer: string) => boolean;
  onAccessLost: (layer: string) => void;
}

/**
 * Keeps premium layer rows synchronized with both Clerk and Convex changes.
 * It deliberately stays subscribed after an unlock: entitlement expiry,
 * downgrade, and sign-out must relock the mounted GlobeMap immediately.
 */
export class PremiumLayerGate {
  private readonly root: HTMLElement;
  private readonly lockedLayers: ReadonlySet<string>;
  private readonly isLayerEnabled: (layer: string) => boolean;
  private readonly onAccessLost: (layer: string) => void;
  private unsubscribeAuthState: (() => void) | null = null;
  private unsubscribeEntitlement: (() => void) | null = null;

  public constructor(
    root: HTMLElement,
    lockedLayers: ReadonlySet<string>,
    options: PremiumLayerGateOptions,
  ) {
    this.root = root;
    this.lockedLayers = lockedLayers;
    this.isLayerEnabled = options.isLayerEnabled;
    this.onAccessLost = options.onAccessLost;
    this.sync = this.sync.bind(this);

    this.unsubscribeAuthState = subscribeAuthState(this.sync);
    this.unsubscribeEntitlement = onEntitlementChange(this.sync);
  }

  public destroy(): void {
    this.unsubscribeAuthState?.();
    this.unsubscribeAuthState = null;
    this.unsubscribeEntitlement?.();
    this.unsubscribeEntitlement = null;
  }

  private sync(): void {
    const hasAccess = hasPremiumAccess(getAuthState());
    this.root.querySelectorAll<HTMLElement>('.layer-toggle').forEach(label => {
      const layer = label.getAttribute('data-layer');
      if (!layer || !this.lockedLayers.has(layer)) return;

      const input = label.querySelector('input') as HTMLInputElement | null;
      const wasEnabled = this.isLayerEnabled(layer) || input?.checked === true;
      applyPremiumLayerPresentation(label, { locked: !hasAccess, enhanced: false });

      if (!hasAccess && wasEnabled) {
        if (input) input.checked = false;
        this.onAccessLost(layer);
      }
    });
  }
}
