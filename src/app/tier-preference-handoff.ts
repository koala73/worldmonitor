/**
 * Tracks the account whose cloud preferences are replacing anonymous/local
 * state. Tier reconciliation must not mutate that state until the handoff's
 * success/error completion signal arrives.
 */
export class TierPreferenceHandoff {
  private activeUserId: string | null = null;

  begin(userId: string): void {
    this.activeUserId = userId;
  }

  shouldDefer(currentUserId: string | null): boolean {
    return currentUserId !== null && this.activeUserId === currentUserId;
  }

  /** Return true only when this completion still belongs to the active account. */
  complete(userId: string, currentUserId: string | null): boolean {
    if (this.activeUserId !== userId) return false;
    this.activeUserId = null;
    return currentUserId === userId;
  }

  clear(): void {
    this.activeUserId = null;
  }
}
