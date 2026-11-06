/**
 * Enterprise account seats in Settings: the account admin invites people by
 * email, sees every seat and removes members or pending invites. Other
 * members see the account name and seat count. Hidden for everyone else.
 * Server side: convex/enterpriseSeats.ts.
 */

import { escapeHtml } from '@/utils/sanitize';
import { setTrustedHtml, trustedHtml } from '@/utils/dom-utils';
import { showToast } from '@/utils/toast';
import {
  inviteEnterpriseMembers,
  listEnterpriseSeats,
  removeEnterpriseMember,
  type EnterpriseSeat,
  type EnterpriseSeatsView,
} from '@/services/billing';
import { businessInviteErrorKind } from '@/services/business-invite-capture';

const ERROR_COPY: Record<string, string> = {
  SEAT_CAP_REACHED: 'All seats are in use. Remove someone or withdraw an invite first.',
  INVITEE_DOMAIN_NOT_CORPORATE: 'Invite a company email address. Free and disposable email domains are not accepted.',
  CANNOT_INVITE_SELF: 'You already have a seat.',
  CONTRACT_ENDED: 'Your Enterprise contract has ended. Contact support to renew.',
  NOT_ACCOUNT_ADMIN: 'Only the account admin can manage seats.',
  CANNOT_REMOVE_SELF: 'You cannot remove your own seat. Contact support to change the admin.',
  TOO_MANY_EMAILS: 'Invite up to 10 people at a time.',
  INVITE_RATE_LIMITED: 'You have sent the most invites allowed in a day. Try again tomorrow.',
};

function errorMessage(err: unknown, fallback: string): string {
  const kind = businessInviteErrorKind(err);
  return (kind && ERROR_COPY[kind]) || fallback;
}

const SCALE = 'var(--wm-panel-effective-scale, 1)';

export class EnterpriseSeatsSection {
  // `undefined` = not asked yet, `null` = asked and not a member.
  private view: EnterpriseSeatsView | null | undefined;
  private loading = false;
  // A refresh asked for while a load is in flight runs once it settles, so an
  // invite or removal is never shown against an older roster.
  private reloadQueued = false;
  private error = '';
  private accountGeneration = 0;
  private readonly removingIds = new Set<string>();

  /** `overlay` is the settings modal root; content renders into `#usEnterpriseSeats`. */
  constructor(private readonly overlay: HTMLElement) {}

  resetForAccountChange(): void {
    this.accountGeneration += 1;
    this.view = undefined;
    this.loading = false;
    this.reloadQueued = false;
    this.error = '';
    this.removingIds.clear();
    this.renderInPlace();
  }

  async load(): Promise<void> {
    if (this.loading) {
      this.reloadQueued = true;
      return;
    }
    const generation = this.accountGeneration;
    this.loading = true;
    this.error = '';
    try {
      const view = await listEnterpriseSeats();
      if (generation !== this.accountGeneration) return;
      this.view = view;
    } catch (err) {
      if (generation !== this.accountGeneration) return;
      // Keep a confirmed view on a failed refresh; the error shows inside it.
      this.error = errorMessage(err, 'Could not load seats. Try again.');
    } finally {
      if (generation === this.accountGeneration) {
        this.loading = false;
        this.renderInPlace();
        if (this.reloadQueued) {
          this.reloadQueued = false;
          void this.load();
        }
      }
    }
  }

  renderInPlace(): void {
    const container = this.overlay.querySelector('#usEnterpriseSeats');
    if (container) {
      setTrustedHtml(container, trustedHtml(this.renderContent(), 'enterprise seats section'));
    }
  }

