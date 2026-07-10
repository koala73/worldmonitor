import { createServer, type Server } from 'node:http';
import { expect, test, type FrameLocator, type Page } from '@playwright/test';

const WORLD_TOPOLOGY = {
  type: 'Topology',
  transform: {
    scale: [0.01, 0.01],
    translate: [-5, -5],
  },
  objects: {
    countries: {
      type: 'GeometryCollection',
      geometries: [
        {
          type: 'Polygon',
          arcs: [[0]],
          id: 'TST',
          properties: { name: 'Testland' },
        },
      ],
    },
  },
  arcs: [
    [
      [0, 0],
      [1000, 0],
      [0, 1000],
      [-1000, 0],
      [0, -1000],
    ],
  ],
};

async function stubWorldAtlas(page: Page): Promise<void> {
  await page.route('**/data/countries-50m.json', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(WORLD_TOPOLOGY),
    });
  });
}

async function expectCurrentMapRenderer(page: Page): Promise<void> {
  await expect(page.locator('.wm-embed-map')).toHaveClass(/(?:^|\s)(deckgl-mode|globe-mode|svg-mode)(?:\s|$)/);
  const deckCount = await page.locator('.deckgl-map-wrapper').count();
  if (deckCount > 0) {
    await expect(page.locator('.deckgl-map-wrapper')).toBeVisible();
    await expect(page.locator('.map-svg')).toHaveCount(0);
    return;
  }

  await expect(page.locator('.map-svg')).toBeVisible();
  await expect.poll(async () => page.locator('.country').count()).toBeGreaterThan(0);
}

async function expectCurrentMapRendererInFrame(frame: FrameLocator, page: Page): Promise<void> {
  await expect.poll(() => page.frames().some((candidate) => candidate.url().includes('/embed?'))).toBe(true);
  await expect(frame.locator('.wm-embed-map')).toHaveClass(/(?:^|\s)(deckgl-mode|globe-mode|svg-mode)(?:\s|$)/);
  const deckCount = await frame.locator('.deckgl-map-wrapper').count();
  if (deckCount > 0) {
    await expect(frame.locator('.deckgl-map-wrapper')).toBeVisible();
    await expect(frame.locator('.map-svg')).toHaveCount(0);
    return;
  }

  await expect(frame.locator('.map-svg')).toBeVisible();
  await expect.poll(async () => frame.locator('.country').count()).toBeGreaterThan(0);
}

async function serveThirdPartyHostPage(html: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error('third-party host server did not bind to a TCP port');
  }

  return {
    url: `http://127.0.0.1:${address.port}/worldmonitor-host`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    }),
  };
}

