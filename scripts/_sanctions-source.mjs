import {
  CHROME_UA,
  httpRetryError,
  isRetryableHttpStatus,
  sleep,
} from './_seed-utils.mjs';
import {
  parseProxyConfigForAttempt,
  proxyFetch,
} from './_proxy-utils.cjs';

const OFAC_ACCEPT = 'application/xml, text/xml, */*';
// Native fetch keeps its signal attached while the caller streams the body, so
// the headers and the 128 MB SDN body get separate deadlines on one controller.
const OFAC_HEADER_TIMEOUT_MS = 45_000;
const OFAC_BODY_TIMEOUT_MS = 120_000;
const OFAC_MIN_BODY_TIMEOUT_MS = 1_000;
const OFAC_PROXY_TIMEOUT_MS = 10_000;
const OFAC_PROXY_BOOTSTRAP_MAX_BYTES = 64 * 1024;
const OFAC_DIRECT_MAX_ATTEMPTS = 2;
const OFAC_PROXY_MAX_ATTEMPTS = 3;
const OFAC_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const OFAC_SIGNED_DOWNLOAD_HOST = 'wc2h-sls-prod-public-published.s3.us-gov-west-1.amazonaws.com';

export function resolveOfacProxyUrl(env = process.env) {
  return env.OFAC_PROXY_URL || env.PROXY_URL || '';
}

function isRetryableProxyBootstrapStatus(status) {
  // A different residential exit can recover an origin-level 403. A proxy
  // CONNECT 407 is thrown separately with `proxyConnect: true` and is not
  // retried, because rotating an exit cannot repair credentials.
  return status === 403 || isRetryableHttpStatus(status);
}

function nonRetryableError(message) {
  return Object.assign(new Error(message), { nonRetryable: true });
}

// Undici reports every socket failure as "fetch failed"; the code on its cause
// (ECONNREFUSED, ENOTFOUND, UND_ERR_CONNECT_TIMEOUT, ...) says which one.
export function describeFetchError(error) {
  const message = error?.message || String(error);
  const code = error?.cause?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]*$/.test(code) ? `${message} (${code})` : message;
}

function terminalFetchError(error) {
  if (error && typeof error === 'object') {
    error.nonRetryable = true;
    try { error.message = describeFetchError(error); } catch { /* frozen message keeps its text */ }
    return error;
  }
  return nonRetryableError(String(error));
}

function timeoutError() {
  return new DOMException('The operation was aborted due to timeout', 'TimeoutError');
}

// Returns the time left before the caller's deadline, or throws once too little
// is left to start another wait.
function budgetMs(remainingMs, lastError) {
  const remaining = remainingMs();
  if (remaining > OFAC_MIN_BODY_TIMEOUT_MS) return remaining;
  const suffix = lastError ? ` after ${describeFetchError(lastError)}` : '';
  throw Object.assign(nonRetryableError(`OFAC fetch deadline reached${suffix}`), { deadlineReached: true });
}

async function fetchDirectWithRetry(url, {
  bodyTimeoutMs,
  fetchFn,
  headerTimeoutMs,
  maxAttempts,
  remainingMs,
  sleepFn,
}) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const headerBudgetMs = Math.min(headerTimeoutMs, budgetMs(remainingMs, lastError));
    const controller = new AbortController();
    const headerTimer = setTimeout(() => controller.abort(timeoutError()), headerBudgetMs);
    try {
      const response = await fetchFn(url, {
        headers: { 'User-Agent': CHROME_UA, Accept: OFAC_ACCEPT },
        signal: controller.signal,
      });
      clearTimeout(headerTimer);
      if (response.ok) {
        setTimeout(() => controller.abort(timeoutError()), bodyTimeoutMs()).unref();
        return response;
      }
      const error = httpRetryError(response, { maxRetryAfterMs: 5_000 });
      try {
        await response.body?.cancel();
      } catch {
        // Preserve the HTTP failure if response-body cleanup also fails.
      }
      throw error;
    } catch (error) {
      clearTimeout(headerTimer);
      lastError = error;
      if (error?.nonRetryable || attempt === maxAttempts) break;
      await sleepFn(Math.min(Math.max(500 * attempt, error.retryAfterMs ?? 0), budgetMs(remainingMs, error)));
    }
  }
  throw lastError;
}

