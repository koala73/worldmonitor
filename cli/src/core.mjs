// Pure, dependency-free logic for the WorldMonitor CLI: argument parsing,
// request planning, and output formatting. Nothing here touches the network or
// the process — every export is unit-testable in isolation, and the thin
// network/IO wrapper lives in ./run.mjs.
//
// The CLI is MCP-first. The MCP server (https://worldmonitor.app/mcp) is the
// live, documented agent surface: `tools/list` is public, and `tools/call`
// (used by the curated data commands) authenticates with a user API key. A
// small REST escape hatch (`health`, `get <path>`) and an OpenAPI listing
// (`list`) round it out for host-relative and self-hosted use.

export const VERSION = '0.1.3';

// Cloudflare's WAF challenges generic library User-Agents (node, curl,
// python-requests, empty) on the API edge, so we always identify ourselves.
export const USER_AGENT = `worldmonitor-cli/${VERSION} (+https://worldmonitor.app)`;

export const DEFAULT_BASE_URL = 'https://api.worldmonitor.app';
export const DEFAULT_MCP_URL = 'https://worldmonitor.app/mcp';
export const DEFAULT_SPEC_URL = 'https://worldmonitor.app/openapi.json';

// Header the API accepts for a user-issued key (alias: X-Api-Key).
export const API_KEY_HEADER = 'X-WorldMonitor-Key';

// JSON-RPC error code the MCP server returns when a call needs authentication.
export const MCP_AUTH_ERROR_CODE = -32001;

// Shown on any auth failure (MCP -32001 or a REST 401) so the fix is always one
// hint away, whichever surface the user hit.
export const AUTH_HINT =
  'Hint: this call needs a key — pass --api-key or set WORLDMONITOR_API_KEY (get one at https://worldmonitor.app/pro).';

// Thrown for bad invocations so run.mjs can exit with a distinct status (2) and
// print usage rather than a stack trace.
export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

// Ergonomic shortcuts over the highest-traffic MCP tools. Every other tool is
// reachable via `call <tool>`, so this table stays small. `args` maps positional
// arguments onto named tool arguments; anything else (`--key value`) is merged
// into the tool's arguments too, which is how `--limit`, `--jmespath`,
// `--country`, etc. flow through with no per-tool wiring.
export const CURATED_COMMANDS = {
  world: { tool: 'get_world_brief', args: [], summary: 'Live global situation brief.' },
  country: {
    tool: 'get_country_brief',
    args: [{ name: 'country_code', required: true }],
    summary: 'AI strategic brief for a country (ISO 3166-1 alpha-2 code).',
  },
  risk: {
    tool: 'get_country_risk',
    args: [{ name: 'country_code', required: true }],
    summary: 'Country risk / resilience scores (ISO 3166-1 alpha-2 code).',
  },
  markets: { tool: 'get_market_data', args: [], summary: 'Equities, commodities, crypto and FX quotes.' },
  conflicts: {
    tool: 'get_conflict_events',
    args: [],
    summary: 'Recent conflict events (--country, --min_fatalities, --limit).',
  },
  cyber: {
    tool: 'get_cyber_threats',
    args: [],
    summary: 'Cyber-threat indicators (--min_severity, --threat_type, --country).',
  },
  news: {
    tool: 'get_news_intelligence',
    args: [],
    summary: 'Classified news intelligence (--topic, --country, --alerts_only).',
  },
  disasters: {
    tool: 'get_natural_disasters',
    args: [],
    summary: 'Earthquakes, fires and storms (--dataset, --active_only, --min_magnitude).',
  },
  sanctions: {
    tool: 'get_sanctions_data',
    args: [],
    summary: 'Sanctions designations (--country, --entity_type, --query).',
  },
  forecasts: {
    tool: 'get_forecast_predictions',
    args: [],
    summary: 'Scenario forecasts (--domain, --region).',
  },
  maritime: {
    tool: 'get_maritime_activity',
    args: [{ name: 'country_code', required: true }],
    summary: 'Maritime / port activity for a country (ISO 3166-1 alpha-2 code).',
  },
};

// Flags that consume the following token as a value, mapped to their canonical
// option key. Anything else beginning with `--` is treated as an API/tool
// parameter.
const VALUE_FLAGS = new Map([
  ['api-key', 'apiKey'],
  ['apikey', 'apiKey'],
  ['key', 'apiKey'],
  ['base-url', 'baseUrl'],
  ['mcp-url', 'mcpUrl'],
  ['spec-url', 'specUrl'],
  ['args', 'args'],
  ['arg-json', 'args'],
  ['timeout', 'timeout'],
]);

const BOOL_FLAGS = new Map([
  ['raw', 'raw'],
  ['compact', 'compact'],
  ['help', 'help'],
  ['h', 'help'],
  ['version', 'version'],
  ['v', 'version'],
]);

