import type { UserResource } from '@clerk/types';

export type ClerkUserState = { user: UserResource | null; isLoaded: boolean; signedIn: boolean };
export type ClerkUserStateUpdate = ClerkUserState | ((current: ClerkUserState) => ClerkUserState);
export type ClerkUserStateSetter = (update: ClerkUserStateUpdate) => void;

export type ClerkUserStateSource = {
  user: UserResource | null;
  addListener(cb: () => void): () => void;
};

type ClerkUserStateSyncDeps = {
  hasLiveClientSession(): boolean;
  subscribeClerkLoaded(cb: (clerk: ClerkUserStateSource) => void): () => void;
  scheduleClerkLoad(): Promise<ClerkUserStateSource> | null;
  onLoadError(err: unknown): void;
};

function applyClientSessionBaseline(current: ClerkUserState, signedIn: boolean): ClerkUserState {
  return current.user === null && current.isLoaded === true && current.signedIn === signedIn
    ? current
    : { user: null, isLoaded: true, signedIn };
}

function stateFromClerk(clerk: ClerkUserStateSource): ClerkUserState {
  const user = clerk.user ?? null;
  return { user, isLoaded: true, signedIn: !!user };
}

export function startClerkUserStateSync(
  setState: ClerkUserStateSetter,
  deps: ClerkUserStateSyncDeps
): () => void {
  let mounted = true;
  let unsubscribeAuth: (() => void) | undefined;
  const setFromClerk = (clerk: ClerkUserStateSource): void => {
    if (!mounted) return;
    setState(stateFromClerk(clerk));
    if (!unsubscribeAuth) {
      unsubscribeAuth = clerk.addListener(() => {
        if (!mounted) return;
        setState(stateFromClerk(clerk));
      });
    }
  };

  const signedIn = deps.hasLiveClientSession();
  // subscribeClerkLoaded fires synchronously after Clerk is loaded. Queue the
  // cookie baseline first so the real Clerk user wins React's batched remount.
  setState((current) => applyClientSessionBaseline(current, signedIn));
  const unsubscribeLoaded = deps.subscribeClerkLoaded(setFromClerk);

  if (signedIn) {
    const scheduledClerk = deps.scheduleClerkLoad();
    if (!scheduledClerk) {
      setState({ user: null, isLoaded: true, signedIn: false });
    } else {
      scheduledClerk.catch((err) => {
        if (mounted) deps.onLoadError(err);
      });
    }
  }

  return () => {
    mounted = false;
    unsubscribeLoaded();
    unsubscribeAuth?.();
  };
}
