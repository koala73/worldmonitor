/**
 * Two-phase heavy-layer data commit for DeckGLMap (#4558 / #4537).
 *
 * The interaction-attributed render frame must not synchronously tessellate a
 * heavy deck.gl layer (conflict-zone GeoJson, Supercluster cluster layers). This
 * gate models the *scheduling and per-layer data state* of a two-phase commit,
 * deliberately free of any DOM/deck.gl/WebGL dependency so it is unit-testable
 * under `tsx --test`:
 *
 *   - Phase 1 (immediate): the render builds each heavy layer with its
 *     PREVIOUSLY-committed data via `present(key)` — so an already-visible layer
 *     never blanks (R2 no-flicker); a first build has no previous data and shows
 *     empty for one frame (R3, stable id, acceptable since it was not visible).
 *   - Phase 2 (deferred): a coalesced, teardown-guarded flush moves staged data
 *     to committed and calls `onCommit(changedKeys)`, which the owner uses to run
 *     a second render carrying the real heavy data — off the interaction frame.
 *
 * The owner (DeckGLMap) wires `schedule` to `yieldToMain`, `isAlive` to the
 * `!renderPaused && !webglLost && maplibreMap` guard, and `onCommit` to a
 * deferred `updateLayers`. This module owns none of that — only the state machine.
 */

export interface DeferredCommitDeps<T> {
  /**
   * Schedule the deferred flush to run later (e.g. `yieldToMain`/`setTimeout(0)`).
   * Returns a cancel handle so a superseding stage can coalesce.
   */
  schedule: (run: () => void) => () => void;
  /** True while the map can still receive a commit (not paused/destroyed/WebGL-lost). */
  isAlive: () => boolean;
  /** Called on the deferred flush with the heavy-layer keys whose data changed. */
  onCommit: (changedKeys: string[]) => void;
  /** Equality used to decide whether staged data differs from committed (default `Object.is`). */
  equals?: (a: T | undefined, b: T | undefined) => boolean;
}

export class DeferredHeavyCommit<T> {
  private readonly committed = new Map<string, T>();
  private readonly pending = new Map<string, T>();
  private cancelHandle: (() => void) | null = null;
  private readonly equals: (a: T | undefined, b: T | undefined) => boolean;

  constructor(private readonly deps: DeferredCommitDeps<T>) {
    this.equals = deps.equals ?? ((a, b) => Object.is(a, b));
  }

  /**
   * Stage a heavy layer's newly-available data. If it differs from what is
   * currently committed, schedule a coalesced deferred flush. A burst of stage()
   * calls before the flush runs collapses to a single flush.
   */
  stage(key: string, data: T): void {
    this.pending.set(key, data);
    if (this.equals(data, this.committed.get(key))) {
      // No real change for this key; don't schedule on its account. If this
      // empties the pending set, drop any flush a prior stage() scheduled so
      // hasPending() doesn't report a flush that would commit nothing.
      this.pending.delete(key);
      if (this.pending.size === 0) this.clearHandle();
      return;
    }
    this.scheduleFlush();
  }

  /** Data to present for `key` on the immediate (Phase 1) render: the last committed value, or undefined on first build. */
  present(key: string): T | undefined {
    return this.committed.get(key);
  }

  /** Whether a deferred flush is currently scheduled. */
  hasPending(): boolean {
    return this.cancelHandle !== null;
  }

  /** Keys currently staged but not yet committed (for assertions/diagnostics). */
  pendingKeys(): string[] {
    return [...this.pending.keys()];
  }

  /**
   * Run any scheduled flush immediately. Honors the teardown guard: if the map
   * is no longer alive, the flush is dropped without committing (R4).
   */
  flushNow(): void {
    this.clearHandle();
    if (this.pending.size === 0) return;
    if (!this.deps.isAlive()) {
      // Teardown between schedule and flush — drop staged data, commit nothing.
      this.pending.clear();
      return;
    }
    const changed: string[] = [];
    for (const [key, data] of this.pending) {
      if (!this.equals(data, this.committed.get(key))) changed.push(key);
      this.committed.set(key, data);
    }
    this.pending.clear();
    if (changed.length > 0) this.deps.onCommit(changed);
  }

  /** Drop any scheduled flush and staged data without committing (teardown/destroy). */
  cancel(): void {
    this.clearHandle();
    this.pending.clear();
  }

  private scheduleFlush(): void {
    // Coalesce: cancel a prior scheduled flush and reschedule one.
    this.clearHandle();
    this.cancelHandle = this.deps.schedule(() => this.flushNow());
  }

  private clearHandle(): void {
    if (this.cancelHandle) {
      this.cancelHandle();
      this.cancelHandle = null;
    }
  }
}
