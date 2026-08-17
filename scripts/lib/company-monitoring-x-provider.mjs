import { createHash } from 'node:crypto';
import { promises as dns } from 'node:dns';
import https from 'node:https';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isBlockedResolvedAddress } = require('./notification-webhook-ssrf.cjs');

const X_HANDLE = /^[A-Za-z0-9_]{1,15}$/;
const X_ACCOUNT_ID = /^[1-9]\d{1,18}$/;
const COMPANY_ID = /^cm_company_[0-9A-HJKMNP-TV-Z]{26}$/;
const CLAIM_ID = /^cm_claim_[0-9A-HJKMNP-TV-Z]{26}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]/u;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata',
  'metadata.internal',
  'metadata.google.internal',
  'instance-data',
  'computemetadata',
  '169.254.169.254',
]);
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 512 * 1024;
const DEFAULT_MAX_REDIRECTS = 3;
const DEFAULT_IDENTITY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_X_REQUESTS_PER_LEASE = 100;
export const COMPANY_MONITORING_LEASE_FINALIZATION_RESERVE_MS = 20_000;

export class CompanyMonitoringXSsrfError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CompanyMonitoringXSsrfError';
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function plainText(value, field, maxBytes = 512) {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  const normalized = value.normalize('NFC').trim().replace(/\s+/g, ' ');
  if (!normalized || CONTROL_CHARACTERS.test(normalized)) throw new Error(`${field} is invalid`);
  if (Buffer.byteLength(normalized) > maxBytes) throw new Error(`${field} is too long`);
  return normalized;
}

function normalizeDomain(value) {
  const domain = plainText(value, 'officialDomain', 253).toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(domain)) {
    throw new Error('officialDomain is invalid');
  }
  return domain;
}

function normalizeHandle(value, field = 'currentHandle') {
  const handle = plainText(value, field, 16).replace(/^@/, '');
  if (!X_HANDLE.test(handle)) throw new Error(`${field} is invalid`);
  return handle.toLowerCase();
}

function domainAllowsHostname(hostname, allowedDomain) {
  return hostname === allowedDomain || hostname.endsWith(`.${allowedDomain}`);
}

export function assertSafeOfficialUrl(rawUrl, allowedDomains) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new CompanyMonitoringXSsrfError('Official URL is not a valid URL');
  }
  if (url.protocol !== 'https:') {
    throw new CompanyMonitoringXSsrfError('Official URL must use HTTPS');
  }
  if (url.username || url.password) {
    throw new CompanyMonitoringXSsrfError('Official URL must not contain credentials');
  }
  if (url.port && url.port !== '443') {
    throw new CompanyMonitoringXSsrfError('Official URL must use the HTTPS default port');
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (BLOCKED_HOSTNAMES.has(hostname) || isBlockedResolvedAddress(hostname)) {
    throw new CompanyMonitoringXSsrfError('Official URL points to a forbidden target');
  }
  if (Array.isArray(allowedDomains) && allowedDomains.length > 0) {
    const normalizedAllowed = allowedDomains.map(normalizeDomain);
    if (!normalizedAllowed.some((domain) => domainAllowsHostname(hostname, domain))) {
      throw new CompanyMonitoringXSsrfError('Official URL leaves the claimed domain');
    }
  }
  return url;
}

