const ORIGIN = 'https://www.worldmonitor.app';
const AUTH_ERROR = 'Pro authentication required';

function expectedApexRedirect(url) {
  const requestUrl = new URL(url);
  if (requestUrl.origin !== 'https://worldmonitor.app') return null;
  requestUrl.hostname = 'www.worldmonitor.app';
  return requestUrl.href;
}

function botGateHint(res, text = '') {
  const contentType = res.headers.get('content-type') ?? '';
  if (res.status === 403 && (contentType.includes('text/html') || text.trimStart().startsWith('<'))) {
    return ' — 403 with an HTML body: the bot gate is blocking this probe UA, which would MASK a 5xx here';
  }
  return '';
}

export async function runMcpProxyProbe(url, timedFetch) {
  const records = [];
  let preflight;
  try {
    preflight = await timedFetch(url, {
      method: 'OPTIONS',
      headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST' },
    });
  } catch (err) {
    records.push({
      check: 'mcp-proxy OPTIONS',
      ok: false,
      detail: `HANG/transport error: ${err?.name ?? err}`,
    });
    return records;
  }

  if (preflight.res.status >= 300 && preflight.res.status < 400) {
    const location = preflight.res.headers.get('location');
    const expectedLocation = expectedApexRedirect(url);
    if (expectedLocation !== null && preflight.res.status === 301 && location === expectedLocation) {
      records.push({
        check: 'mcp-proxy OPTIONS',
        ok: true,
        detail: `301 → ${location} (expected apex → www host split; www carries the assertions)`,
      });
    } else {
      records.push({
        check: 'mcp-proxy OPTIONS',
        ok: false,
        detail: `unexpected redirect ${preflight.res.status} → ${location}; expected 301 → ${expectedLocation ?? 'no redirect on this host'}`,
      });
    }
    return records;
  }

  if (preflight.res.status === 204) {
    records.push({ check: 'mcp-proxy OPTIONS', ok: true, detail: '204' });
  } else {
    records.push({
      check: 'mcp-proxy OPTIONS',
      ok: false,
      detail: `expected 204, got ${preflight.res.status}${botGateHint(preflight.res, preflight.text)}`,
    });
  }

  try {
    const { res, text } = await timedFetch(url, { headers: { Origin: ORIGIN } });
    if (res.status !== 401) {
      records.push({
        check: 'mcp-proxy anon GET',
        ok: false,
        detail: `expected the handler's 401 auth wall, got ${res.status}${botGateHint(res, text)} — a 5xx here is the FUNCTION_INVOCATION_FAILED fingerprint of #4749/#7578`,
      });
      return records;
    }

    let body;
    try {
      body = JSON.parse(text);
    } catch {
      records.push({
        check: 'mcp-proxy anon GET',
        ok: false,
        detail: `401 body is not the handler's JSON: ${text.slice(0, 120)}`,
      });
      return records;
    }

    if (body?.error !== AUTH_ERROR) {
      records.push({
        check: 'mcp-proxy anon GET',
        ok: false,
        detail: `401 JSON error must be exactly ${JSON.stringify(AUTH_ERROR)}: ${text.slice(0, 120)}`,
      });
      return records;
    }

    records.push({
      check: 'mcp-proxy anon GET',
      ok: true,
      detail: `401 ${JSON.stringify(body.error)}`,
    });
  } catch (err) {
    records.push({
      check: 'mcp-proxy anon GET',
      ok: false,
      detail: `HANG/transport error: ${err?.name ?? err}`,
    });
  }

  return records;
}
