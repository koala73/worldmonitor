import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  getActiveLiveMedia,
  playAllLiveMedia,
  registerLiveMediaStarter,
  releaseLiveMediaPlayback,
  requestLiveMediaPlayback,
  stopLiveMediaPlayback,
  unregisterLiveMediaStarter,
} from '../src/services/live-media-controller';

describe('live media controller', () => {
  afterEach(() => {
    stopLiveMediaPlayback('live-news', 'destroyed');
    stopLiveMediaPlayback('live-webcams', 'destroyed');
    unregisterLiveMediaStarter('live-news');
    unregisterLiveMediaStarter('live-webcams');
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

  it('playAllLiveMedia fires every registered starter (play-all cascade)', () => {
    const fired: string[] = [];
    registerLiveMediaStarter('live-news', () => fired.push('live-news'));
    registerLiveMediaStarter('live-webcams', () => fired.push('live-webcams'));

    playAllLiveMedia();

    assert.deepEqual(fired.sort(), ['live-news', 'live-webcams']);
  });

  it('unregistering a starter stops it from firing on the next cascade', () => {
    const fired: string[] = [];
    const webcamStarter = () => fired.push('live-webcams');
    registerLiveMediaStarter('live-news', () => fired.push('live-news'));
    registerLiveMediaStarter('live-webcams', webcamStarter);

    unregisterLiveMediaStarter('live-webcams', webcamStarter);
    playAllLiveMedia();

    assert.deepEqual(fired, ['live-news']);
  });

  it('unregister with a stale starter ref does not clobber a re-registered panel', () => {
    const fired: string[] = [];
    const oldStarter = () => fired.push('old');
    const newStarter = () => fired.push('new');

    // Simulate recreate-then-destroy-old: new instance registers, old instance's destroy runs after.
    registerLiveMediaStarter('live-webcams', oldStarter);
    registerLiveMediaStarter('live-webcams', newStarter);
    unregisterLiveMediaStarter('live-webcams', oldStarter); // stale ref — must be ignored

    playAllLiveMedia();
    assert.deepEqual(fired, ['new']);
  });
});
