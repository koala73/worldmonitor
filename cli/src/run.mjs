// Network + IO wrapper around the pure logic in ./core.mjs. `run()` takes an
// injectable IO bag (fetch/env/stdout/stderr) so it can be exercised offline in
// tests, and returns a numeric exit code:
//   0 success · 1 request/transport error · 2 usage error
import {
  API_KEY_HEADER,
  AUTH_HINT,
  DEFAULT_SPEC_URL,
  HELP,
  MCP_AUTH_ERROR_CODE,
  USER_AGENT,
  UsageError,
  VERSION,
  dashboardOptions,
  formatOutput,
  parseArgs,
  planRequest,
  renderListing,
  resolveConfig,
  summarizeSpec,
} from './core.mjs';

const DEFAULT_TIMEOUT_MS = 30000;

// MCP responses may arrive as Server-Sent Events (Streamable HTTP). Pull the
// last `data:` payload; otherwise parse the whole body as JSON, falling back to
// the raw text when it is not JSON at all.
function parseBody(text, headers) {
  const contentType = (headers && headers.get && headers.get('content-type')) || '';
  let payload = text;
  if (contentType.includes('text/event-stream') || /^(event|data):/m.test(text)) {
    const dataLines = text
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim());
    payload = dataLines[dataLines.length - 1] || '';
  }
  if (!payload) return text;
  try {
    return JSON.parse(payload);
  } catch {
    return text;
  }
}

async function withTimeout(timeoutOpt, fn) {
  const ms = Number(timeoutOpt) > 0 ? Number(timeoutOpt) : DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`request timed out after ${ms}ms`)), ms);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

// The default spec URL redirects (apex -> www), so spec fetches follow
// redirects by hand: the key (a self-hosted spec may be protected) is kept only
// while the redirect stays on the original origin.
async function fetchSpec(fetchImpl, specUrl, headers, signal) {
  const origin = new URL(specUrl).origin;
  let url = specUrl;
  for (let hops = 0; ; hops++) {
    const hopHeaders = { ...headers };
    if (new URL(url).origin !== origin) delete hopHeaders[API_KEY_HEADER];
    const res = await fetchImpl(url, { headers: hopHeaders, redirect: 'manual', signal });
    const location = res.status >= 300 && res.status < 400 && res.headers.get('location');
    if (!location || hops === 5) return res;
    await res.body?.cancel();
    url = new URL(location, url).toString();
  }
}

export async function run(argv, io = {}) {
  const fetchImpl = io.fetch || globalThis.fetch;
  const env = io.env || (typeof process !== 'undefined' ? process.env : {});
  const stdout = io.stdout || ((s) => process.stdout.write(s));
  const stderr = io.stderr || ((s) => process.stderr.write(s));

  const fail = (err) => {
    if (err instanceof UsageError) {
      stderr(`Error: ${err.message}\n`);
      return 2;
    }
    stderr(`Error: ${err && err.message ? err.message : String(err)}\n`);
    return 1;
  };

  const parsed = parseArgs(argv);
  const { command, options } = parsed;

  if (options.version) {
    stdout(`${VERSION}\n`);
    return 0;
  }
  // A bare `worldmonitor` on an interactive terminal opens the dashboard; in a
  // pipe or script it keeps printing help so existing automation is unchanged.
  const interactive = io.isTTY !== undefined ? io.isTTY : Boolean(process.stdout.isTTY && process.stdin.isTTY);
  // `--help` always prints help, even after `tui` or `web`.
  const wantsTui = !options.help && (command === 'tui' || command === 'dashboard' || (!command && interactive));
  if (wantsTui) {
    if (!interactive && !env.WM_TUI_FORCE) {
      stderr('The dashboard needs an interactive terminal. Run `worldmonitor tui` from a terminal, or see --help.\n');
      return 2;
    }
    try {
      const launch = io.launchTui || (await import('./tui/index.mjs')).launchTui;
      return await launch({ options: dashboardOptions(parsed), config: resolveConfig(env), env, fetchImpl: io.fetch });
    } catch (err) {
      return fail(err);
    }
  }
  if (command === 'web' && !options.help) {
    try {
      const runWeb = io.runWeb || (await import('./tui/web.mjs')).runWeb;
      return await runWeb({ options: dashboardOptions(parsed), stdout, stderr, env });
    } catch (err) {
      return fail(err);
    }
  }
  if (options.help || !command || command === 'help') {
    stdout(`${HELP}\n`);
    return 0;
  }

  try {
    if (!fetchImpl) {
      throw new Error('global fetch is unavailable — Node 18+ is required');
    }

    const config = resolveConfig(env);
    const plan = planRequest(parsed, config);

    if (plan.kind === 'list') {
      const specUrl = plan.specUrl || DEFAULT_SPEC_URL;
      const headers = { 'user-agent': USER_AGENT, accept: 'application/json' };
      const apiKey = options.apiKey || config.apiKey;
      if (apiKey) headers[API_KEY_HEADER] = apiKey;
      const res = await withTimeout(options.timeout, (signal) => fetchSpec(fetchImpl, specUrl, headers, signal));
      const spec = parseBody(await res.text(), res.headers);
      if (!res.ok) {
        stderr(`${formatOutput(spec, options)}\n`);
        if (res.status === 401) stderr(`${AUTH_HINT}\n`);
        return 1;
      }
      stdout(`${renderListing(summarizeSpec(spec, plan.service))}\n`);
      return 0;
    }

    const res = await withTimeout(options.timeout, (signal) =>
      // redirect: 'manual' — fetch forwards X-WorldMonitor-Key to a redirect
      // target on any host. The 3xx is reported as a failed request instead.
      fetchImpl(plan.url, { method: plan.method, headers: plan.headers, body: plan.body, redirect: 'manual', signal }),
    );
    const value = parseBody(await res.text(), res.headers);

    if (plan.kind === 'mcp') {
      if (value && typeof value === 'object' && value.error && typeof value.error === 'object') {
        stderr(`${formatOutput(value.error, options)}\n`);
        if (value.error.code === MCP_AUTH_ERROR_CODE) {
          stderr(`${AUTH_HINT}\n`);
        }
        return 1;
      }
      if (!res.ok) {
        stderr(`${formatOutput(value, options)}\n`);
        if (res.status === 401) stderr(`${AUTH_HINT}\n`);
        return 1;
      }
      const result = value && typeof value === 'object' && 'result' in value ? value.result : value;
      stdout(`${formatOutput(result, options)}\n`);
      return 0;
    }

    // plan.kind === 'rest'
    if (!res.ok) {
      stderr(`${formatOutput(value, options)}\n`);
      if (res.status === 401) stderr(`${AUTH_HINT}\n`);
      return 1;
    }
    stdout(`${formatOutput(value, options)}\n`);
    return 0;
  } catch (err) {
    return fail(err);
  }
}

export default run;
