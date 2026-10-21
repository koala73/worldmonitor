export interface AccountAuthHandoffEffects {
  destroyEntitlementSubscription: () => void;
  beginEntitlementVerification: () => void;
  resetEntitlementState: () => void;
  markEntitlementVerificationUnavailable: () => void;
  destroySubscriptionWatch: () => void;
  rebindConvexAuthForWatchHandoff: (
    isCurrent: () => boolean,
    attachWatches: () => void,
  ) => Promise<boolean>;
  initEntitlementSubscription: (
    userId: string,
    isCurrent: () => boolean,
  ) => void | Promise<void>;
  initSubscriptionWatch: (
    userId: string,
    isCurrent: () => boolean,
  ) => void | Promise<void>;
  cloudPrefsSignIn: (userId: string) => void | Promise<void>;
}

/**
 * Reset user-scoped client state and start the authenticated watch handoff.
 *
 * The rebind effect is deliberately invoked before cloud preferences. Its
 * production implementation invalidates the old Clerk token synchronously
 * before its first await, after which Convex and cloud prefs may safely share
 * the new account's in-flight token fetch.
 */
export function startAccountAuthHandoff(input: {
  userId: string;
  isCurrent: () => boolean;
  effects: AccountAuthHandoffEffects;
}): Promise<boolean> {
  const { userId, isCurrent, effects } = input;

  effects.destroyEntitlementSubscription();
  // Publish `pending` before the null snapshot. Settings can receive the
  // reset synchronously, and must never interpret that account-transition
  // emission as a terminal lookup failure.
  effects.beginEntitlementVerification();
  effects.resetEntitlementState();
  effects.destroySubscriptionWatch();

  const handoff = effects.rebindConvexAuthForWatchHandoff(
    isCurrent,
    () => {
      void effects.initEntitlementSubscription(userId, isCurrent);
      void effects.initSubscriptionWatch(userId, isCurrent);
    },
  );
  void effects.cloudPrefsSignIn(userId);
  return handoff.then((ready) => {
    if (!ready && isCurrent()) {
      effects.markEntitlementVerificationUnavailable();
    }
    return ready;
  });
}
