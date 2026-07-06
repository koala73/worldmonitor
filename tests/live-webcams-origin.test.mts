import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isAllowedWebcamEmbedMessageOrigin } from '../src/components/_live-webcams-origin.ts';

describe('LiveWebcamsPanel postMessage origin guard', () => {
  it('accepts YouTube iframe API messages from the iframe embed origin', () => {
    const src = 'https://www.youtube.com/embed/e34xb-Fbl0U?enablejsapi=1&origin=https://worldmonitor.app';

    assert.equal(isAllowedWebcamEmbedMessageOrigin('https://www.youtube.com', src), true);
  });

  it('accepts YouTube nocookie messages only when the iframe uses nocookie', () => {
    const src = 'https://www.youtube-nocookie.com/embed/e34xb-Fbl0U?enablejsapi=1&origin=https://worldmonitor.app';

    assert.equal(isAllowedWebcamEmbedMessageOrigin('https://www.youtube-nocookie.com', src), true);
    assert.equal(isAllowedWebcamEmbedMessageOrigin('https://www.youtube.com', src), false);
  });

  it('accepts the desktop localhost sidecar origin for the youtube embed bridge', () => {
    const src = 'http://localhost:14567/api/youtube-embed?videoId=e34xb-Fbl0U&autoplay=1&mute=1';

    assert.equal(isAllowedWebcamEmbedMessageOrigin('http://localhost:14567', src), true);
  });

  it('rejects same-window messages after a child frame navigates to an unexpected origin', () => {
    const originalSrc = 'https://www.youtube.com/embed/e34xb-Fbl0U?enablejsapi=1&origin=https://worldmonitor.app';

    assert.equal(isAllowedWebcamEmbedMessageOrigin('https://evil.example', originalSrc), false);
    assert.equal(isAllowedWebcamEmbedMessageOrigin('https://www.youtube.com.evil.example', originalSrc), false);
    assert.equal(isAllowedWebcamEmbedMessageOrigin('null', originalSrc), false);
  });

  it('rejects non-embed YouTube pages even on an allowed YouTube origin', () => {
    const watchPage = 'https://www.youtube.com/watch?v=e34xb-Fbl0U';

    assert.equal(isAllowedWebcamEmbedMessageOrigin('https://www.youtube.com', watchPage), false);
  });

  it('rejects loopback messages that do not match the expected sidecar endpoint and port', () => {
    const sidecarSrc = 'http://localhost:14567/api/youtube-embed?videoId=e34xb-Fbl0U';
    const otherLocalEndpoint = 'http://localhost:14567/api/hls-proxy?url=https%3A%2F%2Fexample.com%2Fstream.m3u8';

    assert.equal(isAllowedWebcamEmbedMessageOrigin('http://localhost:9999', sidecarSrc), false);
    assert.equal(isAllowedWebcamEmbedMessageOrigin('http://localhost:14567', otherLocalEndpoint), false);
  });
});
