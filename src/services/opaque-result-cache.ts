export interface OpaqueResultCacheOptions {
  maxEntries: number;
  ttlMs: number;
  now?: () => number;
  createKey?: () => string;
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

function randomOpaqueKey(): string {
  const runtimeCrypto = globalThis.crypto;
  if (!runtimeCrypto?.getRandomValues) {
    throw new Error('Secure randomness is unavailable');
  }
  const bytes = new Uint8Array(16);
  runtimeCrypto.getRandomValues(bytes);
  return `sr_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

/** A small in-memory, per-page cache for unguessable result capabilities. */
export class OpaqueResultCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly createKey: () => string;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;

  public constructor(options: OpaqueResultCacheOptions) {
    this.maxEntries = Math.max(1, Math.floor(options.maxEntries));
    this.ttlMs = Math.max(1, Math.floor(options.ttlMs));
    this.now = options.now ?? Date.now;
    this.createKey = options.createKey ?? randomOpaqueKey;
  }

  public issue(value: T): string {
    this.pruneExpired();
    let key = this.createKey();
    for (let attempts = 0; this.entries.has(key) && attempts < 4; attempts += 1) {
      key = this.createKey();
    }
    if (this.entries.has(key)) throw new Error('Could not issue a unique result key');

    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (!oldest) break;
      this.entries.delete(oldest);
    }
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
    this.scheduleExpirySweep();
    return key;
  }

  public get(key: string): T | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      this.scheduleExpirySweep();
      return null;
    }
    return entry.value;
  }

  public delete(key: string): void {
    this.entries.delete(key);
    this.scheduleExpirySweep();
  }

  public clear(): void {
    this.entries.clear();
    if (this.expiryTimer !== null) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
  }

  public get size(): number {
    this.pruneExpired();
    this.scheduleExpirySweep();
    return this.entries.size;
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }

  private scheduleExpirySweep(): void {
    if (this.expiryTimer !== null) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    let earliest = Number.POSITIVE_INFINITY;
    for (const entry of this.entries.values()) earliest = Math.min(earliest, entry.expiresAt);
    if (!Number.isFinite(earliest)) return;

    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = null;
      this.pruneExpired();
      this.scheduleExpirySweep();
    }, Math.max(0, earliest - this.now()));
    // Node test timers should not keep the process alive; browsers return a
    // numeric handle with no unref method.
    (this.expiryTimer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
  }
}
