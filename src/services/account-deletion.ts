/**
 * Client wrapper for self-serve account deletion.
 *
 * The public Convex mutation authenticates from the current Clerk subject,
 * then this helper polls until the orchestrator finishes (or the session
 * dies because Clerk already deleted the user). `settleAccountOperation`
 * fences the in-flight request so an account switch cannot apply another
 * user's result.
 */

import {
  getConvexApi,
  getConvexClient,
  waitForConvexAuthForUser,
} from './convex-client';
import { getCurrentClerkUser } from './clerk';
import { settleAccountOperation } from './account-operation';

export type AccountDeletionResult = {
  status: 'pending' | 'complete' | 'already_deleted';
  userIdHash: string;
};

type DeletionStatus = {
  status: 'pending' | 'complete' | 'failed';
  step: string;
  userIdHash: string;
  clerkDeletedAt?: number;
  lastError?: string;
};

/**
 * Server evidence that this account is really gone.
 *
 * A null current Clerk user is NOT evidence: an SDK reload, a lost cached
 * user on tab refocus, or a multi-session setActive() in flight all look
 * identical to a finished deletion, and the sign-out that follows ends
 * whichever session Clerk currently considers active. Accept only a
 * server-reported `complete`, or a row that reached the external step with
 * the Clerk user already deleted.
 */
function serverConfirmedDeletion(status: DeletionStatus | null): boolean {
  if (!status) return false;
  if (status.status === 'complete') return true;
  return status.step === 'external' && status.clerkDeletedAt != null;
}

const POLL_INTERVAL_MS = 400;
const POLL_TIMEOUT_MS = 45_000;

const STILL_RUNNING_MESSAGE =
  'Account deletion is still running. Reload in a moment to check.';

/**
 * `lastError` from the public status query is a stable code, not prose
 * (see publicErrorCode in convex/accountDeletion/erase.ts), so render a
 * sentence and keep the code for support.
 */
function deletionFailureMessage(code: string | undefined): string {
  return code
    ? `Account deletion failed (${code}). Try again, or contact support with that code.`
    : 'Account deletion failed. Try again.';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function currentUserId(): string | null {
  return getCurrentClerkUser()?.id ?? null;
}

function accountChangedError(): Error {
  return new Error('Account changed while deleting the account. Try again.');
}

function assertNotSwitched(expectedUserId: string): void {
  const current = currentUserId();
  if (current != null && current !== expectedUserId) {
    throw accountChangedError();
  }
}

/**
 * Request deletion of the current Clerk subject and wait until credentials
 * are dead. Throws if another account is selected mid-flight.
 */
export async function requestOwnAccountDeletion(): Promise<AccountDeletionResult> {
  const userId = currentUserId();
  if (!userId) throw new Error('Sign in to delete your account.');

  const [client, api] = await Promise.all([getConvexClient(), getConvexApi()]);
  if (!client || !api) throw new Error('Convex unavailable');
  if (!await waitForConvexAuthForUser(userId)) {
    throw accountChangedError();
  }

  const started = await settleAccountOperation(
    userId,
    'deleting the account',
    () => client.action(
      (api as any).accountDeletion.erase.requestAccountDeletion,
      {},
    ) as Promise<AccountDeletionResult>,
  );

  if (started.status === 'complete' || started.status === 'already_deleted') {
    return started;
  }

  // Last status the server actually reported. The session can die at any
  // point once Clerk deletes the user, so this is the only durable proof we
  // will have that the erase reached its end.
  let lastStatus: DeletionStatus | null = null;
  const confirmed = (): AccountDeletionResult => ({
    status: 'complete',
    userIdHash: lastStatus?.userIdHash ?? started.userIdHash,
  });

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    assertNotSwitched(userId);
    if (currentUserId() == null && serverConfirmedDeletion(lastStatus)) {
      return confirmed();
    }

    await sleep(POLL_INTERVAL_MS);

    assertNotSwitched(userId);
    if (currentUserId() == null && serverConfirmedDeletion(lastStatus)) {
      return confirmed();
    }

    try {
      const status = await settleAccountOperation(
        userId,
        'deleting the account',
        () => client.query(
          (api as any).accountDeletion.erase.getOwnDeletionStatus,
          {},
        ) as Promise<DeletionStatus | null>,
      );
      if (status) lastStatus = status;
      if (serverConfirmedDeletion(status)) {
        return confirmed();
      }
      if (status?.status === 'failed') {
        throw new Error(deletionFailureMessage(status.lastError));
      }
    } catch (err) {
      assertNotSwitched(userId);
      // The query can fail simply because Clerk already revoked the session.
      // That is only a success when the server told us so before it died.
      if (serverConfirmedDeletion(lastStatus)) {
        return confirmed();
      }
      if (currentUserId() == null) {
        throw new Error(STILL_RUNNING_MESSAGE);
      }
      throw err;
    }
  }

  throw new Error(STILL_RUNNING_MESSAGE);
}
