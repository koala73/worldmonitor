/**
 * Business Pro seats panel (#4634/#4635) — invite/list/remove UI for API
 * Business owners, extracted out of UnifiedSettings.ts so that mega-component
 * doesn't keep absorbing every new billing feature slice inline.
 */

import { escapeHtml } from '@/utils/sanitize';
import { setTrustedHtml, trustedHtml } from '@/utils/dom-utils';
import { showToast } from '@/utils/toast';
import { t } from '@/services/i18n';
import {
  listBusinessSeats,
  inviteBusinessSeats,
  removeBusinessSeat,
  type BusinessSeat,
} from '@/services/billing';

export class BusinessSeatsSection {
  private seats: BusinessSeat[] = [];
  private loading = false;
  private error = '';
  // Optimistic default (true) so the invite form doesn't flash a "must be
  // corporate" rejection during the async listBusinessSeats() round-trip —
  // the server call is the authoritative gate at submit time regardless.
  private ownerIsCorporateDomain = true;
  // The SERVER's verdict on whether this account owns a covering Business
  // subscription — `listSeats` returns it non-null exactly when
  // getCoveringBusinessSubscription found one. `undefined` means "not asked
  // yet", which is deliberately distinct from `null` ("asked; not an owner").
  //
  // The client cannot derive this itself: getSubscription() exposes one
  // DISPLAY row picked by a sort that ranks active < on_hold < ended
  // (convex/payments/billing.ts), so an owner holding an active pro_monthly
  // alongside an on_hold or paid-through-cancelled api_business row never sees
  // the Business row at all. Asking the server is the only sound gate.
  private businessSubscriptionId: string | null | undefined;
  private accountGeneration = 0;
  // grantIds with a removeSeat mutation currently in flight — lets two
  // DIFFERENT seats be removed concurrently while still preventing a
  // double-click on the SAME seat's button from firing twice.
  private readonly removingGrantIds = new Set<string>();

  /** `overlay` is the settings modal's root element; content is rendered into `#usBusinessSeats` within it. */
  constructor(private readonly overlay: HTMLElement) {}

  resetForAccountChange(): void {
    this.accountGeneration += 1;
    this.seats = [];
    this.loading = false;
    this.error = '';
    this.ownerIsCorporateDomain = true;
    this.businessSubscriptionId = undefined;
    this.removingGrantIds.clear();
    this.renderInPlace();
  }

  async load(): Promise<void> {
    if (this.loading) return;
    const generation = this.accountGeneration;
    this.loading = true;
    this.error = '';
    try {
      const result = await listBusinessSeats();
      if (generation !== this.accountGeneration) return;
      this.seats = result.seats;
      this.ownerIsCorporateDomain = result.ownerIsCorporateDomain;
      this.businessSubscriptionId = result.businessSubscriptionId;
    } catch (err) {
      if (generation !== this.accountGeneration) return;
      // Deliberately does NOT clear businessSubscriptionId: a transient failure
      // on a refresh must not strip a confirmed owner's seat surface out from
      // under them — the error renders inside the section instead. A first load
      // that fails leaves it `undefined`, so an unconfirmed account still shows
      // nothing rather than a guessed surface.
      this.error = err instanceof Error ? err.message : t('settings.account.businessSeats.loadFailed');
    } finally {
      if (generation === this.accountGeneration) {
        this.loading = false;
        this.renderInPlace();
      }
    }
  }

  renderInPlace(): void {
    const container = this.overlay.querySelector('#usBusinessSeats');
    if (container) {
      setTrustedHtml(container, trustedHtml(this.renderContent(), 'legacy direct innerHTML migration'));
    }
  }

