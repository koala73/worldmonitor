// @vitest-environment node
import { afterEach, describe, expect, test, vi } from 'vitest';
vi.mock('../auth-session', () => ({ validateBearerToken: vi.fn() }));
import { validateBearerToken } from '../auth-session';
import { resolveClerkSession } from '../_shared/auth-session';
import quota from '../../api/user/mcp-quota';
import revoke from '../../api/user/mcp-revoke';
import context from '../../api/internal/mcp-grant-context';
import mint from '../../api/internal/mcp-grant-mint';
import passkey from '../../api/user/passkey-offer';
import { createDomainGateway } from '../gateway';
import { classifyGrantDenial } from '../../src/services/mcp-grant-denial';

afterEach(() => vi.resetAllMocks());
describe('session verification availability', () => {
  test('gateway preserves verification outages before dispatch', async () => {
    vi.mocked(validateBearerToken).mockResolvedValue({ valid: false, reason: 'unverifiable' });
    const dispatch = vi.fn(async () => new Response('private'));
    const path = '/api/market/v1/get-insider-transactions';
    const gateway = createDomainGateway([{ method: 'GET', path, handler: dispatch }]);
    const response = await gateway(new Request(`https://worldmonitor.app${path}`, {
      headers: { Authorization: 'Bearer token', Origin: 'https://worldmonitor.app' },
    }));
    expect(response.status).toBe(503);
    expect(Number(response.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(dispatch).not.toHaveBeenCalled();
  });
  test('keeps invalid and absent credentials distinct from outages', async () => {
    vi.mocked(validateBearerToken).mockResolvedValue({ valid: false, reason: 'invalid' });
    expect(await resolveClerkSession(new Request('https://worldmonitor.app', {
      headers: { Authorization: 'Bearer invalid' },
    }))).toBeNull();
    expect(await resolveClerkSession(new Request('https://worldmonitor.app'))).toBeNull();
  });
  test('preserves an unverifiable session instead of returning an invalid credential', async () => {
    vi.mocked(validateBearerToken).mockResolvedValue({ valid: false, reason: 'unverifiable' });
    expect(await resolveClerkSession(new Request('https://worldmonitor.app', {
      headers: { Authorization: 'Bearer token' },
    }))).toMatchObject({ reason: 'unverifiable' });
  });
  for (const [name, handler, method] of [
    ['quota', quota, 'GET'], ['revoke', revoke, 'POST'],
    ['context', context, 'GET'], ['mint', mint, 'POST'], ['passkey', passkey, 'POST'],
  ] as const) {
    test(`${name} returns retryable 503 before account work`, async () => {
      vi.mocked(validateBearerToken).mockResolvedValue({ valid: false, reason: 'unverifiable' });
      const response = await handler(new Request(`https://worldmonitor.app/api/${name}`, {
        method, headers: { Authorization: 'Bearer token', Origin: 'https://worldmonitor.app', 'Content-Type': 'application/json' },
        ...(method === 'POST' ? { body: '{}' } : {}),
      }));
      expect(response.status).toBe(503);
      expect(Number(response.headers.get('Retry-After'))).toBeGreaterThan(0);
      if (name === 'context' || name === 'mint') {
        const body = await response.json();
        expect(classifyGrantDenial(response.status, body.error).action).toBe('retryable');
        expect(body.error_description).toContain('Session verification');
      }
    });
  }
});
