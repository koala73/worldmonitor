import { logCacheReadError, readCachedJson } from './redis';

export class SeedUnavailableError extends Error {
  readonly statusCode = 503;

  constructor(key: string) {
    super(`Seed unavailable: ${key}`);
    this.name = 'SeedUnavailableError';
  }
}

export async function readRequiredSeed<T>(
  key: string,
  decode: (value: unknown) => T | undefined,
): Promise<T> {
  const result = await readCachedJson(key, true);
  if (result.status === 'error') logCacheReadError(key, result.error);
  if (result.status !== 'hit') throw new SeedUnavailableError(key);
  const data = decode(result.value);
  if (data === undefined) throw new SeedUnavailableError(key);
  return data;
}
