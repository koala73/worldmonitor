import type { RedisConfigNodejs } from '@upstash/redis';

export function upstashRetryBackoff(attempt: number): number;

export function upstashRedisOptions(
  url: string,
  token: string,
  options?: { retry?: boolean; timeoutMs?: number },
): RedisConfigNodejs;
