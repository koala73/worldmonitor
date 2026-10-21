/**
 * Locked stand-in for the header export control (plan 2026-07-25-001, U5).
 *
 * The export panel is VISIBLE to everyone — hiding it was the old `role ===
 * 'pro'` behaviour, and `role` is written by nothing, so paying subscribers
 * never saw the button at all. Non-entitled users now get this control instead:
 * the same trigger glyph at rest, and a single locked row (icon + reason +
 * CTA) in place of the format options once the menu opens.
 *
 * It deliberately lives OUTSIDE `@/utils/export`: a locked user must never pay
 * for that chunk, so the heavy exporter is imported only on an allowed verdict
 * (see `tests/dashboard-eager-chunks.test.mjs` for the chunk discipline).
 */

import { t } from '@/services/i18n';
import { PanelGateReason } from '@/services/panel-gating';
import { h, replaceChildren, setTrustedHtml, trustedHtml } from '@/utils/dom-utils';
import { lockSvg, upgradeSvg } from '@/components/gate-icons';

export interface GateCopy {
  icon: string;
  desc: string;
  cta: string;
}

/**
 * The four billing-aware branches every locked surface shares — a customer
 * with paid evidence must never see a fresh upsell, so these reuse the same
 * `components.billingState.*` strings as the payment banner and panel CTAs
 * (`Panel.gatedCtaEntry`). Returns null for the reasons each surface must
 * resolve with its own copy (ANONYMOUS and the free-tier default).
 */
export function billingAwareGateCopy(reason: PanelGateReason): GateCopy | null {
  switch (reason) {
    case PanelGateReason.PAYMENT_ON_HOLD:
      return { icon: lockSvg, desc: t('components.billingState.onHoldDesc'), cta: t('components.billingState.updatePayment') };
    case PanelGateReason.RENEWAL_PENDING:
      return { icon: lockSvg, desc: t('components.billingState.renewalPendingDesc'), cta: t('components.billingState.refreshStatus') };
    case PanelGateReason.RENEWAL_FAILED:
      return { icon: lockSvg, desc: t('components.billingState.renewalFailedDesc'), cta: t('components.billingState.manageBilling') };
    case PanelGateReason.LAPSED:
      return { icon: upgradeSvg, desc: t('components.billingState.lapsedDesc'), cta: t('components.billingState.resubscribe') };
    default:
      return null;
  }
}

/** Export-specific copy: shared billing-aware branches plus this surface's own sign-in/upgrade cases. */
export function exportGateCopy(reason: PanelGateReason): GateCopy {
  const billing = billingAwareGateCopy(reason);
  if (billing) return billing;
  if (reason === PanelGateReason.ANONYMOUS) {
    return { icon: lockSvg, desc: t('components.exportGate.signedOutDesc'), cta: t('premium.signIn') };
  }
  return { icon: upgradeSvg, desc: t('components.exportGate.upgradeDesc'), cta: t('components.exportGate.upgradeCta') };
}

export interface ExportGateControlOptions {
  reason: PanelGateReason;
  /** Fires when a locked user OPENS the menu (the gate-hit metric). */
  onOpen: () => void;
  /** Runs the resolved gate action (auth modal, pricing page, billing portal). */
  onAction: () => void;
}

export class ExportGateControl {
  private readonly element: HTMLElement;
  private readonly trigger: HTMLButtonElement;
  private readonly menu: HTMLElement;
  private readonly onOpen: () => void;
  private readonly onAction: () => void;
  private readonly onDocumentClick: (event: MouseEvent) => void;
  private isOpen = false;
  private reason: PanelGateReason;

  constructor(options: ExportGateControlOptions) {
    this.reason = options.reason;
    this.onOpen = options.onOpen;
    this.onAction = options.onAction;

    this.trigger = h('button', {
      type: 'button',
      className: 'export-btn',
      title: t('common.exportData'),
    }, '⬇') as HTMLButtonElement;
    this.trigger.setAttribute('aria-haspopup', 'dialog');
    this.trigger.setAttribute('aria-expanded', 'false');

    this.menu = h('div', { className: 'export-menu hidden' });
    this.element = h('div', { className: 'export-panel-container' }, this.trigger, this.menu);

    this.trigger.addEventListener('click', (event) => {
      event.stopPropagation();
      this.setOpen(!this.isOpen);
    });

    this.onDocumentClick = (event: MouseEvent) => {
      if (!this.element.contains(event.target as Node)) this.setOpen(false);
    };
    document.addEventListener('click', this.onDocumentClick);

    this.render();
  }

  /** Re-render for a new gate reason (billing state changed mid-session). */
  public update(reason: PanelGateReason): void {
    if (reason === this.reason) return;
    this.reason = reason;
    this.render();
  }

  public getElement(): HTMLElement {
    return this.element;
  }

  public destroy(): void {
    document.removeEventListener('click', this.onDocumentClick);
    this.element.remove();
  }

  private setOpen(open: boolean): void {
    if (open === this.isOpen) return;
    this.isOpen = open;
    this.menu.classList.toggle('hidden', !open);
    this.trigger.setAttribute('aria-expanded', String(open));
    // Metric fires on a locked CLICK, never on render — a hidden control that
    // nobody reached for is not a gate hit.
    if (open) this.onOpen();
  }

  private render(): void {
    const copy = exportGateCopy(this.reason);
    this.trigger.setAttribute('aria-label', t('components.exportGate.lockedAriaLabel', { reason: copy.desc }));

    const iconEl = h('div', { className: 'export-locked-icon' });
    setTrustedHtml(iconEl, trustedHtml(copy.icon, 'static inline icon markup'));

    const ctaBtn = h('button', { type: 'button', className: 'export-locked-cta' }, copy.cta);
    ctaBtn.addEventListener('click', () => {
      this.setOpen(false);
      this.onAction();
    });

    replaceChildren(
      this.menu,
      h('div', { className: 'export-locked-state' },
        iconEl,
        h('div', { className: 'export-locked-desc' }, copy.desc),
        ctaBtn),
    );
  }
}
