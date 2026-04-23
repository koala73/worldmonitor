// WebMCP — in-page agent tool surface.
//
// Registers a small set of tools via `navigator.modelContext.provideContext`
// so that browsers implementing the draft WebMCP spec
// (webmachinelearning.github.io/webmcp) can drive the site the same way a
// human does. Tools MUST route through existing UI code paths so agents
// inherit every auth/entitlement gate a browser user is subject to — they
// are not a backdoor around the paywall.
//
// Current tools mirror the static Agent Skills set (#3310) for consistency:
//   1. openCountryBrief({ iso2 }) — opens the country deep-dive panel.
//   2. openSearch()               — opens the global command palette.
//
// The two v1 tools don't branch on auth state, so a single registration at
// init time is correct. Any future Pro-only tool MUST re-register on
// sign-in/sign-out (see feedback_reactive_listeners_must_be_symmetric.md).

import { track } from './analytics';

// Minimal draft-spec types — WebMCP has no published typings yet.
interface WebMcpToolContent {
  type: 'text';
  text: string;
}

interface WebMcpToolResult {
  content: WebMcpToolContent[];
  isError?: boolean;
}

interface WebMcpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<WebMcpToolResult>;
}

interface WebMcpProvider {
  provideContext(ctx: { tools: WebMcpTool[] }): void;
}

interface NavigatorWithWebMcp extends Navigator {
  modelContext?: WebMcpProvider;
}

export interface WebMcpAppBindings {
  openCountryBriefByCode(code: string, country: string): Promise<void>;
  resolveCountryName(code: string): string;
  openSearch(): void;
}

const ISO2 = /^[A-Z]{2}$/;

function textResult(text: string, isError = false): WebMcpToolResult {
  return { content: [{ type: 'text', text }], isError };
}

function withInvocationLogging(name: string, fn: WebMcpTool['execute']): WebMcpTool['execute'] {
  return async (args) => {
    try {
      const result = await fn(args);
      track('webmcp-tool-invoked', { tool: name, ok: !result.isError });
      return result;
    } catch (err) {
      track('webmcp-tool-invoked', { tool: name, ok: false });
      return textResult(`Tool ${name} failed: ${(err as Error).message ?? String(err)}`, true);
    }
  };
}

export function buildWebMcpTools(app: WebMcpAppBindings): WebMcpTool[] {
  return [
    {
      name: 'openCountryBrief',
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
      execute: withInvocationLogging('openCountryBrief', async (args) => {
        const iso2 = typeof args.iso2 === 'string' ? args.iso2.toUpperCase() : '';
        if (!ISO2.test(iso2)) {
          return textResult(
            'iso2 must be an ISO 3166-1 alpha-2 code, e.g. "DE" or "IR".',
            true,
          );
        }
        const name = app.resolveCountryName(iso2);
        await app.openCountryBriefByCode(iso2, name);
        return textResult(`Opened intelligence brief for ${name} (${iso2}).`);
      }),
    },
    {
      name: 'openSearch',
      description:
        'Open the global search command palette so the user can find countries, signals, alerts, and other entities tracked by World Monitor.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      execute: withInvocationLogging('openSearch', async () => {
        app.openSearch();
        return textResult('Opened search palette.');
      }),
    },
  ];
}

// Registers tools with the browser's WebMCP provider, if present.
// Safe to call on every load: no-op in browsers without `navigator.modelContext`.
// Returns true if registration actually happened (for tests / telemetry).
export function registerWebMcpTools(app: WebMcpAppBindings): boolean {
  if (typeof navigator === 'undefined') return false;
  const provider = (navigator as NavigatorWithWebMcp).modelContext;
  if (!provider || typeof provider.provideContext !== 'function') return false;
  const tools = buildWebMcpTools(app);
  provider.provideContext({ tools });
  track('webmcp-registered', { toolCount: tools.length });
  return true;
}