function trustedSignedDownloadUrl(location, sourceUrl) {
  let redirect;
  try {
    redirect = new URL(location, sourceUrl);
  } catch {
    throw nonRetryableError('OFAC proxy returned an invalid redirect URL');
  }
  if (redirect.protocol !== 'https:' || redirect.hostname !== OFAC_SIGNED_DOWNLOAD_HOST) {
    throw nonRetryableError(`OFAC proxy returned an untrusted redirect host: ${redirect.hostname || 'missing'}`);
  }
  return redirect.href;
}

async function fetchRedirectViaProxy(sourceUrl, {
  proxyFetchFn,
  proxyUrl,
  remainingMs,
  sleepFn,
}) {
  let lastError;
  for (let attempt = 0; attempt < OFAC_PROXY_MAX_ATTEMPTS; attempt += 1) {
    const timeoutMs = Math.min(OFAC_PROXY_TIMEOUT_MS, budgetMs(remainingMs, lastError));
    const proxyConfig = parseProxyConfigForAttempt(proxyUrl, attempt);
    if (!proxyConfig) throw nonRetryableError('OFAC proxy configuration is invalid');
    try {
      const result = await proxyFetchFn(sourceUrl, proxyConfig, {
        accept: OFAC_ACCEPT,
        headers: { 'User-Agent': CHROME_UA },
        maxResponseBytes: OFAC_PROXY_BOOTSTRAP_MAX_BYTES,
        timeoutMs,
        // proxyFetch times the tunnel and the response separately; this
        // signal holds both to one timeoutMs.
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (OFAC_REDIRECT_STATUSES.has(result.status) && result.location) {
        return trustedSignedDownloadUrl(result.location, sourceUrl);
      }
      const error = new Error(`OFAC proxy bootstrap HTTP ${result.status}`);
      error.status = result.status;
      error.nonRetryable = !isRetryableProxyBootstrapStatus(result.status);
      throw error;
    } catch (error) {
      lastError = error;
      // CONNECT-layer rejections are gateway auth/quota/policy failures. A
      // different OFAC exit cannot repair them, and runSeed's outer withRetry
      // recognizes only `nonRetryable`, so preserve that contract on escape.
      if (error?.proxyConnect) error.nonRetryable = true;
      if (error?.proxyConnect || error?.nonRetryable || attempt === OFAC_PROXY_MAX_ATTEMPTS - 1) break;
      await sleepFn(Math.min(500 * (attempt + 1), budgetMs(remainingMs, error)));
    }
  }
  throw lastError;
}

/**
 * Fetch an OFAC Advanced XML source without ever buffering its large body.
 *
 * Direct fetch follows OFAC's signed S3 redirect and returns the streaming
 * Response. If Railway's egress is rejected at the OFAC bootstrap host, the
 * proxy is used only for that small redirect response. The signed S3 URL is
 * host-validated, then fetched directly so the SAX consumer retains O(1)
 * response-body memory.
 *
 * `deadlineAt` (epoch ms) is the caller's wall-clock limit. Every header,
 * body, proxy and retry wait shrinks to fit it, and no new wait starts after it.
 */
export async function fetchOfacSourceResponse(sourceUrl, {
  fetchFn = globalThis.fetch,
  proxyFetchFn = proxyFetch,
  proxyUrl = resolveOfacProxyUrl(),
  sleepFn = sleep,
  headerTimeoutMs = OFAC_HEADER_TIMEOUT_MS,
  bodyTimeoutMs = OFAC_BODY_TIMEOUT_MS,
  deadlineAt = Infinity,
} = {}) {
  const remainingMs = () => deadlineAt - Date.now();
  const download = {
    bodyTimeoutMs: () => Math.min(bodyTimeoutMs, Math.max(remainingMs(), OFAC_MIN_BODY_TIMEOUT_MS)),
    fetchFn,
    headerTimeoutMs,
    maxAttempts: OFAC_DIRECT_MAX_ATTEMPTS,
    remainingMs,
    sleepFn,
  };
  let directError;
  try {
    return await fetchDirectWithRetry(sourceUrl, download);
  } catch (error) {
    directError = error;
  }

  if (!proxyUrl || directError?.deadlineReached) throw terminalFetchError(directError);
  console.warn(`  OFAC direct fetch failed (${describeFetchError(directError)}); retrying redirect bootstrap via proxy`);

  try {
    const signedUrl = await fetchRedirectViaProxy(sourceUrl, {
      proxyFetchFn,
      proxyUrl,
      remainingMs,
      sleepFn,
    });
    return await fetchDirectWithRetry(signedUrl, download);
  } catch (error) {
    // The helper owns the complete bounded recovery ladder. Do not let
    // runSeed's outer withRetry replay the same direct/proxy sequence.
    throw terminalFetchError(error);
  }
}
