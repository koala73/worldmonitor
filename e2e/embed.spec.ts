import { createServer, type Server } from 'node:http';
import { expect, test, type FrameLocator, type Page } from '@playwright/test';

import { classifyPublicEmbedFrameRequest } from '../shared/embed-map-frame';

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

const WEBMCP_MIN_CHROME_MAJOR = 149;

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
    res.writeHead(200, {
      'Content-Type': 'text/html',
      'Origin-Agent-Cluster': '?1',
      'Permissions-Policy': 'tools=(self)',
    });
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
  const mapFrameApiPath = '/api/embed/map-frame';
  // The frame used to fan out to four anonymous RPCs plus a bootstrap read.
  // It now polls one composed endpoint, and the fan-out is the regression:
  // a partner page must reach exactly one of our paths, and none of these.
  // Keyed by full query string for bootstrap because only the marked
  // `&public=1` shape was ever the embed's (#5386).
  const retiredEmbedApiPaths = [
    '/api/bootstrap?keys=weatherAlerts&public=1',
    '/api/conflict/v1/list-acled-events',
    '/api/natural/v1/list-natural-events',
    '/api/seismology/v1/list-earthquakes',
    '/api/unrest/v1/list-unrest-events',
  ];

  /** The path+query a request targets, in the shape retiredEmbedApiPaths uses. */
  function trackedKey(rawUrl: string): string {
    const url = new URL(rawUrl);
    return url.pathname === '/api/bootstrap'
      ? `${url.pathname}?${url.searchParams.toString()}`
      : url.pathname;
  }

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

  test('loads inside a third-party iframe host page', async ({ page, baseURL, browser }, testInfo) => {
    await stubWorldAtlas(page);
    const requireWebMcp = process.env.WM_REQUIRE_WEBMCP === '1';
    if (requireWebMcp) {
      const browserVersion = browser.version();
      const browserMajor = Number.parseInt(browserVersion.split('.')[0] ?? '', 10);
      expect(
        Number.isFinite(browserMajor) && browserMajor >= WEBMCP_MIN_CHROME_MAJOR,
        `WM_REQUIRE_WEBMCP requires Chrome ${WEBMCP_MIN_CHROME_MAJOR}+; launched ${browserVersion}`,
      ).toBe(true);
    }
    const localBaseUrl = baseURL ?? 'http://127.0.0.1:4173';
    const embedUrl = new URL(embedPath, localBaseUrl).toString();
    const embedOrigin = new URL(embedUrl).origin;
    const statuses = new Map<string, number[]>();
    // Raw request URLs, not re-serialised ones: the public-shape classifier
    // compares the query string byte for byte, so round-tripping through URL
    // could only weaken what this asserts.
    const mapFrameRequests: string[] = [];
    const retiredRequests: string[] = [];
    page.on('request', (request) => {
      const key = trackedKey(request.url());
      if (key === mapFrameApiPath) mapFrameRequests.push(request.url());
      if (retiredEmbedApiPaths.includes(key)) retiredRequests.push(key);
    });
    page.on('response', (response) => {
      const key = trackedKey(response.url());
      if (key !== mapFrameApiPath && !retiredEmbedApiPaths.includes(key)) return;
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
      const embedResponsePromise = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return url.pathname === '/embed' && response.request().resourceType() === 'document';
      });
      await page.goto(host.url);
      const embedResponse = await embedResponsePromise;
      const embedHeaders = await embedResponse.allHeaders();

      const frame = page.frameLocator('#wm');
      await expect(frame.locator('.wm-embed-attribution')).toHaveText('Live map by World Monitor');
      await expectCurrentMapRendererInFrame(frame, page);
      await expect(frame.locator('.map-controls, .time-slider, .layer-toggles, .map-legend')).toHaveCount(0);
      await expect(frame.locator('body')).toHaveAttribute('data-embed-ready', 'true');
      expect(embedHeaders['origin-agent-cluster']).toBe('?1');
      expect(embedHeaders['permissions-policy']).toContain('tools=()');
      await expect(page.locator('#wm')).not.toHaveAttribute('allow', /\btools\b/);

      const embeddedFrame = page.frames().find((candidate) => candidate.url().includes('/embed?'));
      expect(embeddedFrame, 'cross-origin embed frame must be available for the WebMCP denial probe').toBeTruthy();
      const hostHasModelContext = await page.evaluate(() => Boolean(document.modelContext));
      const embedProbe = await embeddedFrame!.evaluate(async () => {
        type PolicyProbe = { allowsFeature?: (feature: string) => boolean };
        const policyDocument = document as Document & {
          featurePolicy?: PolicyProbe;
          permissionsPolicy?: PolicyProbe;
        };
        const policy = policyDocument.permissionsPolicy ?? policyDocument.featurePolicy;
        const policyAllowsTools = policy?.allowsFeature?.('tools') ?? null;
        const provider = document.modelContext;
        if (!provider) {
          return {
            modelContextAvailable: false,
            policyAllowsTools,
            registration: 'unavailable' as const,
            toolNames: [] as string[],
          };
        }

        let registration: 'fulfilled' | 'rejected' = 'fulfilled';
        try {
          await provider.registerTool({
            name: 'wmEmbedDeniedProbe',
            description: 'Must never register inside the public World Monitor embed.',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
            execute: () => 'unexpected-success',
          });
        } catch {
          registration = 'rejected';
        }

        const tools = await provider.getTools().catch(() => []);
        return {
          modelContextAvailable: true,
          policyAllowsTools,
          registration,
          toolNames: tools.map((tool) => tool.name),
        };
      });

      expect(embedProbe.policyAllowsTools).not.toBe(true);
      expect(embedProbe.registration).not.toBe('fulfilled');
      expect(embedProbe.toolNames).not.toContain('wmEmbedDeniedProbe');

      if (requireWebMcp) {
        expect(
          hostHasModelContext,
          'WM_REQUIRE_WEBMCP requires Chrome with #enable-webmcp-testing or an active origin trial',
        ).toBe(true);
        expect(embedProbe.policyAllowsTools).toBe(false);
        const crossOriginTools = await page.evaluate(async (origin) => {
          const provider = document.modelContext;
          if (!provider) return null;
          const tools = await provider.getTools({ fromOrigins: [origin] });
          return tools.map((tool) => tool.name);
        }, embedOrigin);
        expect(crossOriginTools).toEqual([]);
      }

      await expect.poll(() => mapFrameRequests.length).toBeGreaterThan(0);
      expect(
        retiredRequests,
        'a partner frame must reach the composed endpoint and nothing else',
      ).toEqual([]);

      // Validating with the edge's own classifier, not a literal, proves the
      // URL this frame emits is one a shared cache may actually hold — the
      // failure mode is silent, since a near-miss still renders, just never
      // from cache. `protests` is a paid layer and must be absent: the free
      // tier drops it rather than fragmenting the CDN key space.
      const frameRequest = mapFrameRequests[0]!;
      expect(
        classifyPublicEmbedFrameRequest(frameRequest),
        `keyless frame URL must be the shared-cacheable shape: ${frameRequest}`,
      ).toEqual(['conflicts', 'earthquakes', 'weather']);
      // `layers` is the only knob this endpoint takes, and that is the point:
      // the per-RPC calls it replaced carried a time window and a page size,
      // which a credential published in partner HTML must not be able to turn.
      expect([...new URL(frameRequest).searchParams.keys()].sort()).toEqual(['layers', 'public']);

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

  // Was 'does not fetch live conflict markers for the DeckGL embed renderer'.
  // The renderer rule did not go away, it moved: the composed endpoint sends
  // one request carrying every active layer whatever the renderer is, and
  // EmbedDataLoader.applyFrame is now what withholds conflict events from a
  // canvas renderer. Watching the wire for it here would assert nothing, so
  // tests/dom/embed-data-loader.test.mts owns that rule and this keeps the
  // half that is still a network contract.
  test('drives the DeckGL embed renderer from the composed frame alone', async ({ page }) => {
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

    const frameRequests: string[] = [];
    const retiredRequests: string[] = [];
    page.on('request', (request) => {
      const key = trackedKey(request.url());
      if (key === mapFrameApiPath) frameRequests.push(request.url());
      if (retiredEmbedApiPaths.includes(key)) retiredRequests.push(key);
    });

    await page.goto('/embed?layers=conflicts&center=0,0&zoom=1&theme=dark&variant=full');

    await expect(page.locator('.wm-embed-map')).toHaveClass(/(?:^|\s)deckgl-mode(?:\s|$)/);
    await expect(page.locator('body')).toHaveAttribute('data-embed-ready', 'true');
    await expect.poll(() => frameRequests.length).toBeGreaterThan(0);
    expect(retiredRequests).toEqual([]);
    expect(classifyPublicEmbedFrameRequest(frameRequests[0]!)).toEqual(['conflicts']);
  });
});

