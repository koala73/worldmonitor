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
import { t } from '@/services/i18n';

/** Server error code to the catalogue key of its copy. */
const ERROR_COPY: Record<string, string> = {
  SEAT_CAP_REACHED: 'settings.account.enterpriseSeats.errors.seatCap',
  INVITEE_DOMAIN_NOT_CORPORATE: 'settings.account.enterpriseSeats.errors.inviteeDomain',
  CANNOT_INVITE_SELF: 'settings.account.enterpriseSeats.errors.self',
  CONTRACT_ENDED: 'settings.account.enterpriseSeats.errors.contractEnded',
  NOT_ACCOUNT_ADMIN: 'settings.account.enterpriseSeats.errors.notAdmin',
  CANNOT_REMOVE_SELF: 'settings.account.enterpriseSeats.errors.removeSelf',
  TOO_MANY_EMAILS: 'settings.account.enterpriseSeats.errors.tooMany',
  INVITE_RATE_LIMITED: 'settings.account.enterpriseSeats.errors.rateLimited',
};

function errorMessage(err: unknown, fallbackKey: string): string {
  const kind = businessInviteErrorKind(err);
  return t((kind && ERROR_COPY[kind]) || fallbackKey);
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
      this.error = errorMessage(err, 'settings.account.enterpriseSeats.loadFailed');
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
        <div style="font-size:calc(13px * ${SCALE});font-weight:600;color:#fff;">${escapeHtml(t('settings.account.enterpriseSeats.heading', { account: view.accountName }))}</div>
        <div style="font-size:calc(11px * ${SCALE});color:#888;">${escapeHtml(t('settings.account.seats.used', { used: String(view.seatsUsed), cap: String(view.seatCap) }))}</div>
      </div>`;
    const errorLine = this.error
      ? `<div style="font-size:calc(12px * ${SCALE});color:#ef4444;margin-bottom:12px;">${escapeHtml(this.error)}</div>`
      : '';

    if (!view.isAdmin) {
      return `
        <div class="enterprise-seats-section" style="margin-top:16px;padding:14px 16px;border:1px solid #1a1a1a;border-radius:6px;background:#0d0d0d;">
          ${header}
          <div style="font-size:calc(12px * ${SCALE});color:#999;">${escapeHtml(t('settings.account.enterpriseSeats.memberHint'))}</div>
          ${errorLine}
        </div>`;
    }

    const canInvite = !view.contractEnded && !full;
    const hint = t(view.contractEnded
      ? 'settings.account.enterpriseSeats.errors.contractEnded'
      : full
        ? 'settings.account.enterpriseSeats.hintFull'
        : 'settings.account.enterpriseSeats.hintOpen');

    return `
      <div class="enterprise-seats-section" style="margin-top:16px;padding:14px 16px;border:1px solid #1a1a1a;border-radius:6px;background:#0d0d0d;">
        ${header}
        <div style="font-size:calc(12px * ${SCALE});color:#999;margin-bottom:12px;">${escapeHtml(hint)}</div>
        <div class="enterprise-seats-invite-form" style="display:flex;gap:8px;margin-bottom:12px;">
          <input type="email" class="enterprise-seats-email-input" aria-label="${escapeHtml(t('settings.account.enterpriseSeats.emailLabel'))}" placeholder="colleague@company.com" style="flex:1;min-width:0;padding:8px 10px;background:#111;border:1px solid #1a1a1a;border-radius:4px;color:#fff;font-size:calc(13px * ${SCALE});" ${canInvite ? '' : 'disabled'} />
          <button class="btn btn-primary enterprise-seats-invite-btn" ${canInvite ? '' : 'disabled'}>${escapeHtml(t('settings.account.seats.invite'))}</button>
        </div>
        ${errorLine}
        <div>${view.seats.map((seat) => this.renderSeat(seat)).join('')}</div>
      </div>`;
  }

  private renderSeat(seat: EnterpriseSeat): string {
    const statusLabel = t(seat.status === 'active'
      ? 'settings.account.enterpriseSeats.statusActive'
      : seat.status === 'expired' ? 'settings.account.enterpriseSeats.statusExpired' : 'settings.account.enterpriseSeats.statusInvited');
    const statusColor = seat.status === 'active' ? '#22c55e' : seat.status === 'expired' ? '#666' : '#eab308';
    const detail = seat.status === 'pending' && seat.emailFailed
      ? t('settings.account.enterpriseSeats.emailFailed')
      : seat.status === 'pending' && seat.inviteExpiresAt
        ? t('settings.account.enterpriseSeats.inviteExpires', { date: new Date(seat.inviteExpiresAt).toLocaleDateString() })
        : '';
    const detailColor = seat.status === 'pending' && seat.emailFailed ? '#ef4444' : '#666';
    const role = seat.role === 'admin' ? t('settings.account.enterpriseSeats.roleAdmin') : '';
    const removing = this.removingIds.has(seat.memberId);
    const action = seat.isSelf
      ? `<span style="font-size:calc(11px * ${SCALE});color:#666;">${escapeHtml(t('settings.account.enterpriseSeats.you'))}</span>`
      : `<button class="btn btn-ghost enterprise-seat-remove-btn" data-member-id="${escapeHtml(seat.memberId)}" style="font-size:calc(12px * ${SCALE});" ${removing ? 'disabled' : ''}>${escapeHtml(t(removing
        ? 'settings.account.seats.removing'
        : seat.status === 'active' ? 'settings.account.seats.remove' : 'settings.account.enterpriseSeats.withdraw'))}</button>`;
    return `
      <div class="enterprise-seat-item" style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 12px;border:1px solid #1a1a1a;border-radius:6px;margin-bottom:8px;background:#0d0d0d;">
        <div style="min-width:0;">
          <div style="font-size:calc(13px * ${SCALE});color:#fff;overflow-wrap:anywhere;">${escapeHtml(seat.email ?? t('settings.account.enterpriseSeats.unknownEmail'))}</div>
          <div style="display:flex;align-items:center;gap:6px;margin-top:4px;flex-wrap:wrap;">
            <span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:${statusColor};"></span>
            <span style="font-size:calc(11px * ${SCALE});color:${statusColor};">${escapeHtml(statusLabel)}</span>
            ${role ? `<span style="font-size:calc(11px * ${SCALE});color:#888;">· ${escapeHtml(role)}</span>` : ''}
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
    btn.textContent = t('settings.account.seats.inviting');
    this.error = '';
    try {
      const result = await inviteEnterpriseMembers([email]);
      if (generation !== this.accountGeneration) return;
      const status = result.invited[0]?.status;
      showToast(t(status === 'created'
        ? 'settings.account.seats.inviteSent'
        : status === 'already_active' ? 'settings.account.enterpriseSeats.alreadyMember' : 'settings.account.seats.alreadyInvited'));
      // Restore the form now; the refresh below can wait behind a load already
      // in flight, and the re-render applies the seat-cap and contract limits.
      if (input) input.value = '';
      this.renderInPlace();
      await this.load();
    } catch (err) {
      if (generation !== this.accountGeneration) return;
      this.error = errorMessage(err, 'settings.account.enterpriseSeats.inviteFailed');
      this.renderInPlace();
    }
  }

  async handleRemove(memberId: string): Promise<void> {
    const generation = this.accountGeneration;
    if (this.removingIds.has(memberId)) return;
    const seat = this.view?.seats.find((s) => s.memberId === memberId);
    const email = seat?.email;
    const question = seat?.status === 'active'
      ? (email ? t('settings.account.enterpriseSeats.confirmRemove', { email }) : t('settings.account.enterpriseSeats.confirmRemoveUnknown'))
      : (email ? t('settings.account.enterpriseSeats.confirmWithdraw', { email }) : t('settings.account.enterpriseSeats.confirmWithdrawUnknown'));
    if (!confirm(question)) return;
    this.removingIds.add(memberId);
    this.renderInPlace();
    try {
      await removeEnterpriseMember(memberId);
      if (generation !== this.accountGeneration) return;
      showToast(t(seat?.status === 'active' ? 'settings.account.enterpriseSeats.removed' : 'settings.account.enterpriseSeats.withdrawn'));
      await this.load();
    } catch (err) {
      if (generation !== this.accountGeneration) return;
      this.error = errorMessage(err, 'settings.account.enterpriseSeats.removeFailed');
      this.renderInPlace();
    } finally {
      if (generation === this.accountGeneration) {
        this.removingIds.delete(memberId);
        this.renderInPlace();
      }
    }
  }
}
