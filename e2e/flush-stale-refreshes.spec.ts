import { expect, test } from '@playwright/test';

/**
 * Tests for flushStaleRefreshes — verifies that stale data refreshes
 * are flushed immediately when a backgrounded tab regains focus.
 */
test.describe('flush stale refreshes on tab focus', () => {

  test('flushStaleRefreshes re-triggers services hidden longer than their interval', async ({ page }) => {
    await page.goto('/tests/runtime-harness.html');

    const result = await page.evaluate(async () => {
      const { App } = await import('/src/App.ts');

      // Access private methods/state via prototype
      const proto = App.prototype as unknown as {
        refreshRunners: Map<string, { run: () => Promise<void>; intervalMs: number }>;
        refreshTimeoutIds: Map<string, ReturnType<typeof setTimeout>>;
        hiddenSince: number;
        flushStaleRefreshes: () => void;
      };

      const fakeApp = {
        refreshRunners: new Map<string, { run: () => Promise<void>; intervalMs: number }>(),
        refreshTimeoutIds: new Map<string, ReturnType<typeof setTimeout>>(),
        hiddenSince: 0,
      };

      const flushed: string[] = [];

      // Register 3 services with different intervals
      fakeApp.refreshRunners.set('fast-service', {
        run: async () => { flushed.push('fast-service'); },
        intervalMs: 60_000, // 1 min
      });
      fakeApp.refreshRunners.set('medium-service', {
        run: async () => { flushed.push('medium-service'); },
        intervalMs: 300_000, // 5 min
      });
      fakeApp.refreshRunners.set('slow-service', {
        run: async () => { flushed.push('slow-service'); },
        intervalMs: 1_800_000, // 30 min
      });

      // Set fake pending timeouts for each
      for (const name of fakeApp.refreshRunners.keys()) {
        fakeApp.refreshTimeoutIds.set(name, setTimeout(() => {}, 999_999));
      }

      // Simulate being hidden for 10 minutes (600,000ms)
      fakeApp.hiddenSince = Date.now() - 600_000;

      // Call flushStaleRefreshes
      proto.flushStaleRefreshes.call(fakeApp);

      // Wait for staggered timeouts to fire (150ms between each, max ~450ms)
      await new Promise((r) => setTimeout(r, 600));

      return {
        flushed,
        hiddenSinceAfter: fakeApp.hiddenSince,
      };
    });

    // fast-service (1min interval) and medium-service (5min interval) should flush
    // because hidden duration (10min) > their interval.
    // slow-service (30min interval) should NOT flush.
    expect(result.flushed).toContain('fast-service');
    expect(result.flushed).toContain('medium-service');
    expect(result.flushed).not.toContain('slow-service');
    expect(result.hiddenSinceAfter).toBe(0);
  });

  test('flushStaleRefreshes does nothing when hiddenSince is 0', async ({ page }) => {
    await page.goto('/tests/runtime-harness.html');

    const result = await page.evaluate(async () => {
      const { App } = await import('/src/App.ts');

      const proto = App.prototype as unknown as {
        refreshRunners: Map<string, { run: () => Promise<void>; intervalMs: number }>;
        refreshTimeoutIds: Map<string, ReturnType<typeof setTimeout>>;
        hiddenSince: number;
        flushStaleRefreshes: () => void;
      };

      const fakeApp = {
        refreshRunners: new Map<string, { run: () => Promise<void>; intervalMs: number }>(),
        refreshTimeoutIds: new Map<string, ReturnType<typeof setTimeout>>(),
        hiddenSince: 0, // Not hidden
      };

      let called = false;
      fakeApp.refreshRunners.set('service', {
        run: async () => { called = true; },
        intervalMs: 60_000,
      });

      proto.flushStaleRefreshes.call(fakeApp);
      await new Promise((r) => setTimeout(r, 300));

      return { called };
    });

    // No services should be flushed since hiddenSince is 0
    expect(result.called).toBe(false);
  });

  test('flushStaleRefreshes skips services hidden for less than their interval', async ({ page }) => {
    await page.goto('/tests/runtime-harness.html');

    const result = await page.evaluate(async () => {
      const { App } = await import('/src/App.ts');

      const proto = App.prototype as unknown as {
        refreshRunners: Map<string, { run: () => Promise<void>; intervalMs: number }>;
        refreshTimeoutIds: Map<string, ReturnType<typeof setTimeout>>;
        hiddenSince: number;
        flushStaleRefreshes: () => void;
      };

      const fakeApp = {
        refreshRunners: new Map<string, { run: () => Promise<void>; intervalMs: number }>(),
        refreshTimeoutIds: new Map<string, ReturnType<typeof setTimeout>>(),
        hiddenSince: Date.now() - 30_000, // Hidden for only 30 seconds
      };

      let called = false;
      fakeApp.refreshRunners.set('service', {
        run: async () => { called = true; },
        intervalMs: 300_000, // 5 min interval — 30s hidden is NOT stale
      });
      fakeApp.refreshTimeoutIds.set('service', setTimeout(() => {}, 999_999));

      proto.flushStaleRefreshes.call(fakeApp);
      await new Promise((r) => setTimeout(r, 300));

      return { called };
    });

    // 30 second hidden duration is less than 5 min interval — should NOT flush
    expect(result.called).toBe(false);
  });

  test('flushStaleRefreshes staggers re-triggered services by 150ms', async ({ page }) => {
    await page.goto('/tests/runtime-harness.html');

    const result = await page.evaluate(async () => {
      const { App } = await import('/src/App.ts');

      const proto = App.prototype as unknown as {
        refreshRunners: Map<string, { run: () => Promise<void>; intervalMs: number }>;
        refreshTimeoutIds: Map<string, ReturnType<typeof setTimeout>>;
        hiddenSince: number;
        flushStaleRefreshes: () => void;
      };

      const fakeApp = {
        refreshRunners: new Map<string, { run: () => Promise<void>; intervalMs: number }>(),
        refreshTimeoutIds: new Map<string, ReturnType<typeof setTimeout>>(),
        hiddenSince: Date.now() - 600_000, // 10 min hidden
      };

      const timestamps: number[] = [];
      const start = Date.now();

      // Register 3 services that all need flushing
      for (const name of ['svc-a', 'svc-b', 'svc-c']) {
        fakeApp.refreshRunners.set(name, {
          run: async () => { timestamps.push(Date.now() - start); },
          intervalMs: 60_000,
        });
        fakeApp.refreshTimeoutIds.set(name, setTimeout(() => {}, 999_999));
      }

      proto.flushStaleRefreshes.call(fakeApp);

      // Wait for all staggered timeouts (0ms, 150ms, 300ms + buffer)
      await new Promise((r) => setTimeout(r, 600));

      return {
        count: timestamps.length,
        // Check that timestamps are roughly staggered
        firstInRange: timestamps[0]! < 50,
        secondInRange: timestamps[1]! >= 100 && timestamps[1]! < 250,
        thirdInRange: timestamps[2]! >= 250 && timestamps[2]! < 450,
      };
    });

    expect(result.count).toBe(3);
    expect(result.firstInRange).toBe(true);
    expect(result.secondInRange).toBe(true);
    expect(result.thirdInRange).toBe(true);
  });
});
