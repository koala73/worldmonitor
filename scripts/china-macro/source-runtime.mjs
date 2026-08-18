import { createRequire } from 'node:module';

const {
  parseProxyConfigForAttempt,
  proxyFetch,
} = createRequire(import.meta.url)('../_proxy-utils.cjs');

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_RETRY_DELAY_MS = 1_000;
export const FETCH_TIMEOUT_MS = 12_000;
// Exit nodes to try before giving up. Four covers the measured ~6% per-exit
// failure rate against NBS with room to spare; more would trade wall time for
// nothing, since a host the proxy genuinely cannot reach fails on every exit.
export const PROXY_EXIT_ATTEMPTS = 4;
// Wall-clock cap for the whole fallback on ONE fetchText call. Five NBS hops
// (robots + listing + 3 articles) at 16s is 80s, which leaves China-Macro's
// 240s seed-bundle timeout room for SAFE/PBOC/GACC. A live 12s per exit
// without this cap would be 4*12s*5 = 240s of NBS alone.
export const PROXY_FALLBACK_BUDGET_MS = 16_000;
const PROXY_BUDGET_FLOOR_MS = 250;

const PROXY_RETRYABLE_CODES = new Set([
  'EAI_AGAIN',
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
  'ETIMEDOUT',
  'UND_ERR_CONNECT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

function sourceContractError(message) {
  return Object.assign(new Error(`SOURCE_CONTRACT_VIOLATION:${message}`), {
    code: 'SOURCE_CONTRACT_VIOLATION',
    publicReason: message,
    nonRetryable: true,
  });
}

function validateSourceUrl(value, policy) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw sourceContractError('INVALID_URL');
  }
  if (
    url.protocol !== 'https:'
    || url.origin !== policy.origin
    || url.username
    || url.password
    || !policy.path(url.pathname)
  ) {
    throw sourceContractError('UNAPPROVED_URL');
  }
  return url;
}

/**
 * Should a failed DIRECT fetch be retried through the configured proxy?
 *
 * Only connection-level failures qualify. The publisher answering — any HTTP
 * status, 403 and 429 included — is a real answer and belongs to the caller's
 * own status handling; re-asking it from a second egress point would be evading
 * the publisher's decision rather than routing around a network block, and only
 * the latter is in scope. fetch() does not throw on status, so those never
 * arrive here anyway; this is a statement of intent for whoever widens it next.
 *
 * Also excluded: our own contract guard (the URL/redirect/size rejection is not
 * a transport problem), a caller-initiated abort, and TLS chain failures, which
 * fetchText already treats as permanent and which a different route would hit
 * identically.
 */
export function shouldRetryViaProxy(error) {
  if (error?.code === 'SOURCE_CONTRACT_VIOLATION') return false;
  if (Number.isInteger(error?.status) || Number.isInteger(error?.cause?.status)) return false;
  if (
    /^HTTP_\d{3}$/.test(String(error?.code ?? ''))
    || /^HTTP_\d{3}$/.test(String(error?.message ?? ''))
  ) return false;
  // Caller abort only. AbortSignal.timeout surfaces as TimeoutError in Node 24
  // and is retryable below — a hang is the blocked-egress shape this hop exists
  // for. fetchText does not accept an external signal today.
  if (error?.name === 'AbortError') return false;
  if (
    error?.code === 'SELF_SIGNED_CERT_IN_CHAIN'
    || error?.cause?.code === 'SELF_SIGNED_CERT_IN_CHAIN'
    || /self signed certificate|certificate chain/i.test(
      `${String(error?.message)} ${String(error?.cause?.message)}`,
    )
  ) return false;
  if (error?.name === 'TimeoutError') return true;
  const code = error?.code || error?.cause?.code;
  if (PROXY_RETRYABLE_CODES.has(code)) return true;
  if (/fetch failed/i.test(String(error?.message ?? ''))) return true;
  return false;
}

/**
 * The same declared request, from a different egress point.
 *
 * Measured 2026-08-18: www.stats.gov.cn answers this exact client normally from
 * a laptop (HTTP 200, ~12 KiB index, ~164 KiB article) while Railway's egress
 * cannot open the connection at all. The seeder reported FETCH_FAILED rather
 * than TIMEOUT or HTTP_nnn, which is what identifies it as connection-level
 * rather than the publisher refusing us. All three required NBS series sat on
 * preserved values while the seeder itself kept publishing, so
 * seed-meta:economic:china-macro-transport froze at 2026-08-14 and health read
 * STALE_SEED off a key the seeder had never stopped updating.
 *
 * Headers are forwarded UNCHANGED on purpose: the same declared User-Agent and
 * Accept-Language reaching the publisher over a different route, not a
 * different client. `location` is carried across because fetchText does its own
 * `redirect: 'manual'` handling and would otherwise lose the hop.
 */
