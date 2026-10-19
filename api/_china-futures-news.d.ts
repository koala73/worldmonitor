/** Reads the opt-in seeder-owned cache; null means disabled, invalid or stale. */
export function readChinaFuturesRss(now?: number): Promise<string | null>;
