import { writeFile } from 'node:fs/promises';
import { expect, test, type Page, type TestInfo } from '@playwright/test';

const requireWebMcp = process.env.WM_REQUIRE_WEBMCP === '1';
const productionSmoke = process.env.WM_WEBMCP_PRODUCTION === '1';
const deployedSha = process.env.WM_WEBMCP_DEPLOYED_SHA?.trim() || null;

const DASHBOARD_TOOL_NAMES = [
  'get_dashboard_context',
  'openCountryBrief',
  'openSearch',
  'open_dashboard_panel',
  'open_search_result',
  'search_dashboard',
  'set_map_layers',
  'set_map_view',
];
const HOMEPAGE_TOOL_NAMES = [
  'getWorldMonitorMcpEndpoint',
  'launchWorldMonitor',
];
const PRODUCTION_DASHBOARDS = [
  { origin: 'https://www.worldmonitor.app', variant: 'full' },
  { origin: 'https://tech.worldmonitor.app', variant: 'tech' },
  { origin: 'https://finance.worldmonitor.app', variant: 'finance' },
  { origin: 'https://commodity.worldmonitor.app', variant: 'commodity' },
  { origin: 'https://happy.worldmonitor.app', variant: 'happy' },
  { origin: 'https://energy.worldmonitor.app', variant: 'energy' },
] as const;

type MutationExecutionProbe = {
  errorMessage?: string;
  errorName?: string;
  ok: boolean;
  output?: unknown;
};

type ColdStartContextProbe = {
  context: unknown;
  discoveredAt: number;
  invokedBeforeUiReady: boolean;
  settledAt: number;
  targetCancellationSupported: boolean;
  uiReadyAtSettlement: boolean;
};

type ToolStartMark = {
  detail?: {
    targetCancellationSupported?: boolean;
    tool?: string;
  };
  name: string;
  startTime: number;
};

type CancellationTerminal = {
  errorMessage: string;
  invokedBeforeUiReady: boolean;
  name: string;
  rejected: boolean;
};

async function attachJsonEvidence(
  testInfo: TestInfo,
  name: string,
  value: unknown,
): Promise<void> {
  const path = testInfo.outputPath(name);
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await testInfo.attach(name, { path, contentType: 'application/json' });
}

async function installReadinessRecorder(page: Page): Promise<void> {
  await page.addInitScript(() => localStorage.setItem('wm_lcp_debug', '1'));
}

async function installColdStartContextProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type ExecutableModelContext = WebMCP.ModelContext & {
      executeTool(tool: WebMCP.RegisteredTool, input: string): Promise<unknown>;
    };
    type ProbeWindow = Window & {
      __wmLcpDebug?: { getSnapshot?: () => { marks: ToolStartMark[] } };
      __wmWebMcpColdStartContext?: Promise<ColdStartContextProbe>;
    };

    const target = window as ProbeWindow;
    const isUiReady = (): boolean => (
      target.__wmLcpDebug?.getSnapshot?.().marks
        .some((mark) => mark.name === 'wm:boot:webmcp-ui-ready') ?? false
    );
    const parseOutput = (value: unknown): unknown => {
      if (typeof value !== 'string') return value;
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    };

    const probe = new Promise<ColdStartContextProbe>((resolve, reject) => {
      const deadline = performance.now() + 60_000;
      let invocationStarted = false;
      const discoverAndInvoke = async (): Promise<void> => {
        if (invocationStarted) return;
        try {
          const provider = document.modelContext as ExecutableModelContext | undefined;
          if (provider && typeof provider.executeTool === 'function') {
            const tool = (await provider.getTools())
              .find((candidate) => candidate.name === 'get_dashboard_context');
            if (tool) {
              invocationStarted = true;
              const discoveredAt = performance.now();
              const invokedBeforeUiReady = !isUiReady();
              try {
                const context = parseOutput(await provider.executeTool(tool, '{}'));
                resolve({
                  context,
                  discoveredAt,
                  invokedBeforeUiReady,
                  settledAt: performance.now(),
                  targetCancellationSupported: Boolean(
                    target.__wmLcpDebug?.getSnapshot?.().marks
                      .filter((mark) => (
                        mark.name === 'wm:webmcp:tool-start'
                        && mark.detail?.tool === 'get_dashboard_context'
                      ))
                      .at(-1)?.detail?.targetCancellationSupported,
                  ),
                  uiReadyAtSettlement: isUiReady(),
                });
              } catch (error) {
                reject(error);
              }
              return;
            }
          }
        } catch {
          // The experimental provider can reject discovery while it is being
          // initialised. Retry until the bounded page-side deadline.
        }
        if (performance.now() >= deadline) {
          reject(new Error('get_dashboard_context was not discovered within 60000ms.'));
          return;
        }
        setTimeout(() => { void discoverAndInvoke(); }, 5);
      };
      void discoverAndInvoke();
    });
    // Keep a rejection observed until Playwright awaits the retained promise.
    void probe.catch(() => undefined);
    target.__wmWebMcpColdStartContext = probe;
  });
}

