import { writeFile } from 'node:fs/promises';
import { expect, test, type Page, type TestInfo } from '@playwright/test';

import { runWebMcpCancellationScenario } from './helpers/webmcp-cancellation';

const requireWebMcp = process.env.WM_REQUIRE_WEBMCP === '1';
const productionSmoke = process.env.WM_WEBMCP_PRODUCTION === '1';
const deployedSha = process.env.WM_WEBMCP_DEPLOYED_SHA?.trim() || null;

const DASHBOARD_TOOL_NAMES = [
  'apply_mission_preset',
  'create_dashboard_tab',
  'delete_dashboard_tab',
  'focus_country',
  'get_access_context',
  'get_dashboard_context',
  'get_panel_layout',
  'list_dashboard_panels',
  'list_dashboard_tabs',
  'list_map_layers',
  'list_mission_presets',
  'move_panel',
  'openCountryBrief',
  'openSearch',
  'open_alerts',
  'open_dashboard_panel',
  'open_mission_picker',
  'open_search_result',
  'open_settings',
  'open_sign_in',
  'rename_dashboard_tab',
  'search_dashboard',
  'select_dashboard_tab',
  'set_map_layers',
  'set_map_mode',
  'set_map_view',
  'set_panel_collapsed',
  'set_panel_enabled',
  'set_panel_fullscreen',
  'set_time_range',
  'switch_monitor',
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

type DashboardPanelCatalogProbe = {
  disabledCount: number;
  pages: number;
  reasons: Record<string, number>;
  total: number;
  uniqueCount: number;
};

type PanelLayoutEntryProbe = {
  collapsed: boolean;
  collapsible: boolean;
  fixed: boolean;
  fullscreen: boolean;
  fullscreenCapable: boolean;
  id: string;
  index: number;
  region: 'sidebar' | 'bottom';
};

type PanelLayoutSnapshotProbe = {
  nextCursor?: string;
  panelCount: number;
  panels: PanelLayoutEntryProbe[];
  panelsTruncated?: boolean;
  regions: {
    bottom: { available: boolean; panelCount: number };
    sidebar: { available: boolean; panelCount: number };
  };
};

type VisiblePanelLayoutProbe = {
  collapsed: boolean;
  fullscreen: boolean;
  id: string;
  index: number;
  region: 'sidebar' | 'bottom';
};

type ToolStartMark = {
  detail?: {
    targetCancellationSupported?: boolean;
    tool?: string;
  };
  name: string;
  startTime: number;
};

type MapLayerListResult = {
  count: number;
  layers: Array<{ available?: boolean; id: string; reason?: string }>;
  nextCursor?: string;
  ok: boolean;
  total: number;
};

function assertMapLayerListResult(listed: unknown, label: string): MapLayerListResult {
  expect(listed, label).toMatchObject({
    ok: true,
    layers: expect.any(Array),
  });
  const result = listed as MapLayerListResult;
  expect(result.layers.length, `${label} layers`).toBeGreaterThan(0);
  if (result.count < result.total) {
    expect(result.nextCursor, `${label} nextCursor`).toBe(
      result.layers[result.layers.length - 1]?.id,
    );
  }
  return result;
}

async function executeListMapLayers(page: Page): Promise<unknown> {
  return page.evaluate(async (): Promise<unknown> => {
    type ExecutableModelContext = WebMCP.ModelContext & {
      executeTool(tool: WebMCP.RegisteredTool, input: string): Promise<unknown>;
    };
    const parseOutput = (value: unknown): unknown => {
      if (typeof value !== 'string') return value;
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    };
    const provider = document.modelContext as ExecutableModelContext;
    const listTool = (await provider.getTools()).find((tool) => tool.name === 'list_map_layers');
    if (!listTool) throw new Error('list_map_layers was not discovered.');
    return parseOutput(await provider.executeTool(listTool, JSON.stringify({ limit: 8 })));
  });
}

async function attachJsonEvidence(
  testInfo: TestInfo,
  name: string,
  value: unknown,
): Promise<void> {
  const path = testInfo.outputPath(name);
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await testInfo.attach(name, { path, contentType: 'application/json' });
}

async function executeDashboardTool(
  page: Page,
  name: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  return page.evaluate(async ({ toolName, payload }) => {
    type ExecutableModelContext = WebMCP.ModelContext & {
      executeTool(tool: WebMCP.RegisteredTool, input: string): Promise<unknown>;
    };
    const provider = document.modelContext as ExecutableModelContext | undefined;
    if (!provider || typeof provider.executeTool !== 'function') {
      throw new Error('Chrome WebMCP execution API is unavailable.');
    }
    const tool = (await provider.getTools()).find((candidate) => candidate.name === toolName);
    if (!tool) throw new Error(`${toolName} was not discovered.`);
    const raw = await provider.executeTool(tool, JSON.stringify(payload));
    if (typeof raw !== 'string') return raw;
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }, { toolName: name, payload: input });
}

async function installReadinessRecorder(page: Page): Promise<void> {
  await page.addInitScript(() => localStorage.setItem('wm_lcp_debug', '1'));
}

async function installSignalCapableModelContext(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type ToolDefinition = {
      annotations?: Record<string, unknown>;
      description: string;
      execute: (args: Record<string, unknown>, extra?: { signal?: AbortSignal }) => unknown;
      inputSchema: Record<string, unknown>;
      name: string;
      title?: string;
    };
    type ToolDescriptor = {
      annotations?: Record<string, unknown>;
      description: string;
      inputSchema: string;
      name: string;
      title?: string;
    };
    const tools = new Map<string, { definition: ToolDefinition; descriptor: ToolDescriptor }>();
    const provider = {
      registerTool(definition: ToolDefinition, options: { signal?: AbortSignal } = {}) {
        const descriptor: ToolDescriptor = Object.freeze({
          annotations: definition.annotations,
          description: definition.description,
          inputSchema: JSON.stringify(definition.inputSchema),
          name: definition.name,
          title: definition.title,
        });
        tools.set(definition.name, { definition, descriptor });
        options.signal?.addEventListener('abort', () => tools.delete(definition.name), { once: true });
        return Promise.resolve();
      },
      async getTools() {
        return [...tools.values()]
          .map(({ descriptor }) => descriptor)
          .sort((left, right) => left.name.localeCompare(right.name));
      },
      async executeTool(descriptor: ToolDescriptor, input: string) {
        const entry = tools.get(descriptor.name);
        if (!entry || entry.descriptor !== descriptor) {
          throw new DOMException('Tool descriptor is stale or foreign.', 'InvalidStateError');
        }
        return entry.definition.execute(JSON.parse(input), {
          signal: new AbortController().signal,
        });
      },
    };
    Object.defineProperty(document, 'modelContext', {
      configurable: true,
      value: provider,
    });
  });
}

