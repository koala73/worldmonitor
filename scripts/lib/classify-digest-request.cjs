'use strict';

// #7437: where should Classify fetch list-feed-digest from, and with which
// auth/transport? The previous inline https.get against the hardcoded
// production API host silently classified 0 titles on every self-host install.
//
// Lives in scripts/lib rather than inline in ais-relay.cjs so the URL, scheme,
// and header contract can execute in tests without importing the boot-on-require
// relay — same reason as digest-stale-gate.cjs.

const DEFAULT_CLASSIFY_API_HOST = 'api.worldmonitor.app';
const DEFAULT_CLASSIFY_API_BASE = `https://${DEFAULT_CLASSIFY_API_HOST}`;

function resolveClassifyApiBase(env = process.env) {
  const raw = typeof env.API_BASE_URL === 'string' ? env.API_BASE_URL.trim() : '';
  return (raw || DEFAULT_CLASSIFY_API_BASE).replace(/\/+$/, '');
}

function buildClassifyDigestUrl(variant, env = process.env) {
  const encodedVariant = encodeURIComponent(String(variant ?? ''));
  return `${resolveClassifyApiBase(env)}/api/news/v1/list-feed-digest?variant=${encodedVariant}&lang=en`;
}

function classifyDigestTransport(url) {
  try {
    return new URL(url).protocol === 'http:' ? 'http' : 'https';
  } catch {
    return 'https';
  }
}

function buildClassifyDigestHeaders({ userAgent, relayKey } = {}) {
  const headers = { Accept: 'application/json' };
  if (userAgent) headers['User-Agent'] = userAgent;
  if (relayKey) headers['X-WorldMonitor-Key'] = relayKey;
  return headers;
}

function formatClassifyDigestFetchFailure(status, relayKey) {
  const authFailure = status === 401 || status === 403;
  const keyNote = !relayKey && authFailure
    ? ' (WORLDMONITOR_RELAY_KEY not set — 401 expected; set it on the relay AND the API host)'
    : '';
  return `[Classify] digest fetch failed: HTTP ${status}${keyNote}`;
}

function shouldWriteClassifySeedMeta({ fetchOk = 0, fetchFailed = 0 } = {}) {
  return fetchOk > 0 || fetchFailed === 0;
}

module.exports = {
  DEFAULT_CLASSIFY_API_HOST,
  DEFAULT_CLASSIFY_API_BASE,
  resolveClassifyApiBase,
  buildClassifyDigestUrl,
  classifyDigestTransport,
  buildClassifyDigestHeaders,
  formatClassifyDigestFetchFailure,
  shouldWriteClassifySeedMeta,
};