async function installColdStartCancellationProbe(
  page: Page,
  toolName: string,
  input: string,
): Promise<void> {
  await page.addInitScript(({ inputJson, name }) => {
    type ExecutableModelContext = WebMCP.ModelContext & {
      executeTool(
        tool: WebMCP.RegisteredTool,
        input: string,
        options?: { signal?: AbortSignal },
      ): Promise<unknown>;
    };
    type ProbeWindow = Window & {
      __wmLcpDebug?: { getSnapshot?: () => { marks: ToolStartMark[] } };
      __wmWebMcpCancellationController?: AbortController;
      __wmWebMcpCancellationTerminal?: Promise<CancellationTerminal>;
    };

    const target = window as ProbeWindow;
    const isUiReady = (): boolean => (
      target.__wmLcpDebug?.getSnapshot?.().marks
        .some((mark) => mark.name === 'wm:boot:webmcp-ui-ready') ?? false
    );
    const deadline = performance.now() + 60_000;
    let invocationStarted = false;
    const discoverAndInvoke = async (): Promise<void> => {
      if (invocationStarted) return;
      try {
        const provider = document.modelContext as ExecutableModelContext | undefined;
        if (provider && typeof provider.executeTool === 'function') {
          const tool = (await provider.getTools()).find((candidate) => candidate.name === name);
          if (tool) {
            invocationStarted = true;
            const controller = new AbortController();
            target.__wmWebMcpCancellationController = controller;
            const invokedBeforeUiReady = !isUiReady();
            const terminal = provider.executeTool(tool, inputJson, { signal: controller.signal }).then(
              () => ({
                errorMessage: '',
                invokedBeforeUiReady,
                name: '',
                rejected: false,
              }),
              (error: unknown) => ({
                errorMessage: error && typeof error === 'object' && 'message' in error
                  ? String(error.message).slice(0, 500)
                  : String(error).slice(0, 500),
                invokedBeforeUiReady,
                name: error && typeof error === 'object' && 'name' in error
                  ? String(error.name)
                  : 'unknown',
                rejected: true,
              }),
            );
            target.__wmWebMcpCancellationTerminal = terminal;
            return;
          }
        }
      } catch {
        // Retry transient discovery failures until the bounded deadline.
      }
      if (performance.now() >= deadline) return;
      setTimeout(() => { void discoverAndInvoke(); }, 5);
    };
    void discoverAndInvoke();
  }, { inputJson: input, name: toolName });
}

async function readToolStartMark(page: Page, toolName: string): Promise<ToolStartMark | null> {
  return page.evaluate((name) => {
    const marks = (window as Window & {
      __wmLcpDebug?: { getSnapshot?: () => { marks: ToolStartMark[] } };
    }).__wmLcpDebug?.getSnapshot?.().marks ?? [];
    return marks.filter((mark) => (
      mark.name === 'wm:webmcp:tool-start' && mark.detail?.tool === name
    )).at(-1) ?? null;
  }, toolName);
}