async function dismissMissionPreset(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem('worldmonitor-mission-preset-dismissed-v1', '1');
  });
}

async function closeMissionPresetIfOpen(page: Page): Promise<void> {
  const closeButton = page.locator('.mission-preset-popover [data-mission-close]');
  if (await closeButton.isVisible({ timeout: 1_000 }).catch(() => false)) {
    await closeButton.click({ force: true });
    await expect(page.locator('.mission-preset-popover')).toBeHidden({ timeout: 5_000 });
  }
}

test('persists a first-session panel move through reload', async ({ page }) => {
  await dismissMissionPreset(page);
  await installSignalCapableModelContext(page);
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
  await waitForDashboardTools(page);
  await expect(page.locator(
    '#panelsGrid > .panel[data-panel="live-news"]:not([data-deferred-panel])',
  )).toBeVisible({ timeout: 60_000 });

  const initial = await readFullPanelLayout(page);
  const liveNews = initial.panels.find((panel) => panel.id === 'live-news');
  const insights = initial.panels.find((panel) => panel.id === 'insights');
  expect(liveNews).toMatchObject({ region: 'sidebar' });
  expect(insights).toMatchObject({ region: 'sidebar' });
  const targetIndex = (insights?.index ?? 0)
    + ((liveNews?.index ?? 0) < (insights?.index ?? 0) ? 0 : 1);

  await expect(executeDashboardTool(page, 'move_panel', {
    panelId: 'live-news',
    region: 'sidebar',
    index: targetIndex,
  })).resolves.toMatchObject({ ok: true, persisted: true });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForDashboardTools(page);

  const restored = await readFullPanelLayout(page);
  const restoredLiveNews = restored.panels.find((panel) => panel.id === 'live-news');
  const restoredInsights = restored.panels.find((panel) => panel.id === 'insights');
  expect(restoredLiveNews?.index).toBe((restoredInsights?.index ?? -1) + 1);
});