async function fetchThroughProxy(target, init, proxyUrl, {
  proxyFetchFn = proxyFetch,
  now = Date.now,
} = {}) {
  let lastError = null;
  // Rotate exits. parseProxyConfigForAttempt maps the attempt index onto a
  // different gateway port and therefore a different exit node, and individual
  // exits fail this host intermittently: measured 2026-08-18 over 18 single
  // attempts against www.stats.gov.cn, 17 returned the real page (12017 bytes,
  // byte-identical to a direct fetch) and one failed CONNECT with 522, while
  // rotating across four indices succeeded 5 of 5 rounds. A single fixed
  // attempt would carry that ~6% per-request failure into all five NBS fetches
  // and lose roughly a quarter of runs.
  //
  // A rotation step is FREE against the request budget on purpose: a 522 from
  // the gateway means the tunnel was never established, so the publisher was
  // never contacted and no load was placed on it. The budget bounds load on the
  // source, not attempts made on our side. Wall-clock is a separate cap
  // (PROXY_FALLBACK_BUDGET_MS) so four live 12s exits cannot blow the seeder.
  const deadlineAt = now() + PROXY_FALLBACK_BUDGET_MS;
  for (let attempt = 0; attempt < PROXY_EXIT_ATTEMPTS; attempt += 1) {
    const remainingMs = deadlineAt - now();
    if (remainingMs < PROXY_BUDGET_FLOOR_MS) break;
    const proxyConfig = parseProxyConfigForAttempt(proxyUrl, attempt);
    if (!proxyConfig) return null;
    const timeoutMs = Math.min(FETCH_TIMEOUT_MS, remainingMs);
    // Fresh deadline per exit. Reusing the direct fetch's AbortSignal.timeout
    // leaves signal.aborted === true after a hang, and proxyFetch then rejects
    // immediately — the hop this fallback exists for.
    const signal = AbortSignal.timeout(timeoutMs);
    let result;
    try {
      result = await proxyFetchFn(String(target), proxyConfig, {
        headers: init?.headers,
        method: init?.method || 'GET',
        maxResponseBytes: MAX_RESPONSE_BYTES,
        timeoutMs,
        signal,
      });
    } catch (error) {
      lastError = error;
      continue;
    }
    if (result.buffer.byteLength > MAX_RESPONSE_BYTES) {
      throw sourceContractError('RESPONSE_TOO_LARGE');
    }
    const retryAfter = result.headers?.['retry-after'] ?? result.headers?.['Retry-After'];
    return new Response(result.buffer, {
      status: result.status,
      headers: {
        ...(result.location ? { Location: result.location } : {}),
        'Content-Type': result.contentType || 'text/html',
        'Content-Length': String(result.buffer.byteLength),
        ...(retryAfter ? { 'Retry-After': String(retryAfter) } : {}),
      },
    });
  }
  if (lastError) throw lastError;
  return null;
}

export function requestBudget(maxRequests) {
  let count = 0;
  return {
    consume() {
      if (count >= maxRequests) throw sourceContractError('REQUEST_BUDGET_EXCEEDED');
      count += 1;
    },
    get count() {
      return count;
    },
  };
}

function retryDelayMs(response) {
  const raw = response?.headers?.get('Retry-After');
  if (!raw) return 100;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const retryAt = Date.parse(raw);
  return Number.isFinite(retryAt) ? Math.max(0, retryAt - Date.now()) : 100;
}

async function waitForRetry(response) {
  const delayMs = retryDelayMs(response);
  if (delayMs > MAX_RETRY_DELAY_MS) return false;
  if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  return true;
}

