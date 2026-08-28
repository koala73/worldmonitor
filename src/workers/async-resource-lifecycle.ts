export class AsyncResourceLifecycle<K, V> {
  private readonly loaded = new Map<K, V>();
  private readonly loading = new Map<K, Promise<V>>();
  private readonly activeUses = new Map<K, number>();
  private readonly idleWaiters = new Map<K, Set<() => void>>();
  private readonly unloading = new Map<K, Promise<boolean>>();
  private resetting: Promise<void> | null = null;

  constructor(private readonly dispose: (value: V) => void | Promise<void>) {}

  keys(): K[] {
    return [...this.loaded.keys()];
  }

  async load(key: K, loader: () => Promise<V>): Promise<V> {
    while (true) {
      if (this.resetting) await this.resetting;
      const unloading = this.unloading.get(key);
      if (unloading) {
        await unloading;
        continue;
      }

      if (this.loaded.has(key)) return this.loaded.get(key)!;

      let loading = this.loading.get(key);
      if (!loading) {
        let started!: Promise<V>;
        started = loader()
          .then((value) => {
            this.loaded.set(key, value);
            return value;
          })
          .finally(() => {
            if (this.loading.get(key) === started) this.loading.delete(key);
          });
        this.loading.set(key, started);
        loading = started;
      }

      const value = await loading;
      if (this.resetting || this.unloading.has(key)) continue;
      return value;
    }
  }

  async use<T>(key: K, loader: () => Promise<V>, operation: (value: V) => Promise<T>): Promise<T> {
    while (true) {
      const value = await this.load(key, loader);
      const unloading = this.unloading.get(key);
      if (this.resetting || unloading) {
        if (this.resetting) await this.resetting;
        if (unloading) await unloading;
        continue;
      }

      this.activeUses.set(key, (this.activeUses.get(key) ?? 0) + 1);
      try {
        return await operation(value);
      } finally {
        this.release(key);
      }
    }
  }

  unload(key: K): Promise<boolean> {
    const existing = this.unloading.get(key);
    if (existing) return existing;

    let operation!: Promise<boolean>;
    operation = this.disposeWhenIdle(key).finally(() => {
      if (this.unloading.get(key) === operation) this.unloading.delete(key);
    });
    this.unloading.set(key, operation);
    return operation;
  }

  reset(): Promise<void> {
    if (this.resetting) return this.resetting;

    let operation!: Promise<void>;
    operation = (async () => {
      const keys = new Set([...this.loaded.keys(), ...this.loading.keys(), ...this.unloading.keys()]);
      await Promise.all([...keys].map((key) => this.unload(key)));
    })().finally(() => {
      if (this.resetting === operation) this.resetting = null;
    });
    this.resetting = operation;
    return operation;
  }

  private async disposeWhenIdle(key: K): Promise<boolean> {
    const loading = this.loading.get(key);
    if (loading) {
      try {
        await loading;
      } catch {
        return false;
      }
    }

    await this.waitUntilIdle(key);
    if (!this.loaded.has(key)) return false;

    const value = this.loaded.get(key)!;
    await this.dispose(value);
    if (this.loaded.get(key) === value) this.loaded.delete(key);
    return true;
  }

  private waitUntilIdle(key: K): Promise<void> {
    if ((this.activeUses.get(key) ?? 0) === 0) return Promise.resolve();
    return new Promise((resolve) => {
      const waiters = this.idleWaiters.get(key) ?? new Set();
      waiters.add(resolve);
      this.idleWaiters.set(key, waiters);
    });
  }

  private release(key: K): void {
    const remaining = (this.activeUses.get(key) ?? 1) - 1;
    if (remaining > 0) {
      this.activeUses.set(key, remaining);
      return;
    }

    this.activeUses.delete(key);
    const waiters = this.idleWaiters.get(key);
    if (!waiters) return;
    this.idleWaiters.delete(key);
    for (const resolve of waiters) resolve();
  }
}
