import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import { createEntitlementReloadController } from '@/services/entitlement-reload-controller';

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

class BlockedStorage {
  getItem(): string | null {
    throw new DOMException('storage blocked', 'SecurityError');
  }

  setItem(): void {
    throw new DOMException('storage blocked', 'SecurityError');
  }
}

describe('entitlement reload controller', () => {
  it('reproduces daypesta cadence without a page reload loop', () => {
    const storage = new MemoryStorage();
    let reloads = 0;
    let gatingPasses = 0;
    const order: string[] = [];
    const options = {
      storage,
      reload: () => {
        order.push('reload');
        reloads += 1;
      },
      onSnapshot: () => {
        order.push('gating');
        gatingPasses += 1;
      },
    };

    // First page boot: the authenticated snapshot changes free → Pro.
    const firstBoot = createEntitlementReloadController(options);
    firstBoot.handleSnapshot(false, 'daypesta');
    firstBoot.handleSnapshot(true, 'daypesta');
    assert.equal(reloads, 1);
    assert.deepEqual(order.slice(-2), ['gating', 'reload']);

    // New JS realm after that navigation. The customer's recording shows
    // this free/Pro sequence recurring roughly every half-second. The
    // persisted one-shot guard must stop every later navigation while
    // gating still follows every snapshot in place.
    const secondBoot = createEntitlementReloadController(options);
    for (const entitled of [false, true, false, true, false, true]) {
      secondBoot.handleSnapshot(entitled, 'daypesta');
    }

    assert.equal(reloads, 1, 'an activation episode may navigate only once across page boots');
    assert.equal(gatingPasses, 8, 'suppressed navigations must still update panel gating');
  });

  it('allows the seeded checkout-return activation to navigate once', () => {
    const storage = new MemoryStorage();
    let reloads = 0;
    const options = {
      storage,
      reload: () => { reloads += 1; },
    };

    const checkoutBoot = createEntitlementReloadController({
      ...options,
      returnedFromCheckout: true,
    });
    checkoutBoot.handleSnapshot(true, 'daypesta');

    const nextBoot = createEntitlementReloadController(options);
    nextBoot.handleSnapshot(false, 'daypesta');
    nextBoot.handleSnapshot(true, 'daypesta');

    assert.equal(reloads, 1);
  });

  it('does not let one account suppress another account activation', () => {
    const storage = new MemoryStorage();
    let reloads = 0;
    const options = {
      storage,
      reload: () => { reloads += 1; },
    };

    const firstAccount = createEntitlementReloadController(options);
    firstAccount.handleSnapshot(false, 'daypesta');
    firstAccount.handleSnapshot(true, 'daypesta');

    const secondAccount = createEntitlementReloadController(options);
    secondAccount.handleSnapshot(false, 'another-user');
    secondAccount.handleSnapshot(true, 'another-user');

    const firstAccountAgain = createEntitlementReloadController(options);
    firstAccountAgain.handleSnapshot(false, 'daypesta');
    firstAccountAgain.handleSnapshot(true, 'daypesta');

    assert.equal(reloads, 2);
  });

  it('fails closed to in-place gating when a cross-reload guard cannot persist', () => {
    let reloads = 0;
    let gatingPasses = 0;
    const controller = createEntitlementReloadController({
      storage: new BlockedStorage(),
      reload: () => { reloads += 1; },
      onSnapshot: () => { gatingPasses += 1; },
    });

    controller.handleSnapshot(false, 'daypesta');
    controller.handleSnapshot(true, 'daypesta');

    assert.equal(reloads, 0, 'never navigate when the loop guard cannot survive navigation');
    assert.equal(gatingPasses, 2, 'Pro access must still unlock in place');
  });

  it('fails closed to in-place gating when the activation cannot be account-scoped', () => {
    let reloads = 0;
    let gatingPasses = 0;
    const controller = createEntitlementReloadController({
      storage: new MemoryStorage(),
      reload: () => { reloads += 1; },
      onSnapshot: () => { gatingPasses += 1; },
    });

    controller.handleSnapshot(false, null);
    controller.handleSnapshot(true, null);

    assert.equal(reloads, 0);
    assert.equal(gatingPasses, 2);
  });

  it('never navigates for an already-Pro first snapshot', () => {
    let reloads = 0;
    const controller = createEntitlementReloadController({
      storage: new MemoryStorage(),
      reload: () => { reloads += 1; },
    });

    controller.handleSnapshot(true, 'daypesta');

    assert.equal(reloads, 0);
  });

  it('wires the guarded controller into the live panel entitlement watcher', async () => {
    const panelLayout = await readFile(
      new URL('../src/app/panel-layout.ts', import.meta.url),
      'utf8',
    );

    assert.match(
      panelLayout,
      /createEntitlementReloadController\(\{\s*returnedFromCheckout,/,
      'checkout-return seeding must flow into the guarded controller',
    );
    assert.match(
      panelLayout,
      /onSnapshot:\s*\(\)\s*=>\s*this\.updatePanelGating\(getAuthState\(\)\)/,
      'every entitlement snapshot must continue to update gating in place',
    );
    assert.match(
      panelLayout,
      /entitlementReloadController\.handleSnapshot\(\s*isEntitled\(\),\s*getAuthState\(\)\.user\?\.id \?\? null,/,
      'the live watcher must scope the cross-reload guard to the authenticated account',
    );
  });
});
