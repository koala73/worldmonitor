import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { isInternalNotifyEventType } from '../api/notify.ts';

describe('/api/notify reserved event types', () => {
  it('reserves relay-control and digest-produced watchlist event types', () => {
    assert.equal(isInternalNotifyEventType('flush_quiet_held'), true);
    assert.equal(isInternalNotifyEventType('channel_welcome'), true);
    assert.equal(isInternalNotifyEventType('watchlist_story_alert'), true);
  });

  it('does not reserve ordinary user-publishable event types', () => {
    assert.equal(isInternalNotifyEventType('rss_alert'), false);
    assert.equal(isInternalNotifyEventType('market_alert'), false);
  });
});
