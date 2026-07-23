import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  API_OVERAGE_METER_ID,
  buildApiOverageUsageEvent,
} from '../server/_shared/api-overage-billing.ts';

type MeterOverride = { count?: number; metered?: boolean; usageDay?: string };

function build(
  overrides: Partial<Omit<Parameters<typeof buildApiOverageUsageEvent>[0], 'meter'>> & {
    meter?: MeterOverride;
  } = {},
) {
  const { meter, ...rest } = overrides;
  return buildApiOverageUsageEvent({
    userId: 'user_123',
    route: '/api/news/v1/list-feed-digest',
    method: 'get',
    status: 200,
    includedAllowance: 1000,
    isUserApiKey: true,
    ...rest,
    meter: { count: 1001, metered: true, usageDay: '2026-07-04', ...(meter ?? {}) },
  });
}

describe('#4560 — API overage billable usage event contract', () => {
  it('returns null while the daily count is at or below the included allowance', () => {
    assert.equal(build({ meter: { count: 1000 } }), null);
    assert.equal(build({ meter: { count: 999 } }), null);
  });

  it('creates one billable api.request event for an over-allowance request', () => {
    const event = build();

    assert.ok(event);
    assert.equal(event.meterId, API_OVERAGE_METER_ID);
    assert.equal(event.userId, 'user_123');
    assert.equal(event.route, '/api/news/v1/list-feed-digest');
    assert.equal(event.method, 'GET');
    assert.equal(event.status, 200);
    assert.equal(event.usageDate, '2026-07-04');
    assert.equal(event.quantity, 1);
    assert.equal(event.dailyCount, 1001);
    assert.equal(event.includedAllowance, 1000);
    assert.match(event.eventId, /^wm_api_request_[0-9a-z]+$/);
    assert.match(
      event.idempotencyKey,
      /^api\.request:user_123:2026-07-04:GET:\/api\/news\/v1\/list-feed-digest:200:1001$/,
    );
  });

  it('does not bill 5xx responses', () => {
    assert.equal(build({ status: 500 }), null);
    assert.equal(build({ status: 503 }), null);
  });

  it('bounds status to the 100–499 range', () => {
    assert.equal(build({ status: 0 }), null);
    assert.equal(build({ status: 99 }), null);
    assert.equal(build({ status: -1 }), null);
    assert.equal(build({ status: 500 }), null);
    assert.ok(build({ status: 499 }));
  });

  it('bills work-performed 4xx but not auth failures or the enforced 429', () => {
    // Policy: 401/403 = no authorized work performed → not billable. 429 =
    // enforce-mode daily refusal (#4684) whose INCR is rolled back → billing it
    // would charge a refused call and alias the rolled-back count onto the next
    // served request. Other 4xx reflect work the gateway did perform → billable.
    assert.equal(build({ status: 401 }), null);
    assert.equal(build({ status: 403 }), null);
    assert.equal(build({ status: 429 }), null);
    assert.ok(build({ status: 400 }));
    assert.ok(build({ status: 404 }));
  });

  it('requires a counted user API-key request', () => {
    assert.equal(build({ userId: '' }), null);
    assert.equal(build({ route: '' }), null);
    assert.equal(build({ method: '' }), null);
    assert.equal(build({ isUserApiKey: false }), null);
    assert.equal(build({ meter: { metered: false } }), null);
    assert.equal(build({ meter: { count: 1001.5 } }), null);
    assert.equal(build({ includedAllowance: -1 }), null);
    assert.equal(build({ includedAllowance: 1000.5 }), null);
  });

  it('returns null when the meter is null or undefined', () => {
    // The build() helper always synthesizes a meter, so exercise the
    // null/undefined branch directly through the real entry point.
    const baseInput = {
      userId: 'user_123',
      route: '/api/news/v1/list-feed-digest',
      method: 'get',
      status: 200,
      includedAllowance: 1000,
      isUserApiKey: true,
    };
    assert.equal(buildApiOverageUsageEvent({ ...baseInput, meter: null }), null);
    assert.equal(buildApiOverageUsageEvent({ ...baseInput, meter: undefined }), null);
  });

  it('rejects a colon in any free-form idempotency segment (delimiter safety)', () => {
    // The idempotency key is ':'-joined; a ':' in userId/method/route could
    // shift segments and alias two distinct requests onto one billing identity.
    assert.equal(build({ userId: 'user:123' }), null);
    assert.equal(build({ route: '/api/x:y/v1/z' }), null);
    assert.equal(build({ method: 'GE:T' }), null);
  });

  it('requires a valid yyyy-mm-dd meter usage day', () => {
    assert.equal(build({ meter: { usageDay: '' } }), null);
    assert.equal(build({ meter: { usageDay: '2026-7-4' } }), null);
    assert.equal(build({ meter: { usageDay: 'not-a-day' } }), null);
  });

  it('binds usageDate to the meter day, never a wall-clock read (UTC rollover)', () => {
    // The meter INCRs against a UTC day; the event must stamp THAT day, not a
    // second clock read at build time. Otherwise a request straddling midnight
    // emits day D+1 carrying a day-D count, and a genuine D+1 request at the
    // same count aliases onto it — silently dropping a billable unit downstream.
    const dayD = build({ meter: { usageDay: '2026-07-04', count: 1001 } });
    const dayNext = build({ meter: { usageDay: '2026-07-05', count: 1001 } });

    assert.ok(dayD);
    assert.ok(dayNext);
    assert.equal(dayD.usageDate, '2026-07-04');
    assert.equal(dayNext.usageDate, '2026-07-05');
    assert.notEqual(dayD.idempotencyKey, dayNext.idempotencyKey);
    assert.notEqual(dayD.eventId, dayNext.eventId);
  });

  it('canonicalizes route to the matched path, stripping any query string', () => {
    const event = build({ route: '/api/news/v1/list-feed-digest?cursor=abc&limit=50' });
    const baseline = build();

    assert.ok(event);
    assert.ok(baseline);
    assert.equal(event.route, '/api/news/v1/list-feed-digest');
    assert.ok(!event.idempotencyKey.includes('?'));
    // Query variants of one route must share identity so they dedupe as one unit.
    assert.equal(event.idempotencyKey, baseline.idempotencyKey);
  });

  it('uses stable idempotency material for the same request count', () => {
    const first = build();
    const second = build();
    const nextCount = build({ meter: { count: 1002 } });

    assert.ok(first);
    assert.ok(second);
    assert.ok(nextCount);
    assert.equal(first.eventId, second.eventId);
    assert.equal(first.idempotencyKey, second.idempotencyKey);
    assert.notEqual(first.eventId, nextCount.eventId);
  });
});
