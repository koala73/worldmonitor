import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
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

  it('lets different panels play at the same time (no cross-panel eviction)', () => {
    const events: string[] = [];

    requestLiveMediaPlayback(
      'live-news',
      'bbc-news',
      () => events.push('start:live-news:bbc-news'),
      (reason) => events.push(`stop:live-news:${reason}`),
    );
    requestLiveMediaPlayback(
      'live-webcams',
      'jerusalem',
      () => events.push('start:live-webcams:jerusalem'),
      (reason) => events.push(`stop:live-webcams:${reason}`),
    );

    // Starting webcams must NOT stop live-news — explicitly played feeds coexist.
    assert.deepEqual(events, [
      'start:live-news:bbc-news',
      'start:live-webcams:jerusalem',
    ]);
    assert.deepEqual(getActiveLiveMedia('live-news'), {
      panelId: 'live-news',
      streamId: 'bbc-news',
    });
    assert.deepEqual(getActiveLiveMedia('live-webcams'), {
      panelId: 'live-webcams',
      streamId: 'jerusalem',
    });
  });

  it('replaces the previous stream within the same panel (single-player switch)', () => {
    const events: string[] = [];

    requestLiveMediaPlayback(
      'live-news',
      'bbc-news',
      () => events.push('start:live-news:bbc-news'),
      (reason) => events.push(`stop:live-news:${reason}`),
    );
    requestLiveMediaPlayback(
      'live-news',
      'sky-news',
      () => events.push('start:live-news:sky-news'),
      (reason) => events.push(`stop:live-news:${reason}`),
    );

    assert.deepEqual(events, [
      'start:live-news:bbc-news',
      'stop:live-news:replaced',
      'start:live-news:sky-news',
    ]);
    assert.deepEqual(getActiveLiveMedia('live-news'), {
      panelId: 'live-news',
      streamId: 'sky-news',
    });
  });

  it('stops only the targeted panel and releases without firing stop callbacks', () => {
    const events: string[] = [];

    requestLiveMediaPlayback(
      'live-news',
      'sky-news',
      () => events.push('start:live-news:sky-news'),
      (reason) => events.push(`stop:live-news:${reason}`),
    );
    requestLiveMediaPlayback(
      'live-webcams',
      'jerusalem',
      () => events.push('start:live-webcams:jerusalem'),
      (reason) => events.push(`stop:live-webcams:${reason}`),
    );

    stopLiveMediaPlayback('live-webcams', 'user-paused');
    assert.equal(getActiveLiveMedia('live-webcams'), null);
    assert.deepEqual(getActiveLiveMedia('live-news'), {
      panelId: 'live-news',
      streamId: 'sky-news',
    });
    assert.deepEqual(events, [
      'start:live-news:sky-news',
      'start:live-webcams:jerusalem',
      'stop:live-webcams:user-paused',
    ]);

    releaseLiveMediaPlayback('live-news', 'sky-news');
    assert.equal(getActiveLiveMedia('live-news'), null);
    assert.deepEqual(events, [
      'start:live-news:sky-news',
      'start:live-webcams:jerusalem',
      'stop:live-webcams:user-paused',
    ]);
  });

  it('release is a no-op when the streamId does not match the active stream', () => {
    const events: string[] = [];

    requestLiveMediaPlayback(
      'live-news',
      'bloomberg',
      () => events.push('start:live-news:bloomberg'),
      (reason) => events.push(`stop:live-news:${reason}`),
    );

    releaseLiveMediaPlayback('live-news', 'sky-news');
    assert.deepEqual(getActiveLiveMedia('live-news'), {
      panelId: 'live-news',
      streamId: 'bloomberg',
    });
  });
});
