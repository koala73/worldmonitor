// Runtime proof that cloud sync watches the panel-order keys the dashboard
// actually writes (#8690, replacing the source-text checks that were in
// tests/cloud-prefs-panel-sync-guard.test.mjs).
//
// The App owns the panel-order key name; the sync key list must carry that
// name and its bottom-set companion, and must not carry the retired
// `worldmonitor-panel-order` the app never writes, or panel order silently
// stops syncing across devices.

import { describe, expect, it, vi } from 'vitest';

vi.mock('@/services', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services')>()),
  initDB: vi.fn(async () => undefined),
}));

import { App } from '@/App';
import { CLOUD_SYNC_KEYS } from '@/utils/sync-keys';

describe('cloud sync panel-order keys', () => {
  it('syncs the key the App persists panel order under, plus its bottom-set companion', () => {
    const container = document.createElement('div');
    container.id = 'app';
    document.body.appendChild(container);
    const app = new App('app');
    const panelOrderKey = (app as unknown as { state: { PANEL_ORDER_KEY: string } }).state.PANEL_ORDER_KEY;
    expect(panelOrderKey).toBe('panel-order');
    const keys: readonly string[] = CLOUD_SYNC_KEYS;
    expect(keys).toContain(panelOrderKey);
    expect(keys).toContain(`${panelOrderKey}-bottom-set`);
    expect(keys).not.toContain('worldmonitor-panel-order');
    app.destroy();
    document.body.replaceChildren();
  });
});