function isFlag(token) {
  if (token.startsWith('--')) return true;
  // single-dash short flag (-h, -v) but not a negative number (-5, -1.2)
  return token.length === 2 && token[0] === '-' && !/[0-9]/.test(token[1]);
}

// Split argv into { command, positionals, options, params }. `options` holds
// recognised global flags; `params` holds every other `--key value` pair and
// becomes the request's tool arguments (MCP) or query string (REST). This is
// what makes `worldmonitor conflicts --country IR --limit 5` work with no
// per-command wiring.
export function parseArgs(argv) {
  const options = {};
  const params = {};
  const positionals = [];

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!isFlag(token)) {
      positionals.push(token);
      continue;
    }

    let name = token.replace(/^--?/, '');
    let inlineValue;
    const eq = name.indexOf('=');
    if (eq !== -1) {
      inlineValue = name.slice(eq + 1);
      name = name.slice(0, eq);
    }
    const key = name.toLowerCase();

    if (BOOL_FLAGS.has(key)) {
      options[BOOL_FLAGS.get(key)] = inlineValue === undefined ? true : inlineValue !== 'false';
      continue;
    }
    if (VALUE_FLAGS.has(key)) {
      options[VALUE_FLAGS.get(key)] = inlineValue !== undefined ? inlineValue : argv[++i];
      continue;
    }
    // Unknown flag → an API/tool parameter. A bare flag with no value is
    // recorded as boolean true.
    if (inlineValue !== undefined) params[name] = inlineValue;
    else if (i + 1 < argv.length && !isFlag(argv[i + 1])) params[name] = argv[++i];
    else params[name] = true;
  }

  const command = positionals.shift();
  return { command, positionals, options, params };
}

// Read defaults from the environment so keys and hosts don't have to be passed
// on every call.
export function resolveConfig(env = {}) {
  return {
    apiKey: env.WORLDMONITOR_API_KEY || env.WM_API_KEY,
    baseUrl: env.WORLDMONITOR_BASE_URL,
    mcpUrl: env.WORLDMONITOR_MCP_URL,
    specUrl: env.WORLDMONITOR_SPEC_URL,
  };
}

function trimTrailingSlash(url) {
  return url.replace(/\/+$/, '');
}

function baseHeaders(apiKey) {
  const headers = { 'user-agent': USER_AGENT };
  if (apiKey) headers[API_KEY_HEADER] = apiKey;
  return headers;
}

// Tool/query arguments: an explicit --args JSON object wins; otherwise the
// collected --key value params, with bare boolean flags kept as true.
function collectArgs(parsed) {
  if (parsed.options.args !== undefined) {
    try {
      return JSON.parse(parsed.options.args);
    } catch (err) {
      throw new UsageError(`--args must be valid JSON: ${err.message}`);
    }
  }
  const args = {};
  for (const [k, v] of Object.entries(parsed.params)) args[k] = v === true ? true : String(v);
  return args;
}

