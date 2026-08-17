/**
 * Business Pro seats panel (#4634/#4635) — invite/list/remove UI for API
 * Business owners, extracted out of UnifiedSettings.ts so that mega-component
 * doesn't keep absorbing every new billing feature slice inline.
 */

import { escapeHtml } from '@/utils/sanitize';
import { setTrustedHtml, trustedHtml } from '@/utils/dom-utils';
import { getAuthState } from '@/services/auth-state';
import { showToast } from '@/utils/toast';
import {
  getSubscription,
  listBusinessSeats,
  inviteBusinessSeats,
  removeBusinessSeat,
  type BusinessSeat,
} from '@/services/billing';

export class BusinessSeatsSection {
  private seats: BusinessSeat[] = [];
  private loading = false;
  private error = '';
  private ownerDomain: string | null = null;
  // Optimistic default (true) so the invite form doesn't flash a "must be
  // corporate" rejection during the async listBusinessSeats() round-trip —
  // the server call is the authoritative gate at submit time regardless.
  private ownerIsCorporateDomain = true;
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
    this.ownerDomain = null;
    this.ownerIsCorporateDomain = true;
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
      this.ownerDomain = result.ownerDomain;
      this.ownerIsCorporateDomain = result.ownerIsCorporateDomain;
    } catch (err) {
      if (generation !== this.accountGeneration) return;
      this.error = err instanceof Error ? err.message : 'Failed to load seats';
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
    const sub = getSubscription();
    const authUser = getAuthState().user;
    const ownerEmail = authUser?.email ?? '';
    // Server-computed corporate-domain check (matches the same isCorporateDomain()
    // the invite/accept mutations enforce, via listBusinessSeats' response) is
    // authoritative once loaded; the locally-parsed domain string is only a
    // display fallback for the brief window before that response arrives.
    const ownerDomain = this.ownerDomain ?? ownerEmail.split('@')[1]?.toLowerCase() ?? '';
    const isBusinessOwner = sub?.planKey === 'api_business' && sub?.status === 'active';
    const isCorporateDomain = this.ownerIsCorporateDomain;

    if (!isBusinessOwner) return '';

    const seats = this.seats;
    const activeSeats = seats.filter((s) => s.status === 'accepted');
    const pendingSeats = seats.filter((s) => s.status === 'pending');
    const seatCount = activeSeats.length + pendingSeats.length;

    const renderSeat = (seat: BusinessSeat) => {
      const statusLabel = seat.status === 'accepted' ? 'Accepted' : seat.status === 'expired' ? 'Expired' : 'Pending';
      const statusColor = seat.status === 'accepted' ? '#22c55e' : seat.status === 'expired' ? '#666' : '#eab308';
      const expires = seat.status === 'pending'
        ? `<div style="font-size:calc(11px * var(--wm-panel-effective-scale, 1));color:#666;">Expires ${new Date(seat.expiresAt).toLocaleDateString()}</div>`
        : '';
      return `
        <div class="business-seat-item" style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border:1px solid #1a1a1a;border-radius:6px;margin-bottom:8px;background:#0d0d0d;">
          <div>
            <div style="font-size:calc(13px * var(--wm-panel-effective-scale, 1));color:#fff;">${escapeHtml(seat.inviteeEmail)}</div>
            <div style="display:flex;align-items:center;gap:6px;margin-top:4px;">
              <span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:${statusColor};"></span>
              <span style="font-size:calc(11px * var(--wm-panel-effective-scale, 1));color:${statusColor};">${statusLabel}</span>
            </div>
            ${expires}
          </div>
          <button class="btn btn-ghost business-seat-remove-btn" data-grant-id="${escapeHtml(seat.grantId)}" style="font-size:calc(12px * var(--wm-panel-effective-scale, 1));" ${this.removingGrantIds.has(seat.grantId) ? 'disabled' : ''}>${this.removingGrantIds.has(seat.grantId) ? 'Removing...' : 'Remove'}</button>
        </div>
      `;
    };

    const inviteHint = isCorporateDomain
      ? `Invite teammates on your company domain (@${escapeHtml(ownerDomain)}).`
      : 'Add a company email to invite teammates.';

    return `
      <div class="business-seats-section" style="margin-top:16px;padding:14px 16px;border:1px solid #1a1a1a;border-radius:6px;background:#0d0d0d;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
          <div style="font-size:calc(13px * var(--wm-panel-effective-scale, 1));font-weight:600;color:#fff;">Business Seats</div>
          <div style="font-size:calc(11px * var(--wm-panel-effective-scale, 1));color:#888;">${seatCount} / 4 used</div>
        </div>
        <div style="font-size:calc(12px * var(--wm-panel-effective-scale, 1));color:#999;margin-bottom:12px;">${escapeHtml(inviteHint)}</div>
        ${!isCorporateDomain ? `<div style="font-size:calc(12px * var(--wm-panel-effective-scale, 1));color:#ef4444;margin-bottom:12px;">Free or disposable email domains cannot invite teammates. Add a company email to use this feature.</div>` : ''}
        ${isCorporateDomain ? `
          <div class="business-seats-invite-form" style="display:flex;gap:8px;margin-bottom:12px;">
            <input type="email" class="business-seats-email-input" placeholder="teammate@${escapeHtml(ownerDomain)}" style="flex:1;padding:8px 10px;background:#111;border:1px solid #1a1a1a;border-radius:4px;color:#fff;font-size:calc(13px * var(--wm-panel-effective-scale, 1));" ${seatCount >= 4 ? 'disabled' : ''} />
            <button class="btn btn-primary business-seats-invite-btn" ${seatCount >= 4 ? 'disabled' : ''}>Invite</button>
          </div>
        ` : ''}
        ${this.error ? `<div style="font-size:calc(12px * var(--wm-panel-effective-scale, 1));color:#ef4444;margin-bottom:12px;">${escapeHtml(this.error)}</div>` : ''}
        <div id="usBusinessSeatsList">
          ${seats.length === 0 ? `<div style="font-size:calc(12px * var(--wm-panel-effective-scale, 1));color:#666;padding:12px;text-align:center;">No seats invited yet.</div>` : seats.map(renderSeat).join('')}
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
    btn.textContent = 'Inviting...';
    this.error = '';
    try {
      const result = await inviteBusinessSeats([email]);
      if (generation !== this.accountGeneration) return;
      if (result.invited[0]?.status === 'created') {
        showToast('Invite sent');
      } else {
        showToast('Already invited');
      }
      await this.load();
    } catch (err) {
      if (generation !== this.accountGeneration) return;
      const msg = err instanceof Error ? err.message : 'Failed to send invite';
      if (msg.includes('SEAT_CAP_REACHED')) {
        this.error = 'All 4 seats are used. Remove a seat first.';
      } else if (msg.includes('INVITEE_DOMAIN_MISMATCH')) {
        this.error = 'Invitee must share your company email domain.';
      } else if (msg.includes('OWNER_DOMAIN_NOT_CORPORATE')) {
        this.error = 'Your account email must be a company domain to invite teammates.';
      } else if (msg.includes('CANNOT_INVITE_SELF')) {
        this.error = 'You cannot invite yourself.';
      } else if (msg.includes('INVITEE_DOMAIN_NOT_CORPORATE')) {
        this.error = 'The invitee email must be a company domain.';
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
    if (!confirm('Remove this seat? The invitee will lose Pro access immediately.')) return;

    this.removingGrantIds.add(grantId);
    this.renderInPlace();
    try {
      const result = await removeBusinessSeat(grantId);
      if (generation !== this.accountGeneration) return;
      showToast(result.status === 'already_inactive' ? 'Seat was already inactive' : 'Seat removed');
      await this.load();
    } catch (err) {
      if (generation !== this.accountGeneration) return;
      this.error = err instanceof Error ? err.message : 'Failed to remove seat';
      this.renderInPlace();
    } finally {
      if (generation === this.accountGeneration) {
        this.removingGrantIds.delete(grantId);
        this.renderInPlace();
      }
    }
  }
}
