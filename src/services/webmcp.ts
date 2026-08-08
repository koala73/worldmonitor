// WebMCP — in-page agent tool surface.
//
// Registers a small set of tools via `document.modelContext.registerTool`
// so browsers implementing the current WebMCP API can drive the site the same
// way a human does. Tools MUST route through existing UI code paths so agents
// inherit every auth/entitlement gate a browser user is subject to — they are
// not a backdoor around the paywall.
//
// Current tools mirror the static Agent Skills set (#3310) for consistency:
//   1. openCountryBrief({ iso2 }) — opens the country deep-dive panel.
//   2. openSearch()               — opens the global command palette.
//
// The two v1 tools don't branch on auth state, so a single registration at
// init time is correct. Any future Pro-only tool MUST re-register on
// sign-in/sign-out (see feedback_reactive_listeners_must_be_symmetric.md).
//
// Scanner compatibility: WebMCP scanners probe for
// `document.modelContext.registerTool` invocations during initial page load.
// Register synchronously from App.ts (no dynamic import, no init-phase
// awaits) so the probe finds the tools before it gives up.

import { track, type UmamiEvent } from './analytics';

export interface WebMcpAppBindings {
  openCountryBriefByCode(code: string, country: string): Promise<void>;
  resolveCountryName(code: string): string;
  // Returns a Promise because implementations may await a readiness signal
  // (e.g. waiting for the search modal to exist during startup) before
  // dispatching. Tool executes must `await` it so rejections surface to
  // withInvocationLogging's catch path.
  openSearch(): void | Promise<void>;
}

type DashboardWebMcpToolName = 'openCountryBrief' | 'openSearch';
type WebMcpAnalytics = (event: UmamiEvent, data?: Record<string, unknown>) => void;
type RegistrationFailureReason =
  | 'invalid-state'
  | 'security'
  | 'not-allowed'
  | 'invalid-tool'
  | 'unknown';

type DashboardWebMcpTool = WebMCP.ModelContextTool & {
  name: DashboardWebMcpToolName;
  execute: WebMCP.ToolExecuteCallback<Record<string, unknown>>;
};

interface WebMcpRegistrationRuntime {
  document?: Pick<Document, 'modelContext' | 'addEventListener'>;
  window?: Pick<Window, 'addEventListener'>;
  track?: WebMcpAnalytics;
}

const ISO2 = /^[A-Z]{2}$/;
const TOOL_FAILURE_MESSAGES: Record<DashboardWebMcpToolName, string> = {
  openCountryBrief: 'World Monitor could not open that country brief.',
  openSearch: 'World Monitor could not open search.',
};

class SafeWebMcpError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'WebMcpToolError';
  }
}

function reportWebMcpEvent(
  trackEvent: WebMcpAnalytics,
  event: UmamiEvent,
  data: Record<string, unknown>,
): void {
  try {
    trackEvent(event, data);
  } catch {
    // Optional telemetry must never affect registration or tool execution.
  }
}

function withInvocationLogging(
  name: DashboardWebMcpToolName,
  fn: WebMCP.ToolExecuteCallback<Record<string, unknown>>,
  trackEvent: WebMcpAnalytics,
): WebMCP.ToolExecuteCallback<Record<string, unknown>> {
  return async (args) => {
    try {
      const result = await fn(args);
      reportWebMcpEvent(trackEvent, 'webmcp-tool-invoked', {
        tool: name,
        outcome: 'success',
      });
      return result;
    } catch (error) {
      reportWebMcpEvent(trackEvent, 'webmcp-tool-invoked', {
        tool: name,
        outcome: 'failure',
      });
      if (error instanceof SafeWebMcpError) throw error;
      throw new SafeWebMcpError(TOOL_FAILURE_MESSAGES[name]);
    }
  };
}

