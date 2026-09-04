import { type AuthSession, getAuthState, subscribeAuthState } from '@/services/auth-state';
import {
  getEntitlementVerificationStatus,
  onEntitlementChange,
} from '@/services/entitlements';
import { PanelGateReason, getPanelGateReason } from '@/services/panel-gating';
import { isProTierResolved } from '@/services/widget-store';
import type { MissionPreviewSpec } from '@/services/mission-preview-registry';
import {
  trackProPreviewCta,
  trackProPreviewDismissed,
  trackProPreviewViewed,
} from '@/services/analytics';
import { h, replaceChildren } from '@/utils/dom-utils';
import { createCheckoutConsentElement } from '@/utils/legal-links';
import { WEB_APP_ORIGIN } from '@/config/web-origin';

/**
 * The shared in-panel Pro preview (plan U4, R7-R9): a static sample of the
 * mission's gated depth, rendered AFTER the hosting panel's free content,
 * with one upgrade invitation at a time and a persisted dismissal.
 *
 * State machine (plan HTD):
 *   resolving -> entitled | preview | anonymous | degraded
 *   preview <-> dismissed (persisted; explicit reopen)
 *   preview -> checkout (CTA)
 *
 * R9 is the load-bearing contract: while access is still resolving, or when
 * entitlement verification terminally failed, this component renders NOTHING.
 * That is deliberately stricter than ResilienceWidget's own locked surface —
 * the widget gates real content and must eventually show a verdict; this is a
 * marketing invitation attached to a FREE panel, so on any uncertainty the
 * free panel simply stands alone and no upgrade prompt can be produced by an
 * outage (the WORLDMONITOR-NY class of failure).
 */
export interface ProPreviewProps extends MissionPreviewSpec {
  missionId: string;
}

const DISMISSED_KEY = 'worldmonitor-pro-preview-dismissed-v1';

function readDismissed(): Record<string, true> {
  try {
    const raw = localStorage.getItem(DISMISSED_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, true>) : {};
  } catch {
    return {};
  }
}

function isPreviewDismissed(previewId: string): boolean {
  return readDismissed()[previewId] === true;
}

function setPreviewDismissed(previewId: string, dismissed: boolean): void {
  try {
    const all = readDismissed();
    if (dismissed) all[previewId] = true;
    else delete all[previewId];
    localStorage.setItem(DISMISSED_KEY, JSON.stringify(all));
  } catch {
    // Storage denied — dismissal lasts for this page only.
  }
}

type PreviewState = 'resolving' | 'degraded' | 'entitled' | 'anonymous' | 'preview' | 'dismissed';

export class ProPreviewSection {
  private readonly element: HTMLElement;
  private readonly props: ProPreviewProps;
  private authState: AuthSession;
  private viewedTracked = false;
  private unsubscribeAuth: (() => void) | null = null;
  private unsubscribeEntitlement: (() => void) | null = null;

  constructor(props: ProPreviewProps) {
    this.props = props;
    this.authState = getAuthState();
    this.element = h('section', {
      className: 'pro-preview',
      'data-preview-id': props.previewId,
      'aria-label': 'Pro preview',
    });
    this.unsubscribeAuth = subscribeAuthState((state) => {
      this.authState = state;
      this.render();
    });
    this.unsubscribeEntitlement = onEntitlementChange(() => this.render());
    this.render();
  }

  getElement(): HTMLElement {
    return this.element;
  }

  destroy(): void {
    this.unsubscribeAuth?.();
    this.unsubscribeEntitlement?.();
    this.unsubscribeAuth = null;
    this.unsubscribeEntitlement = null;
    this.element.remove();
  }

  private resolveState(): PreviewState {
    // Same resolution guard as ResilienceWidget.isAccessStillResolving: a
    // signed-in user's tier is unknown until the entitlement snapshot lands.
    if (this.authState.isPending) return 'resolving';
    if (!isProTierResolved()) {
      const status = getEntitlementVerificationStatus();
      if (status === 'idle' || status === 'pending') return 'resolving';
      // Terminal verification failure: R9 — never an upgrade prompt.
      if (this.authState.user) return 'degraded';
    }
    const reason = getPanelGateReason(this.authState, true);
    if (reason === PanelGateReason.NONE) return 'entitled';
    if (isPreviewDismissed(this.props.previewId)) return 'dismissed';
    if (reason === PanelGateReason.ANONYMOUS) return 'anonymous';
    return 'preview';
  }

