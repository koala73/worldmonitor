/**
 * PERF-035: Object pool for frequently created/destroyed objects.
 * Reduces GC pressure during rapid data refresh cycles.
 */
export class ObjectPool<T> {
    private pool: T[] = [];
    private factory: () => T;
    private reset: (obj: T) => void;
    private maxSize: number;

    constructor(factory: () => T, reset: (obj: T) => void, maxSize = 100) {
        this.factory = factory;
        this.reset = reset;
        this.maxSize = maxSize;
    }

    acquire(): T {
        if (this.pool.length > 0) {
            return this.pool.pop()!;
        }
        return this.factory();
    }

    release(obj: T): void {
        if (this.pool.length < this.maxSize) {
            this.reset(obj);
            this.pool.push(obj);
        }
    }

    get size(): number {
        return this.pool.length;
    }

    clear(): void {
        this.pool.length = 0;
    }
}

/**
 * PERF-032: Rolling window that automatically evicts old entries.
 * Keeps a fixed-size buffer of entries ordered by insertion time.
 */
export class RollingWindow<T> {
    private items: T[] = [];
    private maxSize: number;

    constructor(maxSize: number) {
        this.maxSize = maxSize;
    }

    push(item: T): void {
        this.items.push(item);
        if (this.items.length > this.maxSize) {
            this.items.splice(0, this.items.length - this.maxSize);
        }
    }

    pushMany(newItems: T[]): void {
        this.items.push(...newItems);
        if (this.items.length > this.maxSize) {
            this.items.splice(0, this.items.length - this.maxSize);
        }
    }

    getAll(): readonly T[] {
        return this.items;
    }

    get length(): number {
        return this.items.length;
    }

    clear(): void {
        this.items.length = 0;
    }

    slice(start?: number, end?: number): T[] {
        return this.items.slice(start, end);
    }

    filter(predicate: (item: T) => boolean): T[] {
        return this.items.filter(predicate);
    }
}
