// @vitest-environment node

import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  attachApiErrorHttpResponseMetadata,
  mapErrorToResponse,
} from '../error-mapper';
import { ApiError } from '../../src/generated/server/worldmonitor/market/v1/service_server';

describe('opt-in ApiError HTTP responses', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test('serializes a quota 429 with the public envelope and live rate-limit headers', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-21T12:00:00.000Z'));
    const resetMs = Date.now() + 120_000;
    const error = new ApiError(429, 'Stock backtest daily provider quota exceeded', '');
    (error as ApiError & { retryAfter: number }).retryAfter = 120;
    attachApiErrorHttpResponseMetadata(error, {
      envelope: 'error',
      rateLimit: {
        limit: 200,
        remaining: 0,
        resetMs,
        windowSec: 86_400,
      },
    });

    const response = mapErrorToResponse(error, new Request('https://example.com'));

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual({
      error: 'Stock backtest daily provider quota exceeded',
    });
    expect(response.headers.get('Retry-After')).toBe('120');
    expect(response.headers.get('RateLimit-Policy')).toBe('"default";q=200;w=86400');
    expect(response.headers.get('RateLimit-Limit')).toBe('200');
    expect(response.headers.get('RateLimit-Remaining')).toBe('0');
    expect(response.headers.get('RateLimit-Reset')).toBe('120');
    expect(response.headers.get('RateLimit')).toBe('"default";r=0;t=120');
    expect(response.headers.get('X-RateLimit-Limit')).toBe('200');
    expect(response.headers.get('X-RateLimit-Remaining')).toBe('0');
    expect(response.headers.get('X-RateLimit-Reset')).toBe(String(resetMs));
  });

  test('serializes an opted-in retryable 503 without rate-limit headers', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const error = new ApiError(503, 'Stock backtest quota service unavailable', '');
    (error as ApiError & { retryAfter: number }).retryAfter = 30;
    attachApiErrorHttpResponseMetadata(error, { envelope: 'error' });

    const response = mapErrorToResponse(error, new Request('https://example.com'));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: 'Stock backtest quota service unavailable',
    });
    expect(response.headers.get('Retry-After')).toBe('30');
    expect(response.headers.get('RateLimit-Limit')).toBeNull();
    expect(response.headers.get('X-RateLimit-Limit')).toBeNull();
  });

  test('preserves the legacy ApiError envelope without explicit metadata', async () => {
    const error = new ApiError(429, 'Ordinary retryable error', '');
    (error as ApiError & { retryAfter: number }).retryAfter = 15;

    const response = mapErrorToResponse(error, new Request('https://example.com'));

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual({
      message: 'Ordinary retryable error',
      retryAfter: 15,
    });
    expect(response.headers.get('Retry-After')).toBe('15');
    expect(response.headers.get('RateLimit-Limit')).toBeNull();
  });
});
