import { writeFile } from 'node:fs/promises';
import { expect, test, type Page, type TestInfo } from '@playwright/test';

import { runWebMcpCancellationScenario } from './helpers/webmcp-cancellation';

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
  'set_panel_enabled',
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

    // On Chrome's origin-trial build, touching document.modelContext before
    // the page finishes registering wedges the registration itself: the tools
    // never appear and every later getTools() hangs. So the probe waits on the
    // page's own registration mark — which touches nothing — and only then
    // reads the provider, once.
    //
    // The page emits a separate mark for the zero-tool pass. Registration is
    // over in that case too, so treat it as settled rather than spinning to the
    // deadline and reporting a generic timeout for a definite outcome.
    const registrationSettled = (): boolean => {
      const marks = target.__wmLcpDebug?.getSnapshot?.().marks ?? [];
      return marks.some((mark) => (
        mark.name === 'wm:webmcp:registered'
        || mark.name === 'wm:webmcp:registration-empty'
      ));
    };
    const withTimeout = async <T>(work: Promise<T>, ms: number, label: string): Promise<T> => (
      await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error(`${label} did not settle within ${ms}ms.`)), ms);
        }),
      ])
    );

    const probe = new Promise<ColdStartContextProbe>((resolve, reject) => {
      const deadline = performance.now() + 60_000;

      // Runs exactly once, after registration settled. Every exit path either
      // resolves or throws, so no retry can ever race back ahead of the mark:
      // ANY read of document.modelContext taken before the page's registration
      // mark wedges registration itself, whatever that read returns. A
      // getTools() that resolves empty is one symptom of that, not the cause.
      const readInventoryOnce = async (provider: ExecutableModelContext): Promise<void> => {
        const tools = await withTimeout(provider.getTools(), 15_000, 'getTools()');
        const tool = tools.find((candidate) => candidate.name === 'get_dashboard_context');
        if (!tool) {
          const names = tools.map((candidate) => candidate.name).join(', ') || 'empty inventory';
          throw new Error(`get_dashboard_context absent after registration settled (${names}).`);
        }
        const discoveredAt = performance.now();
        const invokedBeforeUiReady = !isUiReady();
        const context = parseOutput(
          await withTimeout(provider.executeTool(tool, '{}'), 30_000, 'executeTool()'),
        );
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
      };

      const awaitRegistration = (): void => {
        // Do NOT read document.modelContext before the mark. On the
        // origin-trial build, a single read taken before the page finishes
        // registering wedges the registration itself — the tools never appear
        // and every later getTools() hangs. The mark comes from the page's own
        // instrumentation and touches nothing.
        if (registrationSettled()) {
          const provider = document.modelContext as ExecutableModelContext | undefined;
          if (provider && typeof provider.executeTool === 'function') {
            void readInventoryOnce(provider).catch(reject);
            return;
          }
          reject(new Error('WebMCP provider is unusable after registration settled.'));
          return;
        }
        if (performance.now() >= deadline) {
          reject(new Error('WebMCP registration did not settle within 60000ms.'));
          return;
        }
        setTimeout(awaitRegistration, 5);
      };
      awaitRegistration();
    });
    // Keep a rejection observed until Playwright awaits the retained promise.
    void probe.catch(() => undefined);
    target.__wmWebMcpColdStartContext = probe;
  });
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
    // Dashboard-changing tools now run whether or not the browser delivers a
    // target-side signal, so the outcome is the real application one on every
    // build — no compatibility branch.
    expect(panelProbe).toMatchObject({
      ok: true,
      output: {
        ok: false,
        status: 'denied',
        reason: 'panel_not_live',
      },
    });

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
          const raw = await provider.executeTool(searchTool, '{}');
          let output = raw;
          if (typeof raw === 'string') {
            try {
              output = JSON.parse(raw);
            } catch {
              // Preserve non-JSON provider output for the assertion below.
            }
          }
          return { ok: true, output };
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
      // The palette opens on every build now, not only on one that delivers a
      // target-side signal.
      expect(mutation).toEqual({ ok: true, output: 'Opened search palette.' });
      await expect(page.locator('.search-overlay .search-modal')).toBeVisible();
      visibleMutation = { ...mutation, visible: true };
      await page.keyboard.press('Escape');
      await expect(page.locator('.search-overlay')).toHaveCount(0);
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

  test('persists set_panel_enabled in dashboard settings across reload', async ({ page }) => {
    test.skip(productionSmoke, 'Must not mutate production panel settings.');
    const response = await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
    expect(response).not.toBeNull();
    await expect.poll(async () => page.evaluate(async () => (
      (await document.modelContext?.getTools())?.map((tool) => tool.name).sort() ?? []
    )), { timeout: 60_000 }).toEqual(DASHBOARD_TOOL_NAMES);

    const first = await page.evaluate(async () => {
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
      const tool = (await provider.getTools()).find((candidate) => candidate.name === 'set_panel_enabled');
      if (!tool) throw new Error('set_panel_enabled was not discovered.');
      const execute = async (input: { panelId: string; enabled: boolean }) => {
        const controller = new AbortController();
        return parseOutput(await provider.executeTool(
          tool,
          JSON.stringify(input),
          { signal: controller.signal },
        ));
      };
      // Default full layouts already sit at the free-tier counted cap, so
      // enabling a disabled catalog panel first needs a counted slot freed.
      const disableMarkets = await execute({ panelId: 'markets', enabled: false });
      if (
        disableMarkets
        && typeof disableMarkets === 'object'
        && (disableMarkets as { reason?: string }).reason === 'target_cancellation_unsupported'
      ) {
        return {
          output: disableMarkets,
          stored: window.localStorage.getItem('worldmonitor-panels'),
        };
      }
      const enableGiving = await execute({ panelId: 'giving', enabled: true });
      let openGiving: unknown = null;
      if (
        enableGiving
        && typeof enableGiving === 'object'
        && (enableGiving as { ok?: boolean }).ok === true
      ) {
        const openTool = (await provider.getTools())
          .find((candidate) => candidate.name === 'open_dashboard_panel');
        if (!openTool) throw new Error('open_dashboard_panel was not discovered.');
        const controller = new AbortController();
        openGiving = parseOutput(await provider.executeTool(
          openTool,
          JSON.stringify({ panelId: 'giving' }),
          { signal: controller.signal },
        ));
      }
      return {
        output: enableGiving,
        openOutput: openGiving,
        stored: window.localStorage.getItem('worldmonitor-panels'),
      };
    });

    const output = first.output as {
      ok?: boolean;
      reason?: string;
      effectiveEnabled?: boolean;
      changed?: boolean;
    };
    if (output?.reason === 'target_cancellation_unsupported') {
      test.skip(true, 'Host omitted the target-side AbortSignal; persist proof requires cancellation.');
    }

    expect(output).toMatchObject({
      ok: true,
      status: 'applied',
      panelId: 'giving',
      requestedEnabled: true,
      effectiveEnabled: true,
    });
    expect(first.openOutput).toMatchObject({
      ok: true,
      status: 'applied',
    });
    const storedBeforeReload = JSON.parse(String(first.stored)) as Record<string, { enabled?: boolean }>;
    expect(storedBeforeReload.giving?.enabled).toBe(true);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect.poll(async () => page.evaluate(async () => (
      (await document.modelContext?.getTools())?.some((tool) => tool.name === 'get_dashboard_context') ?? false
    )), { timeout: 60_000 }).toBe(true);

    const afterReload = await page.evaluate(async () => {
      type ExecutableModelContext = WebMCP.ModelContext & {
        executeTool(tool: WebMCP.RegisteredTool, input: string): Promise<unknown>;
      };
      const provider = document.modelContext as ExecutableModelContext;
      const contextTool = (await provider.getTools())
        .find((tool) => tool.name === 'get_dashboard_context');
      if (!contextTool) throw new Error('get_dashboard_context was not discovered.');
      const raw = await provider.executeTool(contextTool, '{}');
      let context = raw;
      if (typeof raw === 'string') {
        try {
          context = JSON.parse(raw);
        } catch {
          // Preserve non-JSON provider output.
        }
      }
      return {
        context,
        stored: window.localStorage.getItem('worldmonitor-panels'),
      };
    });
    const storedAfterReload = JSON.parse(String(afterReload.stored)) as Record<string, { enabled?: boolean }>;
    expect(storedAfterReload.giving?.enabled).toBe(true);
    const enabledPanels = (afterReload.context as { panels?: { enabled?: string[] } })
      .panels?.enabled ?? [];
    expect(enabledPanels).toContain('giving');
  });

  // Production collection is intentionally restricted to this spec. Keep a
  // read-only wrapper here while the focused local scenario lives in
  // webmcp-cancellation.spec.ts.
  if (productionSmoke) {
    test('completes page work after a caller-side cancel without leaking an unhandled result', async ({ page }, testInfo) => {
      await runWebMcpCancellationScenario(page, testInfo, { deployedSha, productionSmoke });
    });
  }

  test('records every production origin and cross-origin embed denial', async ({ browser }, testInfo) => {
    test.skip(!productionSmoke, 'The bounded deployed-origin matrix runs only in production mode.');
    const expectedDeployedSha = deployedSha;
    expect(expectedDeployedSha).toMatch(/^[0-9a-f]{40}$/i);
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

        const buildHashResponse = await context.request.get(
          `${target.origin}/build-hash.txt?wm_webmcp_evidence=${expectedDeployedSha}`,
          { headers: { 'cache-control': 'no-cache' } },
        );
        expect(buildHashResponse.status(), `${target.origin} build hash status`).toBe(200);
        const servedSha = (await buildHashResponse.text()).trim();
        expect(servedSha, `${target.origin} served SHA`).toBe(expectedDeployedSha);

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
          servedSha,
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