export async function fetchText(fetchFn, value, {
  policy,
  budget,
  onRedirect = () => {},
  assertTargetAllowed = () => {},
  // Opt-in per publisher. Null, or an unset PROXY_URL, leaves this path
  // byte-for-byte unchanged — a source reachable directly never grows a hop.
  proxyUrl = null,
  onProxyFallback = () => {},
  proxyFetchFn = proxyFetch,
  now = Date.now,
}) {
  let target = validateSourceUrl(value, policy);
  assertTargetAllowed(target);
  let redirected = false;
  let redirects = 0;
  let transientRetries = 0;
  const usableProxy = Boolean(proxyUrl && parseProxyConfigForAttempt(proxyUrl, 0));
  for (;;) {
    budget.consume();
    let response;
    let fromProxy = false;
    // User-Agent URL must stay on a line adjacent to fetchFn so the
    // source-attribution scanner still records this file.
    const requestInit = {
      headers: {
        Accept: 'text/html,text/plain;q=0.9,*/*;q=0.1',
        'Accept-Language': 'en,zh-CN;q=0.8',
        'User-Agent': 'WorldMonitor/2.10 (+https://worldmonitor.app)',
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    };
    try {
      response = await fetchFn(target.toString(), requestInit);
    } catch (error) {
      const permanentTls = error?.code === 'SELF_SIGNED_CERT_IN_CHAIN'
        || error?.cause?.code === 'SELF_SIGNED_CERT_IN_CHAIN'
        || /self signed certificate|certificate chain/i.test(
          `${String(error?.message)} ${String(error?.cause?.message)}`,
        );
      let proxyAttempted = false;
      if (usableProxy && shouldRetryViaProxy(error)) {
        try {
          // Deliberately NO second budget.consume() here.
          //
          // The budget bounds load placed on the PUBLISHER, and a connection-
          // level failure never reached it — no socket, no request, no load. The
          // proxied attempt is the same logical request finally arriving, so it
          // is covered by the unit this iteration already consumed at the top of
          // the loop.
          //
          // Counting it twice is not merely pedantic: NBS_MAX_REQUESTS_PER_RUN
          // is 8 and a run makes 5 NBS fetches (robots + listing + 3 articles).
          // On Railway the direct attempt fails every time, so double-counting
          // needs 10 and trips REQUEST_BUDGET_EXCEEDED — the fix would have
          // failed for a different reason than the one it fixes.
          const proxied = await fetchThroughProxy(target, requestInit, proxyUrl, {
            proxyFetchFn,
            now,
          });
          proxyAttempted = true;
          if (proxied) {
            onProxyFallback({ url: target.toString(), directReason: reasonFor(error) });
            response = proxied;
            fromProxy = true;
          }
        } catch (proxyError) {
          proxyAttempted = true;
          // A contract violation from the proxied response is ours and must
          // surface. Anything else falls through carrying the ORIGINAL error —
          // reporting the proxy's failure instead would bury why the direct
          // route failed, which is the diagnosis that matters.
          if (proxyError?.code === 'SOURCE_CONTRACT_VIOLATION') throw proxyError;
        }
      }
      if (!response) {
        // A configured proxy already had its chance. A second direct cycle on
        // a host Railway cannot open only doubles wall-clock.
        if (
          !proxyAttempted
          && transientRetries === 0
          && !permanentTls
          && error?.code !== 'SOURCE_CONTRACT_VIOLATION'
        ) {
          transientRetries += 1;
          await waitForRetry();
          continue;
        }
        throw error;
      }
    }
    if (response.status >= 300 && response.status < 400) {
      onRedirect('encountered');
      if (redirects >= 1) {
        onRedirect('rejected');
        throw sourceContractError('REDIRECT_LIMIT_EXCEEDED');
      }
      const location = response.headers.get('Location');
      if (!location) {
        onRedirect('rejected');
        throw sourceContractError('REDIRECT_WITHOUT_LOCATION');
      }
      try {
        target = validateSourceUrl(new URL(location, target).toString(), policy);
        assertTargetAllowed(target);
      } catch (error) {
        onRedirect('rejected');
        if (error?.publicReason === 'ROBOTS_DISALLOW') throw error;
        if (error?.code === 'SOURCE_CONTRACT_VIOLATION') {
          throw sourceContractError(`REDIRECT_REJECTED_${error.publicReason}`);
        }
        throw error;
      }
      redirected = true;
      redirects += 1;
      transientRetries = 0;
      onRedirect('followed');
      continue;
    }
    if (response.redirected) {
      onRedirect('rejected');
      throw sourceContractError('IMPLICIT_REDIRECT');
    }
    if (!response.ok) {
      const error = Object.assign(new Error(`HTTP_${response.status}`), { status: response.status });
      // A proxied 403/429 is the publisher answering through the tunnel.
      // Re-entering the direct+proxy ladder would be a second ask.
      if (
        !fromProxy
        && transientRetries === 0
        && (response.status === 408 || response.status === 429 || response.status >= 500)
        && await waitForRetry(response)
      ) {
        transientRetries += 1;
        continue;
      }
      throw error;
    }
    const declaredLength = Number(response.headers.get('Content-Length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
      throw sourceContractError('RESPONSE_TOO_LARGE');
    }
    let text;
    if (response.body?.getReader) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const chunks = [];
      let received = 0;
      try {
        for (;;) {
          const { done, value: chunk } = await reader.read();
          if (done) break;
          received += chunk.byteLength;
          if (received > MAX_RESPONSE_BYTES) {
            await reader.cancel('response exceeds China macro source limit');
            throw sourceContractError('RESPONSE_TOO_LARGE');
          }
          chunks.push(decoder.decode(chunk, { stream: true }));
        }
        chunks.push(decoder.decode());
        text = chunks.join('');
      } finally {
        reader.releaseLock();
      }
    } else {
      text = await response.text();
      if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
        throw sourceContractError('RESPONSE_TOO_LARGE');
      }
    }
    return {
      text,
      redirected,
      url: target.toString(),
    };
  }
}

