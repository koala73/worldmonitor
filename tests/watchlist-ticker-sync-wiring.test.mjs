/**
 * Source-text checks for the watchlist-ticker re-sync wiring (#4922 U3).
 *
 * Why the text is the contract here (#8690 section 2): the behaviour of the
 * notifications panel itself now runs in
 * tests/dom/notifications-settings-delivery-mode.test.mts. What remains are
 * two cross-file wiring facts that no runtime test can observe cheaply:
 *   - `syncWatchlistTickersToAlertRule` in notification-channels.ts talks to
 *     the notification API, and its gating lives inside that network call
 *     path, so exercising it means a full API client harness; and
 *   - watchlist-modal.ts is a long inline-render function with no exported
 *     seam, and the re-sync must be gated on `hasTier(1)` BEFORE the request
 *     so a free or anonymous save does not flood the API with 4xx.
 * If either file grows a harness, move the matching check into it and delete
 * it here.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const channelsSvcSrc = readFileSync(
  resolve(__dirname, '..', 'src', 'services', 'notification-channels.ts'),
  'utf-8',
);
const watchlistModalSrc = readFileSync(
  resolve(__dirname, '..', 'src', 'components', 'watchlist-modal.ts'),
  'utf-8',
);

describe('watchlist tickers — client save + re-sync plumbing (#4922 U3)', () => {
  it('AlertRule carries optional tickers and setNotificationConfig forwards them', () => {
    assert.match(
      channelsSvcSrc,
      /tickers\?:\s*string\[\]/,
      'AlertRule/setNotificationConfig types must carry tickers?: string[]',
    );
  });

  it('service exposes syncWatchlistTickersToAlertRule gated on the enabled + opted-in rule', () => {
    assert.match(
      channelsSvcSrc,
      /export async function syncWatchlistTickersToAlertRule\(/,
      'notification-channels service must export the re-sync helper',
    );
    assert.match(
      channelsSvcSrc,
      /eventTypes\??\.includes\('watchlist_story_alert'\)/,
      're-sync must no-op unless the rule opted into watchlist_story_alert',
    );
  });

  it('watchlist-modal save path re-syncs tickers, gated on PRO tier (no anon/free 4xx flood)', () => {
    assert.match(
      watchlistModalSrc,
      /syncWatchlistTickersToAlertRule/,
      'watchlist-modal save must trigger the ticker re-sync',
    );
    assert.match(
      watchlistModalSrc,
      /hasTier\(1\)/,
      're-sync must be gated on PRO tier client-side before hitting the API',
    );
    assert.match(watchlistModalSrc, /setMarketWatchlistPreferences/, 'catalog and custom layers must save atomically');
    assert.match(watchlistModalSrc, /setAttribute\('role', 'checkbox'\)/, 'catalog items must be keyboard-operable controls');
    assert.match(watchlistModalSrc, /document\.removeEventListener\('keydown'/, 'modal teardown must remove Escape handling');
  });
});
