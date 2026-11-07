/**
 * Settings section for Enterprise contract-account seats
 * (src/components/EnterpriseSeatsSection.ts, server: convex/enterpriseSeats.ts).
 * The server decides membership and admin rights; the section renders what
 * listMySeats returns and routes invite/remove to the admin mutations.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EnterpriseSeatsView } from '@/services/billing';

let view: EnterpriseSeatsView | null = null;
const inviteEnterpriseMembers = vi.fn(async (_emails: string[]) => ({
  invited: [{ email: 'new@hexion.com', memberId: 'm3', status: 'created' as const }],
}));
const removeEnterpriseMember = vi.fn(async (_memberId: string) => ({ ok: true as const, status: 'removed' as const }));

vi.mock('@/services/billing', () => ({
  listEnterpriseSeats: async () => view,
  inviteEnterpriseMembers: (emails: string[]) => inviteEnterpriseMembers(emails),
  removeEnterpriseMember: (memberId: string) => removeEnterpriseMember(memberId),
}));
vi.mock('@/utils/toast', () => ({ showToast: vi.fn() }));

const { EnterpriseSeatsSection } = await import('@/components/EnterpriseSeatsSection');

function adminView(overrides: Partial<EnterpriseSeatsView> = {}): EnterpriseSeatsView {
  return {
    accountName: 'Hexion',
    isAdmin: true,
    seatCap: 5,
    seatsUsed: 3,
    contractEnd: Date.UTC(2027, 10, 2),
    contractEnded: false,
    seats: [
      { memberId: 'm1', email: 'admin@hexion.com', status: 'active', role: 'admin', isSelf: true, invitedAt: 1, joinedAt: 1, inviteExpiresAt: null, emailFailed: false },
      { memberId: 'm2', email: 'analyst@hexion.com', status: 'active', role: 'member', isSelf: false, invitedAt: 1, joinedAt: 1, inviteExpiresAt: null, emailFailed: false },
      { memberId: 'm4', email: 'pending@hexion.com', status: 'pending', role: 'member', isSelf: false, invitedAt: 1, joinedAt: null, inviteExpiresAt: Date.UTC(2026, 10, 20), emailFailed: false },
    ],
    ...overrides,
  };
}

let overlay: HTMLElement;
let section: InstanceType<typeof EnterpriseSeatsSection>;

beforeEach(() => {
  overlay = document.createElement('div');
  overlay.innerHTML = '<div id="usEnterpriseSeats"></div>';
  document.body.appendChild(overlay);
  section = new EnterpriseSeatsSection(overlay);
  vi.stubGlobal('confirm', vi.fn(() => true));
});

afterEach(() => {
  overlay.remove();
  view = null;
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('EnterpriseSeatsSection', () => {
  it('renders nothing before the server answers and for non-members', async () => {
    expect(section.renderContent()).toBe('');
    view = null;
    await section.load();
    expect(section.renderContent()).toBe('');
  });

  it('shows the admin the roster, seat count and invite form; no remove button on their own seat', async () => {
    view = adminView();
    await section.load();
    const root = overlay.querySelector('#usEnterpriseSeats')!;
    expect(root.textContent).toContain('Hexion Enterprise seats');
    expect(root.textContent).toContain('3 / 5 used');
    expect(root.querySelectorAll('.enterprise-seat-item')).toHaveLength(3);
    const buttons = [...root.querySelectorAll<HTMLButtonElement>('.enterprise-seat-remove-btn')];
    expect(buttons.map((b) => [b.dataset.memberId, b.textContent])).toEqual([['m2', 'Remove'], ['m4', 'Withdraw']]);
    expect(root.querySelector<HTMLInputElement>('.enterprise-seats-email-input')!.disabled).toBe(false);
  });

  it('disables inviting when every seat is used or the contract has ended', async () => {
    view = adminView({ seatsUsed: 5 });
    await section.load();
    expect(overlay.querySelector<HTMLButtonElement>('.enterprise-seats-invite-btn')!.disabled).toBe(true);
    view = adminView({ contractEnded: true });
    await section.load();
    expect(overlay.querySelector<HTMLButtonElement>('.enterprise-seats-invite-btn')!.disabled).toBe(true);
    expect(overlay.textContent).toContain('contract has ended');
  });

  it('shows members the account and seat count but no roster or controls', async () => {
    view = adminView({ isAdmin: false, seats: [] });
    await section.load();
    expect(overlay.textContent).toContain('Your account admin adds and removes people');
    expect(overlay.querySelector('.enterprise-seats-invite-form')).toBeNull();
    expect(overlay.querySelector('.enterprise-seat-remove-btn')).toBeNull();
  });

  it('invites the typed address and refreshes', async () => {
    view = adminView();
    await section.load();
    overlay.querySelector<HTMLInputElement>('.enterprise-seats-email-input')!.value = ' new@hexion.com ';
    await section.handleInvite();
    expect(inviteEnterpriseMembers).toHaveBeenCalledWith(['new@hexion.com']);
  });

  it('tells the admin when an invite email was not sent', async () => {
    const base = adminView();
    view = adminView({ seats: base.seats.map((seat) => (seat.memberId === 'm4' ? { ...seat, emailFailed: true } : seat)) });
    await section.load();
    expect(overlay.textContent).toContain('The invite email could not be sent');
  });

  it('restores the invite form at once and refreshes after a load already in flight', async () => {
    view = adminView();
    await section.load();
    let release: () => void = () => {};
    const slow = new Promise<void>((resolve) => { release = resolve; });
    const billing = await import('@/services/billing');
    const spy = vi.spyOn(billing, 'listEnterpriseSeats');
    const stale = view;
    spy.mockImplementationOnce(async () => { await slow; return stale; });
    const inFlight = section.load();

    overlay.querySelector<HTMLInputElement>('.enterprise-seats-email-input')!.value = 'new@hexion.com';
    view = adminView({ seatsUsed: 4 });
    await section.handleInvite();
    const btn = overlay.querySelector<HTMLButtonElement>('.enterprise-seats-invite-btn')!;
    expect(btn.textContent).toBe('Invite');
    expect(btn.disabled).toBe(false);
    expect(overlay.querySelector<HTMLInputElement>('.enterprise-seats-email-input')!.value).toBe('');

    release();
    await inFlight;
    await vi.waitFor(() => expect(overlay.textContent).toContain('4 / 5 used'));
  });

  it('shows the seat-cap rejection in plain words', async () => {
    view = adminView();
    await section.load();
    inviteEnterpriseMembers.mockRejectedValueOnce(Object.assign(new Error('x'), { data: { kind: 'SEAT_CAP_REACHED' } }));
    overlay.querySelector<HTMLInputElement>('.enterprise-seats-email-input')!.value = 'new@hexion.com';
    await section.handleInvite();
    expect(overlay.textContent).toContain('All seats are in use');
  });

  it('removes a member after confirmation', async () => {
    view = adminView();
    await section.load();
    await section.handleRemove('m2');
    expect(globalThis.confirm).toHaveBeenCalledWith(expect.stringContaining('analyst@hexion.com'));
    expect(removeEnterpriseMember).toHaveBeenCalledWith('m2');
  });

  it('escapes emails from the server', async () => {
    view = adminView({
      seats: [{ memberId: 'x', email: '<img src=x onerror=alert(1)>@hexion.com', status: 'pending', role: 'member', isSelf: false, invitedAt: 1, joinedAt: null, inviteExpiresAt: null, emailFailed: false }],
    });
    await section.load();
    expect(overlay.querySelector('img')).toBeNull();
  });
});