export function buildWebMcpTools(
  app: WebMcpAppBindings,
  trackEvent: WebMcpAnalytics = track,
): DashboardWebMcpTool[] {
  return [
    {
      name: 'openCountryBrief',
      title: 'Open Country Brief',
      description:
        'Open the intelligence brief panel for a country by ISO 3166-1 alpha-2 code (e.g. "DE", "IR"). Routes the user to the country deep-dive view; the brief itself is fetched by the same path a click would take.',
      inputSchema: {
        type: 'object',
        properties: {
          iso2: {
            type: 'string',
            description: 'ISO 3166-1 alpha-2 country code, uppercase.',
            pattern: '^[A-Z]{2}$',
          },
        },
        required: ['iso2'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false },
      execute: withInvocationLogging('openCountryBrief', async (args) => {
        const iso2 = typeof args.iso2 === 'string' ? args.iso2.toUpperCase() : '';
        if (!ISO2.test(iso2)) {
          throw new SafeWebMcpError(
            'iso2 must be an ISO 3166-1 alpha-2 code, such as "DE" or "IR".',
          );
        }
        const name = app.resolveCountryName(iso2);
        await app.openCountryBriefByCode(iso2, name);
        return `Opened intelligence brief for ${name} (${iso2}).`;
      }, trackEvent),
    },
    {
      name: 'openSearch',
      title: 'Open Search',
      description:
        'Open the global search command palette so the user can find countries, signals, alerts, and other entities tracked by World Monitor.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false },
      execute: withInvocationLogging('openSearch', async () => {
        await app.openSearch();
        return 'Opened search palette.';
      }, trackEvent),
    },
  ];
}

function registrationFailureReason(error: unknown): RegistrationFailureReason | 'aborted' {
  let name = '';
  try {
    name = error && typeof error === 'object' && 'name' in error
      ? String((error as { name?: unknown }).name ?? '')
      : '';
  } catch {
    return 'unknown';
  }
  switch (name) {
    case 'AbortError':
      return 'aborted';
    case 'InvalidStateError':
      return 'invalid-state';
    case 'SecurityError':
      return 'security';
    case 'NotAllowedError':
      return 'not-allowed';
    case 'TypeError':
      return 'invalid-tool';
    default:
      return 'unknown';
  }
}

function observeRegistration(
  provider: WebMCP.ModelContext,
  tool: DashboardWebMcpTool,
  controller: AbortController,
  trackEvent: WebMcpAnalytics,
): Promise<boolean> {
  let registration: Promise<void>;
  try {
    registration = provider.registerTool(tool, { signal: controller.signal });
  } catch (error) {
    registration = Promise.reject(error);
  }

  return Promise.resolve(registration).then(
    () => !controller.signal.aborted,
    (error: unknown) => {
      const reason = registrationFailureReason(error);
      if (!controller.signal.aborted && reason !== 'aborted') {
        reportWebMcpEvent(trackEvent, 'webmcp-registration-failed', {
          tool: tool.name,
          reason,
        });
      }
      return false;
    },
  );
}

function startRegistration(
  provider: WebMCP.ModelContext,
  tools: DashboardWebMcpTool[],
  controller: AbortController,
  trackEvent: WebMcpAnalytics,
): void {
  const registrations = tools.map((tool) => (
    observeRegistration(provider, tool, controller, trackEvent)
  ));

  void Promise.all(registrations).then((accepted) => {
    if (controller.signal.aborted) return;
    const toolCount = accepted.filter(Boolean).length;
    if (toolCount === 0) return;
    reportWebMcpEvent(trackEvent, 'webmcp-registered', {
      toolCount,
      api: 'registerTool',
    });
  });
}

// Registers tools with the browser's current WebMCP provider, if present.
// Registration calls begin synchronously so discovery probes can observe them.
// A provider installed after head parsing gets one DOM-ready/load retry. The
// returned AbortController tears down accepted tools, pending registrations,
// and retry listeners. Unsupported runtimes remain a no-op.
export function registerWebMcpTools(
  app: WebMcpAppBindings,
  runtime: WebMcpRegistrationRuntime = {},
): AbortController | null {
  const runtimeDocument = runtime.document
    ?? (typeof document === 'undefined' ? null : document);
  if (!runtimeDocument) return null;

  const runtimeWindow = runtime.window
    ?? (typeof window === 'undefined' ? null : window);
  const trackEvent = runtime.track ?? track;
  const tools = buildWebMcpTools(app, trackEvent);
  const controller = new AbortController();
  let registrationStarted = false;

  const registerAvailableProvider = (): boolean => {
    if (registrationStarted || controller.signal.aborted) return registrationStarted;
    let provider: WebMCP.ModelContext | undefined;
    try {
      provider = runtimeDocument.modelContext;
    } catch {
      return false;
    }
    if (!provider || typeof provider.registerTool !== 'function') return false;
    registrationStarted = true;
    startRegistration(provider, tools, controller, trackEvent);
    return true;
  };

  if (!registerAvailableProvider()) {
    const retry = (): void => { registerAvailableProvider(); };
    try {
      runtimeDocument.addEventListener('DOMContentLoaded', retry, {
        once: true,
        signal: controller.signal,
      });
    } catch {
      // Unsupported listener options must not break page initialization.
    }
    try {
      runtimeWindow?.addEventListener('load', retry, {
        once: true,
        signal: controller.signal,
      });
    } catch {
      // Unsupported listener options must not break page initialization.
    }
  }

  return controller;
}
