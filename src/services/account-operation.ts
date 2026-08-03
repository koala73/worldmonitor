import { getCurrentClerkUser } from './clerk';

/**
 * Account-scoped requests may settle after Clerk has selected another user.
 * Never let a result (or an account-specific error) cross that handoff.
 */
export function isAccountStillCurrent(userId: string): boolean {
  return getCurrentClerkUser()?.id === userId;
}

export function assertAccountStillCurrent(userId: string, action: string): void {
  if (!isAccountStillCurrent(userId)) {
    throw new Error(`Account changed while ${action}. Try again.`);
  }
}

export async function settleAccountOperation<T>(
  userId: string,
  action: string,
  operation: () => Promise<T>,
): Promise<T> {
  assertAccountStillCurrent(userId, action);
  let result: T;
  try {
    result = await operation();
  } catch (err) {
    assertAccountStillCurrent(userId, action);
    throw err;
  }
  assertAccountStillCurrent(userId, action);
  return result;
}
