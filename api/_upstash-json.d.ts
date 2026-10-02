export interface UpstashJsonReadResult {
  status: 'hit' | 'miss' | 'error';
  value: unknown | null;
}

/**
 * Deployment key prefix — mirror of server/_shared/redis.ts::getKeyPrefix.
 * '' in production (and in any runtime without VERCEL_ENV, e.g. the Railway
 * digest service importing this module). Computed per call (never memoized),
 * so tests may mutate VERCEL_ENV between calls.
 */
export declare function getKeyPrefix(): string;

/**
 * Prefix an app-owned key explicitly. For mixed-ownership pipelines that
 * pre-finalize each key and then pass raw = true to the helpers.
 */
export declare function applyRedisKeyPrefix(key: string): string;

/**
 * `raw = true` reads/writes the key verbatim (seeder-owned or already-final
 * keys); default applies the deployment key prefix to app-owned keys.
 */
export declare function readJsonFromUpstashWithStatus(
  key: string,
  timeoutMs?: number,
  raw?: boolean,
): Promise<UpstashJsonReadResult>;

export declare function readJsonBatchFromUpstashWithStatus(
  keys: readonly string[],
  timeoutMs?: number,
  raw?: boolean,
): Promise<UpstashJsonReadResult[]>;

// Legacy readers predate TypeScript callers and return multiple cache-specific
// shapes. Preserve that established surface while typing the new status reader
// precisely; consumers narrow their own payload contracts.
export declare function readJsonFromUpstash<T = any>(
  key: string,
  timeoutMs?: number,
  raw?: boolean,
): Promise<T | null>;

export declare function readRawJsonFromUpstash<T = any>(
  key: string,
  timeoutMs?: number,
  raw?: boolean,
): Promise<T | null>;

export declare function getRedisCredentials(): {
  url: string;
  token: string;
} | null;

export declare function readExistsFlags(
  results: unknown,
  keys: readonly string[],
): Map<string, boolean>;

export declare function redisPipeline(
  commands: Array<Array<string | number>>,
  timeoutMs?: number,
  raw?: boolean,
): Promise<Array<{ result?: unknown; error?: unknown }> | null>;

export declare function setCachedData(
  key: string,
  value: unknown,
  ttlSeconds: number,
  raw?: boolean,
): Promise<boolean>;
