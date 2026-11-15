/**
 * Browser-memory caching shared by every orbital surface (map popup, evidence
 * sheet, image viewer). Entries stay in this tab's memory only: nothing here is
 * persisted or sent anywhere, so a cached point never leaves the browser.
 */

/** Work started once for every consumer that joins it, aborted only when every consumer has left. */
export interface SharedWork<T> {
  /** Settles with the work's result, or with `left` when `signal` aborts first. */
  join<L>(signal: AbortSignal | undefined, left: () => L): Promise<T | L>;
  /** The work's own result, for bookkeeping that must not count as a consumer. */
  readonly done: Promise<T>;
  /** True once every consumer left before it settled, so it was aborted and must not be joined. */
  readonly abandoned: boolean;
}

export function shareWork<T>(run: (signal: AbortSignal) => Promise<T>): SharedWork<T> {
  const controller = new AbortController();
  let consumers = 0;
  let settled = false;
  const result = run(controller.signal).finally(() => { settled = true; });
  result.catch(() => {});
  return {
    done: result,
    get abandoned() { return controller.signal.aborted; },
    join<L>(signal: AbortSignal | undefined, left: () => L): Promise<T | L> {
      if (signal?.aborted) {
        if (consumers === 0 && !settled) controller.abort();
        return Promise.resolve(left());
      }
      consumers++;
      return new Promise<T | L>((resolve, reject) => {
        const leave = () => {
          consumers--;
          if (consumers === 0 && !settled) controller.abort();
          try { resolve(left()); } catch (error) { reject(error); }
        };
        signal?.addEventListener('abort', leave, { once: true });
        result.then(
          (value) => { signal?.removeEventListener('abort', leave); resolve(value); },
          (error: unknown) => { signal?.removeEventListener('abort', leave); reject(error); },
        );
      });
    },
  };
}

/** A small least-recently-used map whose entries also expire. */
export class BoundedCache<V> {
  private readonly entries = new Map<string, { value: V; expiresAt: number }>();

  constructor(private readonly maxEntries: number) {}

  get(key: string, nowMs: number): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    if (entry.expiresAt <= nowMs) return undefined;
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V, expiresAt: number): void {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt });
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
  }

  delete(key: string, value?: V): void {
    if (value === undefined || this.entries.get(key)?.value === value) this.entries.delete(key);
  }

  /** Live entries, most recently used last. */
  *live(nowMs: number): Generator<[string, V]> {
    for (const [key, entry] of [...this.entries]) {
      if (entry.expiresAt <= nowMs) this.entries.delete(key);
      else yield [key, entry.value];
    }
  }
}
