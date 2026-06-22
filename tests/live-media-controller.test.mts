import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  enforceExclusiveLiveMediaPlayback,
  getActiveLiveMedia,
  releaseLiveMediaPlayback,
  requestLiveMediaPlayback,
  stopLiveMediaPlayback,
} from '../src/services/live-media-controller';

describe('live media controller', () => {
  afterEach(() => {
    stopLiveMediaPlayback('live-news', 'destroyed');
    stopLiveMediaPlayback('live-webcams', 'destroyed');
  });

  it('starts one stream and stops the previous stream when another begins', () => {
    const events: string[] = [];

    requestLiveMediaPlayback(
      'live-news',
      'bbc-news',
      () => events.push('start:live-news:bbc-news'),
      (reason) => events.push(`stop:live-news:${reason}`),
    );

    assert.deepEqual(getActiveLiveMedia(), {
      panelId: 'live-news',
      streamId: 'bbc-news',
    });

    requestLiveMediaPlayback(
      'live-webcams',
      'jerusalem',
      () => events.push('start:live-webcams:jerusalem'),
      (reason) => events.push(`stop:live-webcams:${reason}`),
    );

    assert.deepEqual(events, [
      'start:live-news:bbc-news',
      'stop:live-news:replaced',
      'start:live-webcams:jerusalem',
    ]);
    assert.deepEqual(getActiveLiveMedia(), {
      panelId: 'live-webcams',
      streamId: 'jerusalem',
    });
  });

  it('stops only the active panel and releases without firing stop callbacks', () => {
    const events: string[] = [];

    requestLiveMediaPlayback(
      'live-news',
      'sky-news',
      () => events.push('start:live-news:sky-news'),
      (reason) => events.push(`stop:live-news:${reason}`),
    );

    stopLiveMediaPlayback('live-webcams', 'user-paused');
    assert.deepEqual(getActiveLiveMedia(), {
      panelId: 'live-news',
      streamId: 'sky-news',
    });
    assert.deepEqual(events, ['start:live-news:sky-news']);

    releaseLiveMediaPlayback('live-news', 'sky-news');
    assert.equal(getActiveLiveMedia(), null);
    assert.deepEqual(events, ['start:live-news:sky-news']);
  });

  it('can opt out of cross-panel replacement for always-on playback', () => {
    const events: string[] = [];

    requestLiveMediaPlayback(
      'live-news',
      'bloomberg',
      () => events.push('start:live-news:bloomberg'),
      (reason) => events.push(`stop:live-news:${reason}`),
      { exclusive: false },
    );
    requestLiveMediaPlayback(
      'live-webcams',
      'jerusalem',
      () => events.push('start:live-webcams:jerusalem'),
      (reason) => events.push(`stop:live-webcams:${reason}`),
      { exclusive: false },
    );

    assert.deepEqual(getActiveLiveMedia('live-news'), {
      panelId: 'live-news',
      streamId: 'bloomberg',
    });
    assert.deepEqual(getActiveLiveMedia('live-webcams'), {
      panelId: 'live-webcams',
      streamId: 'jerusalem',
    });
    assert.deepEqual(events, [
      'start:live-news:bloomberg',
      'start:live-webcams:jerusalem',
    ]);
  });

  it('keeps the preferred panel (live-news) after always-on is disabled, regardless of insertion order', () => {
    const events: string[] = [];

    // Webcams registered FIRST, news SECOND. Without a preference the no-arg form
    // keeps the last-inserted entry (webcams). The panels pass 'live-news', so the
    // surviving stream is deterministic instead of insertion-order dependent.
    requestLiveMediaPlayback(
      'live-webcams',
      'jerusalem',
      () => events.push('start:live-webcams:jerusalem'),
      (reason) => events.push(`stop:live-webcams:${reason}`),
      { exclusive: false },
    );
    requestLiveMediaPlayback(
      'live-news',
      'bloomberg',
      () => events.push('start:live-news:bloomberg'),
      (reason) => events.push(`stop:live-news:${reason}`),
      { exclusive: false },
    );

    enforceExclusiveLiveMediaPlayback('live-news');

    assert.deepEqual(getActiveLiveMedia('live-news'), {
      panelId: 'live-news',
      streamId: 'bloomberg',
    });
    assert.equal(getActiveLiveMedia('live-webcams'), null);
    assert.deepEqual(events, [
      'start:live-webcams:jerusalem',
      'start:live-news:bloomberg',
      'stop:live-webcams:replaced',
    ]);
  });

  it('falls back to keeping the latest stream when the preferred panel is not active', () => {
    const events: string[] = [];

    requestLiveMediaPlayback(
      'live-webcams',
      'jerusalem',
      () => events.push('start:live-webcams:jerusalem'),
      (reason) => events.push(`stop:live-webcams:${reason}`),
      { exclusive: false },
    );

    // 'live-news' is not active, so the preference is ignored and webcams survives.
    enforceExclusiveLiveMediaPlayback('live-news');

    assert.deepEqual(getActiveLiveMedia('live-webcams'), {
      panelId: 'live-webcams',
      streamId: 'jerusalem',
    });
    assert.deepEqual(events, ['start:live-webcams:jerusalem']);
  });

  it('keeps the most recently requested stream after always-on mode is disabled', () => {
    const events: string[] = [];

    requestLiveMediaPlayback(
      'live-news',
      'bloomberg',
      () => events.push('start:live-news:bloomberg'),
      (reason) => events.push(`stop:live-news:${reason}`),
      { exclusive: false },
    );
    requestLiveMediaPlayback(
      'live-webcams',
      'jerusalem',
      () => events.push('start:live-webcams:jerusalem'),
      (reason) => events.push(`stop:live-webcams:${reason}`),
      { exclusive: false },
    );

    enforceExclusiveLiveMediaPlayback();

    assert.equal(getActiveLiveMedia('live-news'), null);
    assert.deepEqual(getActiveLiveMedia('live-webcams'), {
      panelId: 'live-webcams',
      streamId: 'jerusalem',
    });
    assert.deepEqual(events, [
      'start:live-news:bloomberg',
      'start:live-webcams:jerusalem',
      'stop:live-news:replaced',
    ]);
  });
});
