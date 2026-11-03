/**
 * `requestOwnAccountDeletion` may only report success on server evidence.
 *
 * The poll loop runs while Clerk is deleting the very session it polls with,
 * so a null current user is ambiguous: it is what a finished deletion looks
 * like, and equally what an SDK reload, a lost cached user on tab refocus, or
 * a multi-session `setActive()` in flight looks like. Treating that null as
 * proof made the caller `signOut()` whichever session Clerk considered active
 * and toast "Account deleted." for a deletion that might still be pending or
 * about to fail. These tests pin the evidence rule instead.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type DeletionStatus = {
  status: 'pending' | 'complete' | 'failed';
  step: string;
  userIdHash: string;
  clerkDeletedAt?: number;
  lastError?: string;
};

let currentUser: { id: string } | null = { id: 'user_self' };
const actionMock = vi.hoisted(() => vi.fn());
const queryMock = vi.hoisted(() => vi.fn());

vi.mock('@/services/clerk', () => ({
  getCurrentClerkUser: () => currentUser,
}));

vi.mock('@/services/convex-client', () => ({
  getConvexClient: async () => ({
    action: (...args: unknown[]) => actionMock(...args),
    query: (...args: unknown[]) => queryMock(...args),
  }),
  getConvexApi: async () => ({
    accountDeletion: { erase: { requestAccountDeletion: 'a', getOwnDeletionStatus: 'q' } },
  }),
  waitForConvexAuthForUser: async () => true,
}));

vi.mock('@/services/account-operation', () => ({
  settleAccountOperation: async (
    _userId: string,
    _label: string,
    run: () => Promise<unknown>,
  ) => run(),
}));

const { requestOwnAccountDeletion } = await import('@/services/account-deletion');

function pending(overrides: Partial<DeletionStatus> = {}): DeletionStatus {
  return { status: 'pending', step: 'external', userIdHash: 'hash', ...overrides };
}

beforeEach(() => {
  vi.useFakeTimers();
  currentUser = { id: 'user_self' };
  actionMock.mockReset().mockResolvedValue({ status: 'pending', userIdHash: 'hash' });
  queryMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('account deletion completion proof', () => {
  it('reports complete when the server says complete', async () => {
    queryMock.mockResolvedValue({ ...pending(), status: 'complete', step: 'complete' });
    const promise = requestOwnAccountDeletion();
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(promise).resolves.toEqual({ status: 'complete', userIdHash: 'hash' });
  });

  it('reports complete once the row shows the Clerk user is gone', async () => {
    // markExternalComplete can be blocked by a late subscription, so a row
    // parked at external with clerkDeletedAt set is still proof the login is
    // dead and signing out is correct.
    queryMock.mockResolvedValue(pending({ clerkDeletedAt: Date.now() }));
    const promise = requestOwnAccountDeletion();
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(promise).resolves.toEqual({ status: 'complete', userIdHash: 'hash' });
  });

  it('does not report complete when the session vanishes with no server proof', async () => {
    // The exact shape of the old bug: a transient null with the row still
    // pending used to resolve as complete and drive an unconditional signOut.
    queryMock.mockResolvedValue(pending());
    const promise = requestOwnAccountDeletion();
    const assertion = expect(promise).rejects.toThrow(/still running/i);
    await vi.advanceTimersByTimeAsync(500);
    currentUser = null;
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;
  });

  it('does not report complete when the query fails because the session died', async () => {
    // The revoked session is why the query fails, so the failure carries no
    // information about whether the erase finished.
    queryMock.mockImplementation(async () => {
      if (currentUser == null) throw new Error('session revoked');
      return pending();
    });
    const promise = requestOwnAccountDeletion();
    const assertion = expect(promise).rejects.toThrow(/still running/i);
    await vi.advanceTimersByTimeAsync(500);
    currentUser = null;
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;
  });

  it('still surfaces a real query error while the session is alive', async () => {
    queryMock.mockRejectedValue(new Error('Convex unavailable'));
    const promise = requestOwnAccountDeletion();
    const assertion = expect(promise).rejects.toThrow(/Convex unavailable/);
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
  });

  it('reports complete when the session dies after the server already proved it', async () => {
    queryMock.mockResolvedValueOnce(pending({ clerkDeletedAt: Date.now() }))
      .mockRejectedValue(new Error('session revoked'));
    const promise = requestOwnAccountDeletion();
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(promise).resolves.toEqual({ status: 'complete', userIdHash: 'hash' });
  });

  it('surfaces a failed deletion as a retryable error carrying the code', async () => {
    queryMock.mockResolvedValue(pending({ status: 'failed', lastError: 'DODO_TIMEOUT' }));
    const promise = requestOwnAccountDeletion();
    const assertion = expect(promise).rejects.toThrow(/DODO_TIMEOUT/);
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
  });
});