async function waitForUiReadyMark(page: Page): Promise<void> {
  await expect.poll(async () => page.evaluate(() => {
    const debug = (window as unknown as {
      __wmLcpDebug?: { getSnapshot?: () => { marks: Array<{ name: string }> } };
    }).__wmLcpDebug;
    return debug?.getSnapshot?.().marks
      .some((mark) => mark.name === 'wm:boot:webmcp-ui-ready') ?? false;
  }), {
    message: 'WebMCP calls wait for the exact Phase-4 UI readiness mark',
    timeout: 60_000,
  }).toBe(true);
}

test.describe('top-level WebMCP dashboard contract', () => {
  test.skip(
    !requireWebMcp,
    'Requires an installed Chrome with WebMCPTesting enabled; normal browser CI stays model-free.',
  );

  test('discovers the inventory and invokes free and denied paths', async ({ browser, page }, testInfo) => {
    await installReadinessRecorder(page);
    await installColdStartContextProbe(page);
    const response = await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
    expect(response).not.toBeNull();
    const headers = response!.headers();
    expect(headers['origin-agent-cluster']).toBe('?1');
    expect(headers['permissions-policy']).toContain('tools=(self)');
    if (productionSmoke) expect(headers['origin-trial']).toBeTruthy();

    const coldStart = await page.evaluate(async () => {
      const probe = (window as Window & {
        __wmWebMcpColdStartContext?: Promise<ColdStartContextProbe>;
      }).__wmWebMcpColdStartContext;
      if (!probe) throw new Error('Cold-start WebMCP probe was not installed.');
      return probe;
    });
    expect(
      coldStart.invokedBeforeUiReady,
      'the context tool must be invoked at discovery, before Phase-4 readiness',
    ).toBe(true);
    expect(coldStart.uiReadyAtSettlement).toBe(true);

    await expect.poll(async () => page.evaluate(async () => {
      const provider = document.modelContext;
      if (!provider) return [];
      return (await provider.getTools()).map((tool) => tool.name).sort();
    }), { timeout: 60_000 }).toEqual(DASHBOARD_TOOL_NAMES);

    const discoveredContracts = await page.evaluate(async () => {
      const tools = await document.modelContext!.getTools();
      return tools.map((tool) => ({
        annotations: tool.annotations ?? {},
        description: tool.description,
        name: tool.name,
        schema: tool.inputSchema ? JSON.parse(tool.inputSchema) : null,
        title: tool.title,
      }));
    });
    for (const tool of discoveredContracts) {
      expect(tool.title, `${tool.name} title`).toBeTruthy();
      expect(tool.description.length, `${tool.name} description budget`).toBeLessThanOrEqual(500);
      expect(tool.schema, `${tool.name} schema`).toMatchObject({ type: 'object' });
      expect(tool.annotations.readOnlyHint, `${tool.name} readOnlyHint`).toBe(
        ['get_dashboard_context', 'search_dashboard'].includes(tool.name),
      );
      expect(
        Boolean(tool.annotations.untrustedContentHint),
        `${tool.name} untrustedContentHint`,
      ).toBe(tool.name === 'search_dashboard');
    }

    const panelProbe = await page.evaluate(async (): Promise<MutationExecutionProbe> => {
      type ExecutableModelContext = WebMCP.ModelContext & {
        executeTool(
          tool: WebMCP.RegisteredTool,
          input: string,
          options?: { signal?: AbortSignal },
        ): Promise<unknown>;
      };

      const provider = document.modelContext as ExecutableModelContext | undefined;
      if (!provider || typeof provider.executeTool !== 'function') {
        throw new Error('Chrome WebMCP execution API is unavailable.');
      }
      const parseOutput = (value: unknown): unknown => {
        if (typeof value !== 'string') return value;
        try {
          return JSON.parse(value);
        } catch {
          return value;
        }
      };
      const tools = await provider.getTools();
      const byName = new Map(tools.map((tool) => [tool.name, tool]));
      const panelTool = byName.get('open_dashboard_panel');
      if (!panelTool) throw new Error('Expected dashboard tools were not discovered.');

      try {
        return {
          ok: true,
          output: parseOutput(await provider.executeTool(
            panelTool,
            JSON.stringify({ panelId: 'stock-analysis' }),
          )),
        };
      } catch (error) {
        return {
          errorMessage: error && typeof error === 'object' && 'message' in error
            ? String(error.message).slice(0, 500)
            : String(error).slice(0, 500),
          errorName: error && typeof error === 'object' && 'name' in error
            ? String(error.name)
            : 'unknown',
          ok: false,
        };
      }
    });

    expect(coldStart.context).toMatchObject({
      variant: 'full',
      map: {
        enabledLayers: expect.any(Array),
        view: expect.any(String),
      },
      panels: {
        enabled: expect.any(Array),
        mounted: expect.any(Array),
      },
    });
    if (coldStart.targetCancellationSupported) {
      expect(panelProbe).toMatchObject({
        ok: true,
        output: {
          ok: false,
          status: 'denied',
          reason: 'panel_not_live',
        },
      });
    } else {
      expect(panelProbe.ok).toBe(false);
      expect(panelProbe.errorName).toBe('UnknownError');
      expect(panelProbe.errorMessage).toBeTruthy();
    }

    let visibleMutation: (MutationExecutionProbe & { visible: boolean }) | null = null;
    if (!productionSmoke) {
      const mutation = await page.evaluate(async (): Promise<MutationExecutionProbe> => {
        type ExecutableModelContext = WebMCP.ModelContext & {
          executeTool(tool: WebMCP.RegisteredTool, input: string): Promise<unknown>;
        };
        const provider = document.modelContext as ExecutableModelContext;
        const searchTool = (await provider.getTools())
          .find((tool) => tool.name === 'openSearch');
        if (!searchTool) throw new Error('openSearch was not discovered.');
        try {
          return { ok: true, output: await provider.executeTool(searchTool, '{}') };
        } catch (error) {
          return {
            errorMessage: error && typeof error === 'object' && 'message' in error
              ? String(error.message).slice(0, 500)
              : String(error).slice(0, 500),
            errorName: error && typeof error === 'object' && 'name' in error
              ? String(error.name)
              : 'unknown',
            ok: false,
          };
        }
      });
      if (coldStart.targetCancellationSupported) {
        expect(mutation).toEqual({ ok: true, output: 'Opened search palette.' });
        await expect(page.locator('.search-overlay .search-modal')).toBeVisible();
        visibleMutation = { ...mutation, visible: true };
        await page.keyboard.press('Escape');
        await expect(page.locator('.search-overlay')).toHaveCount(0);
      } else {
        expect(mutation.ok).toBe(false);
        expect(mutation.errorName).toBe('UnknownError');
        expect(mutation.errorMessage).toBeTruthy();
        await expect(page.locator('.search-overlay')).toHaveCount(0);
        visibleMutation = { ...mutation, visible: false };
      }
    }

    await attachJsonEvidence(testInfo, 'webmcp-smoke.json', {
      target: response!.url(),
      deployedSha,
      chromeVersion: browser.version(),
      webMcpApi: 'document.modelContext',
      enablement: productionSmoke ? 'origin-trial' : 'testing-flag',
      headers: {
        originAgentCluster: headers['origin-agent-cluster'] ?? null,
        originTrialPresent: Boolean(headers['origin-trial']),
        permissionsPolicy: headers['permissions-policy'] ?? null,
      },
      toolNames: discoveredContracts.map(({ name }) => name).sort(),
      coldStart: {
        discoveredAt: coldStart.discoveredAt,
        invokedBeforeUiReady: coldStart.invokedBeforeUiReady,
        settledAt: coldStart.settledAt,
        targetCancellationSupported: coldStart.targetCancellationSupported,
        uiReadyAtSettlement: coldStart.uiReadyAtSettlement,
      },
      calls: {
        success: { tool: 'get_dashboard_context', output: coldStart.context },
        denied: {
          tool: 'open_dashboard_panel',
          targetCancellationSupported: coldStart.targetCancellationSupported,
          ...panelProbe,
        },
        ...(visibleMutation ? { visibleMutation: { tool: 'openSearch', ...visibleMutation } } : {}),
      },
    });
  });

  test('cancels a pending browser execution without leaking an unhandled result', async ({ page }, testInfo) => {
    const pageErrors: Array<{ name: string; message: string }> = [];
    page.on('pageerror', (error) => {
      pageErrors.push({ name: error.name, message: error.message.slice(0, 500) });
    });
    const cancelTool = productionSmoke ? 'get_dashboard_context' : 'set_map_view';
    const cancelInput = productionSmoke ? '{}' : JSON.stringify({ view: 'eu', zoom: 4 });
    await installReadinessRecorder(page);
    await installColdStartCancellationProbe(page, cancelTool, cancelInput);
    await page.addInitScript(() => {
      const rejectionLog: Array<{ name: string; message: string }> = [];
      Object.defineProperty(window, '__wmWebMcpUnhandledRejections', {
        configurable: true,
        value: rejectionLog,
      });
      window.addEventListener('unhandledrejection', (event) => {
        if (rejectionLog.length >= 20) return;
        const reason = event.reason;
        let name = typeof reason;
        let message = String(reason);
        try {
          if (reason && (typeof reason === 'object' || typeof reason === 'function')) {
            if ('name' in reason) name = String(reason.name);
            if ('message' in reason) message = String(reason.message);
          }
        } catch {
          name = 'unreadable';
          message = 'Unhandled rejection reason could not be inspected.';
        }
        rejectionLog.push({ name: name.slice(0, 100), message: message.slice(0, 500) });
      });
    });

    await page.goto(
      '/dashboard?lat=0&lon=0&zoom=2&view=global&timeRange=24h&layers=none',
      { waitUntil: 'domcontentloaded' },
    );
    await expect.poll(
      async () => Boolean(await readToolStartMark(page, cancelTool)),
      {
        message: `${cancelTool} callback must enter before the caller aborts`,
        timeout: 60_000,
      },
    ).toBe(true);
    const toolStart = await readToolStartMark(page, cancelTool);
    expect(toolStart).not.toBeNull();
    const targetCancellationSupported = Boolean(
      toolStart?.detail?.targetCancellationSupported,
    );
    const abortCancellation = async (): Promise<void> => page.evaluate(() => {
      const controller = (window as Window & {
        __wmWebMcpCancellationController?: AbortController;
      }).__wmWebMcpCancellationController;
      if (!controller) throw new Error('Cold-start cancellation controller is unavailable.');
      controller.abort();
    });
    const readCancellation = async (): Promise<CancellationTerminal> => page.evaluate(async () => {
      const terminal = (window as Window & {
        __wmWebMcpCancellationTerminal?: Promise<CancellationTerminal>;
      }).__wmWebMcpCancellationTerminal;
      if (!terminal) throw new Error('Cold-start cancellation terminal is unavailable.');
      return terminal;
    });
    let cancellation: CancellationTerminal;
    if (!targetCancellationSupported && !productionSmoke) {
      // The compatibility gate rejects synchronously at callback entry. Read
      // that terminal first so a later caller abort cannot win the host race.
      cancellation = await readCancellation();
      await abortCancellation();
    } else {
      await abortCancellation();
      cancellation = await readCancellation();
    }

    await waitForUiReadyMark(page);
    let afterMap: { view: string | null; zoom: number | null } | null = null;
    await expect(page.locator('#panelsGrid')).toBeVisible({ timeout: 30_000 });
    // Cancellation can settle the caller before work queued by the provider or
    // dashboard binding runs. Keep the page alive long enough to catch that
    // late rejection/error or mutation channel instead of ending the smoke
    // immediately. The authoritative map sample must happen after this window.
    const lateLeakWindowMs = 1_500;
    await page.waitForTimeout(lateLeakWindowMs);
    if (!productionSmoke) {
      await expect.poll(async () => {
        afterMap = await page.evaluate(async () => {
          type ExecutableModelContext = WebMCP.ModelContext & {
            executeTool(tool: WebMCP.RegisteredTool, input: string): Promise<unknown>;
          };
          const provider = document.modelContext as ExecutableModelContext;
          const contextTool = (await provider.getTools())
            .find((tool) => tool.name === 'get_dashboard_context');
          if (!contextTool) throw new Error('get_dashboard_context was not discovered.');
          const raw = await provider.executeTool(contextTool, '{}');
          const context = (typeof raw === 'string' ? JSON.parse(raw) : raw) as {
            map?: { view?: string; zoom?: number };
          };
          return {
            view: context.map?.view ?? null,
            zoom: context.map?.zoom ?? null,
          };
        });
        return afterMap;
      }, { timeout: 30_000 }).toEqual({ view: 'global', zoom: 2 });
    }
    const unhandledRejections = await page.evaluate(() => (
      (window as Window & {
        __wmWebMcpUnhandledRejections?: Array<{ name: string; message: string }>;
      }).__wmWebMcpUnhandledRejections ?? []
    ));

    await attachJsonEvidence(testInfo, 'webmcp-cancellation.json', {
      target: page.url(),
      deployedSha,
      tool: cancelTool,
      callback: {
        invokedBeforeUiReady: cancellation.invokedBeforeUiReady,
        targetCancellationSupported,
        startTime: toolStart?.startTime ?? null,
      },
      terminal: { ...cancellation, afterMap },
      visibleDashboard: true,
      lateLeakWindowMs,
      pageErrors,
      unhandledRejections,
    });

    expect(cancellation.rejected).toBe(true);
    expect(cancellation.invokedBeforeUiReady).toBe(true);
    if (!targetCancellationSupported && !productionSmoke) {
      expect(cancellation.name).toBe('UnknownError');
      expect(cancellation.errorMessage).toBeTruthy();
    } else {
      expect(cancellation.name).toBe('AbortError');
    }
    if (!productionSmoke) {
      expect(afterMap, 'cancelled or refused set_map_view must leave the deep-linked map intact')
        .toEqual({ view: 'global', zoom: 2 });
    }
    const unexpectedPageErrors = !targetCancellationSupported && !productionSmoke
      ? pageErrors.filter((error) => !(
        error.name === 'WebMcpToolError'
        && error.message === 'This browser cannot safely execute dashboard-changing WebMCP tools.'
      ))
      : pageErrors;
    expect(
      unexpectedPageErrors,
      'cancelled execution must not leak an unexpected pageerror',
    ).toEqual([]);
    expect(
      unhandledRejections,
      'cancelled execution must not leak an unhandledrejection after the caller settles',
    ).toEqual([]);
  });

  test('records every production origin and cross-origin embed denial', async ({ browser }, testInfo) => {
    test.skip(!productionSmoke, 'The bounded deployed-origin matrix runs only in production mode.');
    testInfo.setTimeout(180_000);
    const context = await browser.newContext({
      colorScheme: 'dark',
      locale: 'en-US',
      viewport: { width: 1280, height: 720 },
    });
    const page = await context.newPage();
    const dashboards: Array<Record<string, unknown>> = [];

    try {
      for (const target of PRODUCTION_DASHBOARDS) {
        let rootRedirect: {
          location: string | null;
          originTrialPresent: boolean;
          status: number;
        } | null = null;
        if (target.variant !== 'full') {
          const redirect = await context.request.get(`${target.origin}/`, { maxRedirects: 0 });
          const redirectHeaders = redirect.headers();
          expect(redirect.status(), `${target.origin}/ redirect status`).toBe(308);
          expect(redirectHeaders.location, `${target.origin}/ redirect location`).toBe('/dashboard');
          expect(
            redirectHeaders['origin-trial'],
            `${target.origin}/ redirect must not enroll a non-document response`,
          ).toBeUndefined();
          rootRedirect = {
            location: redirectHeaders.location ?? null,
            originTrialPresent: Boolean(redirectHeaders['origin-trial']),
            status: redirect.status(),
          };
        }

        const response = await page.goto(`${target.origin}/dashboard`, {
          waitUntil: 'domcontentloaded',
        });
        expect(response, `${target.origin}/dashboard response`).not.toBeNull();
        expect(response!.status(), `${target.origin}/dashboard status`).toBe(200);
        expect(response!.url(), `${target.origin}/dashboard final URL`).toBe(
          `${target.origin}/dashboard`,
        );
        const headers = response!.headers();
        expect(headers['origin-agent-cluster'], target.origin).toBe('?1');
        expect(headers['origin-trial'], target.origin).toBeTruthy();
        expect(headers['permissions-policy'], target.origin).toContain('tools=(self)');
        await expect.poll(async () => page.evaluate(async () => (
          (await document.modelContext?.getTools())?.map((tool) => tool.name).sort() ?? []
        )), { message: `${target.origin} WebMCP inventory`, timeout: 60_000 }).toEqual(
          DASHBOARD_TOOL_NAMES,
        );
        const state = await page.evaluate(async () => ({
          toolNames: (await document.modelContext!.getTools()).map((tool) => tool.name).sort(),
          variant: document.documentElement.dataset.variant ?? 'full',
        }));
        expect(state.variant, `${target.origin} variant`).toBe(target.variant);
        expect(state.toolNames, `${target.origin} anonymous tool inventory`).toEqual(
          DASHBOARD_TOOL_NAMES,
        );

        const directDocumentUrl = `${target.origin}/dashboard.html`;
        const directDocument = await context.request.get(directDocumentUrl, { maxRedirects: 0 });
        expect(directDocument.status(), `${target.origin}/dashboard.html status`).toBe(200);
        expect(directDocument.url(), `${target.origin}/dashboard.html final URL`).toBe(
          directDocumentUrl,
        );
        const directHeaders = directDocument.headers();
        expect(directHeaders['origin-agent-cluster'], target.origin).toBe('?1');
        expect(directHeaders['origin-trial'], target.origin).toBeTruthy();
        expect(directHeaders['permissions-policy'], target.origin).toContain('tools=(self)');
        dashboards.push({
          ...target,
          rootRedirect,
          dashboard: {
            status: response!.status(),
            url: response!.url(),
            headers: {
              originAgentCluster: headers['origin-agent-cluster'] ?? null,
              originTrialPresent: Boolean(headers['origin-trial']),
              permissionsPolicy: headers['permissions-policy'] ?? null,
            },
            toolNames: state.toolNames,
          },
          directDocument: {
            status: directDocument.status(),
            url: directDocument.url(),
            headers: {
              originAgentCluster: directHeaders['origin-agent-cluster'] ?? null,
              originTrialPresent: Boolean(directHeaders['origin-trial']),
              permissionsPolicy: directHeaders['permissions-policy'] ?? null,
            },
          },
        });
      }

      const homepageResponse = await page.goto('https://www.worldmonitor.app/', {
        waitUntil: 'domcontentloaded',
      });
      expect(homepageResponse).not.toBeNull();
      expect(homepageResponse!.status()).toBe(200);
      expect(homepageResponse!.url()).toBe('https://www.worldmonitor.app/');
      const homepageHeaders = homepageResponse!.headers();
      expect(homepageHeaders['origin-agent-cluster']).toBe('?1');
      expect(homepageHeaders['origin-trial']).toBeTruthy();
      expect(homepageHeaders['permissions-policy']).toContain('tools=(self)');
      await expect.poll(async () => page.evaluate(async () => (
        (await document.modelContext?.getTools())?.map((tool) => tool.name).sort() ?? []
      )), { message: 'canonical homepage WebMCP inventory', timeout: 60_000 }).toEqual(
        HOMEPAGE_TOOL_NAMES,
      );
      const homepageToolNames = await page.evaluate(async () => (
        (await document.modelContext!.getTools()).map((tool) => tool.name).sort()
      ));

      await page.goto('https://www.worldmonitor.app/dashboard', { waitUntil: 'domcontentloaded' });
      await expect.poll(async () => page.evaluate(async () => (
        (await document.modelContext?.getTools())?.map((tool) => tool.name).sort() ?? []
      )), { timeout: 60_000 }).toEqual(DASHBOARD_TOOL_NAMES);
      const embedResponsePromise = page.waitForResponse((response) => (
        response.url() === 'https://tech.worldmonitor.app/embed'
      ));
      await page.evaluate(() => {
        const iframe = document.createElement('iframe');
        iframe.id = 'webmcp-cross-origin-denial';
        iframe.src = 'https://tech.worldmonitor.app/embed';
        document.body.appendChild(iframe);
      });
      const embedResponse = await embedResponsePromise;
      expect(embedResponse.headers()['origin-agent-cluster']).toBe('?1');
      expect(embedResponse.headers()['origin-trial']).toBeUndefined();
      expect(embedResponse.headers()['permissions-policy']).toContain('tools=()');
      await expect.poll(async () => {
        const iframe = await page.locator('#webmcp-cross-origin-denial').elementHandle();
        return (await iframe?.contentFrame())?.url() ?? '';
      }, {
        message: 'cross-origin embed frame attachment',
        timeout: 30_000,
      }).toBe('https://tech.worldmonitor.app/embed');
      const iframe = await page.locator('#webmcp-cross-origin-denial').elementHandle();
      const embedFrame = await iframe?.contentFrame();
      expect(embedFrame).toBeTruthy();
      await embedFrame!.waitForLoadState('domcontentloaded');
      const embedProbe = await embedFrame!.evaluate(async () => {
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
            childCrossOriginToolNames: [] as string[],
            modelContextPresent: false,
            policyAllowsTools,
            registration: 'unavailable' as const,
            toolNames: [] as string[],
          };
        }

        let registration: 'fulfilled' | 'rejected' = 'fulfilled';
        try {
          await provider.registerTool({
            name: 'wmProductionEmbedDeniedProbe',
            description: 'Must never register inside the public World Monitor embed.',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
            execute: () => 'unexpected-success',
          });
        } catch {
          registration = 'rejected';
        }
        const tools = await provider.getTools().catch(() => []);
        const crossOriginTools = await provider.getTools({
          fromOrigins: ['https://www.worldmonitor.app'],
        }).catch(() => []);
        return {
          childCrossOriginToolNames: crossOriginTools.map((tool) => tool.name).sort(),
          modelContextPresent: true,
          policyAllowsTools,
          registration,
          toolNames: tools.map((tool) => tool.name),
        };
      });
      expect(embedProbe.policyAllowsTools).toBe(false);
      expect(embedProbe.registration).not.toBe('fulfilled');
      expect(embedProbe.toolNames).not.toContain('wmProductionEmbedDeniedProbe');
      expect(embedProbe.childCrossOriginToolNames).toEqual([]);
      const parentTools = await page.evaluate(async () => (
        (await document.modelContext!.getTools()).map((tool) => tool.name).sort()
      ));
      expect(parentTools).toEqual(DASHBOARD_TOOL_NAMES);
      const crossOriginTools = await page.evaluate(async (origin) => (
        (await document.modelContext!.getTools({ fromOrigins: [origin] }))
          .map((tool) => tool.name)
          .sort()
      ), 'https://tech.worldmonitor.app');
      expect(crossOriginTools).toEqual(parentTools);
      expect(crossOriginTools).not.toContain('wmProductionEmbedDeniedProbe');

      await attachJsonEvidence(testInfo, 'webmcp-production-matrix.json', {
        deployedSha,
        dashboards,
        homepage: {
          origin: 'https://www.worldmonitor.app',
          status: homepageResponse!.status(),
          url: homepageResponse!.url(),
          headers: {
            originAgentCluster: homepageHeaders['origin-agent-cluster'] ?? null,
            originTrialPresent: Boolean(homepageHeaders['origin-trial']),
            permissionsPolicy: homepageHeaders['permissions-policy'] ?? null,
          },
          toolNames: homepageToolNames,
        },
        crossOriginEmbed: {
          origin: 'https://tech.worldmonitor.app',
          path: '/embed',
          originAgentCluster: embedResponse.headers()['origin-agent-cluster'] ?? null,
          originTrialPresent: Boolean(embedResponse.headers()['origin-trial']),
          permissionsPolicy: embedResponse.headers()['permissions-policy'] ?? null,
          ...embedProbe,
          parentFromOriginsToolNames: crossOriginTools,
          parentToolNames: parentTools,
        },
      });
    } finally {
      await context.close();
    }
  });
});
