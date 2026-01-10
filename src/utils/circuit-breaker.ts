interface CircuitState {
  failures: number;
  cooldownUntil: number;
  lastError?: string;
}

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

export interface CircuitBreakerOptions {
  name: string;
  maxFailures?: number;
  cooldownMs?: number;
  cacheTtlMs?: number;
}

const DEFAULT_MAX_FAILURES = 2;
const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

export class CircuitBreaker<T> {
  private state: CircuitState = { failures: 0, cooldownUntil: 0 };
  private cache: CacheEntry<T> | null = null;
  private name: string;
  private maxFailures: number;
  private cooldownMs: number;
  private cacheTtlMs: number;

  constructor(options: CircuitBreakerOptions) {
    this.name = options.name;
    this.maxFailures = options.maxFailures ?? DEFAULT_MAX_FAILURES;
    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  }

  isOnCooldown(): boolean {
    if (Date.now() < this.state.cooldownUntil) {
      return true;
    }
    if (this.state.cooldownUntil > 0) {
      this.state = { failures: 0, cooldownUntil: 0 };
    }
    return false;
  }

  getCooldownRemaining(): number {
    return Math.max(0, Math.ceil((this.state.cooldownUntil - Date.now()) / 1000));
  }

  getStatus(): string {
    if (this.isOnCooldown()) {
      return `temporarily unavailable (retry in ${this.getCooldownRemaining()}s)`;
    }
    return 'ok';
  }

  getCached(): T | null {
    if (this.cache && Date.now() - this.cache.timestamp < this.cacheTtlMs) {
      return this.cache.data;
    }
    return null;
  }

  getCachedOrDefault(defaultValue: T): T {
    return this.cache?.data ?? defaultValue;
  }

  recordSuccess(data: T): void {
    this.state = { failures: 0, cooldownUntil: 0 };
    this.cache = { data, timestamp: Date.now() };
  }

  recordFailure(error?: string): void {
    this.state.failures++;
    this.state.lastError = error;
    if (this.state.failures >= this.maxFailures) {
      this.state.cooldownUntil = Date.now() + this.cooldownMs;
      console.warn(`[${this.name}] On cooldown for ${this.cooldownMs / 1000}s after ${this.state.failures} failures`);
    }
  }

  async execute<R extends T>(
    fn: () => Promise<R>,
    defaultValue: R
  ): Promise<R> {
    if (this.isOnCooldown()) {
      console.log(`[${this.name}] Currently unavailable, ${this.getCooldownRemaining()}s remaining`);
      return this.getCachedOrDefault(defaultValue) as R;
    }

    const cached = this.getCached();
    if (cached !== null) {
      return cached as R;
    }

    try {
      const result = await fn();
      this.recordSuccess(result);
      return result;
    } catch (e) {
      const msg = String(e);
      console.error(`[${this.name}] Failed:`, msg);
      this.recordFailure(msg);
      return this.getCachedOrDefault(defaultValue) as R;
    }
  }
}

// Registry of circuit breakers for global status
const breakers = new Map<string, CircuitBreaker<unknown>>();

export function createCircuitBreaker<T>(options: CircuitBreakerOptions): CircuitBreaker<T> {
  const breaker = new CircuitBreaker<T>(options);
  breakers.set(options.name, breaker as CircuitBreaker<unknown>);
  return breaker;
}

export function getCircuitBreakerStatus(): Record<string, string> {
  const status: Record<string, string> = {};
  breakers.forEach((breaker, name) => {
    status[name] = breaker.getStatus();
  });
  return status;
}

export function isCircuitBreakerOnCooldown(name: string): boolean {
  const breaker = breakers.get(name);
  return breaker ? breaker.isOnCooldown() : false;
}

export function getCircuitBreakerCooldownInfo(name: string): { onCooldown: boolean; remainingSeconds: number } {
  const breaker = breakers.get(name);
  if (!breaker) return { onCooldown: false, remainingSeconds: 0 };
  return {
    onCooldown: breaker.isOnCooldown(),
    remainingSeconds: breaker.getCooldownRemaining()
  };
}