test.describe('allowlisted panel embeds', () => {
  const embeddingKey = 'wm_0123456789abcdef0123456789abcdef01234567';
  const embedKey = `wme_${'a1b2c3d4e5'.repeat(4)}`;

  async function stubPanelApis(page: Page): Promise<void> {
    await page.route('**/api/embed/entitlement**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const panel = url.searchParams.get('panel') ?? '';
      const key = request.headers()['x-worldmonitor-key'] ?? '';
      const allowed = key === embeddingKey || key === embedKey;
      await route.fulfill({
        status: allowed ? 200 : 401,
        contentType: 'application/json',
        body: JSON.stringify({
          allowed,
          panel,
          public: false,
          accountId: allowed ? 'embed-account' : undefined,
          error: allowed ? undefined : 'embedding_api_key_required',
          // Mirrors server/_shared/embed-entitlement.ts: the marker is present
          // for the legacy credential and absent for a wme_ embed key.
          deprecatedCredential: key === embeddingKey ? 'user_api_key' : undefined,
        }),
      });
    });

    await page.route('**/api/supply-chain/v1/get-chokepoint-status**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          fetchedAt: '2026-08-18T00:00:00.000Z',
          upstreamUnavailable: false,
          chokepoints: [
            {
              id: 'hormuz_strait',
              name: 'Strait of Hormuz',
              lat: 26.6,
              lon: 56.3,
              disruptionScore: 12,
              status: 'normal',
              activeWarnings: 0,
              congestionLevel: 'low',
              affectedRoutes: [],
              description: '',
              aisDisruptions: 0,
              directions: [],
              directionalDwt: [],
              warRiskTier: 'WAR_RISK_TIER_NORMAL',
              flowEstimate: {
                currentMbd: 17,
                baselineMbd: 17,
                flowRatio: 1,
                disrupted: false,
                source: 'ais',
                hazardAlertLevel: '',
                hazardAlertName: '',
              },
            },
          ],
        }),
      });
    });

    await page.route('**/api/market/v1/get-fear-greed-index**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          compositeScore: 42,
          compositeLabel: 'Fear',
          previousScore: 40,
          seededAt: '2026-08-18T00:00:00.000Z',
          vix: 18,
          hySpread: 3,
          yield10y: 4,
          putCallRatio: 1,
          pctAbove200d: 50,
          cnnFearGreed: 41,
          cnnLabel: 'Fear',
          aaiiBull: 30,
          aaiiBear: 40,
          fedRate: '4.25',
          unavailable: false,
          fsiValue: 0,
          fsiLabel: '',
          hygPrice: 0,
          tltPrice: 0,
          sectorPerformance: [],
        }),
      });
    });
  }

  test('renders the live map when panel=map', async ({ page }) => {
    await stubWorldAtlas(page);
    await page.goto('/embed?panel=map&layers=conflicts,earthquakes,weather&center=0,0&zoom=1&theme=dark&variant=full');
    await expect(page.locator('body')).toHaveAttribute('data-embed-panel', 'map');
    await expect(page.locator('body')).toHaveAttribute('data-embed-ready', 'true');
    await expect(page.locator('.wm-embed-map')).toBeVisible();
  });

  test('renders chokepoint-strip from the script loader with an embedding key', async ({ page, baseURL }) => {
    await stubPanelApis(page);
    const localBaseUrl = baseURL ?? 'http://127.0.0.1:4173';
    const keyedRequests: string[] = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.pathname === '/api/supply-chain/v1/get-chokepoint-status') {
        keyedRequests.push(request.headers()['x-worldmonitor-key'] ?? '');
      }
    });

    const host = await serveThirdPartyHostPage(`
      <!doctype html>
      <html>
        <body style="margin:0;background:#111">
          <script src="${localBaseUrl}/embed.js" data-panel="chokepoint-strip" data-key="${embeddingKey}" data-theme="dark" data-height="360"></script>
        </body>
      </html>
    `);

    try {
      await page.goto(host.url);
      const frame = page.frameLocator('iframe[title="World Monitor embed"]');
      await expect(frame.locator('body')).toHaveAttribute('data-embed-panel', 'chokepoint-strip');
      await expect(frame.locator('body')).toHaveAttribute('data-embed-ready', 'true');
      await expect(frame.locator('.wm-embed-chokepoints')).toBeVisible();
      await expect(frame.locator('.wm-embed-cp-chip')).toHaveCount(1);
      expect(keyedRequests.some((key) => key === embeddingKey)).toBe(true);
    } finally {
      await host.close();
    }
  });

  test('renders fear-greed from the script loader with an embedding key', async ({ page, baseURL }) => {
    await stubPanelApis(page);
    const localBaseUrl = baseURL ?? 'http://127.0.0.1:4173';
    const host = await serveThirdPartyHostPage(`
      <!doctype html>
      <html>
        <body style="margin:0;background:#111">
          <script src="${localBaseUrl}/embed.js" data-panel="fear-greed" data-key="${embeddingKey}" data-theme="dark" data-height="360"></script>
        </body>
      </html>
    `);

    try {
      await page.goto(host.url);
      const frame = page.frameLocator('iframe[title="World Monitor embed"]');
      await expect(frame.locator('body')).toHaveAttribute('data-embed-panel', 'fear-greed');
      await expect(frame.locator('body')).toHaveAttribute('data-embed-ready', 'true');
      await expect(frame.locator('.wm-embed-fear-greed')).toBeVisible();
      await expect(frame.locator('.wm-embed-fg-score')).toHaveText('42');
    } finally {
      await host.close();
    }
  });

  test('renders chokepoint-strip from a wme_ embed key and sends it on the data read', async ({ page, baseURL }) => {
    // The migration end to end: a credential that authorises embedding and
    // nothing else drives a paid panel, loader handshake included.
    await stubPanelApis(page);
    const localBaseUrl = baseURL ?? 'http://127.0.0.1:4173';
    const keyedRequests: string[] = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.pathname === '/api/supply-chain/v1/get-chokepoint-status') {
        keyedRequests.push(request.headers()['x-worldmonitor-key'] ?? '');
      }
    });

    const host = await serveThirdPartyHostPage(`
      <!doctype html>
      <html>
        <body style="margin:0;background:#111">
          <script src="${localBaseUrl}/embed.js" data-panel="chokepoint-strip" data-key="${embedKey}" data-theme="dark" data-height="360"></script>
        </body>
      </html>
    `);

    try {
      await page.goto(host.url);
      const frame = page.frameLocator('iframe[title="World Monitor embed"]');
      await expect(frame.locator('body')).toHaveAttribute('data-embed-ready', 'true');
      await expect(frame.locator('.wm-embed-chokepoints')).toBeVisible();
      expect(keyedRequests.some((key) => key === embedKey)).toBe(true);
      expect(keyedRequests.some((key) => key.startsWith('wm_'))).toBe(false);
    } finally {
      await host.close();
    }
  });

  test('warns in the partner console for a wm_ key and stays quiet for a wme_ one', async ({ page, baseURL }) => {
    await stubPanelApis(page);
    const localBaseUrl = baseURL ?? 'http://127.0.0.1:4173';
    const warnings: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'warning') warnings.push(message.text());
    });

    const legacy = await serveThirdPartyHostPage(`
      <!doctype html>
      <html>
        <body style="margin:0;background:#111">
          <script src="${localBaseUrl}/embed.js" data-panel="fear-greed" data-key="${embeddingKey}" data-theme="dark" data-height="360"></script>
        </body>
      </html>
    `);
    try {
      await page.goto(legacy.url);
      await expect(page.frameLocator('iframe[title="World Monitor embed"]').locator('body'))
        .toHaveAttribute('data-embed-ready', 'true');
      await expect
        .poll(() => warnings.filter((line) => line.includes('worldmonitor-embed')).length)
        .toBeGreaterThan(0);
      const notice = warnings.find((line) => line.includes('worldmonitor-embed')) ?? '';
      expect(notice).toContain('Settings');
      expect(notice).toContain('wme_');
    } finally {
      await legacy.close();
    }

    warnings.length = 0;
    const scoped = await serveThirdPartyHostPage(`
      <!doctype html>
      <html>
        <body style="margin:0;background:#111">
          <script src="${localBaseUrl}/embed.js" data-panel="fear-greed" data-key="${embedKey}" data-theme="dark" data-height="360"></script>
        </body>
      </html>
    `);
    try {
      await page.goto(scoped.url);
      await expect(page.frameLocator('iframe[title="World Monitor embed"]').locator('body'))
        .toHaveAttribute('data-embed-ready', 'true');
      expect(warnings.filter((line) => line.includes('worldmonitor-embed'))).toEqual([]);
    } finally {
      await scoped.close();
    }
  });

  test('rejects a keyed panel when the embedding API key is missing', async ({ page }) => {
    await stubPanelApis(page);
    await page.goto('/embed?panel=fear-greed&theme=dark');
    await expect(page.locator('body')).toHaveAttribute('data-embed-panel', 'fear-greed');
    await expect(page.locator('body')).toHaveAttribute('data-embed-ready', 'error');
    await expect(page.locator('.wm-embed-error')).toContainText('embedding API key');
  });
});
