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

/**
 * Placeholder the OAuth edge stores when a client registers without a
 * client_name (api/oauth/register.js, api/oauth/authorize-pro.ts). It is no
 * signal, so it classifies as null rather than `other`.
 */
export const UNKNOWN_CLIENT_NAME = 'Unknown Client';

const MCP_GRANT_NAME_PREFIX = 'Connected via ';

/** Display name of an OAuth MCP grant row, from the client's client_name. */
export function mcpGrantName(clientName) {
  const name = typeof clientName === 'string' && clientName.trim() ? clientName : UNKNOWN_CLIENT_NAME;
  return `${MCP_GRANT_NAME_PREFIX}${name}`;
}

/**
 * AI client bucket of an OAuth MCP grant, from the row name mcpGrantName()
 * built. Both sides use this module, so the wording cannot drift apart.
 */
export function mcpGrantClientSource(grantName) {
  if (typeof grantName !== 'string') return null;
  const clientName = grantName.startsWith(MCP_GRANT_NAME_PREFIX)
    ? grantName.slice(MCP_GRANT_NAME_PREFIX.length)
    : grantName;
  return classifyAgentClient(clientName);
}

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
  if (!value || value === UNKNOWN_CLIENT_NAME.toLowerCase()) return null;
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
  return agentRefColumns(ref)?.source ?? null;
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
 * existing) or null. `storage` is injected so tests and the browser pages can
 * call it; every storage failure degrades to "no attribution", and a write is
 * read back so a silently dropped one is reported as null.
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
  return loadAgentRef(storage, now) === incoming ? incoming : null;
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
    clearAgentRef(storage);
    return null;
  }
}

/**
 * Forget the stored agent ref. Called once it has been used for an account
 * record, so a later sign-up in the same browser is not credited to it.
 */
export function clearAgentRef(storage) {
  try { storage?.removeItem(AGENT_REF_STORAGE_KEY); } catch { /* storage unavailable */ }
}

/** Parent domain the ref cookie is shared on, so every variant host sees it. */
export const AGENT_REF_COOKIE_DOMAIN = 'worldmonitor.app';

/**
 * Storage-shaped adapter over a first-party cookie holding only the agent ref.
 * A cookie rather than localStorage because sign-up can happen on another
 * origin than the one the agent link opened (www vs tech., finance., ...):
 * on worldmonitor.app hosts it is set on the parent domain, elsewhere
 * (localhost, previews) host-only. `doc` is `document` and `loc` is
 * `location`, injected so this module stays free of DOM globals.
 */
export function agentRefCookieStorage(doc, loc) {
  const hostname = typeof loc?.hostname === 'string' ? loc.hostname.toLowerCase() : '';
  const shared = hostname === AGENT_REF_COOKIE_DOMAIN || hostname.endsWith(`.${AGENT_REF_COOKIE_DOMAIN}`);
  const attributes = [
    'path=/',
    shared ? `domain=.${AGENT_REF_COOKIE_DOMAIN}` : null,
    'SameSite=Lax',
    loc?.protocol === 'https:' ? 'Secure' : null,
  ].filter(Boolean).join('; ');
  const write = (key, value, maxAgeSeconds) => {
    if (key !== AGENT_REF_STORAGE_KEY) return;
    try {
      doc.cookie = `${key}=${encodeURIComponent(value)}; max-age=${maxAgeSeconds}; ${attributes}`;
    } catch { /* cookies blocked: no attribution */ }
  };
  return {
    getItem(key) {
      if (key !== AGENT_REF_STORAGE_KEY) return null;
      try {
        const prefix = `${key}=`;
        const match = String(doc.cookie ?? '').split(';').map((part) => part.trim()).find((part) => part.startsWith(prefix));
        return match ? decodeURIComponent(match.slice(prefix.length)) : null;
      } catch {
        return null;
      }
    },
    setItem(key, value) {
      write(key, value, Math.floor(AGENT_REF_TTL_MS / 1000));
    },
    removeItem(key) {
      write(key, '', 0);
    },
  };
}

/**
 * Normalized ref and its bucket for a row that records where it came from, or
 * null when the ref is unusable. Callers map these onto their own columns.
 */
export function agentRefColumns(raw) {
  const ref = normalizeAgentRef(raw);
  if (!ref) return null;
  const rest = ref.slice(AGENT_REF_PREFIX.length).replace(/^-/, '');
  return { ref, source: rest ? classifyAgentClient(rest) : 'other' };
}