async function executeDashboardTabTool(
  page: Page,
  name: string,
  input: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  return page.evaluate(async ({ name, input }) => {
    type ExecutableModelContext = WebMCP.ModelContext & {
      executeTool(tool: WebMCP.RegisteredTool, input: string): Promise<unknown>;
    };
    const provider = document.modelContext as ExecutableModelContext;
    const tool = (await provider.getTools()).find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`${name} was not discovered.`);
    const raw = await provider.executeTool(tool, JSON.stringify(input));
    const parsed = typeof raw === 'string' ? JSON.parse(raw) as unknown : raw;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${name} returned a non-object result.`);
    }
    return parsed as Record<string, unknown>;
  }, { name, input });
}

async function waitForDashboardTools(page: Page): Promise<void> {
  await expect.poll(async () => page.evaluate(async () => {
    const provider = document.modelContext;
    if (!provider) return [];
    return (await provider.getTools()).map((tool) => tool.name).sort();
  }), { timeout: 60_000 }).toEqual(DASHBOARD_TOOL_NAMES);
}

async function executeDashboardToolProbe(
  page: Page,
  name: string,
  input: Record<string, unknown>,
): Promise<MutationExecutionProbe> {
  return page.evaluate(async ({ toolName, inputJson }) => {
    type ExecutableModelContext = WebMCP.ModelContext & {
      executeTool(tool: WebMCP.RegisteredTool, input: string): Promise<unknown>;
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
    const tool = (await provider.getTools()).find((candidate) => candidate.name === toolName);
    if (!tool) throw new Error(`${toolName} was not discovered.`);
    try {
      return { ok: true, output: parseOutput(await provider.executeTool(tool, inputJson)) };
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
  }, { toolName: name, inputJson: JSON.stringify(input) });
}

async function storedMapMode(page: Page): Promise<string | null> {
  const raw = await page.evaluate(() => localStorage.getItem('worldmonitor-map-mode'));
  if (raw == null) return null;
  return JSON.parse(raw) as string;
}

async function executeDashboardToolWithCallerSignal(
  page: Page,
  name: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  return page.evaluate(async ({ toolName, payload }) => {
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
    const tool = (await provider.getTools()).find((candidate) => candidate.name === toolName);
    if (!tool) throw new Error(`${toolName} was not discovered.`);
    const controller = new AbortController();
    return parseOutput(await provider.executeTool(
      tool,
      JSON.stringify(payload),
      { signal: controller.signal },
    ));
  }, { toolName: name, payload: input });
}

function isPanelLayoutSnapshot(value: unknown): value is PanelLayoutSnapshotProbe {
  return Boolean(
    value
    && typeof value === 'object'
    && Array.isArray((value as PanelLayoutSnapshotProbe).panels)
    && (value as PanelLayoutSnapshotProbe).regions
    && typeof (value as PanelLayoutSnapshotProbe).panelCount === 'number',
  );
}

async function readFullPanelLayout(page: Page): Promise<PanelLayoutSnapshotProbe> {
  const panels: PanelLayoutEntryProbe[] = [];
  let cursor: string | undefined;
  let latest: PanelLayoutSnapshotProbe | null = null;
  let pages = 0;
  for (; pages < 80; pages += 1) {
    const raw = await executeDashboardTool(
      page,
      'get_panel_layout',
      cursor ? { cursor } : {},
    );
    if (!isPanelLayoutSnapshot(raw)) {
      throw new Error('get_panel_layout returned a non-layout result.');
    }
    latest = raw;
    for (const panel of raw.panels) {
      if (panels.some((existing) => existing.id === panel.id)) {
        throw new Error(`get_panel_layout repeated panel ${panel.id}.`);
      }
      panels.push(panel);
    }
    if (raw.panelsTruncated !== true) break;
    if (typeof raw.nextCursor !== 'string' || raw.nextCursor.length === 0) {
      throw new Error('Paginated get_panel_layout is missing its next cursor.');
    }
    cursor = raw.nextCursor;
  }
  if (!latest) throw new Error('get_panel_layout did not return a layout page.');
  if (pages >= 80) throw new Error('get_panel_layout pagination did not terminate.');
  return { ...latest, panels, panelCount: latest.panelCount };
}

async function readVisiblePanelLayout(
  page: Page,
  includeBottom: boolean,
): Promise<VisiblePanelLayoutProbe[]> {
  return page.evaluate((readBottom) => {
    const collect = (
      gridId: string,
      region: 'sidebar' | 'bottom',
    ): VisiblePanelLayoutProbe[] => {
      const grid = document.getElementById(gridId);
      if (!grid) return [];
      const panels: VisiblePanelLayoutProbe[] = [];
      let index = 0;
      for (const child of Array.from(grid.children)) {
        if (!(child instanceof HTMLElement) || !child.classList.contains('panel')) continue;
        const id = child.dataset.panel;
        if (!id) continue;
        panels.push({
          collapsed: child.classList.contains('panel-collapsed'),
          fullscreen: child.classList.contains('live-news-fullscreen'),
          id,
          index,
          region,
        });
        index += 1;
      }
      return panels;
    };
    return [
      ...collect('panelsGrid', 'sidebar'),
      ...(readBottom ? collect('mapBottomGrid', 'bottom') : []),
    ];
  }, includeBottom);
}

function visibleStateFromLayout(layout: PanelLayoutSnapshotProbe): VisiblePanelLayoutProbe[] {
  return layout.panels
    .filter((panel) => panel.region === 'sidebar' || layout.regions.bottom.available)
    .map((panel) => ({
      collapsed: panel.collapsed,
      fullscreen: panel.fullscreen,
      id: panel.id,
      index: panel.index,
      region: panel.region,
    }));
}

async function waitForCountryGeometry(page: Page): Promise<void> {
  await expect.poll(async () => page.evaluate(() => {
    const marks = (window as Window & {
      __wmLcpDebug?: { getSnapshot?: () => { marks: Array<{ name: string }> } };
    }).__wmLcpDebug?.getSnapshot?.().marks ?? [];
    if (marks.some((mark) => mark.name === 'wm:data:country-geometry-fetch-error')) return 'error';
    if (marks.some((mark) => mark.name === 'wm:data:country-geometry-fetch-ready')) return 'ready';
    return 'pending';
  }), { timeout: 60_000 }).toMatch(/^(ready|error)$/);
  expect(
    await page.evaluate(() => {
      const marks = (window as Window & {
        __wmLcpDebug?: { getSnapshot?: () => { marks: Array<{ name: string }> } };
      }).__wmLcpDebug?.getSnapshot?.().marks ?? [];
      return marks.some((mark) => mark.name === 'wm:data:country-geometry-fetch-ready');
    }),
    'country geometry must load before focus_country',
  ).toBe(true);
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

test.describe('dashboard tab persistence', () => {
  test.skip(productionSmoke, 'Do not mutate production dashboard tab persistence.');

  test('creates, renames, selects, and deletes a dashboard tab', async ({ page }) => {
    await dismissMissionPreset(page);
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
    const tabBar = page.locator('.dashboard-tabs-bar');
    await expect(tabBar).toBeVisible({ timeout: 60_000 });
    await closeMissionPresetIfOpen(page);

    const labels = page.locator('.dashboard-tab-label');
    await expect(labels).toHaveCount(1);
    const originalName = (await labels.first().innerText()).trim();
    expect(originalName.length).toBeGreaterThan(0);

    if (requireWebMcp) {
      await expect.poll(async () => page.evaluate(async () => (
        (await document.modelContext?.getTools())?.map((tool) => tool.name).sort() ?? []
      )), { timeout: 60_000 }).toEqual(DASHBOARD_TOOL_NAMES);
      const listed = await executeDashboardTabTool(page, 'list_dashboard_tabs');
      expect(listed).toMatchObject({
        tabCount: 1,
        tabs: [{ name: originalName, active: true, canDelete: false }],
      });
      expect((listed.tabs as Array<{ id: string }>)[0]?.id).toMatch(/^tab-[a-z0-9]+-[a-z0-9]+$/);

      // Current Chrome still omits the target-side AbortSignal, so persistent
      // tab mutations fail closed. Prove the denial, then drive persistence
      // through the visible tab bar like the model-free path.
      const created = await executeDashboardTabTool(page, 'create_dashboard_tab', {
        name: 'Draft Workspace',
      });
      expect(created).toMatchObject({
        ok: false,
        status: 'denied',
        reason: 'target_cancellation_unsupported',
      });
      await expect(labels).toHaveCount(1);
    }

    await page.locator('.dashboard-tab-add').click();
    await expect(labels).toHaveCount(2);
    const createdName = (await labels.nth(1).innerText()).trim();
    expect(createdName).not.toBe(originalName);

    await labels.nth(1).dblclick();
    const rename = page.locator('.dashboard-tab-rename');
    await expect(rename).toBeVisible();
    await rename.fill('WebMCP Workspace');
    await rename.press('Enter');
    await expect(labels.nth(1)).toHaveText('WebMCP Workspace');
    await expect(labels.nth(1)).toHaveAttribute('aria-selected', 'true');

    await labels.first().click();
    await expect(labels.first()).toHaveAttribute('aria-selected', 'true');
    await labels.nth(1).click();
    await expect(labels.nth(1)).toHaveAttribute('aria-selected', 'true');

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('.dashboard-tab-label')).toHaveCount(2);
    await expect(page.locator('.dashboard-tab-label').nth(1)).toHaveText('WebMCP Workspace');
    await expect(page.locator('.dashboard-tab-label').nth(1)).toHaveAttribute('aria-selected', 'true');
    await closeMissionPresetIfOpen(page);

    await page.locator('.dashboard-tab').nth(1).locator('.dashboard-tab-close').click();
    await expect(page.locator('.dashboard-tab-label')).toHaveCount(1);
    await expect(page.locator('.dashboard-tab-label')).toHaveText(originalName);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('.dashboard-tab-label')).toHaveCount(1);
    await expect(page.locator('.dashboard-tab-label')).toHaveText(originalName);
  });
});

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
        [
          'get_access_context',
          'get_dashboard_context',
          'get_panel_layout',
          'list_dashboard_tabs',
          'list_map_layers',
          'list_dashboard_panels',
          'list_mission_presets',
          'search_dashboard',
        ].includes(tool.name),
      );
      expect(
        Boolean(tool.annotations.untrustedContentHint),
        `${tool.name} untrustedContentHint`,
      ).toBe(tool.name === 'search_dashboard');
    }

    const accessContract = discoveredContracts.find((tool) => tool.name === 'get_access_context');
    const signInContract = discoveredContracts.find((tool) => tool.name === 'open_sign_in');
    expect(accessContract?.schema).toMatchObject({ type: 'object', additionalProperties: false });
    expect(accessContract?.schema.properties ?? {}).toEqual({});
    expect(signInContract?.schema).toMatchObject({ type: 'object', additionalProperties: false });
    expect(Object.keys(signInContract?.schema.properties ?? {})).toEqual([]);
    expect(JSON.stringify(signInContract?.schema ?? {})).not.toMatch(
      /password|otp|one[-_]?time|credential|provider/i,
    );

    const accessAndSignIn = await page.evaluate(async () => {
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
      const accessTool = byName.get('get_access_context');
      const signInTool = byName.get('open_sign_in');
      if (!accessTool || !signInTool) {
        throw new Error('Expected access and sign-in tools were not discovered.');
      }
      const access = parseOutput(await provider.executeTool(accessTool, JSON.stringify({})));
      let signInError: { message?: string; name?: string } | null = null;
      let signInResult: unknown;
      try {
        signInResult = parseOutput(await provider.executeTool(signInTool, JSON.stringify({})));
      } catch (error) {
        signInError = {
          name: error instanceof Error ? error.name : undefined,
          message: error instanceof Error ? error.message : String(error),
        };
      }
      return {
        access,
        clerkModalPresent: Boolean(document.querySelector(
          '.cl-modalBackdrop, .cl-modal, [data-clerk-component="SignIn"]',
        )),
        signInError,
        signInResult,
      };
    });
    expect(accessAndSignIn.access).toEqual(expect.objectContaining({
      accountState: expect.stringMatching(/^(signed_out|loading|signed_in)$/),
      clerk: expect.stringMatching(/^(unavailable|loading|ready)$/),
    }));
    expect(JSON.stringify(accessAndSignIn.access)).not.toMatch(
      /@|user_|pk_test_|sk_live_|Bearer |sessionId|"email"|"name"|"token"/i,
    );
    if (accessAndSignIn.signInError) {
      throw new Error(
        `open_sign_in must return a bounded result, not throw: ${accessAndSignIn.signInError.name}: ${accessAndSignIn.signInError.message}`,
      );
    }
    const signInResult = accessAndSignIn.signInResult as {
      ok?: boolean;
      reason?: string;
      status?: string;
    };
    const accessSnapshot = accessAndSignIn.access as { clerk?: string };
    const signInEvidence = {
      clerk: accessSnapshot.clerk ?? null,
      clerkModalPresent: accessAndSignIn.clerkModalPresent,
      signInResult,
    };
    // Production must prove the real Clerk modal. The clerk_unavailable
    // denial is only valid on the local Vite fixture, where Clerk is
    // explicitly unconfigured (`clerk: unavailable`).
    const unconfiguredLocalFixture =
      !productionSmoke && accessSnapshot.clerk === 'unavailable';
    if (unconfiguredLocalFixture) {
      expect(signInResult).toEqual({
        ok: false,
        status: 'denied',
        reason: 'clerk_unavailable',
      });
      expect(accessAndSignIn.clerkModalPresent).toBe(false);
    } else {
      expect(
        accessAndSignIn.clerkModalPresent,
        productionSmoke
          ? 'production smoke must open the real Clerk sign-in modal'
          : 'configured Clerk must open the real sign-in modal',
      ).toBe(true);
      expect(signInResult).toEqual(expect.objectContaining({
        ok: true,
        status: expect.stringMatching(/^(opened|already_open)$/),
      }));
    }

    const catalogProbe = await page.evaluate(async (): Promise<DashboardPanelCatalogProbe> => {
      type ExecutableModelContext = WebMCP.ModelContext & {
        executeTool(tool: WebMCP.RegisteredTool, input: string): Promise<unknown>;
      };
      type CatalogItem = {
        enabled?: boolean;
        id?: string;
        unavailableReason?: string;
      };
      type CatalogPage = {
        hasMore?: boolean;
        nextCursor?: string | null;
        panels?: CatalogItem[];
        total?: number;
      };

      const provider = document.modelContext as ExecutableModelContext | undefined;
      if (!provider || typeof provider.executeTool !== 'function') {
        throw new Error('Chrome WebMCP execution API is unavailable.');
      }
      const tool = (await provider.getTools())
        .find((candidate) => candidate.name === 'list_dashboard_panels');
      if (!tool) throw new Error('list_dashboard_panels was not discovered.');

      const ids = new Set<string>();
      const reasons: Record<string, number> = {};
      let cursor: string | undefined;
      let disabledCount = 0;
      let pages = 0;
      let total = 0;
      for (; pages < 80; pages += 1) {
        const raw = await provider.executeTool(tool, JSON.stringify({ cursor, limit: 8 }));
        const page = (typeof raw === 'string' ? JSON.parse(raw) : raw) as CatalogPage;
        const panels = Array.isArray(page.panels) ? page.panels : [];
        total = typeof page.total === 'number' ? page.total : total;
        for (const panel of panels) {
          if (typeof panel.id !== 'string') throw new Error('Catalog panel is missing its ID.');
          if (ids.has(panel.id)) throw new Error(`Catalog repeated panel ${panel.id}.`);
          ids.add(panel.id);
          if (panel.enabled === false) disabledCount += 1;
          if (typeof panel.unavailableReason === 'string') {
            reasons[panel.unavailableReason] = (reasons[panel.unavailableReason] ?? 0) + 1;
          }
        }
        if (page.hasMore !== true) break;
        if (typeof page.nextCursor !== 'string') {
          throw new Error('Paginated catalog response is missing its next cursor.');
        }
        cursor = page.nextCursor;
      }
      if (pages >= 80) throw new Error('Catalog pagination did not terminate.');
      return { disabledCount, pages: pages + 1, reasons, total, uniqueCount: ids.size };
    });
    expect(catalogProbe.uniqueCount).toBe(catalogProbe.total);

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
    const layerListed = await executeListMapLayers(page);
    assertMapLayerListResult(layerListed, 'list_map_layers');

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

    type SearchResultEffectProbe = {
      allowed: MutationExecutionProbe & {
        executable?: boolean;
        query?: string;
      };
      denied?: MutationExecutionProbe & {
        executable?: boolean;
        query?: string;
      };
    };
    let searchResultEffects: SearchResultEffectProbe | null = null;
    if (!productionSmoke) {
      searchResultEffects = await page.evaluate(async (
        targetCancellationSupported: boolean | undefined,
      ): Promise<SearchResultEffectProbe> => {
        type ExecutableModelContext = WebMCP.ModelContext & {
          executeTool(tool: WebMCP.RegisteredTool, input: string): Promise<unknown>;
        };
        const parseOutput = (value: unknown): unknown => {
          if (typeof value !== 'string') return value;
          try {
            return JSON.parse(value);
          } catch {
            return value;
          }
        };
        const provider = document.modelContext as ExecutableModelContext;
        const tools = await provider.getTools();
        const byName = new Map(tools.map((tool) => [tool.name, tool]));
        const searchTool = byName.get('search_dashboard');
        const openTool = byName.get('open_search_result');
        if (!searchTool || !openTool) {
          throw new Error('Expected dashboard search tools were not discovered.');
        }
        const execute = async (tool: WebMCP.RegisteredTool, input: string) => {
          try {
            return { ok: true as const, output: parseOutput(await provider.executeTool(tool, input)) };
          } catch (error) {
            return {
              errorMessage: error && typeof error === 'object' && 'message' in error
                ? String(error.message).slice(0, 500)
                : String(error).slice(0, 500),
              errorName: error && typeof error === 'object' && 'name' in error
                ? String(error.name)
                : 'unknown',
              ok: false as const,
            };
          }
        };
        const panelSearch = await execute(searchTool, JSON.stringify({
          query: 'live webcams',
          scope: 'panels',
          limit: 8,
        }));
        const panelResults = panelSearch.ok
          && panelSearch.output
          && typeof panelSearch.output === 'object'
          && 'results' in panelSearch.output
          && Array.isArray((panelSearch.output as { results: unknown }).results)
          ? (panelSearch.output as {
            results: Array<{ key?: string; executable?: boolean }>;
          }).results
          : [];
        const allowedResult = panelResults.find((result) => result.executable === true) ?? panelResults[0];
        const allowedOpen = allowedResult?.key
          ? await execute(openTool, JSON.stringify({ resultKey: allowedResult.key }))
          : {
            ok: false as const,
            errorName: 'missing_result',
            errorMessage: 'search_dashboard did not return an executable panel result.',
          };
        const probe: SearchResultEffectProbe = {
          allowed: {
            ...allowedOpen,
            executable: allowedResult?.executable,
            query: 'live webcams',
          },
        };
        if (targetCancellationSupported === true) return probe;

        const layerSearch = await execute(searchTool, JSON.stringify({
          query: 'conflicts',
          scope: 'map',
          limit: 8,
        }));
        const layerResults = layerSearch.ok
          && layerSearch.output
          && typeof layerSearch.output === 'object'
          && 'results' in layerSearch.output
          && Array.isArray((layerSearch.output as { results: unknown }).results)
          ? (layerSearch.output as {
            results: Array<{ key?: string; executable?: boolean }>;
          }).results
          : [];
        const deniedResult = layerResults.find((result) => result.executable === false)
          ?? layerResults[0];
        const deniedOpen = deniedResult?.key
          ? await execute(openTool, JSON.stringify({ resultKey: deniedResult.key }))
          : {
            ok: false as const,
            errorName: 'missing_result',
            errorMessage: 'search_dashboard did not return a persistent map result.',
          };
        probe.denied = {
          ...deniedOpen,
          executable: deniedResult?.executable,
          query: 'conflicts',
        };
        return probe;
      }, coldStart.targetCancellationSupported);

      expect(searchResultEffects).not.toBeNull();
      expect(searchResultEffects!.allowed).toMatchObject({
        ok: true,
        executable: true,
        output: {
          ok: true,
          status: 'opened',
          type: 'command',
        },
      });
      if (coldStart.targetCancellationSupported !== true) {
        expect(searchResultEffects!.denied).toMatchObject({
          ok: true,
          executable: false,
          output: {
            ok: false,
            status: 'denied',
            reason: 'target_cancellation_unsupported',
          },
        });
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
        layerCatalog: { tool: 'list_map_layers', output: layerListed },
        panelCatalog: {
          tool: 'list_dashboard_panels',
          disabledCount: catalogProbe.disabledCount,
          pages: catalogProbe.pages,
          reasons: catalogProbe.reasons,
          total: catalogProbe.total,
          uniqueCount: catalogProbe.uniqueCount,
        },
        denied: {
          tool: 'open_dashboard_panel',
          targetCancellationSupported: coldStart.targetCancellationSupported,
          ...panelProbe,
        },
        signIn: { tool: 'open_sign_in', ...signInEvidence },
        ...(visibleMutation ? { visibleMutation: { tool: 'openSearch', ...visibleMutation } } : {}),
        ...(searchResultEffects ? { searchResultEffects } : {}),
      },
    });
  });

  test('validates monitor switches and opens settings and alerts through existing UI', async ({ page }, testInfo) => {
    test.skip(productionSmoke, 'Must not execute switch_monitor against a production origin.');
    testInfo.setTimeout(120_000);
    const response = await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
    expect(response).not.toBeNull();
    await expect.poll(async () => page.evaluate(async () => (
      (await document.modelContext?.getTools())?.map((tool) => tool.name).sort() ?? []
    )), { timeout: 60_000 }).toEqual(DASHBOARD_TOOL_NAMES);

    const invalid = await executeDashboardTool(page, 'switch_monitor', { monitor: 'World' });
    expect(invalid).toMatchObject({
      ok: false,
      status: 'invalid',
      reason: 'unknown_monitor',
    });
    expect(page.url()).toContain('/dashboard');
    await expect(page.locator('.variant-option.active[data-variant="full"]')).toBeVisible();

    const settings = await executeDashboardTool(page, 'open_settings', {});
    expect(settings).toMatchObject({
      ok: true,
      destination: 'settings',
      overlay: 'open',
      tab: 'settings',
    });
    await expect(page.locator('#unifiedSettingsModal.active')).toBeVisible();
    await expect(page.locator('#unifiedSettingsModal [data-tab="settings"][aria-selected="true"]')).toBeVisible();

    const alerts = await executeDashboardTool(page, 'open_alerts', {});
    expect(alerts).toMatchObject({
      ok: true,
      destination: 'alerts',
      overlay: 'open',
      tab: 'notifications',
    });
    await expect(page.locator('#unifiedSettingsModal.active')).toBeVisible();
    await expect(page.locator('#unifiedSettingsModal [data-tab="notifications"][aria-selected="true"]')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#unifiedSettingsModal.active')).toHaveCount(0);

    const historyBefore = await page.evaluate(() => window.history.length);
    const locationBefore = new URL(page.url());
    const switchResult = await executeDashboardTool(page, 'switch_monitor', { monitor: 'tech' });
    expect(switchResult).toMatchObject({
      ok: false,
      status: 'denied',
      reason: 'target_cancellation_unsupported',
    });

    const context = await executeDashboardTool(page, 'get_dashboard_context', {}) as {
      variant?: string;
    };
    expect(context.variant).toBe('full');
    await expect(page.locator('.variant-option.active[data-variant="full"]')).toBeVisible();
    const locationAfter = new URL(page.url());
    expect({ origin: locationAfter.origin, pathname: locationAfter.pathname }).toEqual({
      origin: locationBefore.origin,
      pathname: locationBefore.pathname,
    });
    expect(await page.evaluate(() => window.history.length)).toBe(historyBefore);

    await attachJsonEvidence(testInfo, 'webmcp-navigation.json', {
      invalid,
      settings,
      alerts,
      switchResult,
      context,
      url: page.url(),
      historyLength: await page.evaluate(() => window.history.length),
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

  test('applies supply-chain-risk mission preset and persists across reload', async ({ page }) => {
    test.skip(productionSmoke, 'Must not mutate production mission presets.');
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
      const listTool = (await provider.getTools())
        .find((candidate) => candidate.name === 'list_mission_presets');
      if (!listTool) throw new Error('list_mission_presets was not discovered.');
      const listOutput = parseOutput(await provider.executeTool(listTool, '{}'));
      const applyTool = (await provider.getTools())
        .find((candidate) => candidate.name === 'apply_mission_preset');
      if (!applyTool) throw new Error('apply_mission_preset was not discovered.');
      const controller = new AbortController();
      const applyOutput = parseOutput(await provider.executeTool(
        applyTool,
        JSON.stringify({ presetId: 'supply-chain-risk' }),
        { signal: controller.signal },
      ));
      return {
        listOutput,
        applyOutput,
        storedPreset: window.localStorage.getItem('worldmonitor-mission-preset-v1'),
        missionLabel: document.querySelector('.mission-preset-button__label')?.textContent ?? null,
      };
    });

    const applyOutput = first.applyOutput as {
      ok?: boolean;
      reason?: string;
      presetId?: string;
      map?: { view?: string; timeRange?: string };
      panels?: { enabled?: string[] };
    };
    if (applyOutput?.reason === 'target_cancellation_unsupported') {
      test.skip(true, 'Host omitted the target-side AbortSignal; persist proof requires cancellation.');
    }

    expect(first.listOutput).toMatchObject({
      ok: true,
      count: 7,
    });
    expect(applyOutput).toMatchObject({
      ok: true,
      status: 'applied',
      presetId: 'supply-chain-risk',
      map: {
        view: 'global',
        timeRange: '7d',
      },
    });
    expect(applyOutput.panels?.enabled ?? []).toEqual(
      expect.arrayContaining(['map', 'supply-chain']),
    );
    expect(first.storedPreset).toBe('supply-chain-risk');
    expect(first.missionLabel).toBe('Supply');

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect.poll(async () => page.evaluate(async () => (
      (await document.modelContext?.getTools())?.some((tool) => tool.name === 'list_mission_presets') ?? false
    )), { timeout: 60_000 }).toBe(true);

    const afterReload = await page.evaluate(async () => {
      type ExecutableModelContext = WebMCP.ModelContext & {
        executeTool(tool: WebMCP.RegisteredTool, input: string): Promise<unknown>;
      };
      const provider = document.modelContext as ExecutableModelContext;
      const listTool = (await provider.getTools())
        .find((tool) => tool.name === 'list_mission_presets');
      if (!listTool) throw new Error('list_mission_presets was not discovered.');
      const raw = await provider.executeTool(listTool, '{}');
      let listed = raw;
      if (typeof raw === 'string') {
        try {
          listed = JSON.parse(raw);
        } catch {
          // Preserve non-JSON provider output.
        }
      }
      return {
        listed,
        storedPreset: window.localStorage.getItem('worldmonitor-mission-preset-v1'),
        missionLabel: document.querySelector('.mission-preset-button__label')?.textContent ?? null,
      };
    });
    expect(afterReload.storedPreset).toBe('supply-chain-risk');
    expect(afterReload.missionLabel).toBe('Supply');
    expect(afterReload.listed).toMatchObject({
      ok: true,
      activePresetId: 'supply-chain-risk',
    });
  });

  test('applies panel layout mutations and proves visible order and state', async ({ page }, testInfo) => {
    test.skip(productionSmoke, 'Must not mutate production panel layout.');
    testInfo.setTimeout(120_000);
    await dismissMissionPreset(page);
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
    await waitForDashboardTools(page);
    await closeMissionPresetIfOpen(page);
    await expect(page.locator('#panelsGrid > .panel[data-panel]').first()).toBeAttached({
      timeout: 60_000,
    });

    await expect.poll(async () => {
      const layout = await readFullPanelLayout(page);
      return layout.panels.some((panel) => panel.collapsible && panel.fullscreenCapable)
        && layout.panels.filter((panel) => panel.region === 'sidebar').length >= 2;
    }, {
      message: 'layout snapshot must include a collapsible fullscreen panel and a move peer',
      timeout: 60_000,
    }).toBe(true);

    const initialLayout = await readFullPanelLayout(page);
    const initialVisible = await readVisiblePanelLayout(
      page,
      initialLayout.regions.bottom.available,
    );
    expect(initialVisible).toEqual(visibleStateFromLayout(initialLayout));
    expect(initialLayout.panels.length).toBeGreaterThan(0);

    const fullscreenPanel = initialLayout.panels.find((panel) => panel.fullscreenCapable);
    expect(fullscreenPanel, 'a fullscreen-capable panel must be mounted').toBeTruthy();
    const fullscreenId = fullscreenPanel!.id;

    const enterFullscreen = await executeDashboardTool(page, 'set_panel_fullscreen', {
      panelId: fullscreenId,
      fullscreen: true,
    });
    expect(enterFullscreen).toMatchObject({
      ok: true,
      status: 'applied',
      actionType: 'set_fullscreen',
      panelId: fullscreenId,
      requestedFullscreen: true,
      effectiveFullscreen: true,
    });
    await expect(page.locator(`.panel[data-panel="${fullscreenId}"]`)).toHaveClass(/live-news-fullscreen/);
    await expect(page.locator('body')).toHaveClass(/live-news-fullscreen-active/);

    const afterFullscreen = await readFullPanelLayout(page);
    expect(afterFullscreen.panels.find((panel) => panel.id === fullscreenId)).toMatchObject({
      fullscreen: true,
    });
    expect(await readVisiblePanelLayout(page, afterFullscreen.regions.bottom.available))
      .toEqual(visibleStateFromLayout(afterFullscreen));

    const exitFullscreen = await executeDashboardTool(page, 'set_panel_fullscreen', {
      panelId: fullscreenId,
      fullscreen: false,
    });
    expect(exitFullscreen).toMatchObject({
      ok: true,
      status: 'applied',
      actionType: 'set_fullscreen',
      panelId: fullscreenId,
      requestedFullscreen: false,
      effectiveFullscreen: false,
    });
    await expect(page.locator(`.panel[data-panel="${fullscreenId}"]`)).not.toHaveClass(/live-news-fullscreen/);
    await expect(page.locator('body')).not.toHaveClass(/live-news-fullscreen-active/);

    const collapsePanel = afterFullscreen.panels.find((panel) => panel.collapsible)
      ?? fullscreenPanel;
    expect(collapsePanel, 'a collapsible panel must be mounted').toBeTruthy();
    const collapseId = collapsePanel!.id;
    const requestedCollapsed = true;

    const sidebarPeers = afterFullscreen.panels.filter((panel) => panel.region === 'sidebar');
    const movePanel = sidebarPeers.find((panel) => panel.id !== collapseId && panel.fixed !== true)
      ?? sidebarPeers.find((panel) => panel.fixed !== true);
    expect(movePanel, 'a movable sidebar panel must be mounted').toBeTruthy();
    const moveId = movePanel!.id;
    const moveToBottom = afterFullscreen.regions.bottom.available === true;
    const moveRegion = moveToBottom ? 'bottom' as const : 'sidebar' as const;
    const moveIndex = moveToBottom
      ? 0
      : (movePanel!.index === 0 ? sidebarPeers.length - 1 : 0);

    const collapsed = await executeDashboardToolWithCallerSignal(page, 'set_panel_collapsed', {
      panelId: collapseId,
      collapsed: requestedCollapsed,
    });
    const moved = await executeDashboardToolWithCallerSignal(page, 'move_panel', {
      panelId: moveId,
      region: moveRegion,
      index: moveIndex,
    });
    const collapseOutput = collapsed as { ok?: boolean; reason?: string };
    const moveOutput = moved as { ok?: boolean; reason?: string };
    if (
      collapseOutput.reason === 'target_cancellation_unsupported'
      || moveOutput.reason === 'target_cancellation_unsupported'
    ) {
      await attachJsonEvidence(testInfo, 'webmcp-panel-layout.json', {
        initialLayout,
        enterFullscreen,
        exitFullscreen,
        collapsed,
        moved,
        skipped: 'target_cancellation_unsupported',
      });
      test.skip(true, 'Host omitted the target-side AbortSignal; persist proof requires cancellation.');
    }

    expect(collapsed).toMatchObject({
      ok: true,
      status: 'applied',
      actionType: 'set_collapsed',
      panelId: collapseId,
      requestedCollapsed,
      effectiveCollapsed: requestedCollapsed,
    });
    await expect(page.locator(`.panel[data-panel="${collapseId}"]`)).toHaveClass(/panel-collapsed/);
    await expect(page.locator(`.panel[data-panel="${collapseId}"] .panel-collapse-btn`))
      .toHaveAttribute('aria-expanded', 'false');

    expect(moved).toMatchObject({
      ok: true,
      status: 'applied',
      actionType: 'move',
      panelId: moveId,
      region: moveRegion,
      index: moveIndex,
    });

    const afterMutations = await readFullPanelLayout(page);
    expect(afterMutations.panels.find((panel) => panel.id === collapseId)).toMatchObject({
      collapsed: requestedCollapsed,
    });
    expect(afterMutations.panels.find((panel) => panel.id === moveId)).toMatchObject({
      region: moveRegion,
      index: moveIndex,
    });
    expect(await readVisiblePanelLayout(page, afterMutations.regions.bottom.available))
      .toEqual(visibleStateFromLayout(afterMutations));
    if (moveToBottom) {
      await expect(page.locator(`#mapBottomGrid > .panel[data-panel="${moveId}"]`)).toBeAttached();
    }

    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForDashboardTools(page);
    await closeMissionPresetIfOpen(page);
    await expect(page.locator(`#${moveToBottom ? 'mapBottomGrid' : 'panelsGrid'} > .panel[data-panel="${moveId}"]`))
      .toBeAttached({ timeout: 60_000 });

    await expect.poll(async () => {
      const layout = await readFullPanelLayout(page);
      const collapsedEntry = layout.panels.find((panel) => panel.id === collapseId);
      const movedEntry = layout.panels.find((panel) => panel.id === moveId);
      return collapsedEntry?.collapsed === requestedCollapsed
        && movedEntry?.region === moveRegion
        && movedEntry?.index === moveIndex;
    }, {
      message: 'persistent collapse and move must survive reload',
      timeout: 60_000,
    }).toBe(true);

    const afterReload = await readFullPanelLayout(page);
    expect(afterReload.panels.find((panel) => panel.id === fullscreenId)).toMatchObject({
      fullscreen: false,
    });
    expect(await readVisiblePanelLayout(page, afterReload.regions.bottom.available))
      .toEqual(visibleStateFromLayout(afterReload));
    await expect(page.locator(`.panel[data-panel="${collapseId}"]`)).toHaveClass(/panel-collapsed/);
    await expect(page.locator('body')).not.toHaveClass(/live-news-fullscreen-active/);

    await attachJsonEvidence(testInfo, 'webmcp-panel-layout.json', {
      initialLayout,
      enterFullscreen,
      exitFullscreen,
      collapsed,
      moved,
      afterMutations,
      afterReload,
    });
  });

  test('applies time range and country focus, and gates 2D/3D without target cancellation', async ({ page }, testInfo) => {
    test.skip(productionSmoke, 'Local view-state mutations stay off the production origin.');
    testInfo.setTimeout(180_000);
    await installReadinessRecorder(page);
    await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
    await waitForDashboardTools(page);

    const timeRange = await executeDashboardToolProbe(page, 'set_time_range', { timeRange: '6h' });
    expect(timeRange).toMatchObject({
      ok: true,
      output: {
        ok: true,
        status: 'applied',
        actionType: 'set_time_range',
        requested: { timeRange: '6h' },
        effective: { timeRange: '6h' },
        compatibility: { adjusted: false },
      },
    });
    await expect.poll(() => new URL(page.url()).searchParams.get('timeRange')).toBe('6h');
    await expect(page.locator('.time-btn.active[data-range="6h"]')).toBeVisible();

    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForDashboardTools(page);
    expect(new URL(page.url()).searchParams.get('timeRange')).toBe('6h');
    await expect(page.locator('.time-btn.active[data-range="6h"]')).toBeVisible();

    await waitForCountryGeometry(page);
    const focus = await executeDashboardToolProbe(page, 'focus_country', { iso2: 'DE' });
    expect(focus).toMatchObject({
      ok: true,
      output: {
        ok: true,
        status: 'applied',
        actionType: 'focus_country',
        requested: { iso2: 'DE' },
        effective: { iso2: 'DE' },
        compatibility: { adjusted: false },
      },
    });
    const afterFocus = new URL(page.url()).searchParams;
    expect(afterFocus.get('view')).toBe('global');
    expect(afterFocus.get('country')).toBeNull();
    const lat = Number(afterFocus.get('lat'));
    const lon = Number(afterFocus.get('lon'));
    expect(lat).toBeGreaterThan(45);
    expect(lat).toBeLessThan(56);
    expect(lon).toBeGreaterThan(5);
    expect(lon).toBeLessThan(16);
    await expect(page.locator('#country-deep-dive-panel')).toHaveAttribute('aria-hidden', 'true');
    await expect(page.locator('#country-deep-dive-panel')).not.toHaveClass(/active/);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForDashboardTools(page);
    const afterFocusReload = new URL(page.url()).searchParams;
    expect(afterFocusReload.get('timeRange')).toBe('6h');
    expect(afterFocusReload.get('view')).toBe('global');
    expect(afterFocusReload.get('country')).toBeNull();
    expect(Number(afterFocusReload.get('lat'))).toBeCloseTo(lat, 3);
    expect(Number(afterFocusReload.get('lon'))).toBeCloseTo(lon, 3);
    await expect(page.locator('#country-deep-dive-panel')).toHaveAttribute('aria-hidden', 'true');

    await expect(page.locator('#mapDimensionToggle .map-dim-btn[data-mode="flat"]')).toHaveClass(/active/);
    await expect(page.locator('#mapDimensionToggle .map-dim-btn[data-mode="globe"]')).toBeVisible();

    // Chrome 149–151 invokes the page callback with the input alone, even when
    // executeTool() is given `{ signal }`. set_map_mode stays gated there.
    // Do not click the 2D/3D control as a substitute: that would hide a broken
    // cancellation gate. Binding tests cover the apply path with a real signal.
    const to3d = await executeDashboardToolProbe(page, 'set_map_mode', { mode: '3d' });
    expect(to3d).toMatchObject({
      ok: true,
      output: {
        ok: false,
        status: 'denied',
        reason: 'target_cancellation_unsupported',
      },
    });
    await expect(page.locator('#mapDimensionToggle .map-dim-btn[data-mode="flat"]')).toHaveClass(/active/);
    await expect(page.locator('#mapDimensionToggle .map-dim-btn[data-mode="globe"]')).not.toHaveClass(/active/);
    expect(new URL(page.url()).searchParams.get('mapMode')).toBeNull();
    expect(new URL(page.url()).searchParams.get('timeRange')).toBe('6h');
    expect(await storedMapMode(page)).not.toBe('globe');

    await attachJsonEvidence(testInfo, 'webmcp-map-view-state.json', {
      timeRange,
      focus,
      to3d,
      urlAfterFocus: afterFocus.toString(),
    });
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

        const layerListed = await executeListMapLayers(page);
        assertMapLayerListResult(layerListed, `${target.origin} list_map_layers`);

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
          listMapLayers: layerListed,
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
