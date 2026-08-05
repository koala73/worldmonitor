/**
 * Runtime contract and successful-read cache for the intelligence-history RPCs.
 * buf.validate annotations describe the public surface, but the Edge gateway
 * does not install a validator, so handlers must enforce the same constraints.
 */

import { ApiError } from '../../src/generated/server/worldmonitor/intelligence/v1/service_server';
import { cachedFetchJson } from './redis';

const HISTORY_DOMAINS = new Set(['conflict', 'military', 'energy']);
const SUCCESS_CACHE_TTL_SECONDS = 30 * 60;

export interface ValidatedHistoryScope {
  domain: string;
  country: string;
  from: number;
  to: number;
  limit: number;
}

function invalid(message: string): never {
  throw new ApiError(400, message, '');
}

function integer(value: unknown, name: string, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) {
    invalid(`${name} must be an integer between 0 and ${max}`);
  }
  return value;
}

/** Validate and normalize the scope and numeric fields shared by all reads. */
export function validateHistoryScope(
  req: { domain?: unknown; country?: unknown; from?: unknown; to?: unknown; limit?: unknown },
  maxLimit: number,
): ValidatedHistoryScope {
  const domain = typeof req.domain === 'string' ? req.domain.trim().toLowerCase() : '';
  const country = typeof req.country === 'string' ? req.country.trim().toUpperCase() : '';
  if (domain && !HISTORY_DOMAINS.has(domain)) {
    invalid('domain must be one of conflict, military, or energy');
  }
  if (country && !/^[A-Z]{2}$/.test(country)) {
    invalid('country must be an ISO 3166-1 alpha-2 code');
  }
  const from = integer(req.from ?? 0, 'from', Number.MAX_SAFE_INTEGER);
  const to = integer(req.to ?? 0, 'to', Number.MAX_SAFE_INTEGER);
  const limit = integer(req.limit ?? 0, 'limit', maxLimit);
  if (from && to && from > to) invalid('from must be less than or equal to to');
  return { domain, country, from, to, limit };
}

/** Validate required semantic text without silently truncating paid input. */
export function validateHistoryText(value: unknown, name: string, min: number, max: number): string {
  if (typeof value !== 'string' || value.length < min || value.length > max) {
    invalid(`${name} must be between ${min} and ${max} characters`);
  }
  return value;
}

async function opaqueCacheKey(kind: string, normalizedInputs: Record<string, unknown>): Promise<string> {
  const canonical = JSON.stringify(normalizedInputs);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  const hash = Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `intel-history:read:v1:${kind}:${hash}`;
}

class UpstreamUnavailable extends Error {}

/**
 * Cache only successful history reads. Failed upstream responses intentionally
 * throw through cachedFetchJson with cacheFetcherErrors disabled, so neither a
 * Redis negative sentinel nor a raw semantic-text cache key is ever created.
 */
export async function cacheSuccessfulHistoryRead<T extends object>(
  kind: string,
  normalizedInputs: Record<string, unknown>,
  read: () => Promise<T | null>,
): Promise<T | null> {
  const key = await opaqueCacheKey(kind, normalizedInputs);
  try {
    return await cachedFetchJson<T>(
      key,
      SUCCESS_CACHE_TTL_SECONDS,
      async () => {
        const result = await read();
        if (result === null) throw new UpstreamUnavailable();
        return result;
      },
      0,
      { cacheFetcherErrors: false, timeoutMs: 12_000 },
    );
  } catch (error) {
    if (error instanceof UpstreamUnavailable || error instanceof Error) return null;
    return null;
  }
}
