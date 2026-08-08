import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { __testing__ } from '../src/bootstrap/lcp-attribution';

describe('lcp attribution helpers', () => {
  it('recognizes explicit debug flags only', () => {
    assert.equal(__testing__.isTruthyDebugFlag('1'), true);
    assert.equal(__testing__.isTruthyDebugFlag('true'), true);
    assert.equal(__testing__.isTruthyDebugFlag('yes'), true);
    assert.equal(__testing__.isTruthyDebugFlag('0'), false);
    assert.equal(__testing__.isTruthyDebugFlag(null), false);
  });

  it('does not throw when browser storage getters are blocked', () => {
    const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        location: { href: 'https://worldmonitor.app/dashboard' },
        get sessionStorage() { throw new Error('storage blocked'); },
        get localStorage() { throw new Error('storage blocked'); },
      },
    });
    try {
      assert.equal(__testing__.isLcpDebugEnabled(), false);
    } finally {
      if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor);
      else delete (globalThis as typeof globalThis & { window?: unknown }).window;
    }
  });

  it('captures viewport, DPR, variant, theme, and visibility context', () => {
    const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        devicePixelRatio: 2.625,
        innerHeight: 780,
        innerWidth: 360,
      },
    });
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: {
        documentElement: {
          clientHeight: 640,
          clientWidth: 320,
          dataset: { theme: 'light', variant: 'tech' },
        },
        visibilityState: 'hidden',
      },
    });
    try {
      assert.deepEqual(__testing__.snapshotContext(), {
        devicePixelRatio: 2.63,
        theme: 'light',
        variant: 'tech',
        viewport: { height: 780, width: 360 },
        visibilityState: 'hidden',
      });
    } finally {
      if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor);
      else delete (globalThis as typeof globalThis & { window?: unknown }).window;
      if (documentDescriptor) Object.defineProperty(globalThis, 'document', documentDescriptor);
      else delete (globalThis as typeof globalThis & { document?: unknown }).document;
    }
  });

  it('redacts query strings from resource URLs', () => {
    assert.equal(
      __testing__.sanitizeResourceUrl('https://api.worldmonitor.app/api/bootstrap?tier=fast&wms=secret#frag'),
      'https://api.worldmonitor.app/api/bootstrap?[redacted]',
    );
    assert.equal(
      __testing__.sanitizeResourceUrl('https://worldmonitor.app/data/countries-110m.json'),
      'https://worldmonitor.app/data/countries-110m.json',
    );
  });

  it('classifies resources that may compete before LCP', () => {
    assert.equal(__testing__.classifyCriticalResource('/api/bootstrap?tier=fast', 'fetch'), 'bootstrap');
    assert.equal(__testing__.classifyCriticalResource('/api/news/v1/list-feed-digest?lang=en', 'fetch'), 'feed-digest');
    assert.equal(__testing__.classifyCriticalResource('/data/countries.geojson', 'fetch'), 'country-geometry');
    assert.equal(__testing__.classifyCriticalResource('/data/countries-50m.json', 'fetch'), 'map-topology');
    assert.equal(__testing__.classifyCriticalResource('/assets/MapContainer-abc.js', 'script'), 'map-chunk');
    assert.equal(__testing__.classifyCriticalResource('/assets/sentry-abc.js', 'script'), 'secondary-startup');
    assert.equal(__testing__.classifyCriticalResource('/assets/index-abc.css', 'css'), 'style');
  });

  it('caps text snippets for debug evidence', () => {
    assert.equal(__testing__.capText('  hello   world  ', 20), 'hello world');
    assert.equal(__testing__.capText('x'.repeat(200), 10), 'xxxxxxxxxx');
  });

  it('keeps raw LCP text capture opt-in behind a separate flag', () => {
    const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
    // Debug enabled, but the text flag is NOT set: raw text must stay redacted.
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        location: { href: 'https://worldmonitor.app/dashboard?wm_lcp_debug=1' },
        sessionStorage: { getItem: () => null },
        localStorage: { getItem: () => null },
      },
    });
    try {
      assert.equal(__testing__.isLcpDebugEnabled(), true);
      assert.equal(__testing__.isLcpTextCaptureEnabled(), false);
    } finally {
      if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor);
      else delete (globalThis as typeof globalThis & { window?: unknown }).window;
    }

    // The explicit text flag opts in.
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        location: { href: 'https://worldmonitor.app/dashboard?wm_lcp_text=1' },
        sessionStorage: { getItem: () => null },
        localStorage: { getItem: () => null },
      },
    });
    try {
      assert.equal(__testing__.isLcpTextCaptureEnabled(), true);
    } finally {
      if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor);
      else delete (globalThis as typeof globalThis & { window?: unknown }).window;
    }
  });
});