export function reasonFor(error) {
  if (error?.code === 'SOURCE_CONTRACT_VIOLATION') return error.publicReason;
  if (Number.isInteger(error?.status)) return `HTTP_${error.status}`;
  if (
    error?.code === 'SELF_SIGNED_CERT_IN_CHAIN'
    || error?.cause?.code === 'SELF_SIGNED_CERT_IN_CHAIN'
    || /self signed certificate|certificate chain/i.test(
      `${String(error?.message)} ${String(error?.cause?.message)}`,
    )
  ) return 'TLS_CERTIFICATE_ERROR';
  if (error?.name === 'TimeoutError' || /timeout/i.test(String(error?.message))) return 'TIMEOUT';
  if (/MALFORMED_RELEASE/.test(String(error?.message))) return 'SCHEMA_DRIFT';
  return 'FETCH_FAILED';
}

export function findReleaseUrl(html, baseUrl, titlePattern, label, policy) {
  const anchorPattern = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(anchorPattern)) {
    const title = String(match[2]).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (titlePattern.test(title)) {
      return validateSourceUrl(new URL(match[1], baseUrl).toString(), policy).toString();
    }
  }
  throw new Error(`MALFORMED_RELEASE:${label}_LINK`);
}

function robotsGroups(text) {
  const groups = [];
  let current = { agents: [], rules: [] };
  let groupHasDirectives = false;
  const finishGroup = () => {
    if (current.agents.length > 0) groups.push(current);
    current = { agents: [], rules: [] };
    groupHasDirectives = false;
  };
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const separator = line.indexOf(':');
    if (separator < 0) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (field === 'user-agent') {
      if (groupHasDirectives) finishGroup();
      current.agents.push(value.toLowerCase());
      continue;
    }
    if (current.agents.length === 0) continue;
    groupHasDirectives = true;
    if ((field === 'allow' || field === 'disallow') && value) {
      current.rules.push({ kind: field, path: value });
    }
  }
  finishGroup();
  return groups;
}

function robotsDisallowPaths(text, candidatePaths) {
  const groups = robotsGroups(text);
  const crawler = 'worldmonitor';
  const specific = groups.filter((group) => (
    group.agents.some((agent) => agent !== '*' && crawler.startsWith(agent))
  ));
  const applicable = specific.length > 0
    ? specific
    : groups.filter((group) => group.agents.includes('*'));
  const rules = applicable.flatMap((group) => group.rules);
  return candidatePaths.some((candidatePath) => {
    const matches = rules
      .filter((rule) => candidatePath.startsWith(rule.path))
      .sort((left, right) => (
        right.path.length - left.path.length
        || (left.kind === 'allow' ? -1 : 1)
      ));
    return matches[0]?.kind === 'disallow';
  });
}

export function robotsDisallowAll(text) {
  return robotsDisallowPaths(text, ['/']);
}

export function assertRobotsAllowed(text, candidatePaths) {
  if (robotsDisallowPaths(text, candidatePaths)) {
    throw sourceContractError('ROBOTS_DISALLOW');
  }
}

export async function checkRobots(fetchFn, url, options) {
  try {
    const result = await fetchText(fetchFn, url, options);
    assertRobotsAllowed(result.text, options.candidatePaths ?? ['/']);
    return { status: 'allows_candidate_paths', text: result.text };
  } catch (error) {
    if (error?.status === 404) return { status: 'no_rules_published', text: '' };
    throw error;
  }
}
