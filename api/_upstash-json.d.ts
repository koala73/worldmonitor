export interface UpstashJsonReadResult {
  status: 'hit' | 'miss' | 'error';
  value: unknown | null;
}

export declare function readJsonFromUpstashWithStatus(
  key: string,
  timeoutMs?: number,
): Promise<UpstashJsonReadResult>;

export declare function readJsonBatchFromUpstashWithStatus(
  keys: readonly string[],
  timeoutMs?: number,
): Promise<UpstashJsonReadResult[]>;

// Legacy readers predate TypeScript callers and return multiple cache-specific
// shapes. Preserve that established surface while typing the new status reader
// precisely; consumers narrow their own payload contracts.
export declare function readJsonFromUpstash<T = any>(
  key: string,
  timeoutMs?: number,
): Promise<T | null>;

export declare function readRawJsonFromUpstash<T = any>(
  key: string,
  timeoutMs?: number,
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
): Promise<Array<{ result?: unknown; error?: unknown }> | null>;

export declare function setCachedData(
  key: string,
  value: unknown,
  ttlSeconds: number,
): Promise<boolean>;
