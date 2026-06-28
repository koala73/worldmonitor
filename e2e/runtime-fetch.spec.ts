import { expect, test } from '@playwright/test';

test.describe('desktop runtime routing guardrails', () => {
  test('detectDesktopRuntime covers packaged tauri hosts', async ({ page }) => {
    await page.goto('/tests/runtime-harness.html');

    const result = await page.evaluate(async () => {
      const runtime = await import('/src/services/runtime.ts');
      return {
        tauriHost: runtime.detectDesktopRuntime({
          hasTauriGlobals: false,
          userAgent: 'Mozilla/5.0',
          locationProtocol: 'https:',
          locationHost: 'tauri.localhost',
          locationOrigin: 'https://tauri.localhost',
        }),
        tauriScheme: runtime.detectDesktopRuntime({
          hasTauriGlobals: false,
          userAgent: 'Mozilla/5.0',
          locationProtocol: 'tauri:',
          locationHost: '',
          locationOrigin: 'tauri://localhost',
        }),
        tauriUa: runtime.detectDesktopRuntime({
          hasTauriGlobals: false,
          userAgent: 'Mozilla/5.0 Tauri/2.0',
          locationProtocol: 'https:',
          locationHost: 'example.com',
          locationOrigin: 'https://example.com',
        }),
        tauriGlobal: runtime.detectDesktopRuntime({
          hasTauriGlobals: true,
          userAgent: 'Mozilla/5.0',
          locationProtocol: 'https:',
          locationHost: 'example.com',
          locationOrigin: 'https://example.com',
        }),
        secureLocalhost: runtime.detectDesktopRuntime({
          hasTauriGlobals: false,
          userAgent: 'Mozilla/5.0',
          locationProtocol: 'https:',
          locationHost: 'localhost',
          locationOrigin: 'https://localhost',
        }),
        insecureLocalhost: runtime.detectDesktopRuntime({
          hasTauriGlobals: false,
          userAgent: 'Mozilla/5.0',
          locationProtocol: 'http:',
          locationHost: 'localhost:5173',
          locationOrigin: 'http://localhost:5173',
        }),
        webHost: runtime.detectDesktopRuntime({
          hasTauriGlobals: false,
          userAgent: 'Mozilla/5.0',
          locationProtocol: 'https:',
          locationHost: 'worldmonitor.app',
          locationOrigin: 'https://worldmonitor.app',
        }),
      };
    });

    expect(result.tauriHost).toBe(true);
    expect(result.tauriScheme).toBe(true);
    expect(result.tauriUa).toBe(true);
    expect(result.tauriGlobal).toBe(true);
    expect(result.secureLocalhost).toBe(true);
    expect(result.insecureLocalhost).toBe(false);
    expect(result.webHost).toBe(false);
  });

  test('runtime fetch patch falls back to cloud for local failures', async ({ page }) => {
    await page.goto('/tests/runtime-harness.html');

    const result = await page.evaluate(async () => {
      const runtime = await import('/src/services/runtime.ts');
      const runtimeConfig = await import('/src/services/runtime-config.ts');
      const globalWindow = window as unknown as Record<string, unknown>;
      const originalFetch = window.fetch.bind(window);

      const calls: string[] = [];
      const responseJson = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        });

      window.fetch = (async (input: RequestInfo | URL) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
            ? input.toString()
            : input.url;

        calls.push(url);

        if (url.includes('127.0.0.1:46123/api/fred-data')) {
          return responseJson({ error: 'missing local api key' }, 500);
        }
        if (url.includes('worldmonitor.app/api/fred-data')) {
          return responseJson({ observations: [{ value: '321.5' }] }, 200);
        }

        if (url.includes('127.0.0.1:46123/api/stablecoin-markets')) {
          throw new Error('ECONNREFUSED');
        }
        if (url.includes('worldmonitor.app/api/stablecoin-markets')) {
          return responseJson({ stablecoins: [{ symbol: 'USDT' }] }, 200);
        }

        return responseJson({ ok: true }, 200);
      }) as typeof window.fetch;

      const previousTauri = globalWindow.__TAURI__;
      globalWindow.__TAURI__ = { core: { invoke: () => Promise.resolve(null) } };
      delete globalWindow.__wmFetchPatched;

      // Set a valid WM API key so cloud fallback is allowed
      await runtimeConfig.setSecretValue('WORLDMONITOR_API_KEY' as import('/src/services/runtime-config.ts').RuntimeSecretKey, 'wm_test_key_1234567890abcdef');

      try {
        runtime.installRuntimeFetchPatch();

        const fredResponse = await window.fetch('/api/fred-data?series_id=CPIAUCSL');
        const fredBody = await fredResponse.json() as { observations?: Array<{ value: string }> };

        const stableResponse = await window.fetch('/api/stablecoin-markets');
        const stableBody = await stableResponse.json() as { stablecoins?: Array<{ symbol: string }> };

        return {
          fredStatus: fredResponse.status,
          fredValue: fredBody.observations?.[0]?.value ?? null,
          stableStatus: stableResponse.status,
          stableSymbol: stableBody.stablecoins?.[0]?.symbol ?? null,
          calls,
        };
      } finally {
        window.fetch = originalFetch;
        delete globalWindow.__wmFetchPatched;
        if (previousTauri === undefined) {
          delete globalWindow.__TAURI__;
        } else {
          globalWindow.__TAURI__ = previousTauri;
        }
        await runtimeConfig.setSecretValue('WORLDMONITOR_API_KEY' as import('/src/services/runtime-config.ts').RuntimeSecretKey, '');
      }
    });

    expect(result.fredStatus).toBe(200);
    expect(result.fredValue).toBe('321.5');
    expect(result.stableStatus).toBe(200);
    expect(result.stableSymbol).toBe('USDT');

    expect(result.calls.some((url) => url.includes('127.0.0.1:46123/api/fred-data'))).toBe(true);
    expect(result.calls.some((url) => url.includes('worldmonitor.app/api/fred-data'))).toBe(true);
    expect(result.calls.some((url) => url.includes('127.0.0.1:46123/api/stablecoin-markets'))).toBe(true);
    expect(result.calls.some((url) => url.includes('worldmonitor.app/api/stablecoin-markets'))).toBe(true);
  });

  test('runtime fetch patch never sends local-only endpoints to cloud', async ({ page }) => {
    await page.goto('/tests/runtime-harness.html');

    const result = await page.evaluate(async () => {
      const runtime = await import('/src/services/runtime.ts');
      const globalWindow = window as unknown as Record<string, unknown>;
      const originalFetch = window.fetch.bind(window);

      const calls: string[] = [];
      const responseJson = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        });

      window.fetch = (async (input: RequestInfo | URL) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
            ? input.toString()
            : input.url;
        calls.push(url);

        if (url.includes('127.0.0.1:46123/api/local-env-update')) {
          return responseJson({ error: 'Unauthorized' }, 401);
        }
        if (url.includes('127.0.0.1:46123/api/local-validate-secret')) {
          throw new Error('ECONNREFUSED');
        }

        if (url.includes('worldmonitor.app/api/local-env-update')) {
          return responseJson({ leaked: true }, 200);
        }
        if (url.includes('worldmonitor.app/api/local-validate-secret')) {
          return responseJson({ leaked: true }, 200);
        }

        return responseJson({ ok: true }, 200);
      }) as typeof window.fetch;

      const previousTauri = globalWindow.__TAURI__;
      globalWindow.__TAURI__ = { core: { invoke: () => Promise.resolve(null) } };
      delete globalWindow.__wmFetchPatched;

      try {
        runtime.installRuntimeFetchPatch();

        const envUpdateResponse = await window.fetch('/api/local-env-update', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: 'GROQ_API_KEY', value: 'sk-secret-value' }),
        });

        let validateError: string | null = null;
        try {
          await window.fetch('/api/local-validate-secret', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key: 'GROQ_API_KEY', value: 'sk-secret-value' }),
          });
        } catch (error) {
          validateError = error instanceof Error ? error.message : String(error);
        }

        return {
          envUpdateStatus: envUpdateResponse.status,
          validateError,
          calls,
        };
      } finally {
        window.fetch = originalFetch;
        delete globalWindow.__wmFetchPatched;
        if (previousTauri === undefined) {
          delete globalWindow.__TAURI__;
        } else {
          globalWindow.__TAURI__ = previousTauri;
        }
      }
    });

    expect(result.envUpdateStatus).toBe(401);
    expect(result.validateError).toContain('ECONNREFUSED');

    expect(result.calls.some((url) => url.includes('127.0.0.1:46123/api/local-env-update'))).toBe(true);
    expect(result.calls.some((url) => url.includes('127.0.0.1:46123/api/local-validate-secret'))).toBe(true);
    expect(result.calls.some((url) => url.includes('worldmonitor.app/api/local-env-update'))).toBe(false);
    expect(result.calls.some((url) => url.includes('worldmonitor.app/api/local-validate-secret'))).toBe(false);
  });

  test('chunk preload reload guard is one-shot until app boot clears it', async ({ page }) => {
    await page.goto('/tests/runtime-harness.html');

    const result = await page.evaluate(async () => {
      const {
        buildChunkReloadStorageKey,
        installChunkReloadGuard,
        clearChunkReloadGuard,
      } = await import('/src/bootstrap/chunk-reload.ts');

      const listeners = new Map<string, Array<() => void>>();
      const eventTarget = {
        addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
          const list = listeners.get(type) ?? [];
          list.push(() => {
            if (typeof listener === 'function') {
              listener(new Event(type));
            } else {
              listener.handleEvent(new Event(type));
            }
          });
          listeners.set(type, list);
        },
      };

      const storageMap = new Map<string, string>();
      const storage = {
        getItem: (key: string) => storageMap.get(key) ?? null,
        setItem: (key: string, value: string) => {
          storageMap.set(key, value);
        },
        removeItem: (key: string) => {
          storageMap.delete(key);
        },
      };

      const emit = (eventName: string) => {
        const handlers = listeners.get(eventName) ?? [];
        handlers.forEach((handler) => handler());
      };

      let reloadCount = 0;
      const storageKey = installChunkReloadGuard('9.9.9', {
        eventTarget,
        storage,
        eventName: 'preload-error',
        reload: () => {
          reloadCount += 1;
        },
      });

      emit('preload-error');
      emit('preload-error');
      const reloadCountBeforeClear = reloadCount;

      clearChunkReloadGuard(storageKey, storage);
      emit('preload-error');

      return {
        storageKey,
        expectedKey: buildChunkReloadStorageKey('9.9.9'),
        reloadCountBeforeClear,
        reloadCountAfterClear: reloadCount,
        storedValue: storageMap.get(storageKey) ?? null,
      };
    });

    expect(result.storageKey).toBe(result.expectedKey);
    expect(result.reloadCountBeforeClear).toBe(1);
    expect(result.reloadCountAfterClear).toBe(2);
    expect(result.storedValue).toBe('1');
  });

  test('update badge picks architecture-correct desktop download url', async ({ page }) => {
    await page.goto('/tests/runtime-harness.html');

    const result = await page.evaluate(async () => {
      const { DesktopUpdater } = await import('/src/app/desktop-updater.ts');
      const globalWindow = window as unknown as {
        __TAURI__?: { core?: { invoke?: (command: string) => Promise<unknown> } };
      };
      const previousTauri = globalWindow.__TAURI__;
      const releaseUrl = 'https://github.com/koala73/worldmonitor/releases/latest';

      const updaterProto = DesktopUpdater.prototype as unknown as {
        resolveUpdateDownloadUrl: (releaseUrl: string) => Promise<string>;
        mapDesktopDownloadPlatform: (os: string, arch: string) => string | null;
        getDesktopBuildVariant: () => 'full' | 'tech' | 'finance';
      };
      const fakeApp = {
        mapDesktopDownloadPlatform: updaterProto.mapDesktopDownloadPlatform,
        getDesktopBuildVariant: () => 'full' as const,
      };

      try {
        globalWindow.__TAURI__ = {
          core: {
            invoke: async (command: string) => {
              if (command !== 'get_desktop_runtime_info') throw new Error(`Unexpected command: ${command}`);
              return { os: 'macos', arch: 'aarch64' };
            },
          },
        };
        const macArm = await updaterProto.resolveUpdateDownloadUrl.call(fakeApp, releaseUrl);

        globalWindow.__TAURI__ = {
          core: {
            invoke: async () => ({ os: 'windows', arch: 'amd64' }),
          },
        };
        const windowsX64 = await updaterProto.resolveUpdateDownloadUrl.call(fakeApp, releaseUrl);

        globalWindow.__TAURI__ = {
          core: {
            invoke: async () => ({ os: 'linux', arch: 'x86_64' }),
          },
        };
        const linuxFallback = await updaterProto.resolveUpdateDownloadUrl.call(fakeApp, releaseUrl);

        return { macArm, windowsX64, linuxFallback };
      } finally {
        if (previousTauri === undefined) {
          delete globalWindow.__TAURI__;
        } else {
          globalWindow.__TAURI__ = previousTauri;
        }
      }
    });

    expect(result.macArm).toBe('https://worldmonitor.app/api/download?platform=macos-arm64&variant=full');
    expect(result.windowsX64).toBe('https://worldmonitor.app/api/download?platform=windows-exe&variant=full');
    expect(result.linuxFallback).toBe('https://github.com/koala73/worldmonitor/releases/latest');
  });

  test('MapContainer paints a mobile shell before heavy map renderer resources', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/tests/runtime-harness.html');

    const result = await page.evaluate(async () => {
      const { DEFAULT_MAP_LAYERS } = await import('/src/config/index.ts');
      const { initI18n } = await import('/src/services/i18n.ts');
      await initI18n();

      const isHeavyMapResource = (name: string): boolean =>
        /DeckGLMap|GlobeMap|maplibre|deck-stack|globe\.gl|pmtiles|\.pmtiles|@deck\.gl|@luma\.gl|@loaders\.gl/i.test(name);
      const heavyResourceNames = (): string[] =>
        performance.getEntriesByType('resource')
          .map((entry) => entry.name)
          .filter(isHeavyMapResource);
      const nextFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));
      const waitForRenderer = async (host: HTMLElement): Promise<void> => {
        const deadline = performance.now() + 5_000;
        while (!(
          host.classList.contains('svg-mode')
          || host.classList.contains('deckgl-mode')
          || host.classList.contains('globe-mode')
        )) {
          if (performance.now() > deadline) throw new Error('Map renderer did not settle');
          await nextFrame();
        }
      };

      performance.clearResourceTimings();
      const { MapContainer } = await import('/src/components/MapContainer.ts');
      const heavyAfterMapContainerImport = heavyResourceNames();

      const mapHost = document.createElement('div');
      mapHost.className = 'map-container';
      mapHost.style.width = '390px';
      mapHost.style.height = '260px';
      mapHost.style.position = 'relative';
      document.body.appendChild(mapHost);

      let map: InstanceType<typeof MapContainer> | null = null;
      const originalGetContext = HTMLCanvasElement.prototype.getContext;
      let webglProbeCalls = 0;
      try {
        HTMLCanvasElement.prototype.getContext = (function (
          this: HTMLCanvasElement,
          contextId: string,
          options?: unknown
        ) {
          if (contextId.toLowerCase().includes('webgl')) webglProbeCalls += 1;
          return originalGetContext.call(this, contextId, options as never);
        }) as typeof HTMLCanvasElement.prototype.getContext;

        map = new MapContainer(mapHost, {
          zoom: 2.5,
          pan: { x: 0, y: 0 },
          view: 'global',
          layers: { ...DEFAULT_MAP_LAYERS },
          timeRange: '7d',
        });
        const webglProbeCallsAtShell = webglProbeCalls;

        const shellRect = mapHost.getBoundingClientRect();
        const shellState = {
          hasShellClass: mapHost.classList.contains('map-renderer-shell'),
          ariaBusy: mapHost.getAttribute('aria-busy'),
          pendingRenderer: mapHost.dataset.mapRendererPending ?? null,
          shellChildCount: mapHost.querySelectorAll('.map-renderer-shell-surface').length,
          width: shellRect.width,
          height: shellRect.height,
        };

        await nextFrame();
        const heavyBeforeShellPaint = heavyResourceNames();
        await waitForRenderer(mapHost);
        const settledRect = mapHost.getBoundingClientRect();
        const heavyAfterMobileFallback = heavyResourceNames();

        return {
          shellState,
          heavyAfterMapContainerImport,
          heavyBeforeShellPaint,
          heavyAfterMobileFallback,
          webglProbeCallsAtShell,
          webglProbeCallsAfterRenderer: webglProbeCalls,
          settled: {
            svgMode: mapHost.classList.contains('svg-mode'),
            deckMode: mapHost.classList.contains('deckgl-mode'),
            globeMode: mapHost.classList.contains('globe-mode'),
            width: settledRect.width,
            height: settledRect.height,
          },
        };
      } finally {
        HTMLCanvasElement.prototype.getContext = originalGetContext;
        map?.destroy();
        mapHost.remove();
      }
    });

    expect(result.shellState.hasShellClass).toBe(true);
    expect(result.shellState.ariaBusy).toBe('true');
    expect(result.shellState.pendingRenderer).toBe('svg');
    expect(result.shellState.shellChildCount).toBe(1);
    expect(result.shellState.width).toBeGreaterThan(0);
    expect(result.shellState.height).toBeGreaterThan(0);
    expect(result.heavyAfterMapContainerImport).toEqual([]);
    expect(result.heavyBeforeShellPaint).toEqual([]);
    expect(result.heavyAfterMobileFallback).toEqual([]);
    expect(result.webglProbeCallsAtShell).toBe(0);
    expect(result.settled.svgMode).toBe(true);
    expect(result.settled.deckMode).toBe(false);
    expect(result.settled.globeMode).toBe(false);
    expect(Math.abs(result.settled.width - result.shellState.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(result.settled.height - result.shellState.height)).toBeLessThanOrEqual(1);
  });

  test('MapContainer waits for desktop map demand before heavy WebGL resources', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/tests/runtime-harness.html');

    const result = await page.evaluate(async () => {
      const { DEFAULT_MAP_LAYERS } = await import('/src/config/index.ts');
      const { initI18n } = await import('/src/services/i18n.ts');
      await initI18n();

      const isHeavyMapResource = (name: string): boolean =>
        /DeckGLMap|GlobeMap|maplibre|deck-stack|globe\.gl|pmtiles|\.pmtiles|@deck\.gl|@luma\.gl|@loaders\.gl/i.test(name);
      const heavyResourceNames = (): string[] =>
        performance.getEntriesByType('resource')
          .map((entry) => entry.name)
          .filter(isHeavyMapResource);
      const nextFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));
      const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

      performance.clearResourceTimings();
      const { MapContainer } = await import('/src/components/MapContainer.ts');
      const heavyAfterMapContainerImport = heavyResourceNames();

      const mapHost = document.createElement('div');
      mapHost.className = 'map-container';
      mapHost.style.width = '960px';
      mapHost.style.height = '360px';
      mapHost.style.position = 'relative';
      document.body.appendChild(mapHost);

      const originalGetContext = HTMLCanvasElement.prototype.getContext;
      const fakeDebugInfo = { UNMASKED_RENDERER_WEBGL: 0x9246 };
      const fakeWebGL2 = {
        getExtension(name: string) {
          return name === 'WEBGL_debug_renderer_info' ? fakeDebugInfo : null;
        },
        getParameter() {
          return 'ANGLE (Apple, ANGLE Metal Renderer: Apple M4, Unspecified Version)';
        },
      };
      let map: InstanceType<typeof MapContainer> | null = null;

      try {
        HTMLCanvasElement.prototype.getContext = (function (
          this: HTMLCanvasElement,
          contextId: string,
          options?: unknown,
        ) {
          if (contextId === 'webgl2') return fakeWebGL2 as unknown as RenderingContext;
          return originalGetContext.call(this, contextId, options as never);
        }) as typeof HTMLCanvasElement.prototype.getContext;

        map = new MapContainer(mapHost, {
          zoom: 1,
          pan: { x: 0, y: 0 },
          view: 'global',
          layers: { ...DEFAULT_MAP_LAYERS },
          timeRange: '7d',
        });

        await nextFrame();
        await nextFrame();
        const shellRect = mapHost.getBoundingClientRect();
        await wait(700);

        return {
          heavyAfterMapContainerImport,
          heavyBeforeDemand: heavyResourceNames(),
          shellState: {
            hasShellClass: mapHost.classList.contains('map-renderer-shell'),
            ariaBusy: mapHost.getAttribute('aria-busy'),
            pendingRenderer: mapHost.dataset.mapRendererPending ?? null,
            deckMode: mapHost.classList.contains('deckgl-mode'),
            svgMode: mapHost.classList.contains('svg-mode'),
            width: shellRect.width,
            height: shellRect.height,
          },
        };
      } finally {
        HTMLCanvasElement.prototype.getContext = originalGetContext;
        map?.destroy();
        mapHost.remove();
      }
    });

    expect(result.heavyAfterMapContainerImport).toEqual([]);
    expect(result.heavyBeforeDemand).toEqual([]);
    expect(result.shellState.hasShellClass).toBe(true);
    expect(result.shellState.ariaBusy).toBe('true');
    expect(result.shellState.pendingRenderer).toBe('deck');
    expect(result.shellState.deckMode).toBe(false);
    expect(result.shellState.svgMode).toBe(false);
    expect(result.shellState.width).toBeGreaterThan(0);
    expect(result.shellState.height).toBeGreaterThan(0);
  });

  test('MapContainer starts desktop WebGL resources on first map interaction', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/tests/runtime-harness.html');

    const result = await page.evaluate(async () => {
      const { DEFAULT_MAP_LAYERS } = await import('/src/config/index.ts');
      const { initI18n } = await import('/src/services/i18n.ts');
      await initI18n();

      const isHeavyMapResource = (name: string): boolean =>
        /DeckGLMap|GlobeMap|maplibre|deck-stack|globe\.gl|pmtiles|\.pmtiles|@deck\.gl|@luma\.gl|@loaders\.gl/i.test(name);
      const heavyResourceNames = (): string[] =>
        performance.getEntriesByType('resource')
          .map((entry) => entry.name)
          .filter(isHeavyMapResource);
      const nextFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));
      const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
      const waitForHeavyResource = async (): Promise<string[]> => {
        const deadline = performance.now() + 5_000;
        while (performance.now() < deadline) {
          const names = heavyResourceNames();
          if (names.length > 0) return names;
          await wait(50);
        }
        return heavyResourceNames();
      };

      performance.clearResourceTimings();
      const { MapContainer } = await import('/src/components/MapContainer.ts');

      const mapHost = document.createElement('div');
      mapHost.className = 'map-container';
      mapHost.style.width = '960px';
      mapHost.style.height = '360px';
      mapHost.style.position = 'relative';
      document.body.appendChild(mapHost);

      const originalGetContext = HTMLCanvasElement.prototype.getContext;
      const fakeDebugInfo = { UNMASKED_RENDERER_WEBGL: 0x9246 };
      const fakeWebGL2 = {
        getExtension(name: string) {
          return name === 'WEBGL_debug_renderer_info' ? fakeDebugInfo : null;
        },
        getParameter() {
          return 'ANGLE (Apple, ANGLE Metal Renderer: Apple M4, Unspecified Version)';
        },
      };
      let map: InstanceType<typeof MapContainer> | null = null;

      try {
        HTMLCanvasElement.prototype.getContext = (function (
          this: HTMLCanvasElement,
          contextId: string,
          options?: unknown,
        ) {
          if (contextId === 'webgl2') return fakeWebGL2 as unknown as RenderingContext;
          return originalGetContext.call(this, contextId, options as never);
        }) as typeof HTMLCanvasElement.prototype.getContext;

        map = new MapContainer(mapHost, {
          zoom: 1,
          pan: { x: 0, y: 0 },
          view: 'global',
          layers: { ...DEFAULT_MAP_LAYERS },
          timeRange: '7d',
        });

        await nextFrame();
        await nextFrame();
        await wait(100);
        const heavyBeforeInteraction = heavyResourceNames();
        mapHost.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }));
        const heavyAfterInteraction = await waitForHeavyResource();

        return {
          heavyBeforeInteraction,
          heavyAfterInteraction,
          pendingRenderer: mapHost.dataset.mapRendererPending ?? null,
        };
      } finally {
        HTMLCanvasElement.prototype.getContext = originalGetContext;
        map?.destroy();
        mapHost.remove();
      }
    });

    expect(result.heavyBeforeInteraction).toEqual([]);
    expect(result.pendingRenderer).toBe('deck');
    expect(result.heavyAfterInteraction.some((name) => (
      /DeckGLMap|maplibre|@deck\.gl|@luma\.gl|@loaders\.gl/i.test(name)
    ))).toBe(true);
  });

  test('MapContainer replays escalation getter setup after deferred renderer mount', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/tests/runtime-harness.html');

    const result = await page.evaluate(async () => {
      const { DEFAULT_MAP_LAYERS } = await import('/src/config/index.ts');
      const { initI18n } = await import('/src/services/i18n.ts');
      await initI18n();
      const { MapComponent } = await import('/src/components/Map.ts');
      const { MapContainer } = await import('/src/components/MapContainer.ts');

      const proto = MapComponent.prototype as {
        initEscalationGetters: () => void;
      };
      const originalInitEscalationGetters = proto.initEscalationGetters;
      let initCalls = 0;
      const nextFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));
      const waitForSvgRenderer = async (host: HTMLElement): Promise<void> => {
        const deadline = performance.now() + 5_000;
        while (!host.classList.contains('svg-mode')) {
          if (performance.now() > deadline) throw new Error('SVG renderer did not settle');
          await nextFrame();
        }
      };

      proto.initEscalationGetters = function (this: InstanceType<typeof MapComponent>): void {
        initCalls += 1;
        originalInitEscalationGetters.call(this);
      };

      const mapHost = document.createElement('div');
      mapHost.className = 'map-container';
      mapHost.style.width = '390px';
      mapHost.style.height = '260px';
      mapHost.style.position = 'relative';
      document.body.appendChild(mapHost);

      let map: InstanceType<typeof MapContainer> | null = null;
      try {
        map = new MapContainer(mapHost, {
          zoom: 2.5,
          pan: { x: 0, y: 0 },
          view: 'global',
          layers: { ...DEFAULT_MAP_LAYERS },
          timeRange: '7d',
        });
        map.initEscalationGetters();
        const callsBeforeRenderer = initCalls;

        await waitForSvgRenderer(mapHost);

        return {
          callsBeforeRenderer,
          callsAfterRenderer: initCalls,
          svgMode: mapHost.classList.contains('svg-mode'),
        };
      } finally {
        map?.destroy();
        mapHost.remove();
        proto.initEscalationGetters = originalInitEscalationGetters;
      }
    });

    expect(result.callsBeforeRenderer).toBe(0);
    expect(result.callsAfterRenderer).toBe(1);
    expect(result.svgMode).toBe(true);
  });

  test('MapContainer replays pending view and zoom after deferred renderer mount', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/tests/runtime-harness.html');

    const result = await page.evaluate(async () => {
      const { DEFAULT_MAP_LAYERS } = await import('/src/config/index.ts');
      const { initI18n } = await import('/src/services/i18n.ts');
      await initI18n();
      const { MapComponent } = await import('/src/components/Map.ts');
      const { MapContainer } = await import('/src/components/MapContainer.ts');

      const proto = MapComponent.prototype as {
        setView: (view: string, zoom?: number) => void;
        setZoom: (zoom: number) => void;
      };
      const originalSetView = proto.setView;
      const originalSetZoom = proto.setZoom;
      const viewCalls: Array<{ view: string; zoom?: number }> = [];
      const zoomCalls: number[] = [];
      const nextFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));
      const waitForSvgRenderer = async (host: HTMLElement): Promise<void> => {
        const deadline = performance.now() + 5_000;
        while (!host.classList.contains('svg-mode')) {
          if (performance.now() > deadline) throw new Error('SVG renderer did not settle');
          await nextFrame();
        }
      };

      proto.setView = function (this: InstanceType<typeof MapComponent>, view: string, zoom?: number): void {
        viewCalls.push({ view, zoom });
        originalSetView.call(this, view as never, zoom);
      };
      proto.setZoom = function (this: InstanceType<typeof MapComponent>, zoom: number): void {
        zoomCalls.push(zoom);
        originalSetZoom.call(this, zoom);
      };

      const mapHost = document.createElement('div');
      mapHost.className = 'map-container';
      mapHost.style.width = '390px';
      mapHost.style.height = '260px';
      mapHost.style.position = 'relative';
      document.body.appendChild(mapHost);

      let map: InstanceType<typeof MapContainer> | null = null;
      try {
        map = new MapContainer(mapHost, {
          zoom: 2.5,
          pan: { x: 0, y: 0 },
          view: 'global',
          layers: { ...DEFAULT_MAP_LAYERS },
          timeRange: '7d',
        });
        map.setView('mena', 4);
        map.setZoom(5);
        const callsBeforeRenderer = { view: viewCalls.length, zoom: zoomCalls.length };

        await waitForSvgRenderer(mapHost);

        return {
          callsBeforeRenderer,
          viewCalls,
          zoomCalls,
          state: map.getState(),
          svgMode: mapHost.classList.contains('svg-mode'),
        };
      } finally {
        map?.destroy();
        mapHost.remove();
        proto.setView = originalSetView;
        proto.setZoom = originalSetZoom;
      }
    });

    expect(result.callsBeforeRenderer).toEqual({ view: 0, zoom: 0 });
    expect(result.viewCalls).toEqual([{ view: 'mena', zoom: 4 }]);
    expect(result.zoomCalls).toEqual([5]);
    expect(result.state.view).toBe('mena');
    expect(result.state.zoom).toBe(5);
    expect(result.svgMode).toBe(true);
  });

  test('MapContainer applies pending time range before deferred renderer mount', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/tests/runtime-harness.html');

    const result = await page.evaluate(async () => {
      const { DEFAULT_MAP_LAYERS } = await import('/src/config/index.ts');
      const { initI18n } = await import('/src/services/i18n.ts');
      await initI18n();
      const { MapComponent } = await import('/src/components/Map.ts');
      const { MapContainer } = await import('/src/components/MapContainer.ts');

      const proto = MapComponent.prototype as {
        setTimeRange: (range: string) => void;
      };
      const originalSetTimeRange = proto.setTimeRange;
      const rendererRanges: string[] = [];
      const callbackRanges: string[] = [];
      const nextFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));
      const waitForSvgRenderer = async (host: HTMLElement): Promise<void> => {
        const deadline = performance.now() + 5_000;
        while (!host.classList.contains('svg-mode')) {
          if (performance.now() > deadline) throw new Error('SVG renderer did not settle');
          await nextFrame();
        }
      };

      proto.setTimeRange = function (this: InstanceType<typeof MapComponent>, range: string): void {
        rendererRanges.push(range);
        originalSetTimeRange.call(this, range as never);
      };

      const mapHost = document.createElement('div');
      mapHost.className = 'map-container';
      mapHost.style.width = '390px';
      mapHost.style.height = '260px';
      mapHost.style.position = 'relative';
      document.body.appendChild(mapHost);

      let map: InstanceType<typeof MapContainer> | null = null;
      try {
        map = new MapContainer(mapHost, {
          zoom: 2.5,
          pan: { x: 0, y: 0 },
          view: 'global',
          layers: { ...DEFAULT_MAP_LAYERS },
          timeRange: '7d',
        });
        map.onTimeRangeChanged((range) => callbackRanges.push(range));
        map.setTimeRange('24h');
        const beforeRenderer = {
          callbackRanges: [...callbackRanges],
          rendererRanges: [...rendererRanges],
          timeRange: map.getTimeRange(),
        };

        await waitForSvgRenderer(mapHost);

        return {
          beforeRenderer,
          afterRenderer: {
            callbackRanges,
            rendererRanges,
            timeRange: map.getTimeRange(),
            stateRange: map.getState().timeRange,
          },
          svgMode: mapHost.classList.contains('svg-mode'),
        };
      } finally {
        map?.destroy();
        mapHost.remove();
        proto.setTimeRange = originalSetTimeRange;
      }
    });

    expect(result.beforeRenderer).toEqual({
      callbackRanges: ['24h'],
      rendererRanges: [],
      timeRange: '24h',
    });
    expect(result.afterRenderer.callbackRanges).toEqual(['24h']);
    expect(result.afterRenderer.rendererRanges).toEqual([]);
    expect(result.afterRenderer.timeRange).toBe('24h');
    expect(result.afterRenderer.stateRange).toBe('24h');
    expect(result.svgMode).toBe(true);
  });

  test('MapContainer replays hidden layer toggles after deferred renderer mount', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/tests/runtime-harness.html');

    const result = await page.evaluate(async () => {
      const { DEFAULT_MAP_LAYERS } = await import('/src/config/index.ts');
      const { initI18n } = await import('/src/services/i18n.ts');
      await initI18n();
      const { MapComponent } = await import('/src/components/Map.ts');
      const { MapContainer } = await import('/src/components/MapContainer.ts');

      const proto = MapComponent.prototype as {
        hideLayerToggle: (layer: string) => void;
      };
      const originalHideLayerToggle = proto.hideLayerToggle;
      const hiddenLayers: string[] = [];
      const nextFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));
      const waitForSvgRenderer = async (host: HTMLElement): Promise<void> => {
        const deadline = performance.now() + 5_000;
        while (!host.classList.contains('svg-mode')) {
          if (performance.now() > deadline) throw new Error('SVG renderer did not settle');
          await nextFrame();
        }
      };

      proto.hideLayerToggle = function (this: InstanceType<typeof MapComponent>, layer: string): void {
        hiddenLayers.push(layer);
        originalHideLayerToggle.call(this, layer as never);
      };

      const mapHost = document.createElement('div');
      mapHost.className = 'map-container';
      mapHost.style.width = '390px';
      mapHost.style.height = '260px';
      mapHost.style.position = 'relative';
      document.body.appendChild(mapHost);

      let map: InstanceType<typeof MapContainer> | null = null;
      try {
        map = new MapContainer(mapHost, {
          zoom: 2.5,
          pan: { x: 0, y: 0 },
          view: 'global',
          layers: { ...DEFAULT_MAP_LAYERS },
          timeRange: '7d',
        });
        map.hideLayerToggle('outages');
        const callsBeforeRenderer = hiddenLayers.length;

        await waitForSvgRenderer(mapHost);

        return {
          callsBeforeRenderer,
          hiddenLayers,
          svgMode: mapHost.classList.contains('svg-mode'),
        };
      } finally {
        map?.destroy();
        mapHost.remove();
        proto.hideLayerToggle = originalHideLayerToggle;
      }
    });

    expect(result.callsBeforeRenderer).toBe(0);
    expect(result.hiddenLayers).toEqual(['outages']);
    expect(result.svgMode).toBe(true);
  });

  test('MapContainer preserves early enabled layers for deferred renderer mount', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/tests/runtime-harness.html');

    const result = await page.evaluate(async () => {
      const { DEFAULT_MAP_LAYERS } = await import('/src/config/index.ts');
      const { initI18n } = await import('/src/services/i18n.ts');
      await initI18n();
      const { MapComponent } = await import('/src/components/Map.ts');
      const { MapContainer } = await import('/src/components/MapContainer.ts');

      const proto = MapComponent.prototype as {
        enableLayer: (layer: string) => void;
      };
      const originalEnableLayer = proto.enableLayer;
      const enableCalls: string[] = [];
      const nextFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));
      const waitForSvgRenderer = async (host: HTMLElement): Promise<void> => {
        const deadline = performance.now() + 5_000;
        while (!host.classList.contains('svg-mode')) {
          if (performance.now() > deadline) throw new Error('SVG renderer did not settle');
          await nextFrame();
        }
      };

      proto.enableLayer = function (this: InstanceType<typeof MapComponent>, layer: string): void {
        enableCalls.push(layer);
        originalEnableLayer.call(this, layer as never);
      };

      const mapHost = document.createElement('div');
      mapHost.className = 'map-container';
      mapHost.style.width = '390px';
      mapHost.style.height = '260px';
      mapHost.style.position = 'relative';
      document.body.appendChild(mapHost);

      let map: InstanceType<typeof MapContainer> | null = null;
      try {
        map = new MapContainer(mapHost, {
          zoom: 2.5,
          pan: { x: 0, y: 0 },
          view: 'global',
          layers: { ...DEFAULT_MAP_LAYERS, outages: false },
          timeRange: '7d',
        });
        map.enableLayer('outages');
        const beforeRenderer = {
          enableCalls: [...enableCalls],
          layerEnabled: map.getState().layers.outages,
        };

        await waitForSvgRenderer(mapHost);

        return {
          beforeRenderer,
          afterRenderer: {
            enableCalls,
            layerEnabled: map.getState().layers.outages,
          },
          svgMode: mapHost.classList.contains('svg-mode'),
        };
      } finally {
        map?.destroy();
        mapHost.remove();
        proto.enableLayer = originalEnableLayer;
      }
    });

    expect(result.beforeRenderer).toEqual({ enableCalls: [], layerEnabled: true });
    expect(result.afterRenderer.enableCalls).toEqual([]);
    expect(result.afterRenderer.layerEnabled).toBe(true);
    expect(result.svgMode).toBe(true);
  });

  test('MapContainer replays early chokepoint data after deferred renderer mount', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/tests/runtime-harness.html');

    const result = await page.evaluate(async () => {
      const { DEFAULT_MAP_LAYERS } = await import('/src/config/index.ts');
      const { initI18n } = await import('/src/services/i18n.ts');
      await initI18n();
      const { MapComponent } = await import('/src/components/Map.ts');
      const { MapContainer } = await import('/src/components/MapContainer.ts');

      const proto = MapComponent.prototype as {
        setChokepointData: (data: unknown) => void;
      };
      const originalChokepoint = proto.setChokepointData;
      let calls = 0;
      const nextFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));
      const waitForSvgRenderer = async (host: HTMLElement): Promise<void> => {
        const deadline = performance.now() + 5_000;
        while (!host.classList.contains('svg-mode')) {
          if (performance.now() > deadline) throw new Error('SVG renderer did not settle');
          await nextFrame();
        }
      };

      proto.setChokepointData = function (this: InstanceType<typeof MapComponent>, data: unknown): void {
        if (data) calls += 1;
        originalChokepoint.call(this, data as never);
      };

      const mapHost = document.createElement('div');
      mapHost.className = 'map-container';
      mapHost.style.width = '390px';
      mapHost.style.height = '260px';
      mapHost.style.position = 'relative';
      document.body.appendChild(mapHost);

      let map: InstanceType<typeof MapContainer> | null = null;
      try {
        map = new MapContainer(mapHost, {
          zoom: 1,
          pan: { x: 0, y: 0 },
          view: 'global',
          layers: { ...DEFAULT_MAP_LAYERS },
          timeRange: '7d',
        });
        map.setChokepointData({ chokepoints: [] } as never);
        const callsBeforeRenderer = calls;

        await waitForSvgRenderer(mapHost);

        return {
          callsBeforeRenderer,
          callsAfterRenderer: calls,
          svgMode: mapHost.classList.contains('svg-mode'),
        };
      } finally {
        map?.destroy();
        mapHost.remove();
        proto.setChokepointData = originalChokepoint;
      }
    });

    expect(result.callsBeforeRenderer).toBe(0);
    expect(result.callsAfterRenderer).toBe(1);
    expect(result.svgMode).toBe(true);
  });

  test('MapContainer falls back to SVG when WebGL2 is unavailable', async ({ page }) => {
    await page.goto('/tests/runtime-harness.html');

    const result = await page.evaluate(async () => {
      const { DEFAULT_MAP_LAYERS } = await import('/src/config/index.ts');
      const { initI18n } = await import('/src/services/i18n.ts');
      await initI18n();
      const { MapContainer } = await import('/src/components/MapContainer.ts');

      const mapHost = document.createElement('div');
      mapHost.className = 'map-container';
      mapHost.style.width = '1200px';
      mapHost.style.height = '720px';
      document.body.appendChild(mapHost);

      const originalGetContext = HTMLCanvasElement.prototype.getContext;
      let map: InstanceType<typeof MapContainer> | null = null;
      const waitForRenderer = async (): Promise<void> => {
        const deadline = performance.now() + 5_000;
        while (!mapHost.classList.contains('svg-mode')) {
          if (performance.now() > deadline) throw new Error('Map renderer did not settle');
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }
      };

      try {
        HTMLCanvasElement.prototype.getContext = (function (
          this: HTMLCanvasElement,
          contextId: string,
          options?: unknown
        ) {
          if (contextId === 'webgl2') return null;
          return originalGetContext.call(this, contextId, options as never);
        }) as typeof HTMLCanvasElement.prototype.getContext;

        map = new MapContainer(mapHost, {
          zoom: 1,
          pan: { x: 0, y: 0 },
          view: 'global',
          layers: { ...DEFAULT_MAP_LAYERS },
          timeRange: '7d',
        });
        await new Promise<void>((resolve) => requestAnimationFrame(() => {
          requestAnimationFrame(() => window.setTimeout(resolve, 0));
        }));
        mapHost.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        await waitForRenderer();

        return {
          isDeckGLMode: map.isDeckGLMode(),
          hasSvgModeClass: mapHost.classList.contains('svg-mode'),
          hasDeckModeClass: mapHost.classList.contains('deckgl-mode'),
          deckWrapperCount: mapHost.querySelectorAll('.deckgl-map-wrapper').length,
          svgWrapperCount: mapHost.querySelectorAll('.map-wrapper').length,
        };
      } finally {
        HTMLCanvasElement.prototype.getContext = originalGetContext;
        map?.destroy();
        mapHost.remove();
      }
    });

    expect(result.isDeckGLMode).toBe(false);
    expect(result.hasSvgModeClass).toBe(true);
    expect(result.hasDeckModeClass).toBe(false);
    expect(result.deckWrapperCount).toBe(0);
    expect(result.svgWrapperCount).toBe(1);
  });

  test('MapContainer clears partial DeckGL DOM after constructor failure fallback', async ({ page }) => {
    await page.goto('/tests/runtime-harness.html');

    const result = await page.evaluate(async () => {
      const { DEFAULT_MAP_LAYERS } = await import('/src/config/index.ts');
      const { initI18n } = await import('/src/services/i18n.ts');
      await initI18n();
      const { MapContainer } = await import('/src/components/MapContainer.ts');

      const mapHost = document.createElement('div');
      mapHost.className = 'map-container';
      mapHost.style.width = '1200px';
      mapHost.style.height = '720px';
      document.body.appendChild(mapHost);

      const originalGetContext = HTMLCanvasElement.prototype.getContext;
      const originalGetElementById = Document.prototype.getElementById;
      let map: InstanceType<typeof MapContainer> | null = null;
      const waitForRenderer = async (): Promise<void> => {
        const deadline = performance.now() + 5_000;
        while (!mapHost.classList.contains('svg-mode')) {
          if (performance.now() > deadline) throw new Error('Map renderer did not settle');
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }
      };

      try {
        HTMLCanvasElement.prototype.getContext = (function (
          this: HTMLCanvasElement,
          contextId: string,
          options?: unknown
        ) {
          if (contextId === 'webgl2') {
            return {
              getExtension: () => null,
              getParameter: () => null,
            } as unknown as WebGL2RenderingContext;
          }
          return originalGetContext.call(this, contextId, options as never);
        }) as typeof HTMLCanvasElement.prototype.getContext;

        Document.prototype.getElementById = (function (
          this: Document,
          id: string
        ): HTMLElement | null {
          if (id === 'deckgl-basemap') {
            throw new Error('forced DeckGL init failure');
          }
          return originalGetElementById.call(this, id);
        }) as typeof Document.prototype.getElementById;

        map = new MapContainer(mapHost, {
          zoom: 1,
          pan: { x: 0, y: 0 },
          view: 'global',
          layers: { ...DEFAULT_MAP_LAYERS },
          timeRange: '7d',
        });
        await waitForRenderer();

        return {
          isDeckGLMode: map.isDeckGLMode(),
          hasSvgModeClass: mapHost.classList.contains('svg-mode'),
          hasDeckModeClass: mapHost.classList.contains('deckgl-mode'),
          deckWrapperCount: mapHost.querySelectorAll('.deckgl-map-wrapper').length,
          svgWrapperCount: mapHost.querySelectorAll('.map-wrapper').length,
        };
      } finally {
        HTMLCanvasElement.prototype.getContext = originalGetContext;
        Document.prototype.getElementById = originalGetElementById;
        map?.destroy();
        mapHost.remove();
      }
    });

    expect(result.isDeckGLMode).toBe(false);
    expect(result.hasSvgModeClass).toBe(true);
    expect(result.hasDeckModeClass).toBe(false);
    expect(result.deckWrapperCount).toBe(0);
    expect(result.svgWrapperCount).toBe(1);
  });

  test('MapContainer falls back to SVG for software WebGL renderers', async ({ page }) => {
    await page.goto('/tests/runtime-harness.html');

    const result = await page.evaluate(async () => {
      const { DEFAULT_MAP_LAYERS } = await import('/src/config/index.ts');
      const { initI18n } = await import('/src/services/i18n.ts');
      await initI18n();
      const { MapContainer } = await import('/src/components/MapContainer.ts');

      const mapHost = document.createElement('div');
      mapHost.className = 'map-container';
      mapHost.style.width = '1200px';
      mapHost.style.height = '720px';
      document.body.appendChild(mapHost);

      const originalGetContext = HTMLCanvasElement.prototype.getContext;
      let map: InstanceType<typeof MapContainer> | null = null;
      const waitForRenderer = async (): Promise<void> => {
        const deadline = performance.now() + 5_000;
        while (!(
          mapHost.classList.contains('svg-mode')
          || mapHost.classList.contains('deckgl-mode')
          || mapHost.classList.contains('globe-mode')
        )) {
          if (performance.now() > deadline) throw new Error('Map renderer did not settle');
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }
      };

      try {
        const rendererInfo = { UNMASKED_RENDERER_WEBGL: 0x9246 };
        HTMLCanvasElement.prototype.getContext = (function (
          this: HTMLCanvasElement,
          contextId: string,
          options?: unknown
        ) {
          if (contextId === 'webgl2') {
            return {
              getExtension: (name: string) => name === 'WEBGL_debug_renderer_info' ? rendererInfo : null,
              getParameter: (param: number) => param === rendererInfo.UNMASKED_RENDERER_WEBGL ? 'Google SwiftShader' : null,
            } as unknown as WebGL2RenderingContext;
          }
          return originalGetContext.call(this, contextId, options as never);
        }) as typeof HTMLCanvasElement.prototype.getContext;

        map = new MapContainer(mapHost, {
          zoom: 1,
          pan: { x: 0, y: 0 },
          view: 'global',
          layers: { ...DEFAULT_MAP_LAYERS },
          timeRange: '7d',
        });
        await waitForRenderer();

        return {
          isDeckGLMode: map.isDeckGLMode(),
          hasSvgModeClass: mapHost.classList.contains('svg-mode'),
          hasDeckModeClass: mapHost.classList.contains('deckgl-mode'),
          deckWrapperCount: mapHost.querySelectorAll('.deckgl-map-wrapper').length,
          svgWrapperCount: mapHost.querySelectorAll('.map-wrapper').length,
        };
      } finally {
        HTMLCanvasElement.prototype.getContext = originalGetContext;
        map?.destroy();
        mapHost.remove();
      }
    });

    expect(result.isDeckGLMode).toBe(false);
    expect(result.hasSvgModeClass).toBe(true);
    expect(result.hasDeckModeClass).toBe(false);
    expect(result.deckWrapperCount).toBe(0);
    expect(result.svgWrapperCount).toBe(1);
  });

  test('loadMarkets keeps Yahoo-backed data when Finnhub is skipped', async ({ page }) => {
    await page.goto('/tests/runtime-harness.html');

    const result = await page.evaluate(async () => {
      const { DataLoaderManager } = await import('/src/app/data-loader.ts');
      const originalFetch = window.fetch.bind(window);

      const calls: string[] = [];
      const toUrl = (input: RequestInfo | URL): string => {
        if (typeof input === 'string') return new URL(input, window.location.origin).toString();
        if (input instanceof URL) return input.toString();
        return new URL(input.url, window.location.origin).toString();
      };
      const responseJson = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        });

      const yahooChart = (symbol: string) => {
        const base = symbol.length * 100;
        return {
          chart: {
            result: [{
              meta: {
                regularMarketPrice: base + 1,
                previousClose: base,
              },
              indicators: {
                quote: [{ close: [base - 2, base - 1, base, base + 1] }],
              },
            }],
          },
        };
      };

      const marketRenders: number[] = [];
      const marketConfigErrors: string[] = [];
      const heatmapRenders: number[] = [];
      const heatmapConfigErrors: string[] = [];
      const commoditiesRenders: number[] = [];
      const commoditiesConfigErrors: string[] = [];
      const cryptoRenders: number[] = [];
      const apiStatuses: Array<{ name: string; status: string }> = [];

      // Yahoo-only symbols (same set as server handler)
      const yahooOnly = new Set(['^GSPC', '^DJI', '^IXIC', '^VIX', 'GC=F', 'CL=F', 'NG=F', 'SI=F', 'HG=F']);

      window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = toUrl(input);
        calls.push(url);
        const parsed = new URL(url);

        // Sebuf proto: POST /api/market/v1/list-market-quotes
        if (parsed.pathname === '/api/market/v1/list-market-quotes') {
          const body = init?.body ? JSON.parse(String(init.body)) : {};
          const symbols: string[] = body.symbols || [];
          const quotes = symbols
            .filter((s: string) => yahooOnly.has(s))
            .map((s: string) => {
              const base = s.length * 100;
              return { symbol: s, name: s, display: s, price: base + 1, change: ((base + 1) - base) / base * 100, sparkline: [base - 2, base - 1, base, base + 1] };
            });
          return responseJson({
            quotes,
            finnhubSkipped: true,
            skipReason: 'FINNHUB_API_KEY not configured',
          });
        }

        // Sebuf proto: POST /api/market/v1/list-crypto-quotes
        if (parsed.pathname === '/api/market/v1/list-crypto-quotes') {
          return responseJson({
            quotes: [
              { name: 'Bitcoin', symbol: 'BTC', price: 50000, change: 1.2, sparkline: [1, 2, 3] },
              { name: 'Ethereum', symbol: 'ETH', price: 3000, change: -0.5, sparkline: [1, 2, 3] },
              { name: 'Solana', symbol: 'SOL', price: 120, change: 2.1, sparkline: [1, 2, 3] },
            ],
          });
        }

        return responseJson({});
      }) as typeof window.fetch;

      const fakeApp = {
        ctx: {
          latestMarkets: [] as Array<unknown>,
          panels: {
            markets: {
              renderMarkets: (data: Array<unknown>) => marketRenders.push(data.length),
              showConfigError: (message: string) => marketConfigErrors.push(message),
            },
            heatmap: {
              renderHeatmap: (data: Array<unknown>) => heatmapRenders.push(data.length),
              showConfigError: (message: string) => heatmapConfigErrors.push(message),
            },
            commodities: {
              renderCommodities: (data: Array<unknown>) => commoditiesRenders.push(data.length),
              showConfigError: (message: string) => commoditiesConfigErrors.push(message),
              showRetrying: () => {},
            },
            crypto: {
              renderCrypto: (data: Array<unknown>) => cryptoRenders.push(data.length),
              showRetrying: () => {},
            },
          },
          statusPanel: {
            updateApi: (name: string, payload: { status?: string }) => {
              apiStatuses.push({ name, status: payload.status ?? '' });
            },
          },
        },
      };

      try {
        await (DataLoaderManager.prototype as unknown as { loadMarkets: () => Promise<void> })
          .loadMarkets.call(fakeApp);

        // Commodities now go through listMarketQuotes (batch), not individual Yahoo calls
        const marketQuoteCalls = calls.filter((url) =>
          new URL(url).pathname === '/api/market/v1/list-market-quotes'
        );

        return {
          marketRenders,
          marketConfigErrors,
          heatmapRenders,
          heatmapConfigErrors,
          commoditiesRenders,
          commoditiesConfigErrors,
          cryptoRenders,
          apiStatuses,
          latestMarketsCount: fakeApp.ctx.latestMarkets.length,
          marketQuoteCalls: marketQuoteCalls.length,
        };
      } finally {
        window.fetch = originalFetch;
      }
    });

    expect(result.marketRenders.some((count) => count > 0)).toBe(true);
    expect(result.latestMarketsCount).toBeGreaterThan(0);
    expect(result.marketConfigErrors.length).toBe(0);

    expect(result.heatmapRenders.length).toBe(0);
    expect(result.heatmapConfigErrors).toEqual(['FINNHUB_API_KEY not configured — add in Settings']);

    expect(result.commoditiesRenders.some((count) => count > 0)).toBe(true);
    expect(result.commoditiesConfigErrors.length).toBe(0);
    // Commodities go through listMarketQuotes batch (at least 2 calls: stocks + commodities)
    expect(result.marketQuoteCalls).toBeGreaterThanOrEqual(2);

    expect(result.cryptoRenders.some((count) => count > 0)).toBe(true);
    expect(result.apiStatuses.some((entry) => entry.name === 'Finnhub' && entry.status === 'error')).toBe(true);
    expect(result.apiStatuses.some((entry) => entry.name === 'CoinGecko' && entry.status === 'ok')).toBe(true);
  });

  test('fetchHapiSummary maps proto countryCode to iso2 field', async ({ page }) => {
    await page.goto('/tests/runtime-harness.html');

    const result = await page.evaluate(async () => {
      const originalFetch = window.fetch.bind(window);
      const toUrl = (input: RequestInfo | URL): string => {
        if (typeof input === 'string') return new URL(input, window.location.origin).toString();
        if (input instanceof URL) return input.toString();
        return new URL(input.url, window.location.origin).toString();
      };
      const responseJson = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        });

      const seenCountryCodes = new Set<string>();

      window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const parsed = new URL(toUrl(input));
        if (parsed.pathname === '/api/conflict/v1/get-humanitarian-summary') {
          const body = init?.body ? JSON.parse(String(init.body)) : {};
          const countryCode = String(body.countryCode || '').toUpperCase();
          seenCountryCodes.add(countryCode);
          return responseJson({
            summary: {
              countryCode,
              countryName: countryCode,
              conflictEventsTotal: 1,
              conflictPoliticalViolenceEvents: 1,
              conflictFatalities: 1,
              referencePeriod: '2026-02',
              conflictDemonstrations: 0,
              updatedAt: Date.now(),
            },
          });
        }
        return responseJson({});
      }) as typeof window.fetch;

      try {
        const conflict = await import('/src/services/conflict/index.ts');
        const summaries = await conflict.fetchHapiSummary();
        const us = summaries.get('US') as Record<string, unknown> | undefined;
        return {
          fetchedCount: seenCountryCodes.size,
          usIso2: us?.iso2 ?? null,
          hasIso3Field: !!us && Object.hasOwn(us, 'iso3'),
        };
      } finally {
        window.fetch = originalFetch;
      }
    });

    expect(result.fetchedCount).toBeGreaterThan(0);
    expect(result.usIso2).toBe('US');
    expect(result.hasIso3Field).toBe(false);
  });

  test('cloud fallback blocked without WorldMonitor API key', async ({ page }) => {
    await page.goto('/tests/runtime-harness.html');

    const result = await page.evaluate(async () => {
      const runtime = await import('/src/services/runtime.ts');
      const globalWindow = window as unknown as Record<string, unknown>;
      const originalFetch = window.fetch.bind(window);

      const calls: string[] = [];
      const responseJson = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        });

      window.fetch = (async (input: RequestInfo | URL) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
            ? input.toString()
            : input.url;

        calls.push(url);

        if (url.includes('127.0.0.1:46123/api/fred-data')) {
          throw new Error('ECONNREFUSED');
        }
        if (url.includes('worldmonitor.app/api/fred-data')) {
          return responseJson({ observations: [{ value: '999' }] }, 200);
        }
        return responseJson({ ok: true }, 200);
      }) as typeof window.fetch;

      const previousTauri = globalWindow.__TAURI__;
      globalWindow.__TAURI__ = { core: { invoke: () => Promise.resolve(null) } };
      delete globalWindow.__wmFetchPatched;

      try {
        runtime.installRuntimeFetchPatch();

        let fetchError: string | null = null;
        try {
          await window.fetch('/api/fred-data?series_id=CPIAUCSL');
        } catch (err) {
          fetchError = err instanceof Error ? err.message : String(err);
        }

        const cloudCalls = calls.filter(u => u.includes('worldmonitor.app'));

        return {
          fetchError,
          cloudCalls: cloudCalls.length,
          localCalls: calls.filter(u => u.includes('127.0.0.1')).length,
        };
      } finally {
        window.fetch = originalFetch;
        delete globalWindow.__wmFetchPatched;
        if (previousTauri === undefined) {
          delete globalWindow.__TAURI__;
        } else {
          globalWindow.__TAURI__ = previousTauri;
        }
      }
    });

    expect(result.fetchError).not.toBeNull();
    expect(result.cloudCalls).toBe(0);
    expect(result.localCalls).toBeGreaterThan(0);
  });

  test('cloud fallback allowed with valid WorldMonitor API key', async ({ page }) => {
    await page.goto('/tests/runtime-harness.html');

    const result = await page.evaluate(async () => {
      const runtime = await import('/src/services/runtime.ts');
      const runtimeConfig = await import('/src/services/runtime-config.ts');
      const globalWindow = window as unknown as Record<string, unknown>;
      const originalFetch = window.fetch.bind(window);

      const calls: string[] = [];
      const capturedHeaders: Record<string, string> = {};
      const responseJson = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        });

      window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
            ? input.toString()
            : input.url;

        calls.push(url);

        if (url.includes('worldmonitor.app') && init?.headers) {
          const h = new Headers(init.headers);
          const wmKey = h.get('X-WorldMonitor-Key');
          if (wmKey) capturedHeaders['X-WorldMonitor-Key'] = wmKey;
        }

        if (url.includes('127.0.0.1:46123/api/market/v1/test')) {
          throw new Error('ECONNREFUSED');
        }
        if (url.includes('worldmonitor.app/api/market/v1/test')) {
          return responseJson({ quotes: [] }, 200);
        }
        return responseJson({ ok: true }, 200);
      }) as typeof window.fetch;

      const previousTauri = globalWindow.__TAURI__;
      globalWindow.__TAURI__ = { core: { invoke: () => Promise.resolve(null) } };
      delete globalWindow.__wmFetchPatched;

      const testKey = 'wm_test_key_1234567890abcdef';
      await runtimeConfig.setSecretValue('WORLDMONITOR_API_KEY' as import('/src/services/runtime-config.ts').RuntimeSecretKey, testKey);

      try {
        runtime.installRuntimeFetchPatch();

        const response = await window.fetch('/api/market/v1/test');
        const body = await response.json() as { quotes?: unknown[] };

        return {
          status: response.status,
          hasQuotes: Array.isArray(body.quotes),
          cloudCalls: calls.filter(u => u.includes('worldmonitor.app')).length,
          wmKeyHeader: capturedHeaders['X-WorldMonitor-Key'] || null,
        };
      } finally {
        window.fetch = originalFetch;
        delete globalWindow.__wmFetchPatched;
        if (previousTauri === undefined) {
          delete globalWindow.__TAURI__;
        } else {
          globalWindow.__TAURI__ = previousTauri;
        }
        await runtimeConfig.setSecretValue('WORLDMONITOR_API_KEY' as import('/src/services/runtime-config.ts').RuntimeSecretKey, '');
      }
    });

    expect(result.status).toBe(200);
    expect(result.hasQuotes).toBe(true);
    expect(result.cloudCalls).toBe(1);
    expect(result.wmKeyHeader).toBe('wm_test_key_1234567890abcdef');
  });

  test('country-instability HAPI fallback ignores eventsCivilianTargeting in score', async ({ page }) => {
    await page.goto('/tests/runtime-harness.html');

    const result = await page.evaluate(async () => {
      const cii = await import('/src/services/country-instability.ts');

      const makeSummary = (eventsCivilianTargeting: number) => ({
        iso2: 'US',
        locationName: 'United States',
        month: '2026-02',
        eventsTotal: 0,
        eventsPoliticalViolence: 1,
        eventsCivilianTargeting,
        eventsDemonstrations: 0,
        fatalitiesTotalPoliticalViolence: 0,
        fatalitiesTotalCivilianTargeting: 0,
      });

      cii.clearCountryData();
      cii.ingestHapiForCII(new Map([['US', makeSummary(0)]]));
      const scoreWithoutCivilian = cii.getCountryScore('US');

      cii.clearCountryData();
      cii.ingestHapiForCII(new Map([['US', makeSummary(999)]]));
      const scoreWithCivilian = cii.getCountryScore('US');

      return { scoreWithoutCivilian, scoreWithCivilian };
    });

    expect(result.scoreWithoutCivilian).not.toBeNull();
    expect(result.scoreWithCivilian).not.toBeNull();
    expect(result.scoreWithoutCivilian).toBe(result.scoreWithCivilian);
    expect(result.scoreWithCivilian as number).toBeLessThan(10);
  });
});