async function defaultResolveHostname(hostname) {
  const records = await dns.lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

function normalizeHeaders(headers) {
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  return Object.fromEntries(
    Object.entries(headers ?? {}).map(([name, value]) => [name.toLowerCase(), Array.isArray(value) ? value.join(', ') : String(value)]),
  );
}

function defaultRequestPinned({
  url,
  address,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
}) {
  const family = address.includes(':') ? 6 : 4;
  return new Promise((resolve, reject) => {
    let settled = false;
    let hardDeadline;
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      if (hardDeadline) clearTimeout(hardDeadline);
      callback(value);
    };
    const request = https.request({
      protocol: 'https:',
      hostname: url.hostname,
      port: url.port || 443,
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      family,
      lookup: (_hostname, _options, callback) => callback(null, address, family),
      headers: {
        Accept: 'text/html,application/xhtml+xml;q=0.9',
        'User-Agent': 'worldmonitor-company-monitoring-x-verifier/1.0',
      },
    }, (response) => {
      const chunks = [];
      let bytes = 0;
      response.on('data', (chunk) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.byteLength;
        if (bytes > maxResponseBytes) {
          request.destroy(new CompanyMonitoringXSsrfError('Official page response is too large'));
          return;
        }
        chunks.push(buffer);
      });
      response.on('error', (error) => settle(reject, error));
      response.on('end', () => settle(resolve, {
        status: response.statusCode ?? 502,
        headers: normalizeHeaders(response.headers),
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.on('error', (error) => settle(reject, error));
    request.setTimeout(timeoutMs, () => request.destroy(new CompanyMonitoringXSsrfError('Official page request timed out')));
    hardDeadline = setTimeout(
      () => request.destroy(new CompanyMonitoringXSsrfError('Official page request timed out')),
      timeoutMs,
    );
    request.end();
  });
}

async function resolveVettedAddresses(hostname, resolveHostname) {
  let addresses;
  try {
    addresses = await resolveHostname(hostname);
  } catch (error) {
    throw new CompanyMonitoringXSsrfError(`Official URL DNS resolution failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new CompanyMonitoringXSsrfError('Official URL DNS resolution returned no addresses');
  }
  for (const address of addresses) {
    if (typeof address !== 'string' || isBlockedResolvedAddress(address)) {
      throw new CompanyMonitoringXSsrfError(`Official URL resolves to a private, reserved, or forbidden address: ${address}`);
    }
  }
  return [...new Set(addresses)];
}

function remainingDeadlineMs(deadline, now) {
  const remaining = deadline - now();
  if (!Number.isFinite(remaining) || remaining <= 0) {
    throw new CompanyMonitoringXSsrfError('Official page fetch timed out');
  }
  return Math.max(1, Math.floor(remaining));
}

async function beforeDeadline(operation, deadline, now) {
  const timeoutMs = remainingDeadlineMs(deadline, now);
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new CompanyMonitoringXSsrfError('Official page fetch timed out')),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([Promise.resolve().then(operation), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Fetch an official-domain page without re-resolving through a generic fetch.
 * Every redirect is restricted to the claimed domain, resolved again, checked
 * as a complete DNS answer set, and connected through one pinned public IP.
 */
export async function fetchSsrfSafeOfficialPage(rawUrl, options = {}) {
  const allowedDomains = (options.allowedDomains ?? [new URL(rawUrl).hostname]).map(normalizeDomain);
  const resolveHostname = options.resolveHostname ?? defaultResolveHostname;
  const requestPinned = options.requestPinned ?? defaultRequestPinned;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const deadline = now() + timeoutMs;
  let url = assertSafeOfficialUrl(rawUrl, allowedDomains);

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    const addresses = await beforeDeadline(
      () => resolveVettedAddresses(url.hostname, resolveHostname),
      deadline,
      now,
    );
    const address = addresses.find((candidate) => candidate.includes('.')) ?? addresses[0];
    const requestTimeoutMs = remainingDeadlineMs(deadline, now);
    const response = await beforeDeadline(
      () => requestPinned({
        url,
        address,
        timeoutMs: requestTimeoutMs,
        maxResponseBytes: options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      }),
      deadline,
      now,
    );
    const headers = normalizeHeaders(response.headers);
    if (REDIRECT_STATUSES.has(response.status)) {
      if (redirectCount === maxRedirects) {
        throw new CompanyMonitoringXSsrfError('Official page exceeded the redirect limit');
      }
      const location = headers.location;
      if (!location) throw new CompanyMonitoringXSsrfError('Official page redirect has no location');
      url = assertSafeOfficialUrl(new URL(location, url).href, allowedDomains);
      continue;
    }
    if (!Number.isInteger(response.status) || response.status < 200 || response.status >= 300) {
      throw new CompanyMonitoringXSsrfError(`Official page returned HTTP ${response.status}`);
    }
    if (!String(headers['content-type'] ?? '').toLowerCase().includes('text/html')) {
      throw new CompanyMonitoringXSsrfError('Official page did not return HTML');
    }
    const body = String(response.body ?? '');
    if (Buffer.byteLength(body) > (options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES)) {
      throw new CompanyMonitoringXSsrfError('Official page response is too large');
    }
    return { url: rawUrl, finalUrl: url.href, html: body, resolvedAddresses: addresses };
  }
  throw new CompanyMonitoringXSsrfError('Official page redirect handling failed closed');
}

const COMPANY_SUFFIXES = new Set([
  'inc', 'incorporated', 'llc', 'ltd', 'limited', 'corp', 'corporation', 'company', 'plc', 'holdings', 'group',
]);
const ROLE_SUFFIXES = [
  ['investorrelations', 'investor_relations'],
  ['investors', 'investor_relations'],
  ['newsroom', 'newsroom'],
  ['news', 'newsroom'],
  ['support', 'support'],
  ['help', 'support'],
  ['developers', 'developer'],
  ['developer', 'developer'],
  ['uk', 'regional'],
  ['usa', 'regional'],
];

function nameTokens(value) {
  const normalized = plainText(value, 'name', 256)
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  if (!normalized) return [];
  const tokens = normalized.split(/\s+/u);
  while (tokens.length > 1 && COMPANY_SUFFIXES.has(tokens[tokens.length - 1])) tokens.pop();
  return tokens;
}

function canonicalName(value) {
  return nameTokens(value).join('');
}

function inferAuthorityRole(companyName, profileName) {
  const company = canonicalName(companyName);
  const profile = canonicalName(profileName);
  if (!company || !profile) return 'unknown';
  if (profile === company) return 'company';
  for (const [suffix, role] of ROLE_SUFFIXES) {
    if (profile === `${company}${suffix}`) return role;
  }
  return 'unknown';
}

function pageMatchesName(html, name) {
  const pageText = String(html)
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}]+/gu, ' ');
  const tokens = nameTokens(name);
  return tokens.length > 0 && pageText.includes(tokens.join(' '));
}

function pageMatchesDomicile(html, domicileCountry) {
  const source = String(html);
  if (domicileCountry === 'US') {
    return /addressCountry["']?\s*:\s*["']?(?:US|USA|United States)\b/i.test(source)
      || /\b(?:United States of America|United States|U\.S\.A\.|USA)\b/i.test(source);
  }
  if (domicileCountry === 'GB') {
    return /addressCountry["']?\s*:\s*["']?(?:GB|UK|United Kingdom)\b/i.test(source)
      || /\b(?:United Kingdom|Great Britain|England|Scotland|Wales|Northern Ireland)\b/i.test(source);
  }
  return false;
}

function linkedXHandles(html) {
  const handles = new Set();
  const pattern = /https?:\/\/(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})(?=[^A-Za-z0-9_]|$)/gi;
  for (const match of String(html).matchAll(pattern)) handles.add(match[1].toLowerCase());
  return handles;
}

function profileDeclaredUrls(profile) {
  const entityUrls = Array.isArray(profile?.entities?.url?.urls)
    ? profile.entities.url.urls.flatMap((entry) => [entry?.unwound_url, entry?.expanded_url])
      .filter((value) => typeof value === 'string' && value.length > 0)
    : [];
  const candidates = entityUrls.length > 0 ? entityUrls : [profile?.url];
  return [...new Set(candidates.filter((value) => typeof value === 'string' && value.length > 0))].sort();
}

function profileLinksOfficialDomain(profile, domain) {
  return profileDeclaredUrls(profile).some((rawUrl) => {
    try {
      const url = new URL(rawUrl);
      const hostname = url.hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
      return url.protocol === 'https:' && domainAllowsHostname(hostname, domain);
    } catch {
      return false;
    }
  });
}

function allowedUsesForRole(role) {
  if (role === 'company' || role === 'newsroom' || role === 'investor_relations') {
    return ['primary_evidence', 'recent_search'];
  }
  if (role === 'support' || role === 'developer' || role === 'regional') return ['recent_search'];
  return [];
}

function identityEvidenceHash(input) {
  return sha256(JSON.stringify({
    companyId: input.subject.companyId,
    domainClaimId: input.subject.domainClaimId,
    xHandleClaimId: input.subject.xHandleClaimId,
    officialDomain: input.subject.officialDomain,
    finalUrl: input.page.finalUrl,
    htmlHash: sha256(String(input.page.html)),
    accountId: input.profile.id,
    username: String(input.profile.username).toLowerCase(),
    profileName: input.profile.name,
    profileUrls: profileDeclaredUrls(input.profile),
    domicileCountry: input.subject.domicileCountry,
    checkedAt: input.checkedAt,
  }));
}

function identityResult(input, state, demotionReason) {
  const currentHandle = normalizeHandle(input.profile.username);
  const role = inferAuthorityRole(input.subject.name, input.profile.name);
  return {
    state,
    ...(demotionReason ? { demotionReason } : {}),
    companyId: input.subject.companyId,
    domainClaimId: input.subject.domainClaimId,
    xHandleClaimId: input.subject.xHandleClaimId,
    officialDomain: normalizeDomain(input.subject.officialDomain),
    officialPageUrl: input.page.finalUrl,
    accountId: String(input.profile.id),
    currentHandle,
    profileName: plainText(input.profile.name, 'profile.name', 256),
    domicileCountry: input.subject.domicileCountry,
    authorityRole: role,
    badgeVerified: input.profile.verified === true,
    allowedUses: state === 'authoritative' ? allowedUsesForRole(role) : [],
    checkedAt: input.checkedAt,
    expiresAt: input.expiresAt,
    evidenceHash: identityEvidenceHash(input),
  };
}

/**
 * Verify authority from the official-domain evidence. Platform badge state is
 * recorded for audit only and never participates in the authority decision.
 */
export async function verifyOfficialXIdentity(input) {
  if (!input?.subject || !input.page || !input.profile) throw new Error('official identity input is required');
  if (!COMPANY_ID.test(input.subject.companyId)) throw new Error('companyId is invalid');
  if (!CLAIM_ID.test(input.subject.domainClaimId) || !CLAIM_ID.test(input.subject.xHandleClaimId)) {
    throw new Error('claim IDs are invalid');
  }
  const domain = normalizeDomain(input.subject.officialDomain);
  const officialUrl = assertSafeOfficialUrl(input.page.finalUrl, [domain]);
  const pageUrl = assertSafeOfficialUrl(input.subject.officialPageUrl, [domain]);
  if (!domainAllowsHostname(pageUrl.hostname, domain) || !domainAllowsHostname(officialUrl.hostname, domain)) {
    throw new Error('official page leaves the claimed domain');
  }
  const checkedAt = input.checkedAt;
  const expiresAt = input.expiresAt ?? checkedAt + DEFAULT_IDENTITY_TTL_MS;
  if (!Number.isSafeInteger(checkedAt) || !Number.isSafeInteger(expiresAt) || expiresAt <= checkedAt) {
    throw new Error('identity verification time range is invalid');
  }
  const normalizedInput = { ...input, checkedAt, expiresAt };
  const profileId = String(input.profile.id);
  const profileHandle = normalizeHandle(input.profile.username);
  if (!X_ACCOUNT_ID.test(profileId)) throw new Error('profile account ID is invalid');

  const prior = input.priorIdentity;
  if (prior?.accountId && String(prior.accountId) !== profileId) {
    const reason = normalizeHandle(prior.currentHandle) === profileHandle
      ? 'account_reassigned'
      : 'account_changed';
    return identityResult(normalizedInput, 'demoted', reason);
  }

  if (!profileLinksOfficialDomain(input.profile, domain)) {
    return identityResult(normalizedInput, 'demoted', 'official_link_lost');
  }
  const handles = linkedXHandles(input.page.html);
  if (!handles.has(profileHandle)) {
    return identityResult(normalizedInput, 'demoted', 'official_link_lost');
  }
  if (!pageMatchesName(input.page.html, input.subject.name)) {
    return identityResult(normalizedInput, 'demoted', 'name_mismatch');
  }
  if (!pageMatchesDomicile(input.page.html, input.subject.domicileCountry)) {
    return identityResult(normalizedInput, 'demoted', 'domicile_mismatch');
  }
  const role = inferAuthorityRole(input.subject.name, input.profile.name);
  if (role === 'unknown') return identityResult(normalizedInput, 'demoted', 'name_mismatch');
  return identityResult(normalizedInput, 'authoritative');
}

export function evaluateOfficialIdentityState(identity, now = Date.now()) {
  if (identity?.state === 'authoritative' && Number.isSafeInteger(identity.expiresAt) && identity.expiresAt > now) {
    return identity;
  }
  return { state: 'demoted', demotionReason: 'expired', allowedUses: [] };
}

function packId(query, identities) {
  return sha256(JSON.stringify({
    version: 1,
    query,
    accounts: identities.map((identity) => [identity.companyId, identity.accountId, identity.currentHandle]),
  }));
}

export function compileXRecentSearchPacks(identities, options = {}) {
  const now = options.now ?? Date.now();
  const maxAccountsPerPack = options.maxAccountsPerPack ?? 10;
  const maxQueryBytes = options.maxQueryBytes ?? 512;
  if (!Number.isSafeInteger(maxAccountsPerPack) || maxAccountsPerPack < 1 || maxAccountsPerPack > 25) {
    throw new Error('maxAccountsPerPack is invalid');
  }
  if (!Number.isSafeInteger(maxQueryBytes) || maxQueryBytes < 32 || maxQueryBytes > 512) {
    throw new Error('maxQueryBytes is invalid');
  }
  const omissions = [];
  const eligible = [];
  const seenAccountIds = new Set();
  for (const identity of Array.isArray(identities) ? identities : []) {
    const companyId = String(identity?.companyId ?? '');
    let reason;
    if (identity?.state !== 'authoritative') reason = 'identity_not_authoritative';
    else if (!Number.isSafeInteger(identity.expiresAt) || identity.expiresAt <= now) reason = 'identity_expired';
    else if (!Array.isArray(identity.allowedUses) || !identity.allowedUses.includes('recent_search')) reason = 'recent_search_not_allowed';
    else if (!X_ACCOUNT_ID.test(String(identity.accountId ?? ''))) reason = 'invalid_account_id';
    else if (!X_HANDLE.test(String(identity.currentHandle ?? ''))) reason = 'invalid_handle';
    else if (seenAccountIds.has(String(identity.accountId))) reason = 'duplicate_account_id';
    if (reason) {
      omissions.push({ companyId, reason });
      continue;
    }
    seenAccountIds.add(String(identity.accountId));
    eligible.push({
      companyId,
      accountId: String(identity.accountId),
      currentHandle: normalizeHandle(identity.currentHandle),
    });
  }
  eligible.sort((left, right) => left.accountId.localeCompare(right.accountId) || left.companyId.localeCompare(right.companyId));

  const packs = [];
  let current = [];
  const queryFor = (items) => `(${items.map((identity) => `from:${identity.currentHandle}`).join(' OR ')}) -is:retweet`;
  const flush = () => {
    if (current.length === 0) return;
    const query = queryFor(current);
    packs.push({
      packId: packId(query, current),
      query,
      companyIds: current.map((identity) => identity.companyId),
      accountIds: current.map((identity) => identity.accountId),
      handles: current.map((identity) => identity.currentHandle),
    });
    current = [];
  };
  for (const identity of eligible) {
    const candidate = [...current, identity];
    if (candidate.length > maxAccountsPerPack || Buffer.byteLength(queryFor(candidate)) > maxQueryBytes) flush();
    if (Buffer.byteLength(queryFor([identity])) > maxQueryBytes) {
      omissions.push({ companyId: identity.companyId, reason: 'query_too_long' });
      continue;
    }
    current.push(identity);
  }
  flush();
  omissions.sort((left, right) => left.companyId.localeCompare(right.companyId));
  return { packs, omissions };
}

function normalizePostId(value, field) {
  const id = String(value ?? '');
  if (!X_ACCOUNT_ID.test(id)) throw new Error(`${field} is invalid`);
  return id;
}

function normalizeTimestamp(value, field) {
  const timestamp = typeof value === 'number' ? value : Date.parse(String(value));
  if (!Number.isSafeInteger(timestamp)) throw new Error(`${field} is invalid`);
  return timestamp;
}

export function normalizeXRecentSearchPage(page, options) {
  const permittedStorage = options?.permittedStorage === 'full_text' ? 'full_text' : 'metadata_only';
  const bindings = new Map(
    (options?.bindings ?? []).map((binding) => [String(binding.accountId), {
      companyId: String(binding.companyId),
      accountId: String(binding.accountId),
      currentHandle: normalizeHandle(binding.currentHandle),
      permittedStorage: binding.permittedStorage === 'metadata_only' ? 'metadata_only' : permittedStorage,
    }]),
  );
  const users = new Map((page?.includes?.users ?? []).map((user) => [String(user.id), user]));
  const observedAt = normalizeTimestamp(options?.observedAt, 'observedAt');
  const posts = [];
  const unexpectedAuthors = [];

  for (const raw of page?.data ?? []) {
    const authorAccountId = normalizePostId(raw.author_id, 'author_id');
    const binding = bindings.get(authorAccountId);
    if (!binding) {
      unexpectedAuthors.push(authorAccountId);
      continue;
    }
    const user = users.get(authorAccountId);
    const editHistoryPostIds = [...new Set((raw.edit_history_tweet_ids ?? [raw.id]).map((id) => normalizePostId(id, 'edit_history_tweet_ids')))] ;
    const withheldCountryCodes = [...new Set((raw.withheld?.country_codes ?? []).map((code) => String(code).toUpperCase()))].sort();
    const contentState = withheldCountryCodes.length > 0
      ? 'withheld'
      : user?.protected === true
        ? 'protected'
        : editHistoryPostIds.length > 1
          ? 'edited'
          : 'active';
    const mayStoreText = binding.permittedStorage === 'full_text' &&
      (contentState === 'active' || contentState === 'edited');
    posts.push({
      companyId: binding.companyId,
      postId: normalizePostId(raw.id, 'post ID'),
      authorAccountId,
      currentHandle: normalizeHandle(user?.username ?? binding.currentHandle),
      createdAt: normalizeTimestamp(raw.created_at, 'created_at'),
      observedAt,
      contentState,
      storageState: mayStoreText ? 'full_text' : 'metadata_only',
      editHistoryPostIds,
      ...(withheldCountryCodes.length > 0 ? { withheldCountryCodes } : {}),
      ...(mayStoreText ? { text: plainText(raw.text, 'post text', 32 * 1024) } : {}),
    });
  }

  for (const event of page?.compliance ?? []) {
    const authorAccountId = normalizePostId(event.authorAccountId, 'compliance authorAccountId');
    const binding = bindings.get(authorAccountId);
    if (!binding) {
      unexpectedAuthors.push(authorAccountId);
      continue;
    }
    if (event.type !== 'delete' && event.type !== 'protected' && event.type !== 'withheld') {
      throw new Error('compliance event type is invalid');
    }
    posts.push({
      companyId: binding.companyId,
      postId: normalizePostId(event.postId, 'compliance postId'),
      authorAccountId,
      currentHandle: binding.currentHandle,
      createdAt: normalizeTimestamp(event.observedAt, 'compliance observedAt'),
      observedAt: normalizeTimestamp(event.observedAt, 'compliance observedAt'),
      contentState: event.type === 'delete' ? 'deleted' : event.type,
      storageState: event.type === 'delete' ? 'tombstone' : 'metadata_only',
      editHistoryPostIds: [normalizePostId(event.postId, 'compliance postId')],
      ...(event.type === 'withheld'
        ? { withheldCountryCodes: [...new Set((event.countryCodes ?? []).map((code) => String(code).toUpperCase()))].sort() }
        : {}),
    });
  }

  return {
    posts,
    unexpectedAuthors: [...new Set(unexpectedAuthors)].sort(),
    resultCount: Number.isSafeInteger(page?.meta?.result_count) ? page.meta.result_count : posts.length,
    nextToken: typeof page?.meta?.next_token === 'string' ? page.meta.next_token : undefined,
  };
}

class XProviderError extends Error {
  constructor(reason, message) {
    super(message);
    this.name = 'XProviderError';
    this.reason = reason;
  }
}

class XProviderPartialError extends Error {
  constructor(message) {
    super(message);
    this.name = 'XProviderPartialError';
  }
}

function xProviderReason(status) {
  if (status === 401 || status === 403) return 'authentication_failed';
  if (status === 408 || status === 504) return 'timeout';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'provider_unavailable';
  return 'request_rejected';
}

function checkedNonNegativeInteger(value, fallback = 0) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function uniqueBy(items, keyFor) {
  const seen = new Set();
  return items.filter((item) => {
    const key = keyFor(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function publicPriorIdentity(identity) {
  if (!identity) return undefined;
  return {
    accountId: identity.accountId,
    currentHandle: identity.currentHandle,
    state: identity.state,
    expiresAt: identity.expiresAt,
  };
}

function isolateCorporateFamilyIdentities(identities, subjects, now) {
  const authoritativeByAccount = new Map();
  for (const identity of identities) {
    if (identity.state !== 'authoritative' || identity.expiresAt <= now) continue;
    const rows = authoritativeByAccount.get(identity.accountId) ?? [];
    rows.push(identity);
    authoritativeByAccount.set(identity.accountId, rows);
  }
  const storedOwnersByAccount = new Map();
  for (const subject of subjects) {
    const identity = subject.currentIdentity;
    if (
      identity?.state !== 'authoritative' ||
      identity.expiresAt <= now ||
      !X_ACCOUNT_ID.test(String(identity.accountId ?? ''))
    ) continue;
    const owners = storedOwnersByAccount.get(String(identity.accountId)) ?? [];
    owners.push(String(subject.companyId));
    storedOwnersByAccount.set(String(identity.accountId), owners);
  }
  return identities.map((identity) => {
    const conflicts = authoritativeByAccount.get(identity.accountId) ?? [];
    if (conflicts.length < 2 || identity.state !== 'authoritative') return identity;
    const storedOwners = storedOwnersByAccount.get(identity.accountId) ?? [];
    const owner = storedOwners.length === 1 && conflicts.some((row) => row.companyId === storedOwners[0])
      ? storedOwners[0]
      : undefined;
    if (owner === identity.companyId) return identity;
    return {
      ...identity,
      state: 'demoted',
      demotionReason: 'family_conflict',
      allowedUses: [],
    };
  });
}

function buildCheckpoint(work, packs) {
  const digest = sha256(JSON.stringify({
    version: 1,
    workId: String(work.workId ?? ''),
    windowEnd: work.windowEnd,
    packIds: packs.map((pack) => pack.packId),
  })).slice(0, 32);
  return `x:v1:${work.windowEnd}:${digest}`;
}

function providerErrorResult(error, requestCount, requestCostUsdMicros) {
  const reason = error instanceof XProviderError ? error.reason : 'provider_unavailable';
  return {
    type: 'provider_error',
    reason,
    costUsdMicros: requestCount * requestCostUsdMicros,
  };
}

/**
 * Execute one server-shaped X lease. Official pages are fetched through the
 * pinned SSRF-safe client; X requests are bounded, authenticated, and retain
 * only storage-policy-permitted content. Tracked-post reconciliation failure
 * is an explicit partial gap, never a reassuring complete result.
 */
export function createXRecentSearchExecutor(options = {}) {
  const bearerToken = options.bearerToken ?? '';
  const fetchImpl = options.fetchImpl ?? ((...args) => globalThis.fetch(...args));
  const fetchOfficialPage = options.fetchOfficialPage ?? fetchSsrfSafeOfficialPage;
  const fetchComplianceEvents = options.fetchComplianceEvents;
  const now = options.now ?? Date.now;
  const storageMode = options.storageMode === 'full_text' ? 'full_text' : 'metadata_only';
  const requestCostUsdMicros = checkedNonNegativeInteger(options.requestCostUsdMicros);
  const timeoutMs = checkedNonNegativeInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS);

  return async (work) => {
    if (work?.source !== 'x') {
      return { type: 'provider_error', reason: 'provider_unavailable', costUsdMicros: 0 };
    }
    if (!bearerToken) {
      return { type: 'provider_error', reason: 'authentication_failed', costUsdMicros: 0 };
    }
    const checkedAt = now();
    if (
      !Number.isSafeInteger(work.windowStart) ||
      !Number.isSafeInteger(work.windowEnd) ||
      work.windowStart >= work.windowEnd ||
      !Number.isSafeInteger(work.resultCap) ||
      work.resultCap < 1 ||
      work.resultCap > 100 ||
      !Array.isArray(work.obligations) ||
      !Array.isArray(work.subjects)
    ) {
      return { type: 'provider_error', reason: 'request_rejected', costUsdMicros: 0 };
    }

    let requestCount = 0;
    let providerPartial = false;
    const remainingCallTimeoutMs = () => {
      if (!Number.isSafeInteger(work.leaseExpiresAt)) return Math.max(1, timeoutMs);
      const remaining = work.leaseExpiresAt - now() - COMPANY_MONITORING_LEASE_FINALIZATION_RESERVE_MS;
      if (remaining <= 0) throw new XProviderPartialError('Provider lease deadline reached');
      return Math.max(1, Math.min(timeoutMs, remaining));
    };
    const reserveRequest = (reserve = 0) => {
      if (requestCount >= MAX_X_REQUESTS_PER_LEASE - reserve) {
        throw new XProviderPartialError('Provider request budget reached');
      }
      const callTimeoutMs = remainingCallTimeoutMs();
      requestCount += 1;
      return callTimeoutMs;
    };
    const xJson = async (url, { reserve = 0 } = {}) => {
      const callTimeoutMs = reserveRequest(reserve);
      let response;
      try {
        const headers = new Headers({
          Authorization: `Bearer ${bearerToken}`,
          Accept: 'application/json',
          'User-Agent': 'worldmonitor-company-monitoring-x/1.0',
        });
        response = await fetchImpl(url, {
          method: 'GET',
          headers,
          signal: AbortSignal.timeout(callTimeoutMs),
        });
      } catch (error) {
        if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
          throw new XProviderError('timeout', 'X request timed out');
        }
        throw new XProviderError('provider_unavailable', `X request failed: ${error?.message ?? String(error)}`);
      }
      if (!response?.ok) {
        throw new XProviderError(xProviderReason(response?.status ?? 503), `X returned HTTP ${response?.status ?? 503}`);
      }
      try {
        return await response.json();
      } catch {
        throw new XProviderError('request_rejected', 'X returned malformed JSON');
      }
    };

    const profileCache = new Map();
    const profiledAccountIds = new Set();
    const profileBy = async (kind, value, reserve) => {
      const key = `${kind}:${String(value).toLowerCase()}`;
      if (profileCache.has(key)) return profileCache.get(key);
      const path = kind === 'id'
        ? `/2/users/${encodeURIComponent(value)}`
        : `/2/users/by/username/${encodeURIComponent(value)}`;
      const url = new URL(path, 'https://api.x.com');
      url.searchParams.set('user.fields', 'id,name,username,verified,protected,url,entities');
      const body = await xJson(url, { reserve });
      if (!body?.data) throw new XProviderError('request_rejected', 'X profile lookup returned no user');
      profileCache.set(key, body.data);
      return body.data;
    };

    const identities = [];
    const protectedAccountIds = new Set();
    let verificationIncomplete = false;
    const sortedSubjects = [...work.subjects].sort((left, right) =>
      String(left.companyId).localeCompare(String(right.companyId))
    );
    const subjectsWithClaims = sortedSubjects.filter((subject) =>
      Array.isArray(subject.domains) && subject.domains.length > 0 &&
      Array.isArray(subject.xHandles) && subject.xHandles.length > 0
    );
    const anticipatedSearchRequests = Math.max(1, Math.ceil(subjectsWithClaims.length / 10));
    const hasTrackedPosts = sortedSubjects.some((subject) =>
      Array.isArray(subject.trackedPosts) && subject.trackedPosts.length > 0
    );
    const verificationReserve = Math.min(
      MAX_X_REQUESTS_PER_LEASE,
      anticipatedSearchRequests + (hasTrackedPosts ? 1 : 0) + (typeof fetchComplianceEvents === 'function' ? 1 : 0),
    );
    subjectLoop: for (const subject of sortedSubjects) {
      const domains = Array.isArray(subject.domains) ? subject.domains : [];
      const handles = Array.isArray(subject.xHandles) ? subject.xHandles : [];
      if (domains.length === 0 || handles.length === 0) {
        verificationIncomplete = true;
        continue;
      }
      let bestDemotion;
      let verified;
      let attempted = false;
      let subjectVerificationIncomplete = false;
      for (const domainClaim of domains) {
        const domain = normalizeDomain(domainClaim.value);
        const priorUrl = subject.currentIdentity?.officialDomain === domain
          ? subject.currentIdentity.officialPageUrl
          : undefined;
        const officialPageUrl = priorUrl ?? `https://${domain}/`;
        let page;
        try {
          const callTimeoutMs = remainingCallTimeoutMs();
          page = await fetchOfficialPage(officialPageUrl, { allowedDomains: [domain], timeoutMs: callTimeoutMs });
        } catch (error) {
          if (error instanceof XProviderPartialError) {
            providerPartial = true;
            verificationIncomplete = true;
            break subjectLoop;
          }
          subjectVerificationIncomplete = true;
          continue;
        }

        const profileCandidates = [];
        if (subject.currentIdentity?.accountId) {
          profileCandidates.push(['id', subject.currentIdentity.accountId]);
        }
        const candidateHandles = uniqueBy([
          ...(subject.currentIdentity?.currentHandle ? [subject.currentIdentity.currentHandle] : []),
          ...handles.map((claim) => claim.value),
        ], (handle) => String(handle).toLowerCase());
        profileCandidates.push(...candidateHandles.map((handle) => ['handle', handle]));

        for (const [kind, value] of profileCandidates) {
          attempted = true;
          let profile;
          try {
            profile = await profileBy(kind, value, verificationReserve);
          } catch (error) {
            if (error instanceof XProviderPartialError) {
              providerPartial = true;
              verificationIncomplete = true;
              break subjectLoop;
            }
            if (error instanceof XProviderError && error.reason === 'request_rejected') continue;
            return providerErrorResult(error, requestCount, requestCostUsdMicros);
          }
          profiledAccountIds.add(String(profile.id));
          if (profile.protected === true) protectedAccountIds.add(String(profile.id));
          const handleClaim = handles.find((claim) =>
            String(claim.value).toLowerCase() === String(value).toLowerCase()
          ) ?? handles[0];
          let observation;
          try {
            observation = await verifyOfficialXIdentity({
              subject: {
                companyId: subject.companyId,
                name: subject.name,
                domicileCountry: subject.domicileCountry,
                officialDomain: domain,
                officialPageUrl,
                domainClaimId: domainClaim.claimId,
                xHandleClaimId: handleClaim.claimId,
                claimedHandle: handleClaim.value,
              },
              page,
              profile,
              checkedAt,
              expiresAt: checkedAt + DEFAULT_IDENTITY_TTL_MS,
              priorIdentity: publicPriorIdentity(subject.currentIdentity),
            });
          } catch {
            subjectVerificationIncomplete = true;
            continue;
          }
          if (observation.state === 'authoritative') {
            verified = observation;
            break;
          }
          bestDemotion = observation;
        }
        if (verified) break;
      }
      if (subjectVerificationIncomplete) verificationIncomplete = true;
      if (verified) identities.push(verified);
      else if (bestDemotion && !subjectVerificationIncomplete) identities.push(bestDemotion);
      else if (attempted) verificationIncomplete = true;
    }

    const isolatedIdentities = isolateCorporateFamilyIdentities(identities, sortedSubjects, checkedAt);
    identities.splice(0, identities.length, ...isolatedIdentities);
    const identityByCompany = new Map(identities.map((identity) => [identity.companyId, identity]));
    const { packs } = compileXRecentSearchPacks(identities, { now: checkedAt });
    const bindings = packs.flatMap((pack) => pack.accountIds.map((accountId, index) => ({
      companyId: pack.companyIds[index],
      accountId,
      currentHandle: pack.handles[index],
      permittedStorage: storageMode,
    })));
    const complianceBindings = uniqueBy([
      ...bindings,
      ...sortedSubjects.flatMap((subject) => {
        const identity = subject.currentIdentity;
        if (!identity || !X_ACCOUNT_ID.test(String(identity.accountId ?? ''))) return [];
        const effectiveIdentity = identityByCompany.get(String(subject.companyId)) ?? identity;
        const mayStoreText = effectiveIdentity.state === 'authoritative' &&
          effectiveIdentity.expiresAt > checkedAt &&
          Array.isArray(effectiveIdentity.allowedUses) &&
          effectiveIdentity.allowedUses.includes('recent_search');
        try {
          return [{
            companyId: String(subject.companyId),
            accountId: String(identity.accountId),
            currentHandle: normalizeHandle(identity.currentHandle),
            permittedStorage: mayStoreText ? storageMode : 'metadata_only',
          }];
        } catch {
          return [];
        }
      }),
    ], (binding) => binding.accountId);

    const retentionStart = checkedAt - 7 * 24 * 60 * 60 * 1000;
    const availableStart = Math.min(work.windowEnd - 1, Math.max(work.windowStart, retentionStart));
    const returnedWindow = { startAt: availableStart, endAt: work.windowEnd };
    const reconciledPosts = [];
    const complianceEvents = [];
    let complianceUnavailable = false;
    const allTrackedPosts = sortedSubjects.flatMap((subject) =>
      (Array.isArray(subject.trackedPosts) ? subject.trackedPosts : []).map((tracked) => ({
        ...tracked,
        companyId: subject.companyId,
      }))
    ).filter((tracked) => complianceBindings.some((binding) =>
      binding.companyId === tracked.companyId && binding.accountId === String(tracked.authorAccountId)
    ));
    const trackedReconciliationCap = Math.min(100, Math.max(1, work.resultCap - 1));
    const trackedPosts = allTrackedPosts.slice(0, trackedReconciliationCap);
    if (trackedPosts.length < allTrackedPosts.length) complianceUnavailable = true;
    if (trackedPosts.length > 0) {
      try {
        const trackedUrl = new URL('/2/tweets', 'https://api.x.com');
        trackedUrl.searchParams.set('ids', trackedPosts.map((tracked) => tracked.postId).join(','));
        trackedUrl.searchParams.set('tweet.fields', 'author_id,created_at,edit_history_tweet_ids,withheld');
        trackedUrl.searchParams.set('expansions', 'author_id');
        trackedUrl.searchParams.set('user.fields', 'id,name,username,protected,verified');
        const trackedBody = await xJson(trackedUrl, { reserve: Math.max(1, packs.length) });
        const normalizedTracked = normalizeXRecentSearchPage(trackedBody, {
          bindings: complianceBindings,
          permittedStorage: storageMode,
          observedAt: checkedAt,
        });
        reconciledPosts.push(...normalizedTracked.posts);
        const returnedIds = new Set((trackedBody?.data ?? []).map((item) => String(item.id)));
        const errorsById = new Map((trackedBody?.errors ?? []).map((error) => [
          String(error.resource_id ?? error.value ?? ''),
          error,
        ]));
        for (const tracked of trackedPosts) {
          if (returnedIds.has(String(tracked.postId))) continue;
          const error = errorsById.get(String(tracked.postId));
          const errorText = `${error?.title ?? ''} ${error?.detail ?? ''}`;
          const protectedContent = protectedAccountIds.has(String(tracked.authorAccountId)) || /\bprotected\b/i.test(errorText);
          const definitiveDeletion = profiledAccountIds.has(String(tracked.authorAccountId)) &&
            Boolean(error) &&
            /\b(?:not found|does not exist|deleted)\b/i.test(errorText) &&
            !/\b(?:authori[sz]ation|forbidden|suspended|protected)\b/i.test(errorText);
          if (protectedContent || definitiveDeletion) {
            complianceEvents.push({
              type: protectedContent ? 'protected' : 'delete',
              postId: tracked.postId,
              authorAccountId: tracked.authorAccountId,
              observedAt: checkedAt,
            });
          } else {
            complianceUnavailable = true;
          }
        }
      } catch (error) {
        if (error instanceof XProviderPartialError) providerPartial = true;
        complianceUnavailable = true;
      }
    }
    if (typeof fetchComplianceEvents === 'function') {
      try {
        const callTimeoutMs = reserveRequest(Math.max(1, packs.length));
        const externalEvents = await fetchComplianceEvents({
          startAt: availableStart,
          endAt: work.windowEnd,
          bindings: complianceBindings,
          bearerToken,
          timeoutMs: callTimeoutMs,
        });
        if (!Array.isArray(externalEvents)) throw new Error('compliance events must be an array');
        complianceEvents.push(...externalEvents);
      } catch (error) {
        if (error instanceof XProviderPartialError) providerPartial = true;
        complianceUnavailable = true;
      }
    }

    const postMap = new Map();
    const unexpectedAuthors = new Set();
    const normalizedCompliance = normalizeXRecentSearchPage(
      { data: [], compliance: complianceEvents },
      { bindings: complianceBindings, permittedStorage: storageMode, observedAt: checkedAt },
    );
    for (const author of normalizedCompliance.unexpectedAuthors) unexpectedAuthors.add(author);
    const coalescedCompliance = new Map();
    for (const post of normalizedCompliance.posts) {
      const key = `${post.companyId}:${post.postId}`;
      const prior = coalescedCompliance.get(key);
      if (prior?.contentState === 'deleted') continue;
      coalescedCompliance.set(key, post);
    }
    let hasMore = false;
    const compliancePosts = [...coalescedCompliance.values()].sort((left, right) =>
      Number(right.contentState === 'deleted') - Number(left.contentState === 'deleted') ||
      left.companyId.localeCompare(right.companyId) ||
      left.postId.localeCompare(right.postId)
    );
    let retainedComplianceEventCount = 0;
    for (const post of compliancePosts) {
      if (postMap.size >= work.resultCap) {
        hasMore = true;
        continue;
      }
      postMap.set(`${post.companyId}:${post.postId}`, post);
      retainedComplianceEventCount += 1;
    }
    for (const post of reconciledPosts) {
      const key = `${post.companyId}:${post.postId}`;
      if (postMap.has(key)) continue;
      if (postMap.size >= work.resultCap) {
        hasMore = true;
        continue;
      }
      postMap.set(key, post);
    }
    try {
      packLoop: for (let packIndex = 0; packIndex < packs.length; packIndex += 1) {
        const pack = packs[packIndex];
        let nextToken;
        do {
          const remaining = work.resultCap - postMap.size;
          if (remaining <= 0) {
            hasMore = true;
            break packLoop;
          }
          const url = new URL('/2/tweets/search/recent', 'https://api.x.com');
          url.searchParams.set('query', pack.query);
          url.searchParams.set('start_time', new Date(availableStart).toISOString());
          url.searchParams.set('end_time', new Date(work.windowEnd).toISOString());
          url.searchParams.set('max_results', String(Math.max(10, Math.min(100, remaining))));
          url.searchParams.set('tweet.fields', 'author_id,created_at,edit_history_tweet_ids,withheld');
          url.searchParams.set('expansions', 'author_id');
          url.searchParams.set('user.fields', 'id,name,username,protected,verified');
          if (nextToken) url.searchParams.set('next_token', nextToken);
          const body = await xJson(url);
          const normalized = normalizeXRecentSearchPage(body, {
            bindings: bindings.filter((binding) => pack.accountIds.includes(binding.accountId)),
            permittedStorage: storageMode,
            observedAt: checkedAt,
          });
          for (const author of normalized.unexpectedAuthors) unexpectedAuthors.add(author);
          for (const post of normalized.posts) {
            const key = `${post.companyId}:${post.postId}`;
            if (postMap.has(key)) continue;
            if (postMap.size >= work.resultCap) {
              hasMore = true;
              break;
            }
            postMap.set(key, post);
          }
          nextToken = normalized.nextToken;
          if (nextToken && postMap.size >= work.resultCap) {
            hasMore = true;
            break packLoop;
          }
        } while (nextToken);
        if (packIndex < packs.length - 1 && postMap.size >= work.resultCap) {
          hasMore = true;
          break;
        }
      }
    } catch (error) {
      if (error instanceof XProviderPartialError) {
        providerPartial = true;
        hasMore = true;
      } else {
        return providerErrorResult(error, requestCount, requestCostUsdMicros);
      }
    }
    if (postMap.size >= work.resultCap) hasMore = true;

    const gaps = [];
    if (availableStart > work.windowStart) {
      gaps.push({
        startAt: work.windowStart,
        endAt: availableStart,
        reason: 'provider_retention',
      });
    }
    const incompleteReason = providerPartial
      ? 'provider_partial'
      : hasMore
      ? 'pagination_cap'
      : complianceUnavailable
        ? 'compliance_unavailable'
        : verificationIncomplete
          ? 'provider_partial'
          : undefined;
    if (incompleteReason && availableStart < work.windowEnd) {
      gaps.push({ startAt: availableStart, endAt: work.windowEnd, reason: incompleteReason });
    }
    const checkpoint = buildCheckpoint(work, packs);
    const posts = [...postMap.values()];
    const coverage = gaps.length > 0 ? 'partial' : 'complete';
    return {
      type: 'result',
      itemCount: posts.length,
      hasMore,
      coverage,
      returnedRange: { startAt: work.windowStart, endAt: work.windowEnd },
      checkpoint,
      emptyValidated: posts.length === 0 && coverage === 'complete',
      costUsdMicros: requestCount * requestCostUsdMicros,
      xIngestion: {
        requestedWindow: { startAt: work.windowStart, endAt: work.windowEnd },
        returnedWindow,
        checkpoints: work.obligations.map((obligation) => ({
          companyId: obligation.companyId,
          ...(obligation.checkpoint ? { checkpointBefore: obligation.checkpoint } : {}),
          checkpointAfter: checkpoint,
        })),
        packing: packs,
        gaps,
        permittedStorage: storageMode,
        identities,
        posts,
        unexpectedAuthorAccountIds: [...unexpectedAuthors].sort(),
        requestCount,
        complianceEventCount: retainedComplianceEventCount,
      },
    };
  };
}
