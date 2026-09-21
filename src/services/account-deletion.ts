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
  lastError?: string;
};

const POLL_INTERVAL_MS = 400;
const POLL_TIMEOUT_MS = 45_000;

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
    () => client.mutation(
      (api as any).accountDeletion.erase.requestAccountDeletion,
      {},
    ) as Promise<AccountDeletionResult>,
  );

  if (started.status === 'complete' || started.status === 'already_deleted') {
    return started;
  }

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    assertNotSwitched(userId);
    if (currentUserId() == null) {
      return { status: 'complete', userIdHash: started.userIdHash };
    }

    await sleep(POLL_INTERVAL_MS);

    assertNotSwitched(userId);
    if (currentUserId() == null) {
      return { status: 'complete', userIdHash: started.userIdHash };
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
      if (status?.status === 'complete') {
        return { status: 'complete', userIdHash: status.userIdHash };
      }
      if (status?.status === 'failed') {
        throw new Error(status.lastError ?? 'Account deletion failed. Try again.');
      }
    } catch (err) {
      assertNotSwitched(userId);
      if (currentUserId() == null) {
        return { status: 'complete', userIdHash: started.userIdHash };
      }
      throw err;
    }
  }

  throw new Error('Account deletion is still running. Try again in a moment.');
}
