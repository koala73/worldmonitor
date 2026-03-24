import { strict as assert } from 'node:assert';
import test from 'node:test';

const RELEASES_PAGE = 'https://github.com/bradleybond512/worldmonitor-macos/releases/latest';

function makeGitHubReleaseResponse(assets) {
  return new Response(JSON.stringify({ assets }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

async function loadHandler() {
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const module = await import(`../api/download.js?case=${nonce}`);
  return module.default;
}

test('matches full variant for dotted World.Monitor AppImage asset names', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => makeGitHubReleaseResponse([
    {
      name: 'World.Monitor_2.5.7_amd64.AppImage',
      browser_download_url: 'https://downloads.example/World.Monitor_2.5.7_amd64.AppImage',
    },
  ]);

  try {
    const handler = await loadHandler();
    const response = await handler(
      new Request('https://worldmonitor.app/api/download?platform=linux-appimage&variant=full')
    );
    assert.equal(response.status, 302);
    assert.equal(
      response.headers.get('location'),
      'https://downloads.example/World.Monitor_2.5.7_amd64.AppImage'
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('matches tech variant for dashed Tech-Monitor AppImage asset names', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => makeGitHubReleaseResponse([
    {
      name: 'Tech-Monitor_2.5.7_amd64.AppImage',
      browser_download_url: 'https://downloads.example/Tech-Monitor_2.5.7_amd64.AppImage',
    },
    {
      name: 'World.Monitor_2.5.7_amd64.AppImage',
      browser_download_url: 'https://downloads.example/World.Monitor_2.5.7_amd64.AppImage',
    },
  ]);

  try {
    const handler = await loadHandler();
    const response = await handler(
      new Request('https://worldmonitor.app/api/download?platform=linux-appimage&variant=tech')
    );
    assert.equal(response.status, 302);
    assert.equal(
      response.headers.get('location'),
      'https://downloads.example/Tech-Monitor_2.5.7_amd64.AppImage'
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('falls back to release page when requested variant has no matching asset', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => makeGitHubReleaseResponse([
    {
      name: 'World.Monitor_2.5.7_amd64.AppImage',
      browser_download_url: 'https://downloads.example/World.Monitor_2.5.7_amd64.AppImage',
    },
  ]);

  try {
    const handler = await loadHandler();
    const response = await handler(
      new Request('https://worldmonitor.app/api/download?platform=linux-appimage&variant=finance')
    );
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), RELEASES_PAGE);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
