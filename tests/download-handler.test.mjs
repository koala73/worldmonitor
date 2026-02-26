import { strict as assert } from 'node:assert';
import test from 'node:test';
import handler from '../api/download.js';

const RELEASES_PAGE = 'https://github.com/koala73/worldmonitor/releases/latest';

function makeGitHubReleaseResponse(assets) {
  return new Response(JSON.stringify({ assets }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
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
    const response = await handler(
      new Request('https://worldmonitor.app/api/download?platform=linux-appimage&variant=finance')
    );
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), RELEASES_PAGE);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
