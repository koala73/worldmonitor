/**
 * Per-host commerce policy.
 *
 * ChatGPT's app guidelines allow a paid product: a user may sign in to a paid
 * account, and an app may say a feature is not on the current plan and link a
 * page that describes the plans. They forbid starting a checkout, linking to
 * one, and promoting an upgrade
 * (https://developers.openai.com/apps-sdk/app-submission-guidelines,
 * "Commerce and monetization").
 *
 * So for ChatGPT the server hides `start_upgrade` (it returns a checkout link),
 * drops the checkout hint from denials and rewrites their copy to state the
 * plan fact. Plan gating, limits and the plans page link (`upgradeUrl`, /pro)
 * stay the same. Every other client keeps the in-flow upgrade from #9144.
 */

import { START_UPGRADE_TOOL } from './checkout';
import { INFORM_ONLY_MESSAGES, informOnlyNextStep, type McpDenialReason } from './upgrade';

/**
 * ChatGPT sends `openai-mcp/<version>` on every MCP request, plain or followed
 * by ` (ChatGPT)`. The Codex CLI sends the same product token followed by
 * ` (Codex)`; it is not a ChatGPT app surface, so it keeps the default.
 * Observed in wm_api_usage over 2026-10-03..2026-11-02.
 */
export function isChatGptHost(req: Request): boolean {
  const userAgent = req.headers.get('User-Agent') ?? '';
  return /^openai-mcp\//i.test(userAgent) && !/\(codex\)/i.test(userAgent);
}

/**
 * The Codex CLI sends `codex-mcp-client/<version>` or `openai-mcp/<version> (Codex)`.
 * Neither opens a sign-in window on its own: the user runs
 * `codex mcp login worldmonitor`.
 */
export function isCodexClient(req: Request): boolean {
  const userAgent = req.headers.get('User-Agent') ?? '';
  return /codex-mcp-client\//i.test(userAgent) || /\(codex\)/i.test(userAgent);
}

/**
 * Claude Code sends `claude-code/<version> (...)`. Since the connect-time
 * challenge it shows the server as needing auth until the user runs `/mcp`
 * and chooses Authenticate.
 */
export function isClaudeCodeClient(req: Request): boolean {
  const userAgent = req.headers.get('User-Agent') ?? '';
  return /^claude-code\//i.test(userAgent);
}

/**
 * The sign-in step for clients that do not start OAuth by themselves after the
 * anonymous 401. `null` for every other client: its generic `nextStep` stands.
 */
export function connectInstruction(req: Request): string | null {
  if (isCodexClient(req)) {
    return 'Run `codex mcp login worldmonitor` in a terminal, then restart Codex. A free World Monitor account works.';
  }
  if (isClaudeCodeClient(req)) {
    return 'In Claude Code run /mcp, select worldmonitor and choose Authenticate. A free World Monitor account works.';
  }
  return null;
}

/** Tools a ChatGPT request never sees or reaches. */
export const CHATGPT_HIDDEN_TOOLS: ReadonlySet<string> = new Set([START_UPGRADE_TOOL]);

const DENIAL_REASONS: ReadonlySet<string> = new Set<McpDenialReason>([
  'no-account',
  'allowance-exhausted',
  'upgrade-required',
  'lapsed-subscription',
  'quota-exceeded',
]);

function rewriteError(message: unknown): boolean {
  if (!message || typeof message !== 'object') return false;
  const error = (message as { error?: unknown }).error;
  if (!error || typeof error !== 'object') return false;
  const err = error as { message?: unknown; data?: unknown };
  const data = err.data as Record<string, unknown> | undefined;
  if (!data || typeof data !== 'object' || typeof data.reason !== 'string' || !DENIAL_REASONS.has(data.reason)) return false;

  data.nextStep = informOnlyNextStep({
    reason: data.reason as McpDenialReason,
    sharedWithRestApi: data.sharedWithRestApi === true,
    allowance: data.allowance,
  });
  delete data.recommendedPlan;
  delete data.checkoutTool;
  if (typeof err.message === 'string') err.message = INFORM_ONLY_MESSAGES.get(err.message) ?? err.message;
  return true;
}

/**
 * Rewrite a structured account-access denial for ChatGPT. Runs on the JSON
 * response before any SSE framing or modern-era shaping. Denials are never
 * SSE-framed (only HTTP 200 is), so every denial path passes through here.
 * Anything that is not a structured denial is returned untouched.
 */
export async function applyChatGptCommercePolicy(res: Response): Promise<Response> {
  if (res.status === 200 || res.body === null) return res;
  if (!/application\/json/i.test(res.headers.get('Content-Type') ?? '')) return res;
  const text = await res.clone().text();
  if (!text.includes('"reason"')) return res;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return res;
  }
  const changed = Array.isArray(parsed)
    ? parsed.map(rewriteError).some(Boolean)
    : rewriteError(parsed);
  if (!changed) return res;

  const body = JSON.stringify(parsed);
  const headers = new Headers(res.headers);
  if (headers.has('Content-Length')) headers.set('Content-Length', String(new TextEncoder().encode(body).byteLength));
  return new Response(body, { status: res.status, statusText: res.statusText, headers });
}
