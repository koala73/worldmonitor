import { strict as assert } from 'node:assert';
import test from 'node:test';
import handler from '../api/download.js';

const RELEASES_PAGE = 'https://github.com/koala73/worldmonitor/releases/latest';
const WORLD_APPIMAGE = 'https://downloads.example/World.Monitor_2.5.7_amd64.AppImage';

function makeGitHubReleaseResponse(assets) {
  return new Response(JSON.stringify({ assets }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function worldMonitorAssets() {
  return [
    {
      name: 'World.Monitor_2.5.7_amd64.AppImage',
      browser_download_url: WORLD_APPIMAGE,
    },
  ];
}

async function download(query, assets) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => makeGitHubReleaseResponse(assets ?? worldMonitorAssets());
  try {
    return await handler(new Request(`https://worldmonitor.app/api/download?${query}`));
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test('matches the desktop binary for dotted World.Monitor AppImage asset names', async () => {
  const response = await download('platform=linux-appimage&variant=full');
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), WORLD_APPIMAGE);
});

test('resolves the platform asset when no variant is supplied', async () => {
  const response = await download('platform=linux-appimage');
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), WORLD_APPIMAGE);
});

test('applies the World Monitor identity filter even with no variant supplied', async () => {
  // The desktop updater stopped sending `variant` under the one-binary model,
  // so the no-variant path is the app's own download path. A stray branded
  // asset ordered first must not win it.
  const response = await download('platform=linux-appimage', [
    {
      name: 'Tech-Monitor_2.5.7_amd64.AppImage',
      browser_download_url: 'https://downloads.example/Tech-Monitor_2.5.7_amd64.AppImage',
    },
    ...worldMonitorAssets(),
  ]);
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), WORLD_APPIMAGE);
});

test('does not treat inherited Object properties as known platforms', async () => {
  // `PLATFORM_PATTERNS['constructor']` is truthy AND callable, so a bare lookup
  // passed the guard and then matched every asset name.
  for (const platform of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    const response = await download(`platform=${encodeURIComponent(platform)}`);
    assert.equal(response.status, 302);
    assert.equal(
      response.headers.get('location'),
      RELEASES_PAGE,
      `platform=${platform} must not resolve to an asset`
    );
  }
});

// #5908: one published desktop binary, variants switch in-app. Every supported
// variant must resolve to that same artifact — the old per-variant identifiers
// advertised `techmonitor`/`financemonitor` assets no pipeline has ever built,
// so `variant=tech` and `variant=finance` could only ever 302 to the releases
// page while the docs and the in-app switcher promised a download.
for (const variant of ['full', 'world', 'tech', 'finance', 'commodity', 'energy', 'happy']) {
  test(`resolves variant=${variant} to the single desktop binary`, async () => {
    const response = await download(`platform=linux-appimage&variant=${variant}`);
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), WORLD_APPIMAGE);
  });
}

test('treats an empty variant the same as omitting it', async () => {
  // `variant=` is falsy, so it skips the supported-set check. It must still get
  // the identity filter — that is now unconditional precisely so no path can
  // resolve a non-World-Monitor asset.
  const response = await download('platform=linux-appimage&variant=', [
    {
      name: 'Tech-Monitor_2.5.7_amd64.AppImage',
      browser_download_url: 'https://downloads.example/Tech-Monitor_2.5.7_amd64.AppImage',
    },
    ...worldMonitorAssets(),
  ]);
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), WORLD_APPIMAGE);
});

test('is case-insensitive about the variant', async () => {
  const response = await download('platform=linux-appimage&variant=TECH');
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), WORLD_APPIMAGE);
});

test('still resolves to the World Monitor asset when a stray branded asset is present', async () => {
  // Defends the collapse itself: a leftover per-variant artifact on a release
  // must not resurrect per-variant asset selection.
  const response = await download('platform=linux-appimage&variant=tech', [
    {
      name: 'Tech-Monitor_2.5.7_amd64.AppImage',
      browser_download_url: 'https://downloads.example/Tech-Monitor_2.5.7_amd64.AppImage',
    },
    ...worldMonitorAssets(),
  ]);
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), WORLD_APPIMAGE);
});

test('falls back to the release page for a variant the product does not support', async () => {
  const response = await download('platform=linux-appimage&variant=nonsense');
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), RELEASES_PAGE);
});

test('rejects an unsupported variant without calling GitHub', async () => {
  // An unsupported variant has one answer regardless of what upstream returns,
  // so it must not cost a round-trip or depend on GitHub being reachable.
  const originalFetch = globalThis.fetch;
  let upstreamCalls = 0;
  globalThis.fetch = async () => {
    upstreamCalls++;
    return makeGitHubReleaseResponse(worldMonitorAssets());
  };
  try {
    const response = await handler(
      new Request('https://worldmonitor.app/api/download?platform=linux-appimage&variant=nonsense')
    );
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), RELEASES_PAGE);
    assert.equal(upstreamCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('falls back to the release page when the platform has no matching asset', async () => {
  const response = await download('platform=windows-msi&variant=full');
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), RELEASES_PAGE);
});

test('falls back to the release page for an unknown platform', async () => {
  const response = await download('platform=solaris-sparc&variant=full');
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), RELEASES_PAGE);
});
