/**
 * Which AI client a sign-up, API key or MCP connection came from.
 *
 * One vocabulary for every surface that records it, so the counts line up:
 *   - the MCP `initialize` handshake (`params.clientInfo.name`, User-Agent),
 *   - the OAuth client a user grants (`client_name` from dynamic registration),
 *   - an inbound agent link (`?ref=agent-<client>`), captured first-touch in the
 *     browser and stamped on the Convex `users` / `userApiKeys` row.
 *
 * `?ref=` is affiliate attribution elsewhere on the site (see
 * shared/referral-namespaces.ts). Agent links therefore live under the reserved
 * `agent` namespace, which referral capture rejects, so an agent link can never
 * become an `affonso_referral` code at checkout.
 *
 * Pure data and string functions: no DOM, Node or Convex imports, so the
 * dashboard, /pro, Convex, the MCP edge handler and the /agent page generator
 * can all import it.
 */

/** Buckets reported in counts. Order is display order. */
export const AGENT_CLIENT_SOURCES = Object.freeze([
  'claude',
  'chatgpt',
  'cursor',
  'gemini',
  'grok-bot',
  'other',
]);

/**
 * Matchers, checked in order against a lowercased client name, User-Agent or
 * ref. First match wins, so the more specific product names come first.
 * Grok Bot and grok.com connectors both land in `grok-bot`.
 */
const CLIENT_MATCHERS = Object.freeze([
  ['claude', /claude|anthropic/],
  ['chatgpt', /chatgpt|openai/],
  ['cursor', /cursor/],
  ['gemini', /gemini/],
  ['grok-bot', /grok/],
]);

/** Prefix that marks an inbound agent link: `?ref=agent-claude`. */
export const AGENT_REF_PREFIX = 'agent';

/**
 * Accepted shape of a `?ref=` value under the agent namespace. Bounded and
 * charset-restricted before it is stored anywhere or rendered.
 */
export const AGENT_REF_PATTERN = /^agent(?:-[a-z0-9]{1,24}){0,2}$/;

/** localStorage key for the first-touch agent ref. */
export const AGENT_REF_STORAGE_KEY = 'wm-agent-ref';

/** First-touch window. A sign-up after this is no longer credited. */
export const AGENT_REF_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Longest client name kept in telemetry. */
export const MAX_CLIENT_NAME_LENGTH = 64;

/**
 * Normalize a raw `?ref=` value. Returns the lowercased ref when it is under
 * the agent namespace, otherwise null (an affiliate code, a `welcome-*` tag or
 * garbage is not an agent ref).
 */
export function normalizeAgentRef(raw) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  if (value.length === 0 || value.length > 64) return null;
  return AGENT_REF_PATTERN.test(value) ? value : null;
}

/**
 * Classify any client hint (MCP clientInfo.name, OAuth client_name,
 * User-Agent, or an agent ref) into a bucket. Returns null when there is no
 * usable hint at all, so "no signal" is never counted as "other".
 */
export function classifyAgentClient(hint) {
  if (typeof hint !== 'string') return null;
  const value = hint.trim().toLowerCase().slice(0, 512);
  if (!value) return null;
  for (const [source, pattern] of CLIENT_MATCHERS) {
    if (pattern.test(value)) return source;
  }
  return 'other';
}

/**
 * Classify the first hint that yields a bucket other than `other`, falling back
 * to `other` when some hint was present, or null when none was. Used where the
 * MCP client name and the User-Agent can disagree in specificity (a generic SDK
 * name with a branded UA, or the reverse).
 */
export function classifyAgentClientHints(hints) {
  let sawHint = false;
  for (const hint of hints) {
    const source = classifyAgentClient(hint);
    if (source === null) continue;
    sawHint = true;
    if (source !== 'other') return source;
  }
  return sawHint ? 'other' : null;
}

/** Bucket for an agent ref (`agent-claude` -> `claude`, `agent` -> `other`). */
export function agentSourceFromRef(ref) {
  const normalized = normalizeAgentRef(ref);
  if (!normalized) return null;
  const rest = normalized.slice(AGENT_REF_PREFIX.length).replace(/^-/, '');
  return rest ? classifyAgentClient(rest) : 'other';
}

/**
 * Trim an MCP clientInfo.name for logging: bounded, printable ASCII only, so a
 * hostile client cannot inject control characters or bloat each log line.
 */
export function sanitizeClientName(raw) {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.replace(/[^\x20-\x7e]/g, '').trim().slice(0, MAX_CLIENT_NAME_LENGTH);
  return cleaned || null;
}

/**
 * Read an agent ref from a URL search string and store it first-touch.
 * Never overwrites an unexpired earlier ref. Returns the stored ref (new or
 * existing) or null. `storage` is injected so tests and both browser apps can
 * call it; every storage failure degrades to "no attribution".
 */
export function captureAgentRefFromSearch(search, storage, now = Date.now()) {
  if (typeof search !== 'string' || !storage) return null;
  let refs;
  try {
    refs = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search).getAll('ref');
  } catch {
    return null;
  }
  const incoming = refs.map(normalizeAgentRef).find(Boolean) ?? null;
  const existing = loadAgentRef(storage, now);
  if (existing) return existing;
  if (!incoming) return null;
  try {
    storage.setItem(AGENT_REF_STORAGE_KEY, JSON.stringify({ ref: incoming, capturedAt: now }));
  } catch {
    return null;
  }
  return incoming;
}

/** Read the stored first-touch agent ref, clearing it when stale or malformed. */
export function loadAgentRef(storage, now = Date.now()) {
  if (!storage) return null;
  try {
    const raw = storage.getItem(AGENT_REF_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const ref = normalizeAgentRef(parsed?.ref);
    if (!ref || typeof parsed.capturedAt !== 'number' || now - parsed.capturedAt > AGENT_REF_TTL_MS || parsed.capturedAt > now + 60_000) {
      storage.removeItem(AGENT_REF_STORAGE_KEY);
      return null;
    }
    return ref;
  } catch {
    try { storage.removeItem(AGENT_REF_STORAGE_KEY); } catch { /* storage unavailable */ }
    return null;
  }
}