function mcpPlan(method, rpcParams, options, config, extra = {}) {
  const mcpUrl = options.mcpUrl || config.mcpUrl || DEFAULT_MCP_URL;
  const apiKey = options.apiKey || config.apiKey;
  const rpc = { jsonrpc: '2.0', id: 1, method };
  if (rpcParams !== undefined) rpc.params = rpcParams;
  return {
    kind: 'mcp',
    url: mcpUrl,
    method: 'POST',
    headers: {
      ...baseHeaders(apiKey),
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify(rpc),
    rpc,
    ...extra,
  };
}

function restPlan(path, params, options, config) {
  const baseUrl = trimTrailingSlash(options.baseUrl || config.baseUrl || DEFAULT_BASE_URL);
  const apiKey = options.apiKey || config.apiKey;
  const url = new URL(baseUrl + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v === true ? 'true' : String(v));
  return {
    kind: 'rest',
    url: url.toString(),
    method: 'GET',
    headers: { ...baseHeaders(apiKey), accept: 'application/json' },
  };
}

// Turn a parsed invocation into a concrete, executable plan. Returns one of:
//   { kind: 'mcp',  url, method, headers, body, rpc, needsKey? }
//   { kind: 'rest', url, method, headers }
//   { kind: 'list', specUrl, service }
// Throws UsageError for malformed input.
export function planRequest(parsed, config = {}) {
  const { command, positionals, options, params } = parsed;

  if (command === 'list' || command === 'endpoints') {
    return {
      kind: 'list',
      specUrl: options.specUrl || config.specUrl || DEFAULT_SPEC_URL,
      service: positionals[0],
    };
  }

  if (command === 'health') {
    return restPlan('/api/health', {}, options, config);
  }
  if (command === 'get') {
    const path = positionals[0];
    if (!path || !path.startsWith('/')) {
      throw new UsageError('`get` needs an API path, e.g. `worldmonitor get /api/health`');
    }
    return restPlan(path, params, options, config);
  }

  if (command === 'tools') return mcpPlan('tools/list', undefined, options, config);
  if (command === 'prompts') return mcpPlan('prompts/list', undefined, options, config);
  if (command === 'resources') return mcpPlan('resources/list', undefined, options, config);

  if (command === 'call') {
    const tool = positionals[0];
    if (!tool) {
      throw new UsageError(
        '`call` needs a tool name, e.g. `worldmonitor call get_country_risk --country_code IR`',
      );
    }
    return mcpPlan('tools/call', { name: tool, arguments: collectArgs(parsed) }, options, config, {
      needsKey: true,
    });
  }

  if (Object.hasOwn(CURATED_COMMANDS, command)) {
    const spec = CURATED_COMMANDS[command];
    const args = {};
    for (const [k, v] of Object.entries(params)) args[k] = v === true ? true : String(v);
    spec.args.forEach((a, idx) => {
      if (positionals[idx] !== undefined) args[a.name] = positionals[idx];
    });
    for (const a of spec.args) {
      if (a.required && args[a.name] === undefined) {
        throw new UsageError(`\`${command}\` needs <${a.name}>. Usage: worldmonitor ${command} <${a.name}>`);
      }
    }
    return mcpPlan('tools/call', { name: spec.tool, arguments: args }, options, config, {
      needsKey: true,
    });
  }

  throw new UsageError(`Unknown command: ${command || '(none)'}. Run \`worldmonitor --help\`.`);
}

export function formatOutput(value, options = {}) {
  if (options.raw && typeof value === 'string') return value;
  if (options.compact) return JSON.stringify(value);
  return JSON.stringify(value, null, 2);
}

// Flatten an OpenAPI document into printable operation rows, optionally scoped
// to one service (the first path segment after /api/).
export function summarizeSpec(spec, serviceFilter) {
  const paths = (spec && spec.paths) || {};
  const rows = [];
  for (const p of Object.keys(paths).sort()) {
    const match = p.match(/^\/api\/([^/]+)\/v\d+\//);
    const service = match ? match[1] : '(other)';
    if (serviceFilter && service !== serviceFilter) continue;
    for (const method of Object.keys(paths[p])) {
      if (!['get', 'post', 'put', 'delete', 'patch'].includes(method)) continue;
      rows.push({
        service,
        method: method.toUpperCase(),
        path: p,
        summary: paths[p][method].summary || '',
      });
    }
  }
  return rows;
}

export function renderListing(rows) {
  if (!rows.length) return 'No operations found.';
  const lines = rows.map(
    (r) => `${r.method.padEnd(5)} ${r.path}${r.summary ? `  — ${r.summary}` : ''}`,
  );
  return `${rows.length} operation(s):\n${lines.join('\n')}`;
}

export const HELP = `worldmonitor — command-line client for the World Monitor global-intelligence API

USAGE
  worldmonitor <command> [arguments] [--flags]

DATA COMMANDS (MCP tools/call — need --api-key)
  world                    Live global situation brief
  country <ISO>            AI strategic brief for a country (ISO alpha-2)
  risk <ISO>               Country risk / resilience scores
  markets                  Equities, commodities, crypto, FX quotes
  conflicts                Recent conflict events (--country, --limit…)
  cyber                    Cyber-threat indicators (--min_severity…)
  news                     Classified news intelligence (--topic, --country…)
  disasters                Earthquakes, fires, storms (--active_only…)
  sanctions                Sanctions designations (--country, --query…)
  forecasts                Scenario forecasts (--domain, --region…)
  maritime <ISO>           Maritime / port activity for a country

MCP
  tools                    List every MCP tool (public — no key needed)
  call <tool> [--arg val]  Call any MCP tool (--args '<json>' for typed args)
  prompts | resources      List MCP prompt / resource templates

REST
  health                   API status / health check (needs --api-key)
  get <path> [--param val] Call a raw REST path (host-relative /api/…)
  list [service]           List documented REST operations (from the live spec)

FLAGS
  --api-key <key>          User API key (or env WORLDMONITOR_API_KEY)
  --mcp-url <url>          MCP endpoint (default ${DEFAULT_MCP_URL})
  --base-url <url>         REST base (default ${DEFAULT_BASE_URL})
  --args <json>            Typed arguments object for a tool call
  --timeout <ms>           Request timeout (default 30000)
  --raw                    Print the response body verbatim
  --compact                Print single-line JSON
  -h, --help               Show this help
  -v, --version            Print version

Any other --key value pair becomes a tool/request parameter, e.g.
  worldmonitor risk IR --api-key wm_xxx
  worldmonitor conflicts --country IR --limit 5 --api-key wm_xxx
  worldmonitor call get_market_data --asset_class crypto --api-key wm_xxx
  worldmonitor tools

Get an API key at https://worldmonitor.app/pro · docs https://worldmonitor.app/docs/cli`;
