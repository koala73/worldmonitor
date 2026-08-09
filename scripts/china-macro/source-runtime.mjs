const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_RETRY_DELAY_MS = 1_000;

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
}) {
  let target = validateSourceUrl(value, policy);
  assertTargetAllowed(target);
  let redirected = false;
  let redirects = 0;
  let transientRetries = 0;
  for (;;) {
    budget.consume();
    let response;
    try {
      response = await fetchFn(target.toString(), {
        headers: {
          Accept: 'text/html,text/plain;q=0.9,*/*;q=0.1',
          'Accept-Language': 'en,zh-CN;q=0.8',
          'User-Agent': 'WorldMonitor/2.10 (+https://worldmonitor.app)',
        },
        redirect: 'manual',
        signal: AbortSignal.timeout(12_000),
      });
    } catch (error) {
      const permanentTls = error?.code === 'SELF_SIGNED_CERT_IN_CHAIN'
        || error?.cause?.code === 'SELF_SIGNED_CERT_IN_CHAIN'
        || /self signed certificate|certificate chain/i.test(
          `${String(error?.message)} ${String(error?.cause?.message)}`,
        );
      if (transientRetries === 0 && !permanentTls && error?.code !== 'SOURCE_CONTRACT_VIOLATION') {
        transientRetries += 1;
        await waitForRetry();
        continue;
      }
      throw error;
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
      if (
        transientRetries === 0
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
