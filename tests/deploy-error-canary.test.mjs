import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/**
 * #7107 — the 2026-08-01 validation deploy broke get-aircraft-details-batch
 * for effectively every dashboard user (~132,500 client-facing 400s over
 * three days, 17k+ distinct IPs) and nothing alerted, because no monitoring
 * compares a route's error rate against its own pre-deploy baseline.
 *
 * evaluateDeployCanary is the pure detection core: given per-route
 * {total, errors} aggregates for a baseline window and a current window, it
 * flags routes whose current error rate is a step change over their own
 * baseline. The acceptance shape from the issue:
 *   - replaying Aug 1–3 (a route going from ~0 to >30k 400s/day) alerts,
 *     attributed to the windows compared;
 *   - normal daily variance on the same routes does not alert.
 */
import {
  DEFAULT_CANARY_OPTIONS,
  evaluateDeployCanary,
  buildCanaryApl,
} from '../scripts/deploy-error-canary.mjs';

const ROUTE = '/api/military/v1/get-aircraft-details-batch';

function windowRows(rows) {
  return rows.map(([route, total, errors]) => ({ route, total, errors }));
}

describe('evaluateDeployCanary — the Aug 1–3 regression shape alerts', () => {
  it('flags a route going from ~0% to ~100% errors at dashboard volume', () => {
    // Baseline: seven healthy days, 40k requests, 0.1% 4xx noise.
    const baseline = windowRows([[ROUTE, 40_000, 40]]);
    // Current 2h window of Aug 1 traffic: ~2,900 400s (34,840/day pace).
    const current = windowRows([[ROUTE, 3_000, 2_900]]);

    const report = evaluateDeployCanary({ baseline, current });

    assert.equal(report.alerts.length, 1, 'the regression must alert');
    const alert = report.alerts[0];
    assert.equal(alert.route, ROUTE);
    assert.ok(alert.currentErrorRate > 0.9);
    assert.ok(
      alert.rateMultiple >= DEFAULT_CANARY_OPTIONS.rateMultiple,
      'the alert carries how many times over baseline the route is',
    );
  });

  it('flags a route with NO baseline traffic that ships broken (the new-route cell)', () => {
    const baseline = windowRows([]);
    const current = windowRows([[ROUTE, 1_000, 990]]);

    const report = evaluateDeployCanary({ baseline, current });

    assert.equal(report.alerts.length, 1, 'a route that never existed before the deploy still alerts');
  });
});

describe('evaluateDeployCanary — normal variance stays quiet', () => {
  it('does not alert on ordinary error-rate wobble at high traffic', () => {
    const baseline = windowRows([[ROUTE, 40_000, 400]]); // 1%
    const current = windowRows([[ROUTE, 3_000, 60]]); // 2%

    assert.deepEqual(evaluateDeployCanary({ baseline, current }).alerts, []);
  });

  it('does not alert below the absolute error floor (tiny routes cannot page)', () => {
    const baseline = windowRows([['/api/x', 20, 0]]);
    const current = windowRows([['/api/x', 10, 8]]);

    assert.deepEqual(evaluateDeployCanary({ baseline, current }).alerts, []);
  });

  it('does not alert on a healthy route that merely got busier', () => {
    const baseline = windowRows([[ROUTE, 4_000, 4]]);
    const current = windowRows([[ROUTE, 9_000, 12]]);

    assert.deepEqual(evaluateDeployCanary({ baseline, current }).alerts, []);
  });

  it('caps evaluation to the top routes by current traffic', () => {
    const baseline = [];
    const current = [];
    for (let i = 0; i < 80; i++) {
      current.push({ route: `/api/r${i}`, total: 1_000 + i, errors: 990 });
      baseline.push({ route: `/api/r${i}`, total: 10_000, errors: 10 });
    }

    const report = evaluateDeployCanary({
      baseline,
      current,
      options: { ...DEFAULT_CANARY_OPTIONS, topRoutes: 50 },
    });

    assert.equal(report.evaluatedRoutes, 50, 'top-50 by current traffic, per the issue sketch');
    assert.equal(report.alerts.length, 50);
  });
});

describe('report attribution', () => {
  it('names the windows compared so the alert is attributable to the deploy window', () => {
    const report = evaluateDeployCanary({
      baseline: windowRows([[ROUTE, 40_000, 40]]),
      current: windowRows([[ROUTE, 3_000, 2_900]]),
      windows: {
        baseline: { from: '2026-07-25T00:00:00Z', to: '2026-08-01T08:00:00Z' },
        current: { from: '2026-08-01T08:00:00Z', to: '2026-08-01T10:00:00Z' },
      },
    });

    assert.equal(report.windows.current.from, '2026-08-01T08:00:00Z');
    const line = report.alerts[0].summary;
    assert.match(line, /get-aircraft-details-batch/);
    assert.match(line, /2026-08-01T08:00:00Z/, 'the alert line must carry the window it is attributed to');
  });
});

describe('buildCanaryApl', () => {
  it('aggregates total and 4xx/5xx per route over the given window', () => {
    const apl = buildCanaryApl({ from: '2026-08-01T08:00:00Z', to: '2026-08-01T10:00:00Z' });
    assert.match(apl, /wm_api_usage/);
    assert.match(apl, /status >= 400/);
    assert.match(apl, /by route/);
  });
});