  renderContent(): string {
    const view = this.view;
    if (!view) return '';
    const full = view.seatsUsed >= view.seatCap;
    const header = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
        <div style="font-size:calc(13px * ${SCALE});font-weight:600;color:#fff;">${escapeHtml(view.accountName)} Enterprise seats</div>
        <div style="font-size:calc(11px * ${SCALE});color:#888;">${view.seatsUsed} / ${view.seatCap} used</div>
      </div>`;
    const errorLine = this.error
      ? `<div style="font-size:calc(12px * ${SCALE});color:#ef4444;margin-bottom:12px;">${escapeHtml(this.error)}</div>`
      : '';

    if (!view.isAdmin) {
      return `
        <div class="enterprise-seats-section" style="margin-top:16px;padding:14px 16px;border:1px solid #1a1a1a;border-radius:6px;background:#0d0d0d;">
          ${header}
          <div style="font-size:calc(12px * ${SCALE});color:#999;">Your account admin adds and removes people on this account.</div>
          ${errorLine}
        </div>`;
    }

    const canInvite = !view.contractEnded && !full;
    const hint = view.contractEnded
      ? 'Your Enterprise contract has ended. Contact support to renew.'
      : full
        ? 'All seats are in use. Remove someone or withdraw an invite to free a seat.'
        : 'Invite people by company email. They get a link that is valid for 14 days and share this account\'s allowance.';

    return `
      <div class="enterprise-seats-section" style="margin-top:16px;padding:14px 16px;border:1px solid #1a1a1a;border-radius:6px;background:#0d0d0d;">
        ${header}
        <div style="font-size:calc(12px * ${SCALE});color:#999;margin-bottom:12px;">${escapeHtml(hint)}</div>
        <div class="enterprise-seats-invite-form" style="display:flex;gap:8px;margin-bottom:12px;">
          <input type="email" class="enterprise-seats-email-input" aria-label="Email address to invite" placeholder="colleague@company.com" style="flex:1;min-width:0;padding:8px 10px;background:#111;border:1px solid #1a1a1a;border-radius:4px;color:#fff;font-size:calc(13px * ${SCALE});" ${canInvite ? '' : 'disabled'} />
          <button class="btn btn-primary enterprise-seats-invite-btn" ${canInvite ? '' : 'disabled'}>Invite</button>
        </div>
        ${errorLine}
        <div>${view.seats.map((seat) => this.renderSeat(seat)).join('')}</div>
      </div>`;
  }

  private renderSeat(seat: EnterpriseSeat): string {
    const statusLabel = seat.status === 'active' ? 'Active' : seat.status === 'expired' ? 'Invite expired' : 'Invited';
    const statusColor = seat.status === 'active' ? '#22c55e' : seat.status === 'expired' ? '#666' : '#eab308';
    const detail = seat.status === 'pending' && seat.emailFailed
      ? 'The invite email could not be sent. Check the address, then withdraw and invite again.'
      : seat.status === 'pending' && seat.inviteExpiresAt
        ? `Invite expires ${new Date(seat.inviteExpiresAt).toLocaleDateString()}`
        : '';
    const detailColor = seat.status === 'pending' && seat.emailFailed ? '#ef4444' : '#666';
    const role = seat.role === 'admin' ? 'Admin' : '';
    const removing = this.removingIds.has(seat.memberId);
    const action = seat.isSelf
      ? `<span style="font-size:calc(11px * ${SCALE});color:#666;">You</span>`
      : `<button class="btn btn-ghost enterprise-seat-remove-btn" data-member-id="${escapeHtml(seat.memberId)}" style="font-size:calc(12px * ${SCALE});" ${removing ? 'disabled' : ''}>${removing ? 'Removing...' : seat.status === 'active' ? 'Remove' : 'Withdraw'}</button>`;
    return `
      <div class="enterprise-seat-item" style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 12px;border:1px solid #1a1a1a;border-radius:6px;margin-bottom:8px;background:#0d0d0d;">
        <div style="min-width:0;">
          <div style="font-size:calc(13px * ${SCALE});color:#fff;overflow-wrap:anywhere;">${escapeHtml(seat.email ?? 'Unknown email')}</div>
          <div style="display:flex;align-items:center;gap:6px;margin-top:4px;flex-wrap:wrap;">
            <span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:${statusColor};"></span>
            <span style="font-size:calc(11px * ${SCALE});color:${statusColor};">${statusLabel}</span>
            ${role ? `<span style="font-size:calc(11px * ${SCALE});color:#888;">· ${role}</span>` : ''}
          </div>
          ${detail ? `<div style="font-size:calc(11px * ${SCALE});color:${detailColor};">${escapeHtml(detail)}</div>` : ''}
        </div>
        ${action}
      </div>`;
  }

  async handleInvite(): Promise<void> {
    const generation = this.accountGeneration;
    const input = this.overlay.querySelector<HTMLInputElement>('.enterprise-seats-email-input');
    const btn = this.overlay.querySelector<HTMLButtonElement>('.enterprise-seats-invite-btn');
    const email = input?.value.trim();
    if (!email || !btn || btn.disabled) return;
    btn.disabled = true;
    btn.textContent = 'Inviting...';
    this.error = '';
    try {
      const result = await inviteEnterpriseMembers([email]);
      if (generation !== this.accountGeneration) return;
      const status = result.invited[0]?.status;
      showToast(status === 'created' ? 'Invite sent' : status === 'already_active' ? 'Already a member' : 'Already invited');
      // Restore the form now; the refresh below can wait behind a load already
      // in flight, and the re-render applies the seat-cap and contract limits.
      if (input) input.value = '';
      this.renderInPlace();
      await this.load();
    } catch (err) {
      if (generation !== this.accountGeneration) return;
      this.error = errorMessage(err, 'Could not send the invite. Try again.');
      this.renderInPlace();
    }
  }

  async handleRemove(memberId: string): Promise<void> {
    const generation = this.accountGeneration;
    if (this.removingIds.has(memberId)) return;
    const seat = this.view?.seats.find((s) => s.memberId === memberId);
    const question = seat?.status === 'active'
      ? `Remove ${seat.email ?? 'this person'}? They lose Enterprise access immediately.`
      : `Withdraw the invite to ${seat?.email ?? 'this address'}?`;
    if (!confirm(question)) return;
    this.removingIds.add(memberId);
    this.renderInPlace();
    try {
      await removeEnterpriseMember(memberId);
      if (generation !== this.accountGeneration) return;
      showToast(seat?.status === 'active' ? 'Member removed' : 'Invite withdrawn');
      await this.load();
    } catch (err) {
      if (generation !== this.accountGeneration) return;
      this.error = errorMessage(err, 'Could not remove. Try again.');
      this.renderInPlace();
    } finally {
      if (generation === this.accountGeneration) {
        this.removingIds.delete(memberId);
        this.renderInPlace();
      }
    }
  }
}