  private render(): void {
    const state = this.resolveState();

    if (state === 'resolving' || state === 'degraded' || state === 'entitled') {
      this.element.hidden = true;
      replaceChildren(this.element);
      return;
    }

    this.element.hidden = false;

    if (state === 'dismissed') {
      replaceChildren(this.element, this.renderReopenChip());
      return;
    }

    if (!this.viewedTracked) {
      this.viewedTracked = true;
      trackProPreviewViewed(this.props.missionId, this.props.panelKey);
    }
    replaceChildren(this.element, ...this.renderPreviewBody(state === 'anonymous'));
  }

  private renderPreviewBody(anonymous: boolean): HTMLElement[] {
    const sampleEl = this.props.renderSample();
    const badge = h('div', { className: 'pro-preview__badge' },
      h('span', { className: 'pro-preview__badge-tag' }, 'PRO'),
      h('span', { className: 'pro-preview__badge-sample' }, 'Sample'),
      this.renderDismissButton(),
    );
    const copy = h('p', { className: 'panel-locked-desc pro-preview__copy' },
      anonymous ? `${this.props.unlockCopy} Sign in to get started.` : this.props.unlockCopy);

    const cta = h('button', {
      type: 'button',
      className: 'panel-locked-cta pro-preview__cta',
      onclick: () => void this.onCtaClick(anonymous),
    }, anonymous ? 'Sign In' : 'Upgrade to Pro') as HTMLButtonElement;

    return [
      badge,
      sampleEl,
      copy,
      // Assent above the CTA (#6976) — upgrade branch only; the sign-in modal
      // carries its own Terms and Privacy links.
      ...(anonymous ? [] : [createCheckoutConsentElement(WEB_APP_ORIGIN)]),
      cta,
    ];
  }

  private renderDismissButton(): HTMLElement {
    return h('button', {
      type: 'button',
      className: 'pro-preview__dismiss',
      'aria-label': 'Dismiss Pro preview',
      title: 'Dismiss',
      onclick: () => {
        setPreviewDismissed(this.props.previewId, true);
        trackProPreviewDismissed(this.props.missionId, this.props.panelKey);
        this.render();
      },
    }, '×');
  }

  private renderReopenChip(): HTMLElement {
    // R8: dismissal persists, and only an explicit locked-feature interaction
    // reopens — this chip is that interaction.
    return h('button', {
      type: 'button',
      className: 'pro-preview__reopen',
      'aria-label': `Show Pro preview: ${this.props.unlockCopy}`,
      onclick: () => {
        setPreviewDismissed(this.props.previewId, false);
        this.render();
      },
    }, 'Pro preview');
  }

  private async onCtaClick(anonymous: boolean): Promise<void> {
    if (anonymous) {
      try {
        const module = await import('@/services/clerk');
        module.openSignIn();
      } catch {
        const { showCheckoutErrorToast } = await import('@/services/checkout-error-toast')
          .catch(() => ({ showCheckoutErrorToast: (m: string) => window.alert(m) }));
        showCheckoutErrorToast('Sign-in is temporarily unavailable. Please try again.');
      }
      return;
    }

    trackProPreviewCta(this.props.missionId, this.props.panelKey);
    try {
      const [{ DEFAULT_UPGRADE_PRODUCT }, { isDesktopRuntime }] = await Promise.all([
        import('@/config/products'),
        import('@/services/runtime'),
      ]);
      if (isDesktopRuntime()) {
        const { openExternalUrl } = await import('@/services/external-navigation');
        await openExternalUrl('https://worldmonitor.app/pro');
        return;
      }
      const { startCheckout } = await import('@/services/checkout');
      await startCheckout(DEFAULT_UPGRADE_PRODUCT, undefined, {
        analyticsSurface: 'mission-preview',
        analyticsAttribution: {
          missionId: this.props.missionId,
          panelKey: this.props.panelKey,
        },
      });
    } catch {
      window.open('https://worldmonitor.app/pro', '_blank', 'noopener,noreferrer');
    }
  }
}
