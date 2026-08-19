import { expect, test } from '@playwright/test';

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

type ToolExecutionProbe = {
  context: unknown;
  denied: unknown;
};

test.describe('top-level WebMCP dashboard contract', () => {
  test.skip(
    !requireWebMcp,
    'Requires an installed Chrome with WebMCPTesting enabled; normal browser CI stays model-free.',
  );

  test('discovers the inventory and invokes free and denied paths', async ({ browser, page }, testInfo) => {
    const response = await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
    expect(response).not.toBeNull();
    const headers = response!.headers();
    expect(headers['origin-agent-cluster']).toBe('?1');
    expect(headers['permissions-policy']).toContain('tools=(self)');
    if (productionSmoke) expect(headers['origin-trial']).toBeTruthy();

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

    const probe = await page.evaluate(async (): Promise<ToolExecutionProbe> => {
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
      const contextTool = byName.get('get_dashboard_context');
      const panelTool = byName.get('open_dashboard_panel');
      if (!contextTool || !panelTool) throw new Error('Expected dashboard tools were not discovered.');

      const context = parseOutput(await provider.executeTool(contextTool, '{}'));
      const denied = parseOutput(await provider.executeTool(
        panelTool,
        JSON.stringify({ panelId: 'stock-analysis' }),
      ));
      return { context, denied };
    });

    expect(probe.context).toMatchObject({
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
    expect(probe.denied).toMatchObject({
      ok: false,
      status: 'denied',
      reason: 'panel_not_live',
    });

    await testInfo.attach('webmcp-smoke.json', {
      body: JSON.stringify({
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
        calls: {
          success: { tool: 'get_dashboard_context', output: probe.context },
          denied: { tool: 'open_dashboard_panel', output: probe.denied },
        },
      }, null, 2),
      contentType: 'application/json',
    });
  });

  test('cancels a pending browser execution without leaking an unhandled result', async ({ page }, testInfo) => {
    const pageErrors: Array<{ name: string; message: string }> = [];
    page.on('pageerror', (error) => {
      pageErrors.push({ name: error.name, message: error.message.slice(0, 500) });
    });
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

    await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
    await expect.poll(async () => page.evaluate(async () => {
      const provider = document.modelContext;
      if (!provider) return false;
      return (await provider.getTools()).some((tool) => tool.name === 'set_map_view');
    }), { timeout: 60_000 }).toBe(true);

    const cancellation = await page.evaluate(async () => {
      type ExecutableModelContext = WebMCP.ModelContext & {
        executeTool(
          tool: WebMCP.RegisteredTool,
          input: string,
          options?: { signal?: AbortSignal },
        ): Promise<unknown>;
      };

      const provider = document.modelContext as ExecutableModelContext;
      const tool = (await provider.getTools()).find(({ name }) => name === 'set_map_view');
      if (!tool) throw new Error('set_map_view was not discovered.');
      const controller = new AbortController();
      const execution = provider.executeTool(
        tool,
        JSON.stringify({ view: 'eu', zoom: 4 }),
        { signal: controller.signal },
      );
      controller.abort();
      try {
        await execution;
        return { rejected: false, name: '' };
      } catch (error) {
        return {
          rejected: true,
          name: error && typeof error === 'object' && 'name' in error
            ? String(error.name)
            : 'unknown',
        };
      }
    });

    await expect(page.locator('#panelsGrid')).toBeVisible({ timeout: 30_000 });
    // Cancellation can settle the caller before work queued by the provider or
    // dashboard binding runs. Keep the page alive long enough to catch that
    // late rejection/error channel instead of ending the smoke immediately.
    const lateLeakWindowMs = 1_500;
    await page.waitForTimeout(lateLeakWindowMs);
    const unhandledRejections = await page.evaluate(() => (
      (window as Window & {
        __wmWebMcpUnhandledRejections?: Array<{ name: string; message: string }>;
      }).__wmWebMcpUnhandledRejections ?? []
    ));

    await testInfo.attach('webmcp-cancellation.json', {
      body: JSON.stringify({
        target: page.url(),
        deployedSha,
        tool: 'set_map_view',
        terminal: cancellation,
        visibleDashboard: true,
        lateLeakWindowMs,
        pageErrors,
        unhandledRejections,
      }, null, 2),
      contentType: 'application/json',
    });

    expect(cancellation).toEqual({ rejected: true, name: 'AbortError' });
    expect(pageErrors, 'cancelled execution must not leak a pageerror').toEqual([]);
    expect(
      unhandledRejections,
      'cancelled execution must not leak an unhandledrejection after the caller settles',
    ).toEqual([]);
  });
});