  renderContent(): string {
    const isCorporateDomain = this.ownerIsCorporateDomain;

    // The server's verdict, never a status-string reading of the display row.
    if (typeof this.businessSubscriptionId !== 'string') return '';

    const seats = this.seats;
    const activeSeats = seats.filter((s) => s.status === 'accepted');
    const pendingSeats = seats.filter((s) => s.status === 'pending');
    const seatCount = activeSeats.length + pendingSeats.length;

    const renderSeat = (seat: BusinessSeat) => {
      const statusLabel = t(seat.status === 'accepted'
        ? 'settings.account.businessSeats.statusAccepted'
        : seat.status === 'expired' ? 'settings.account.businessSeats.statusExpired' : 'settings.account.businessSeats.statusPending');
      const statusColor = seat.status === 'accepted' ? '#22c55e' : seat.status === 'expired' ? '#666' : '#eab308';
      const expires = seat.status === 'pending'
        ? `<div style="font-size:calc(11px * var(--wm-panel-effective-scale, 1));color:#666;">${escapeHtml(t('settings.account.businessSeats.expires', { date: new Date(seat.expiresAt).toLocaleDateString() }))}</div>`
        : '';
      return `
        <div class="business-seat-item" style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border:1px solid #1a1a1a;border-radius:6px;margin-bottom:8px;background:#0d0d0d;">
          <div>
            <div style="font-size:calc(13px * var(--wm-panel-effective-scale, 1));color:#fff;">${escapeHtml(seat.inviteeEmail)}</div>
            <div style="display:flex;align-items:center;gap:6px;margin-top:4px;">
              <span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:${statusColor};"></span>
              <span style="font-size:calc(11px * var(--wm-panel-effective-scale, 1));color:${statusColor};">${escapeHtml(statusLabel)}</span>
            </div>
            ${expires}
          </div>
          <button class="btn btn-ghost business-seat-remove-btn" data-grant-id="${escapeHtml(seat.grantId)}" style="font-size:calc(12px * var(--wm-panel-effective-scale, 1));" ${this.removingGrantIds.has(seat.grantId) ? 'disabled' : ''}>${escapeHtml(t(this.removingGrantIds.has(seat.grantId) ? 'settings.account.seats.removing' : 'settings.account.seats.remove'))}</button>
        </div>
      `;
    };

    const inviteHint = t(isCorporateDomain
      ? 'settings.account.businessSeats.hintCorporate'
      : 'settings.account.businessSeats.hintPersonal');

    return `
      <div class="business-seats-section" style="margin-top:16px;padding:14px 16px;border:1px solid #1a1a1a;border-radius:6px;background:#0d0d0d;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
          <div style="font-size:calc(13px * var(--wm-panel-effective-scale, 1));font-weight:600;color:#fff;">${escapeHtml(t('settings.account.businessSeats.heading'))}</div>
          <div style="font-size:calc(11px * var(--wm-panel-effective-scale, 1));color:#888;">${escapeHtml(t('settings.account.seats.used', { used: String(seatCount), cap: '4' }))}</div>
        </div>
        <div style="font-size:calc(12px * var(--wm-panel-effective-scale, 1));color:#999;margin-bottom:12px;">${escapeHtml(inviteHint)}</div>
        ${!isCorporateDomain ? `<div style="font-size:calc(12px * var(--wm-panel-effective-scale, 1));color:#ef4444;margin-bottom:12px;">${escapeHtml(t('settings.account.businessSeats.personalDomain'))}</div>` : ''}
        ${isCorporateDomain ? `
          <div class="business-seats-invite-form" style="display:flex;gap:8px;margin-bottom:12px;">
            <input type="email" class="business-seats-email-input" placeholder="teammate@company.com" style="flex:1;padding:8px 10px;background:#111;border:1px solid #1a1a1a;border-radius:4px;color:#fff;font-size:calc(13px * var(--wm-panel-effective-scale, 1));" ${seatCount >= 4 ? 'disabled' : ''} />
            <button class="btn btn-primary business-seats-invite-btn" ${seatCount >= 4 ? 'disabled' : ''}>${escapeHtml(t('settings.account.seats.invite'))}</button>
          </div>
        ` : ''}
        ${this.error ? `<div style="font-size:calc(12px * var(--wm-panel-effective-scale, 1));color:#ef4444;margin-bottom:12px;">${escapeHtml(this.error)}</div>` : ''}
        <div id="usBusinessSeatsList">
          ${seats.length === 0 ? `<div style="font-size:calc(12px * var(--wm-panel-effective-scale, 1));color:#666;padding:12px;text-align:center;">${escapeHtml(t('settings.account.businessSeats.empty'))}</div>` : seats.map(renderSeat).join('')}
        </div>
      </div>
    `;
  }

  async handleInvite(): Promise<void> {
    const generation = this.accountGeneration;
    const input = this.overlay.querySelector<HTMLInputElement>('.business-seats-email-input');
    const btn = this.overlay.querySelector<HTMLButtonElement>('.business-seats-invite-btn');
    const email = input?.value.trim();
    if (!email || !btn || btn.disabled) return;

    btn.disabled = true;
    btn.textContent = t('settings.account.seats.inviting');
    this.error = '';
    try {
      const result = await inviteBusinessSeats([email]);
      if (generation !== this.accountGeneration) return;
      if (result.invited[0]?.status === 'created') {
        showToast(t('settings.account.seats.inviteSent'));
      } else {
        showToast(t('settings.account.seats.alreadyInvited'));
      }
      await this.load();
    } catch (err) {
      if (generation !== this.accountGeneration) return;
      const msg = err instanceof Error ? err.message : t('settings.account.businessSeats.inviteFailed');
      if (msg.includes('SEAT_CAP_REACHED')) {
        this.error = t('settings.account.businessSeats.errors.seatCap');
      } else if (msg.includes('OWNER_DOMAIN_NOT_CORPORATE')) {
        this.error = t('settings.account.businessSeats.errors.ownerDomain');
      } else if (msg.includes('CANNOT_INVITE_SELF')) {
        this.error = t('settings.account.businessSeats.errors.self');
      } else if (msg.includes('INVITEE_DOMAIN_NOT_CORPORATE')) {
        this.error = t('settings.account.businessSeats.errors.inviteeDomain');
      } else {
        this.error = msg;
      }
      // renderInPlace() below regenerates the invite form fresh (button
      // re-enabled, input cleared) — no manual btn/input reset needed.
      this.renderInPlace();
    }
  }

  async handleRemove(grantId: string): Promise<void> {
    const generation = this.accountGeneration;
    if (this.removingGrantIds.has(grantId)) return;
    if (!confirm(t('settings.account.businessSeats.confirmRemove'))) return;

    this.removingGrantIds.add(grantId);
    this.renderInPlace();
    try {
      const result = await removeBusinessSeat(grantId);
      if (generation !== this.accountGeneration) return;
      showToast(t(result.status === 'already_inactive' ? 'settings.account.businessSeats.alreadyInactive' : 'settings.account.businessSeats.removed'));
      await this.load();
    } catch (err) {
      if (generation !== this.accountGeneration) return;
      this.error = err instanceof Error ? err.message : t('settings.account.businessSeats.removeFailed');
      this.renderInPlace();
    } finally {
      if (generation === this.accountGeneration) {
        this.removingGrantIds.delete(grantId);
        this.renderInPlace();
      }
    }
  }
}
