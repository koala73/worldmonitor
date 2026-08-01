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
const OFAC_SIGNED_DOWNLOAD_TIMEOUT_MS = 45_000;
// Native fetch follows the bootstrap redirect before returning the streaming
// XML Response, so this signal remains attached during body consumption. Keep
// the healthy direct path on the full bounded download budget.
const OFAC_DIRECT_TIMEOUT_MS = OFAC_SIGNED_DOWNLOAD_TIMEOUT_MS;
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

function terminalFetchError(error) {
  if (error && typeof error === 'object') {
    error.nonRetryable = true;
    return error;
  }
  return nonRetryableError(String(error));
}

async function fetchDirectWithRetry(url, {
  fetchFn,
  maxAttempts,
  sleepFn,
  timeoutMs,
}) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetchFn(url, {
        headers: { 'User-Agent': CHROME_UA, Accept: OFAC_ACCEPT },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.ok) return response;
      const error = httpRetryError(response, { maxRetryAfterMs: 5_000 });
      try {
        await response.body?.cancel();
      } catch {
        // Preserve the HTTP failure if response-body cleanup also fails.
      }
      throw error;
    } catch (error) {
      lastError = error;
      if (error?.nonRetryable || attempt === maxAttempts) break;
      await sleepFn(Math.max(500 * attempt, error.retryAfterMs ?? 0));
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
  sleepFn,
}) {
  let lastError;
  for (let attempt = 0; attempt < OFAC_PROXY_MAX_ATTEMPTS; attempt += 1) {
    const proxyConfig = parseProxyConfigForAttempt(proxyUrl, attempt);
    if (!proxyConfig) throw nonRetryableError('OFAC proxy configuration is invalid');
    try {
      const result = await proxyFetchFn(sourceUrl, proxyConfig, {
        accept: OFAC_ACCEPT,
        headers: { 'User-Agent': CHROME_UA },
        maxResponseBytes: OFAC_PROXY_BOOTSTRAP_MAX_BYTES,
        timeoutMs: OFAC_PROXY_TIMEOUT_MS,
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
      await sleepFn(500 * (attempt + 1));
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
 */
export async function fetchOfacSourceResponse(sourceUrl, {
  fetchFn = globalThis.fetch,
  proxyFetchFn = proxyFetch,
  proxyUrl = resolveOfacProxyUrl(),
  sleepFn = sleep,
} = {}) {
  let directError;
  try {
    return await fetchDirectWithRetry(sourceUrl, {
      fetchFn,
      maxAttempts: OFAC_DIRECT_MAX_ATTEMPTS,
      sleepFn,
      timeoutMs: OFAC_DIRECT_TIMEOUT_MS,
    });
  } catch (error) {
    directError = error;
  }

  if (!proxyUrl) throw terminalFetchError(directError);
  console.warn(`  OFAC direct fetch failed (${directError?.message || directError}); retrying redirect bootstrap via proxy`);

  try {
    const signedUrl = await fetchRedirectViaProxy(sourceUrl, {
      proxyFetchFn,
      proxyUrl,
      sleepFn,
    });
    return await fetchDirectWithRetry(signedUrl, {
      fetchFn,
      maxAttempts: OFAC_DIRECT_MAX_ATTEMPTS,
      sleepFn,
      timeoutMs: OFAC_SIGNED_DOWNLOAD_TIMEOUT_MS,
    });
  } catch (error) {
    // The helper owns the complete bounded recovery ladder. Do not let
    // runSeed's outer withRetry replay the same direct/proxy sequence.
    throw terminalFetchError(error);
  }
}
