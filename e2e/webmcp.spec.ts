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
  output?: unknown;
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
      __wmWebMcpCancellationProbeFailure?: string;
      __wmWebMcpCancellationTerminal?: Promise<CancellationTerminal>;
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
    // Same rule as the cold-start context probe: poll the page's registration
    // mark and touch nothing on document.modelContext until it fires. ANY read
    // of document.modelContext taken before the page finishes registering
    // wedges registration itself on the origin-trial build, whatever that read
    // returns — an empty getTools() is one symptom of the wedge, not its cause.
    //
    // The zero-tool pass gets its own mark. Registration is over in that case
    // too, so count it as settled and let the missing-tool path below name the
    // failure instead of burning the deadline on a generic timeout.
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
        new Promise<never>((_, rejectWork) => {
          setTimeout(() => rejectWork(new Error(`${label} did not settle within ${ms}ms.`)), ms);
        }),
      ])
    );
    // Every abandoning path names itself. Leaving the terminal unset makes the
    // test report the generic 'terminal is unavailable', which describes the
    // symptom and hides the cause.
    const abandon = (reason: string): void => {
      if (target.__wmWebMcpCancellationProbeFailure) return;
      target.__wmWebMcpCancellationProbeFailure = reason;
      const failure: Promise<CancellationTerminal> = Promise.reject(new Error(reason));
      // Keep the rejection observed until Playwright awaits the retained promise.
      void failure.catch(() => undefined);
      target.__wmWebMcpCancellationTerminal = failure;
    };
    const deadline = performance.now() + 60_000;
    let invocationStarted = false;
    const discoverAndInvoke = async (): Promise<void> => {
      if (invocationStarted) return;
      try {
        if (!registrationSettled()) {
          if (performance.now() < deadline) {
            setTimeout(() => { void discoverAndInvoke(); }, 5);
            return;
          }
          abandon('WebMCP registration did not settle within 60000ms.');
          return;
        }
        const provider = document.modelContext as ExecutableModelContext | undefined;
        if (!provider || typeof provider.executeTool !== 'function') {
          abandon('WebMCP provider is unusable after registration settled.');
          return;
        }
        invocationStarted = true;
        const tool = (await withTimeout(provider.getTools(), 15_000, 'getTools()'))
          .find((candidate) => candidate.name === name);
        if (!tool) {
          abandon(`${name} was not registered after registration settled.`);
          return;
        }
        const controller = new AbortController();
        target.__wmWebMcpCancellationController = controller;
        const invokedBeforeUiReady = !isUiReady();
        // Bound the invocation too, not only discovery: an unbounded await on a
        // wedged binding would consume the whole Playwright timeout and report
        // nothing about where it hung.
        const terminal = withTimeout(
          provider.executeTool(tool, inputJson, { signal: controller.signal }),
          30_000,
          'executeTool()',
        ).then(
          (output) => ({
            errorMessage: '',
            invokedBeforeUiReady,
            name: '',
            output: parseOutput(output),
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
      } catch (error) {
        // Discovery is committed once registration settled, so a failure here
        // is terminal.
        abandon(
          error && typeof error === 'object' && 'message' in error
            ? String(error.message).slice(0, 500)
            : String(error).slice(0, 500),
        );
      }
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

  test('completes page work after a caller-side cancel without leaking an unhandled result', async ({ page }, testInfo) => {
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
    // Report the probe's own abandon reason instead of a bare "never entered":
    // a wedged getTools() and an unregistered tool are different failures and
    // the boolean form of this poll erased both.
    await expect.poll(
      async () => {
        const failure = await page.evaluate(() => (
          (window as Window & { __wmWebMcpCancellationProbeFailure?: string })
            .__wmWebMcpCancellationProbeFailure ?? null
        ));
        if (failure) return failure;
        return await readToolStartMark(page, cancelTool) ? 'entered' : 'pending';
      },
      {
        message: `${cancelTool} callback must enter before the caller aborts`,
        timeout: 60_000,
      },
    ).toBe('entered');
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
    // Abort FIRST, always. Reading the terminal before aborting waits for the
    // invocation to complete, which is not a cancellation at all — every
    // assertion downstream would then be satisfied by an ordinary un-aborted
    // run. There is no build where reading first is correct: set_map_view now
    // runs on every build and parks awaiting UI readiness, so the abort has a
    // live invocation to race on the local path exactly as it does in
    // production.
    await abortCancellation();
    const cancellation = await readCancellation();

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
      // THE ACCEPTED TRADE-OFF, asserted so it stays deliberate.
      //
      // Chrome through 151 cannot forward cancellation into the page, so the
      // cancelled set_map_view finishes anyway and the map really does land on
      // eu/4 — a phantom completion. We take that over refusing to run 6 of 8
      // tools, because the effect is visible on the person's own screen and
      // they can move the map back by hand.
      //
      // If a browser starts delivering the target-side signal, the cancelled
      // work stops and this flips back to global/2. That failure is the signal
      // to re-tighten the policy, not a value to paper over.
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
      }, { timeout: 30_000 }).toEqual({ view: 'eu', zoom: 4 });
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

    expect(cancellation.invokedBeforeUiReady).toBe(true);
    // Chrome rejects the CALLER on abort but cannot tell the page, so which
    // terminal the caller sees is a race: `AbortError` when the abort lands
    // while the callback is still parked, the tool's own result when the
    // callback finished first. Both are real, so do not pin one — pinning it
    // makes this test flaky on timing rather than on behaviour.
    //
    // Accepting either NAME on its own is too weak: a re-introduced
    // compatibility denial resolves with name '' and would slip through. Pin
    // the joint invariant instead — each terminal must be internally
    // consistent, and a resolved terminal must carry the tool's real applied
    // output, never a denial.
    if (cancellation.rejected) {
      expect(
        cancellation.name,
        `a rejected caller terminal must be the abort, not a page-side failure (${cancellation.errorMessage})`,
      ).toBe('AbortError');
    } else {
      expect(
        cancellation.name,
        'a resolved caller terminal carries no error name',
      ).toBe('');
      expect(
        cancellation.output,
        'a resolved caller terminal must carry the tool output',
      ).toBeTruthy();
      if (productionSmoke) {
        // get_dashboard_context resolved: the real snapshot, not a denial.
        expect(
          cancellation.output,
          'the resolved terminal must be the context snapshot, not a denial',
        ).toMatchObject({ map: expect.any(Object), variant: expect.any(String) });
      } else {
        // set_map_view resolved: the APPLIED action result. A compatibility
        // denial ({ ok: false, status: 'denied' }) fails here by construction,
        // which is the whole point — it means the tool never ran.
        expect(
          cancellation.output,
          'the resolved terminal must be the applied result, not a denial',
        ).toMatchObject({ ok: true, status: 'applied', actionType: 'set_view' });
      }
    }
    // The invariant that actually matters, asserted either way below: the page
    // work completes. That is the phantom completion this policy accepts.
    if (!productionSmoke) {
      expect(
        afterMap,
        'an uncancellable set_map_view completes: the accepted phantom completion',
      ).toEqual({ view: 'eu', zoom: 4 });
    }
    expect(
      pageErrors,
      'cancelled execution must not leak an unexpected pageerror',
    ).toEqual([]);
    expect(
      unhandledRejections,
      'cancelled execution must not leak an unhandledrejection after the caller settles',
    ).toEqual([]);
  });

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
