import { writeFile } from 'node:fs/promises';
import { expect, type Page, type TestInfo } from '@playwright/test';

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
  settledAt: number;
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
      __wmWebMcpCancellationAbortRequestedAt?: number;
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
    // On the origin-trial build, reading document.modelContext before the
    // registration mark wedges registration. Wait for the page's own mark and
    // touch the provider only once registration has settled.
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
    const abandon = (reason: string): void => {
      if (target.__wmWebMcpCancellationProbeFailure) return;
      target.__wmWebMcpCancellationProbeFailure = reason;
      const failure: Promise<CancellationTerminal> = Promise.reject(new Error(reason));
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
            settledAt: performance.now(),
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
            settledAt: performance.now(),
          }),
        );
        target.__wmWebMcpCancellationTerminal = terminal;
      } catch (error) {
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

export async function runWebMcpCancellationScenario(
  page: Page,
  testInfo: TestInfo,
  options: { deployedSha: string | null; productionSmoke: boolean },
): Promise<void> {
  const { deployedSha, productionSmoke } = options;
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
  const targetCancellationSupported = Boolean(toolStart?.detail?.targetCancellationSupported);
  const abortRequestedAt = await page.evaluate(() => {
    const target = window as Window & {
      __wmWebMcpCancellationAbortRequestedAt?: number;
      __wmWebMcpCancellationController?: AbortController;
    };
    const controller = target.__wmWebMcpCancellationController;
    if (!controller) throw new Error('Cold-start cancellation controller is unavailable.');
    const requestedAt = performance.now();
    target.__wmWebMcpCancellationAbortRequestedAt = requestedAt;
    controller.abort();
    return requestedAt;
  });
  const cancellation = await page.evaluate(async () => {
    const terminal = (window as Window & {
      __wmWebMcpCancellationTerminal?: Promise<CancellationTerminal>;
    }).__wmWebMcpCancellationTerminal;
    if (!terminal) throw new Error('Cold-start cancellation terminal is unavailable.');
    return terminal;
  });

  expect(
    abortRequestedAt,
    'caller abort must occur before terminal settlement; ordinary completion is not cancellation',
  ).toBeLessThan(cancellation.settledAt);

  await waitForUiReadyMark(page);
  let afterMap: { view: string | null; zoom: number | null } | null = null;
  await expect(page.locator('#panelsGrid')).toBeVisible({ timeout: 30_000 });
  const lateLeakWindowMs = 1_500;
  await page.waitForTimeout(lateLeakWindowMs);
  if (!productionSmoke) {
    // Intentional migration canary: Chrome through 151 cannot deliver the
    // target-side signal, so the page still reaches eu/4. A future global/2
    // result must fail this test and trigger a policy review.
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
    cancellationOrder: {
      abortRequestedAt,
      terminalSettledAt: cancellation.settledAt,
    },
    terminal: { ...cancellation, afterMap },
    visibleDashboard: true,
    lateLeakWindowMs,
    pageErrors,
    unhandledRejections,
  });

  expect(cancellation.invokedBeforeUiReady).toBe(true);
  if (cancellation.rejected) {
    expect(
      cancellation.name,
      `a rejected caller terminal must be the abort, not a page-side failure (${cancellation.errorMessage})`,
    ).toBe('AbortError');
  } else {
    expect(cancellation.name, 'a resolved caller terminal carries no error name').toBe('');
    expect(cancellation.output, 'a resolved caller terminal must carry the tool output').toBeTruthy();
    if (productionSmoke) {
      expect(
        cancellation.output,
        'the resolved terminal must be the context snapshot, not a denial',
      ).toMatchObject({ map: expect.any(Object), variant: expect.any(String) });
    } else {
      expect(
        cancellation.output,
        'the resolved terminal must be the applied result, not a denial',
      ).toMatchObject({ ok: true, status: 'applied', actionType: 'set_view' });
    }
  }
  if (!productionSmoke) {
    expect(
      afterMap,
      'an uncancellable set_map_view completes: the accepted phantom completion',
    ).toEqual({ view: 'eu', zoom: 4 });
  }
  expect(pageErrors, 'cancelled execution must not leak an unexpected pageerror').toEqual([]);
  expect(
    unhandledRejections,
    'cancelled execution must not leak an unhandledrejection after the caller settles',
  ).toEqual([]);
}