test.describe('public map embed', () => {
  const embedPath = '/embed?layers=conflicts,earthquakes,protests,weather&center=0,0&zoom=1&theme=dark&variant=full';
  const conflictWindowMs = 30 * 24 * 60 * 60 * 1000;
  const conflictApiPath = '/api/conflict/v1/list-acled-events';
  const publicEmbedApiPaths = [
    '/api/bootstrap?keys=weatherAlerts',
    '/api/natural/v1/list-natural-events',
    '/api/seismology/v1/list-earthquakes',
    '/api/unrest/v1/list-unrest-events',
  ];
  const trackedPublicEmbedApiPaths = [...publicEmbedApiPaths, conflictApiPath];

  test('renders the map-only embed route with attribution', async ({ page }, testInfo) => {
    await stubWorldAtlas(page);

    // Guard the self-hosting goal: the map atlas must load from same-origin
    // /data/, never from cdn.jsdelivr.net. Catches a MAP_URLS regression back
    // to the CDN (which stubWorldAtlas would not intercept).
    const cdnAtlasRequests: string[] = [];
    page.on('request', (request) => {
      const url = request.url();
      if (url.includes('cdn.jsdelivr.net') && /(?:world|us)-atlas/.test(url)) {
        cdnAtlasRequests.push(url);
      }
    });

    await page.goto(embedPath);

    await expect(page.locator('.wm-embed-attribution')).toHaveText('Live map by World Monitor');
    await expectCurrentMapRenderer(page);
    await expect(page.locator('.map-controls, .time-slider, .layer-toggles, .map-legend')).toHaveCount(0);
    await expect(page.locator('body')).toHaveAttribute('data-embed-ready', 'true');
    expect(cdnAtlasRequests, 'map atlas must be self-hosted, not fetched from cdn.jsdelivr.net').toHaveLength(0);

    const screenshotPath = testInfo.outputPath('embed-direct.png');
    await page.screenshot({ path: screenshotPath, fullPage: true });
    await testInfo.attach('embed-direct', { path: screenshotPath, contentType: 'image/png' });
  });

  test('loads inside a third-party iframe host page', async ({ page, baseURL }, testInfo) => {
    await stubWorldAtlas(page);
    const localBaseUrl = baseURL ?? 'http://127.0.0.1:4173';
    const embedUrl = new URL(embedPath, localBaseUrl).toString();
    const embedOrigin = new URL(embedUrl).origin;
    const statuses = new Map<string, number[]>();
    const conflictRequests: URL[] = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.pathname === conflictApiPath) {
        conflictRequests.push(url);
      }
    });
    page.on('response', (response) => {
      const url = new URL(response.url());
      const key = url.pathname === '/api/bootstrap'
        ? `${url.pathname}?${url.searchParams.toString()}`
        : url.pathname;
      if (!trackedPublicEmbedApiPaths.includes(key)) return;
      statuses.set(key, [...(statuses.get(key) ?? []), response.status()]);
    });
    await page.route('https://api.worldmonitor.app/api/**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const localUrl = new URL(`${url.pathname}${url.search}`, localBaseUrl).toString();
      const response = await fetch(localUrl, {
        method: request.method(),
        headers: {
          Accept: request.headers()['accept'] ?? '*/*',
          'Content-Type': request.headers()['content-type'] ?? 'application/json',
          Origin: embedOrigin,
        },
      });
      const body = await response.text();
      await route.fulfill({
        status: response.status,
        headers: {
          'Access-Control-Allow-Credentials': 'true',
          'Access-Control-Allow-Origin': embedOrigin,
          'Content-Type': response.headers.get('Content-Type') ?? 'application/json',
          Vary: 'Origin',
        },
        body,
      });
    });

    const host = await serveThirdPartyHostPage(`
      <!doctype html>
      <html>
        <body style="margin:0;background:#f7f7f7">
          <main style="max-width:860px;margin:24px auto;font-family:sans-serif">
            <h1>Host page</h1>
            <iframe id="wm" src="${embedUrl}" title="World Monitor live map" style="width:100%;height:420px;border:0;display:block"></iframe>
          </main>
        </body>
      </html>
    `);

    try {
      await page.goto(host.url);

      const frame = page.frameLocator('#wm');
      await expect(frame.locator('.wm-embed-attribution')).toHaveText('Live map by World Monitor');
      await expectCurrentMapRendererInFrame(frame, page);
      await expect(frame.locator('.map-controls, .time-slider, .layer-toggles, .map-legend')).toHaveCount(0);
      await expect(frame.locator('body')).toHaveAttribute('data-embed-ready', 'true');
      await expect.poll(() => publicEmbedApiPaths.filter((path) => statuses.has(path)).sort()).toEqual([...publicEmbedApiPaths].sort());
      const mapClass = await frame.locator('.wm-embed-map').getAttribute('class') ?? '';
      if (/\bsvg-mode\b/.test(mapClass)) {
        await expect.poll(() => conflictRequests.length).toBeGreaterThan(0);
        const conflictRequest = conflictRequests[0]!;
        const start = Number(conflictRequest.searchParams.get('start'));
        const end = Number(conflictRequest.searchParams.get('end'));
        expect(start, 'embed conflict layer must not request the generated zero/epoch start').toBeGreaterThan(0);
        expect(end, 'embed conflict layer must not request the generated zero/epoch end').toBeGreaterThan(0);
        expect(end - start, 'embed conflict layer should request the recent 30-day ACLED window').toBe(conflictWindowMs);
      } else {
        expect(conflictRequests).toHaveLength(0);
      }
      for (const [path, seenStatuses] of statuses) {
        expect(seenStatuses, `${path} must not 401 for anonymous embed viewers`).not.toContain(401);
      }

      const screenshotPath = testInfo.outputPath('embed-iframe.png');
      await page.screenshot({ path: screenshotPath, fullPage: true });
      await testInfo.attach('embed-iframe', { path: screenshotPath, contentType: 'image/png' });
    } finally {
      await host.close();
    }
  });

  test('does not fetch live conflict markers for the DeckGL embed renderer', async ({ page }) => {
    await page.addInitScript(() => {
      const originalGetContext = HTMLCanvasElement.prototype.getContext;
      let forcedSupportProbe = false;
      const rendererInfo = { UNMASKED_RENDERER_WEBGL: 0x9246 };

      HTMLCanvasElement.prototype.getContext = function getContextWithHardwareProbe(
        this: HTMLCanvasElement,
        contextId: string,
        options?: unknown
      ) {
        if (contextId === 'webgl2' && !forcedSupportProbe) {
          forcedSupportProbe = true;
          return {
            getExtension: (name: string) => name === 'WEBGL_debug_renderer_info' ? rendererInfo : null,
            getParameter: (param: number) => param === rendererInfo.UNMASKED_RENDERER_WEBGL ? 'ANGLE Hardware Renderer' : null,
          } as WebGL2RenderingContext;
        }

        return originalGetContext.call(this, contextId, options as never);
      } as typeof HTMLCanvasElement.prototype.getContext;
    });

    const conflictRequests: URL[] = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.pathname === '/api/conflict/v1/list-acled-events') {
        conflictRequests.push(url);
      }
    });

    await page.goto('/embed?layers=conflicts&center=0,0&zoom=1&theme=dark&variant=full');

    await expect(page.locator('.wm-embed-map')).toHaveClass(/(?:^|\s)deckgl-mode(?:\s|$)/);
    await expect(page.locator('body')).toHaveAttribute('data-embed-ready', 'true');
    expect(conflictRequests).toHaveLength(0);
  });
});
