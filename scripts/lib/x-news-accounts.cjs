'use strict';

const { assertXPostBudgetAdmission, MAX_RECEIPT_BYTES } = require('./x-post-budget.cjs');

/**
 * Curated X news-account monitoring (Track A / #6654).
 *
 * Product-managed public news-account registry helpers used by ais-relay.
 * Official X API only. Post text is R4: first-party panels may show API-fresh
 * bodies; alerts/MCP/embed partners receive derived facts + permalink only.
 */

const X_HANDLE = /^[A-Za-z0-9_]{1,15}$/;
const X_ACCOUNT_ID = /^[1-9]\d{0,18}$/;
const X_API_ORIGIN = 'https://api.x.com';
const TOMBSTONE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_FEED_ITEMS = 200;
const DEFAULT_MAX_TEXT_CHARS = 800;
const X_LIST_POST_LIMIT = 5;
const X_LIST_POLL_INTERVAL_MS = 15 * 60 * 1000;
const MAX_TWEET_LOOKUP_IDS = 100;
const DELETION_AUDIT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DELETION_AUDIT_MAX_POSTS = 25;
const MAX_429_BACKOFF_MS = 15 * 60 * 1000;
// 1000 * 2**10 = 1_024_000ms, the first power of two at or above the 15-min
// ceiling — so the exponential can actually reach MAX_429_BACKOFF_MS.
const MAX_429_BACKOFF_EXPONENT = 10;
// 401/403 is not a transient upstream hiccup and does not heal on API time: an
// absent, wrong-scope or revoked bearer rejects EVERY account until an operator
// provisions or rotates the token. Two full poll intervals guarantees at least
// one whole cycle is skipped even at the slowest cadence, while keeping recovery
// automatic within 30 minutes of the token landing.
const AUTH_FAILURE_BACKOFF_MS = 30 * 60 * 1000;
// 402 is the same CLASS as 401/403 — it does not heal on API time — but it is a
// different remediation. Observed 2026-08-25: the plan ran out of credits and
// every call answered
//   {"title":"Payment Required","detail":"credits depleted","status":402}
// with rate-limit headers untouched (remaining 1999/2000), so neither the 429
// backoff nor the auth breaker engaged and all 64 accounts were rejected every
// cycle — the same ~6.1k/day the auth breaker exists to prevent.
//
// It gets the auth backoff (recovery stays automatic within one deferral of a
// top-up) but its OWN message: the bearer is valid here, and telling an operator
// to "check X_BEARER_TOKEN" would cost a credential rotation that fixes nothing.
const CREDITS_EXHAUSTED_STATUS = 402;
const X_BACKOFF_CAUSES = Object.freeze({
  RATE_LIMIT: 'rate-limit',
  AUTH: 'auth',
  CREDITS: 'credits',
  MEMBERSHIP_DRIFT: 'membership-drift',
});
const X_FEED_SNAPSHOT_VERSION = 1;
const USER_AGENT = 'WorldMonitor/1.0 (curated news-account monitoring; +https://worldmonitor.app)';
const X_CURATED_LIST_NAME = 'WorldMonitor Curated News';
const X_CURATED_LIST_DESCRIPTION = 'WorldMonitor production sources from data/x-accounts.json';

function toText(value) {
  return value == null ? '' : String(value);
}

function normalizeHandle(value) {
  const handle = toText(value).trim().replace(/^@/, '');
  if (!X_HANDLE.test(handle)) return '';
  return handle;
}

function normalizeAccountId(value) {
  const id = toText(value).trim();
  return X_ACCOUNT_ID.test(id) ? id : '';
}

function loadXAccounts(raw, options = {}) {
  // The normal serving set is the union, not one registry bucket. Buckets are
  // editorial views and overlap as the registry evolves; `set` remains an
  // explicit operator override for constrained runs.
  const requestedSet = Object.prototype.hasOwnProperty.call(options, 'set') && options.set != null
    ? String(options.set).trim().toLowerCase()
    : '';
  const hasExplicitSet = requestedSet !== '' && requestedSet !== 'all' && requestedSet !== '*';
  const set = hasExplicitSet ? requestedSet : '';
  const channels = raw?.channels && typeof raw.channels === 'object' ? raw.channels : {};
  const rows = hasExplicitSet
    ? (Array.isArray(channels[set]) ? channels[set] : [])
    : Object.values(channels).flatMap((bucket) => Array.isArray(bucket) ? bucket : []);
  const seen = new Set();
  return rows
    .filter((row) => row && typeof row.handle === 'string')
    .map((row) => {
      const handle = normalizeHandle(row.handle);
      const accountId = normalizeAccountId(row.accountId);
      return {
        handle,
        accountId,
        label: row.label ? String(row.label) : handle,
        sourceName: row.sourceName ? String(row.sourceName) : (row.label ? String(row.label) : handle),
        topic: row.topic ? String(row.topic) : 'other',
        region: row.region ? String(row.region) : undefined,
        tier: row.tier != null ? Number(row.tier) : undefined,
        enabled: row.enabled !== false,
      };
    })
    .filter((row) => {
      if (!row.handle || !row.enabled) return false;
      const key = row.accountId ? `id:${row.accountId}` : `handle:${row.handle.toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function countEnabledAccounts(raw) {
  const channels = raw?.channels || {};
  let count = 0;
  for (const bucket of Object.values(channels)) {
    if (!Array.isArray(bucket)) continue;
    for (const row of bucket) {
      if (row && row.enabled !== false && normalizeHandle(row.handle)) count += 1;
    }
  }
  return count;
}

function permalinkFor(handle, postId) {
  return `https://x.com/${handle}/status/${postId}`;
}

function normalizeXPost(tweet, account, options = {}) {
  const maxChars = Number.isFinite(options.maxTextChars) ? options.maxTextChars : DEFAULT_MAX_TEXT_CHARS;
  const postId = normalizeAccountId(tweet?.id);
  const handle = normalizeHandle(account?.handle);
  if (!postId || !handle) return null;
  const textRaw = toText(tweet?.text);
  const createdAtMs = tweet?.created_at ? Date.parse(String(tweet.created_at)) : Date.now();
  if (!Number.isFinite(createdAtMs)) return null;
  const createdAt = new Date(createdAtMs).toISOString();
  const metrics = tweet?.public_metrics && typeof tweet.public_metrics === 'object' ? tweet.public_metrics : {};
  const referenced = Array.isArray(tweet?.referenced_tweets) ? tweet.referenced_tweets : [];
  const isReply = referenced.some((ref) => ref && ref.type === 'replied_to');
  const isQuote = referenced.some((ref) => ref && ref.type === 'quoted');
  const mediaKeys = Array.isArray(tweet?.attachments?.media_keys) ? tweet.attachments.media_keys : [];
  return {
    id: `${handle}:${postId}`,
    postId,
    source: 'x',
    account: handle,
    accountId: normalizeAccountId(account?.accountId) || '',
    accountTitle: account?.label || handle,
    sourceName: account?.sourceName || account?.label || handle,
    url: permalinkFor(handle, postId),
    ts: createdAt,
    text: textRaw.slice(0, maxChars),
    topic: account?.topic || 'other',
    tags: [account?.region].filter(Boolean),
    lang: tweet?.lang ? String(tweet.lang) : '',
    hasMedia: mediaKeys.length > 0,
    isReply,
    isQuote,
    likeCount: Number.isFinite(metrics.like_count) ? metrics.like_count : 0,
    replyCount: Number.isFinite(metrics.reply_count) ? metrics.reply_count : 0,
    repostCount: Number.isFinite(metrics.retweet_count) ? metrics.retweet_count : 0,
    earlySignal: true,
    storageState: 'metadata_only',
    contentState: 'active',
  };
}

function compactTimelineItem(item) {
  if (!item) return null;
  return {
    postId: item.postId,
    ts: item.ts,
    text: item.text.slice(0, DEFAULT_MAX_TEXT_CHARS),
    lang: item.lang,
    hasMedia: item.hasMedia,
    isReply: item.isReply,
    isQuote: item.isQuote,
    likeCount: item.likeCount,
    replyCount: item.replyCount,
    repostCount: item.repostCount,
  };
}

function expandTimelineItem(item, account) {
  if (!item) return null;
  const handle = normalizeHandle(account?.handle);
  return {
    id: `${handle}:${item.postId}`,
    postId: item.postId,
    source: 'x',
    account: handle,
    accountId: normalizeAccountId(account?.accountId) || '',
    accountTitle: account?.label || handle,
    sourceName: account?.sourceName || account?.label || handle,
    url: permalinkFor(handle, item.postId),
    ts: item.ts,
    text: item.text,
    topic: account?.topic || 'other',
    tags: [account?.region].filter(Boolean),
    lang: item.lang,
    hasMedia: item.hasMedia,
    isReply: item.isReply,
    isQuote: item.isQuote,
    likeCount: item.likeCount,
    replyCount: item.replyCount,
    repostCount: item.repostCount,
    earlySignal: true,
    storageState: 'metadata_only',
    contentState: 'active',
  };
}

function truncateJsonString(value, maxPayloadBytes) {
  const characters = Array.from(value);
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const bytes = Buffer.byteLength(JSON.stringify(characters.slice(0, middle).join(''))) - 2;
    if (bytes <= maxPayloadBytes) low = middle;
    else high = middle - 1;
  }
  return characters.slice(0, low).join('');
}

function fitListReceipt(receipt) {
  if (Buffer.byteLength(JSON.stringify(receipt)) <= MAX_RECEIPT_BYTES) return receipt;
  const bounded = {
    ...receipt,
    posts: receipt.posts.map((post) => ({
      ...post,
      item: post.item ? { ...post.item, text: '' } : null,
    })),
  };
  let remainingBytes = MAX_RECEIPT_BYTES - Buffer.byteLength(JSON.stringify(bounded));
  if (remainingBytes < 0) return null;
  const textPosts = receipt.posts.filter((post) => post.item);
  let remainingPosts = textPosts.length;
  for (let index = 0; index < receipt.posts.length; index += 1) {
    const source = receipt.posts[index];
    if (!source.item) continue;
    const textBudget = Math.floor(remainingBytes / remainingPosts);
    const text = truncateJsonString(source.item.text, textBudget);
    bounded.posts[index].item.text = text;
    remainingBytes -= Buffer.byteLength(JSON.stringify(text)) - 2;
    remainingPosts -= 1;
  }
  return bounded;
}

function listAccountMap(accounts) {
  const result = new Map();
  for (const account of Array.isArray(accounts) ? accounts : []) {
    const accountId = normalizeAccountId(account?.accountId);
    if (!accountId || account?.enabled === false || result.has(accountId)) return null;
    result.set(accountId, { ...account, accountId });
  }
  return result;
}

function verifyXListMembership({ listId, accounts, listBody, membersBody } = {}) {
  const expectedListId = normalizeAccountId(listId);
  const expectedById = listAccountMap(accounts);
  const findings = [];
  const list = listBody?.data;
  const memberRows = Array.isArray(membersBody?.data) ? membersBody.data : null;

  if (!expectedListId || !expectedById) {
    findings.push({ kind: 'invalid-expected-set', message: 'the registry contains an invalid or duplicate account ID' });
  }
  if (!list || typeof list !== 'object' || Array.isArray(list)) {
    findings.push({ kind: 'unreadable-list', message: 'the List details response has no usable data object' });
  } else {
    if (normalizeAccountId(list.id) !== expectedListId) {
      findings.push({ kind: 'list-id-mismatch', message: `expected List ${expectedListId}, received ${String(list.id || 'none')}` });
    }
    if (String(list.name || '') !== X_CURATED_LIST_NAME) {
      findings.push({ kind: 'list-name-mismatch', message: `the List name must be "${X_CURATED_LIST_NAME}"` });
    }
    if (String(list.description || '') !== X_CURATED_LIST_DESCRIPTION) {
      findings.push({ kind: 'list-description-mismatch', message: `the List description must be "${X_CURATED_LIST_DESCRIPTION}"` });
    }
    if (list.private !== false) {
      findings.push({ kind: 'list-private', message: 'the configured X List is not public' });
    }
    if (Number(list.member_count) !== expectedById?.size) {
      findings.push({
        kind: 'member-count-mismatch',
        message: `List details report ${Number(list.member_count) || 0} members; expected ${expectedById?.size || 0}`,
      });
    }
  }

  if (!memberRows || (Array.isArray(membersBody?.errors) && membersBody.errors.length > 0)) {
    const error = Array.isArray(membersBody?.errors) ? membersBody.errors[0] : null;
    findings.push({
      kind: 'unreadable-members',
      message: error
        ? `${error.title || 'API error'}${error.detail ? `: ${error.detail}` : ''}`
        : 'the List members response has no usable data array',
    });
  }
  if (membersBody?.meta?.next_token || membersBody?.meta?.previous_token) {
    findings.push({ kind: 'pagination', message: 'the List members response is paginated; exact single-page verification is not possible' });
  }
  if (memberRows && Number(membersBody?.meta?.result_count) !== memberRows.length) {
    findings.push({
      kind: 'result-count-mismatch',
      message: `members result_count does not match the ${memberRows.length} returned rows`,
    });
  }

  const actualById = new Map();
  for (const member of memberRows || []) {
    const accountId = normalizeAccountId(member?.id);
    if (!accountId || typeof member?.username !== 'string' || !member.username) {
      findings.push({ kind: 'unreadable-member', message: 'a List member is missing a valid immutable ID or username' });
      continue;
    }
    if (actualById.has(accountId)) {
      findings.push({ kind: 'duplicate-member', accountId, message: `List member ID ${accountId} appears more than once` });
      continue;
    }
    actualById.set(accountId, member);
    if (member.protected === true) {
      findings.push({ kind: 'protected-member', accountId, message: `@${member.username} is protected` });
    }
  }

  const expectedIds = [...(expectedById?.keys() || [])];
  const actualIds = [...actualById.keys()];
  const missingIds = expectedIds.filter((id) => !actualById.has(id)).sort();
  const extraIds = actualIds.filter((id) => !expectedById?.has(id)).sort();
  if (missingIds.length) {
    findings.push({ kind: 'missing-members', ids: missingIds, message: `List is missing ${missingIds.join(', ')}` });
  }
  if (extraIds.length) {
    findings.push({ kind: 'extra-members', ids: extraIds, message: `List has undeclared members ${extraIds.join(', ')}` });
  }
  for (const [accountId, expected] of expectedById || []) {
    const actual = actualById.get(accountId);
    if (actual && normalizeHandle(actual.username).toLowerCase() !== normalizeHandle(expected.handle).toLowerCase()) {
      findings.push({
        kind: 'handle-mismatch',
        accountId,
        message: `ID ${accountId} is @${actual.username}, not @${expected.handle}`,
      });
    }
  }

  return {
    ok: findings.length === 0,
    expectedCount: expectedById?.size || 0,
    actualCount: memberRows?.length || 0,
    missingIds,
    extraIds,
    findings,
  };
}

function listPostIsExcluded(tweet) {
  const references = Array.isArray(tweet?.referenced_tweets) ? tweet.referenced_tweets : [];
  return references.some((reference) => reference?.type === 'replied_to' || reference?.type === 'retweeted');
}

function buildXListReceiptResult({
  listId,
  sourceSlot,
  providerSuccessAt,
  accounts,
  body,
  maxTextChars = DEFAULT_MAX_TEXT_CHARS,
}) {
  const reject = (error = 'invalid_page') => ({ receipt: null, error });
  const normalizedListId = normalizeAccountId(listId);
  const normalizedSourceSlot = normalizeSlot(sourceSlot);
  const normalizedProviderSuccessAt = toMs(providerSuccessAt);
  const accountById = listAccountMap(accounts);
  if (!normalizedListId || !normalizedSourceSlot || !normalizedProviderSuccessAt
    || !accountById || accountById.size === 0
    || !body || typeof body !== 'object' || Array.isArray(body)
    || (Array.isArray(body.errors) && body.errors.length > 0)) return reject();
  let rawPosts;
  if (Array.isArray(body.data)) rawPosts = body.data;
  else if (body.data == null && Number(body.meta?.result_count) === 0) rawPosts = [];
  else return reject();
  if (rawPosts.length > X_LIST_POST_LIMIT
    || (body.meta?.result_count != null && Number(body.meta.result_count) !== rawPosts.length)) return reject();

  const posts = [];
  for (const tweet of rawPosts) {
    const postId = normalizeAccountId(tweet?.id);
    const authorId = normalizeAccountId(tweet?.author_id);
    const account = accountById.get(authorId);
    if (!postId || !authorId || typeof tweet?.text !== 'string'
      || !tweet.created_at || !Number.isFinite(Date.parse(String(tweet.created_at)))) return reject();
    if (!account) return reject('unknown_author');
    posts.push({
      id: postId,
      accountId: authorId,
      item: listPostIsExcluded(tweet)
        ? null
        : compactTimelineItem(normalizeXPost(tweet, account, { maxTextChars })),
    });
  }
  const receipt = fitListReceipt({
    version: 1,
    listId: normalizedListId,
    sourceSlot: normalizedSourceSlot,
    providerSuccessAt: normalizedProviderSuccessAt,
    rawPostCount: rawPosts.length,
    posts,
  });
  return receipt ? { receipt, error: null } : reject();
}

function buildXListReceipt(options) {
  return buildXListReceiptResult(options).receipt;
}

function normalizeXListReceipt(receipt, expectedListId, accounts) {
  if (!receipt || receipt.version !== 1 || typeof receipt !== 'object' || Array.isArray(receipt)) return null;
  const listId = normalizeAccountId(receipt.listId);
  const sourceSlot = normalizeSlot(receipt.sourceSlot);
  const providerSuccessAt = toMs(receipt.providerSuccessAt);
  const rawPostCount = Number(receipt.rawPostCount);
  const posts = receipt.posts;
  const accountById = listAccountMap(accounts);
  if (listId !== normalizeAccountId(expectedListId) || !sourceSlot || !providerSuccessAt
    || !accountById
    || !Number.isSafeInteger(rawPostCount) || rawPostCount < 0 || rawPostCount > X_LIST_POST_LIMIT
    || !Array.isArray(posts) || posts.length !== rawPostCount
    || posts.some((post) => !post || typeof post !== 'object' || Array.isArray(post)
      || !normalizeAccountId(post.id)
      || !accountById.has(normalizeAccountId(post.accountId))
      || (post.item !== null && (!post.item || typeof post.item !== 'object' || Array.isArray(post.item)
        || normalizeAccountId(post.item.postId) !== normalizeAccountId(post.id)
        || !Number.isFinite(Date.parse(post.item.ts))
        || typeof post.item.text !== 'string' || post.item.text.length > DEFAULT_MAX_TEXT_CHARS
        || typeof post.item.lang !== 'string'
        || typeof post.item.hasMedia !== 'boolean'
        || typeof post.item.isReply !== 'boolean'
        || typeof post.item.isQuote !== 'boolean'
        || !Number.isFinite(post.item.likeCount)
        || !Number.isFinite(post.item.replyCount)
        || !Number.isFinite(post.item.repostCount))))) return null;
  return { version: 1, listId, sourceSlot, providerSuccessAt, rawPostCount, posts };
}

function listItemsFromReceipt(receipt, accounts) {
  const accountById = listAccountMap(accounts);
  if (!receipt || !accountById) return [];
  return receipt.posts.flatMap((post) => {
    const account = accountById.get(post.accountId);
    const item = account ? expandTimelineItem(post.item, account) : null;
    return item ? [item] : [];
  });
}

function derivedAlertFacts(item) {
  const accountTitle = item?.accountTitle || item?.account || 'X';
  const topic = item?.topic || 'update';
  const facts = [
    `${accountTitle} posted a ${topic} update`,
    item?.hasMedia ? 'includes media' : null,
    item?.isReply ? 'is a reply' : null,
    item?.lang ? `lang=${item.lang}` : null,
  ].filter(Boolean);
  const postId = item?.postId || item?.id || '';
  const title = postId
    ? `${accountTitle} posted a ${topic} update (${postId})`
    : facts[0];
  return {
    title,
    source: item?.sourceName || accountTitle,
    link: item?.url || '',
    publishedAt: item?.ts ? Date.parse(item.ts) : Date.now(),
    facts,
    permalink: item?.url || '',
  };
}

function collectXAlertCandidates(items, sourceTiers, now = Date.now(), recencyMs = 6 * 60 * 60 * 1000) {
  const candidates = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || item.contentState === 'deleted') continue;
    const facts = derivedAlertFacts(item);
    if (!facts.title || !facts.source) continue;
    if (facts.publishedAt && recencyMs > 0 && (now - facts.publishedAt) > recencyMs) continue;
    if (!alertSourcePassesTierGate(facts.source, sourceTiers)) continue;
    candidates.push({
      title: facts.title,
      source: facts.source,
      publishedAt: facts.publishedAt,
      corroborationCount: 1,
      link: facts.permalink,
    });
  }
  return candidates;
}

function mergeAndDedup(existing, incoming, maxItems = DEFAULT_MAX_FEED_ITEMS) {
  const seen = new Set();
  return [...incoming, ...existing]
    .filter((item) => {
      if (!item?.id || seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    })
    .sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')))
    .slice(0, maxItems);
}

function tombstonePosts(items, missingIds, now = Date.now()) {
  const missing = new Set([...missingIds].map((id) => String(id)));
  return items.map((item) => {
    if (!missing.has(String(item.postId)) && !missing.has(String(item.id))) return item;
    if (item.contentState === 'deleted') return item;
    return {
      ...item,
      text: '',
      storageState: 'tombstone',
      contentState: 'deleted',
      deletedAt: new Date(now).toISOString(),
    };
  });
}

function purgeExpiredTombstones(items, now = Date.now(), ttlMs = TOMBSTONE_TTL_MS) {
  return items.filter((item) => {
    if (item.contentState !== 'deleted') return true;
    const deletedAt = Date.parse(item.deletedAt || '');
    if (!Number.isFinite(deletedAt)) return false;
    return (now - deletedAt) < ttlMs;
  });
}

function toMs(value) {
  return Math.max(0, Number(value) || 0);
}

function toCount(value) {
  return Math.max(0, Math.floor(Number(value) || 0));
}

function normalizeLastCycleUsage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return {
    requestsUsed: toCount(value.requestsUsed),
    requestLimit: toCount(value.requestLimit),
    postsRead: toCount(value.postsRead),
    postReadLimit: toCount(value.postReadLimit),
  };
}

function normalizePostBudget(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const numeric = (name) => toCount(value[name]);
  return {
    available: value.available === true,
    day: typeof value.day === 'string' ? value.day : '',
    month: typeof value.month === 'string' ? value.month : '',
    dailyLimit: numeric('dailyLimit'),
    dailyUsed: numeric('dailyUsed'),
    dailyRemaining: numeric('dailyRemaining'),
    dailyCoverageHeld: numeric('dailyCoverageHeld'),
    dailySpendableRemaining: numeric('dailySpendableRemaining'),
    monthlyLimit: numeric('monthlyLimit'),
    monthlyUsed: numeric('monthlyUsed'),
    monthlyRemaining: numeric('monthlyRemaining'),
    monthlyCostUsdMicros: numeric('monthlyCostUsdMicros'),
    projectedMonthlyPosts: numeric('projectedMonthlyPosts'),
    projectedMonthlyCostUsdMicros: numeric('projectedMonthlyCostUsdMicros'),
    exhausted: value.exhausted === true,
    ...(value.nextRequestAdmissible != null ? {
      nextRequestedPosts: numeric('nextRequestedPosts'),
      nextCoverageUnitPosts: numeric('nextCoverageUnitPosts'),
      nextRequestDailyProjected: numeric('nextRequestDailyProjected'),
      nextRequestMonthlyProjected: numeric('nextRequestMonthlyProjected'),
      nextRequestAdmissible: value.nextRequestAdmissible === true,
    } : {}),
  };
}

function normalizeSlot(value) {
  if (typeof value !== 'string' || value.length > 64 || !value.endsWith('Z')) return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
}

function normalizeCoverage(value, expectedAccounts = 0) {
  const expected = toCount(value?.expected ?? expectedAccounts);
  const polled = toCount(value?.polled);
  const failed = toCount(value?.failed);
  const attempted = toCount(value?.attempted);
  return {
    expected,
    polled,
    failed,
    attempted,
    complete: Boolean(value?.complete) && expected > 0 && polled === expected && failed === 0,
  };
}

function normalizeBackoffCause(value) {
  return Object.values(X_BACKOFF_CAUSES).includes(value) ? value : null;
}

function buildXPollState(state, { expectedAccounts = 0 } = {}) {
  const lastPollAt = Number(state?.lastPollAt) || 0;
  const rateLimitedUntil = Math.max(0, Number(state?.rateLimitedUntil) || 0);
  const coverage = normalizeCoverage(state?.lastCoverage, expectedAccounts);
  return {
    generation: Math.max(0, Math.floor(Number(state?.generation) || 0)),
    lastDeletionAuditAt: Math.max(0, Number(state?.lastDeletionAuditAt) || 0),
    lastMembershipCheckAt: Math.max(0, Number(state?.lastMembershipCheckAt) || 0),
    lastCycleUsage: normalizeLastCycleUsage(state?.lastCycleUsage),
    postBudget: normalizePostBudget(state?.postBudget),
    lookupOffset: Math.max(0, Math.floor(Number(state?.lookupOffset) || 0)),
    lastPollAt,
    lastHealthyAt: Math.max(0, Number(state?.lastHealthyAt) || 0),
    lastAttemptAt: toMs(state?.lastAttemptAt),
    lastProviderSuccessAt: toMs(state?.lastProviderSuccessAt),
    lastAcceptedPublicationAt: toMs(state?.lastAcceptedPublicationAt),
    lastAttemptSlot: normalizeSlot(state?.lastAttemptSlot),
    lastProviderSuccessSlot: normalizeSlot(state?.lastProviderSuccessSlot),
    lastPublishedSlot: normalizeSlot(state?.lastPublishedSlot),
    rateLimitedUntil,
    rateLimitAttempt: Math.max(0, Math.floor(Number(state?.rateLimitAttempt) || 0)),
    backoffCause: rateLimitedUntil ? normalizeBackoffCause(state?.backoffCause) : null,
    coverage,
  };
}

function buildXFeedSnapshot(state, { enabled = false, expectedAccounts = 0 } = {}) {
  const items = Array.isArray(state?.items) ? state.items.slice(0, DEFAULT_MAX_FEED_ITEMS) : [];
  const lastPollAt = Number(state?.lastPollAt) || 0;
  const coverage = normalizeCoverage(state?.lastCoverage, expectedAccounts);
  return {
    version: X_FEED_SNAPSHOT_VERSION,
    generation: Math.max(0, Math.floor(Number(state?.generation) || 0)),
    source: 'x',
    earlySignal: true,
    enabled: Boolean(enabled),
    count: items.length,
    updatedAt: lastPollAt > 0 ? new Date(lastPollAt).toISOString() : null,
    lastHealthyAt: Number(state?.lastHealthyAt) > 0 ? new Date(Number(state.lastHealthyAt)).toISOString() : null,
    coverage,
    items,
  };
}

function hydrateXFeedSnapshot(snapshot, { maxItems = DEFAULT_MAX_FEED_ITEMS, pollState: pollStateOverride } = {}) {
  const validSnapshot = Boolean(snapshot && snapshot.version === X_FEED_SNAPSHOT_VERSION && Array.isArray(snapshot.items));
  const validOverride = Boolean(pollStateOverride && typeof pollStateOverride === 'object' && !Array.isArray(pollStateOverride));
  if (!validSnapshot && !validOverride) return null;
  const inherited = validSnapshot ? snapshot.pollState : null;
  const pollState = pollStateOverride && typeof pollStateOverride === 'object' && !Array.isArray(pollStateOverride)
    ? pollStateOverride
    : (inherited && typeof inherited === 'object' && !Array.isArray(inherited) ? inherited : {});
  const itemLimit = Math.max(1, Math.floor(Number(maxItems) || DEFAULT_MAX_FEED_ITEMS));
  const rateLimitedUntil = Math.max(0, Number(pollState.rateLimitedUntil) || 0);
  const snapshotUpdatedAt = validSnapshot ? Date.parse(snapshot.updatedAt || '') : 0;
  const snapshotHealthyAt = validSnapshot ? Date.parse(snapshot.lastHealthyAt || '') : 0;
  return {
    generation: Math.max(0, Math.floor(Number(validSnapshot ? snapshot.generation : pollState.generation) || 0)),
    lastDeletionAuditAt: Math.max(0, Number(pollState.lastDeletionAuditAt) || 0),
    lastMembershipCheckAt: Math.max(0, Number(pollState.lastMembershipCheckAt) || 0),
    lastCycleUsage: normalizeLastCycleUsage(pollState.lastCycleUsage),
    postBudget: normalizePostBudget(pollState.postBudget),
    items: validSnapshot ? snapshot.items.filter((item) => item && typeof item === 'object').slice(0, itemLimit) : [],
    lookupOffset: Math.max(0, Math.floor(Number(pollState.lookupOffset) || 0)),
    lastPollAt: toMs(pollState.lastPollAt || snapshotUpdatedAt),
    lastHealthyAt: toMs(pollState.lastHealthyAt || snapshotHealthyAt),
    lastAttemptAt: toMs(pollState.lastAttemptAt),
    lastProviderSuccessAt: toMs(pollState.lastProviderSuccessAt),
    lastAcceptedPublicationAt: toMs(pollState.lastAcceptedPublicationAt || pollState.lastPollAt || snapshotUpdatedAt),
    lastAttemptSlot: normalizeSlot(pollState.lastAttemptSlot),
    lastProviderSuccessSlot: normalizeSlot(pollState.lastProviderSuccessSlot),
    lastPublishedSlot: normalizeSlot(pollState.lastPublishedSlot),
    rateLimitedUntil,
    rateLimitAttempt: Math.max(0, Math.floor(Number(pollState.rateLimitAttempt) || 0)),
    backoffCause: rateLimitedUntil ? normalizeBackoffCause(pollState.backoffCause) : null,
    lastCoverage: normalizeCoverage(pollState.coverage ?? (validSnapshot ? snapshot.coverage : null)),
  };
}

/**
 * Merge Redis-authoritative poll state into in-process state, under the lock.
 *
 * Split by who owns each field:
 *
 * - Rate-limit state takes the LATER deadline, not simply the Redis one. Both
 *   directions matter: a peer's active backoff must be honoured (all replicas
 *   share one X bearer, so its 429 applies to us too), but a backoff THIS
 *   process just recorded must not be cleared by an older Redis copy. Plain
 *   assignment in either direction loses one of those. The attempt counter takes
 *   the max for the same reason — escalation must not reset when a peer with a
 *   lower count publishes. The typed cause follows the winning deadline so a
 *   peer keeps the correct operator action for credits, auth, or rate limiting.
 *
 * Returns only the fields to apply, so the caller cannot accidentally clobber
 * serving state (items, coverage) with poll bookkeeping.
 */
function mergeRefreshedPollState(current, refreshed) {
  const currentDeadline = toMs(current?.rateLimitedUntil);
  const currentCause = normalizeBackoffCause(current?.backoffCause);
  if (!refreshed || typeof refreshed !== 'object') {
    return {
      lastDeletionAuditAt: toMs(current?.lastDeletionAuditAt),
      lastMembershipCheckAt: toMs(current?.lastMembershipCheckAt),
      lastCycleUsage: normalizeLastCycleUsage(current?.lastCycleUsage),
      postBudget: normalizePostBudget(current?.postBudget),
      lookupOffset: toCount(current?.lookupOffset),
      lastPollAt: toMs(current?.lastPollAt),
      lastHealthyAt: toMs(current?.lastHealthyAt),
      lastAttemptAt: toMs(current?.lastAttemptAt),
      lastProviderSuccessAt: toMs(current?.lastProviderSuccessAt),
      lastAcceptedPublicationAt: toMs(current?.lastAcceptedPublicationAt),
      lastAttemptSlot: normalizeSlot(current?.lastAttemptSlot),
      lastProviderSuccessSlot: normalizeSlot(current?.lastProviderSuccessSlot),
      lastPublishedSlot: normalizeSlot(current?.lastPublishedSlot),
      rateLimitedUntil: currentDeadline,
      rateLimitAttempt: toCount(current?.rateLimitAttempt),
      backoffCause: currentCause,
    };
  }
  const refreshedDeadline = toMs(refreshed.rateLimitedUntil);
  const refreshedCause = normalizeBackoffCause(refreshed.backoffCause);
  const rateLimitedUntil = Math.max(currentDeadline, refreshedDeadline);
  const backoffCause = rateLimitedUntil
    ? (currentDeadline === refreshedDeadline
        ? (refreshedCause || currentCause)
        : (currentDeadline > refreshedDeadline ? currentCause : refreshedCause))
    : null;
  const latestSlot = (timeField, slotField) => {
    const currentAt = toMs(current?.[timeField]);
    const refreshedAt = toMs(refreshed?.[timeField]);
    return refreshedAt >= currentAt
      ? normalizeSlot(refreshed?.[slotField])
      : normalizeSlot(current?.[slotField]);
  };
  return {
    lastDeletionAuditAt: Math.max(toMs(current?.lastDeletionAuditAt), toMs(refreshed.lastDeletionAuditAt)),
    lastMembershipCheckAt: Math.max(toMs(current?.lastMembershipCheckAt), toMs(refreshed.lastMembershipCheckAt)),
    lastCycleUsage: normalizeLastCycleUsage(refreshed.lastCycleUsage ?? current?.lastCycleUsage),
    postBudget: normalizePostBudget(refreshed.postBudget ?? current?.postBudget),
    lookupOffset: toCount(refreshed.lookupOffset),
    lastPollAt: Math.max(toMs(current?.lastPollAt), toMs(refreshed.lastPollAt)),
    lastHealthyAt: Math.max(toMs(current?.lastHealthyAt), toMs(refreshed.lastHealthyAt)),
    lastAttemptAt: Math.max(toMs(current?.lastAttemptAt), toMs(refreshed.lastAttemptAt)),
    lastProviderSuccessAt: Math.max(toMs(current?.lastProviderSuccessAt), toMs(refreshed.lastProviderSuccessAt)),
    lastAcceptedPublicationAt: Math.max(
      toMs(current?.lastAcceptedPublicationAt),
      toMs(refreshed.lastAcceptedPublicationAt),
    ),
    lastAttemptSlot: latestSlot('lastAttemptAt', 'lastAttemptSlot'),
    lastProviderSuccessSlot: latestSlot('lastProviderSuccessAt', 'lastProviderSuccessSlot'),
    lastPublishedSlot: latestSlot('lastAcceptedPublicationAt', 'lastPublishedSlot'),
    rateLimitedUntil,
    rateLimitAttempt: Math.max(toCount(current?.rateLimitAttempt), toCount(refreshed.rateLimitAttempt)),
    backoffCause,
  };
}

function alertSourcePassesTierGate(sourceName, sourceTiers) {
  const tier = Object.prototype.hasOwnProperty.call(sourceTiers, sourceName)
    ? Number(sourceTiers[sourceName])
    : 4;
  return Number.isFinite(tier) && tier !== 4;
}

function parseRetryAfterMs(headers) {
  const raw = headers?.get?.('retry-after') ?? headers?.['retry-after'] ?? headers?.['Retry-After'];
  if (raw == null || raw === '') return 0;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.floor(seconds * 1000);
  const dateMs = Date.parse(String(raw));
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  return 0;
}

/**
 * X API v2 signals rate-limit recovery with `x-rate-limit-reset`, an ABSOLUTE
 * epoch-seconds instant, not a delta. `retry-after` is not sent on every 429,
 * so without this the caller falls back to the blind exponential below.
 */
function parseRateLimitResetMs(headers, now = Date.now) {
  const raw = headers?.get?.('x-rate-limit-reset')
    ?? headers?.['x-rate-limit-reset']
    ?? headers?.['X-Rate-Limit-Reset'];
  if (raw == null || raw === '') return 0;
  const epochSeconds = Number(raw);
  if (!Number.isFinite(epochSeconds) || epochSeconds <= 0) return 0;
  return Math.max(0, Math.floor(epochSeconds * 1000) - now());
}

function compute429BackoffMs(headers, attempt = 0, now = Date.now) {
  // Upstream-declared recovery wins over our guess, bounded so a malformed or
  // hostile header cannot park the poll loop indefinitely.
  const retryAfter = parseRetryAfterMs(headers);
  if (retryAfter > 0) return Math.min(MAX_429_BACKOFF_MS, retryAfter);
  const resetIn = parseRateLimitResetMs(headers, now);
  if (resetIn > 0) return Math.min(MAX_429_BACKOFF_MS, resetIn);
  // The exponent must be able to REACH the ceiling: 1000 * 2**exp >= 900_000
  // needs exp >= 10. The previous clamp of 6 topped out at 64s, which is below
  // even MIN_POLL_INTERVAL_MS, so `rateLimitedUntil` had always elapsed by the
  // next tick and the backoff could never defer a single poll.
  const exp = Math.min(MAX_429_BACKOFF_EXPONENT, Math.max(0, Number(attempt) || 0));
  return Math.min(MAX_429_BACKOFF_MS, 1000 * (2 ** exp));
}

// Membership verification reads List and User resources only. Neither path
// returns Posts, so neither is billed against the shared returned-Post budget --
// see X_POST_RETURNING_PATHS. That is what makes a recurring check affordable.
function buildXListDetailsUrl(listId) {
  const id = normalizeAccountId(listId);
  if (!id) throw new Error('X List ID is invalid');
  const url = new URL(`/2/lists/${encodeURIComponent(id)}`, X_API_ORIGIN);
  url.searchParams.set('list.fields', 'id,name,description,private,member_count');
  return url;
}

function buildXListMembersUrl(listId) {
  const id = normalizeAccountId(listId);
  if (!id) throw new Error('X List ID is invalid');
  const url = new URL(`/2/lists/${encodeURIComponent(id)}/members`, X_API_ORIGIN);
  url.searchParams.set('max_results', '100');
  url.searchParams.set('user.fields', 'id,name,username,protected');
  return url;
}

// Findings that mean the List no longer covers the registry. A cosmetic name or
// description edit is deliberately NOT drift: the activation gate in
// scripts/verify-x-accounts.mjs still enforces those, but they cost no coverage
// and must not degrade a serving feed.
const MEMBERSHIP_DRIFT_KINDS = new Set([
  'list-id-mismatch',
  'list-private',
  'member-count-mismatch',
  'duplicate-member',
  'protected-member',
  'result-count-mismatch',
  'missing-members',
  'extra-members',
  'handle-mismatch',
]);

// Being unable to READ the List is not evidence that the List is wrong, and it
// must not be treated as drift: verifyXListMembership computes missingIds against
// an empty member map, so an unreadable page would otherwise report all 64
// accounts missing and red a perfectly healthy feed on a transient API blip.
// Report it, stamp the clock so the check does not hammer, and leave coverage be.
const MEMBERSHIP_UNVERIFIABLE_KINDS = new Set([
  'invalid-expected-set',
  'unreadable-list',
  'unreadable-members',
  'unreadable-member',
  'pagination',
]);

const MEMBERSHIP_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

function membershipCheckIsDue(lastMembershipCheckAt, nowMs) {
  const last = Math.max(0, Number(lastMembershipCheckAt) || 0);
  return last === 0 || nowMs < last || (nowMs - last) >= MEMBERSHIP_CHECK_INTERVAL_MS;
}

function buildXListPostsUrl(listId) {
  const id = normalizeAccountId(listId);
  if (!id) throw new Error('X List ID is invalid');
  const url = new URL(`/2/lists/${encodeURIComponent(id)}/tweets`, X_API_ORIGIN);
  url.searchParams.set('max_results', String(X_LIST_POST_LIMIT));
  url.searchParams.set('tweet.fields', 'author_id,created_at,lang,public_metrics,referenced_tweets,attachments');
  return url;
}

function lookupErrorResourceId(error) {
  return normalizeAccountId(error?.resource_id || error?.value);
}

function isTweetNotFoundLookupError(error) {
  if (!error || typeof error !== 'object') return false;
  const type = String(error.type || '').trim();
  return /\/2\/problems\/resource-not-found\/?$/i.test(type);
}

function recordRateLimit(nextState, headers, now) {
  const attempt = Math.max(0, Math.floor(Number(nextState.rateLimitAttempt) || 0));
  nextState.rateLimitedUntil = now() + compute429BackoffMs(headers, attempt, now);
  // Must allow the attempt counter to reach MAX_429_BACKOFF_EXPONENT; the old
  // cap of 7 held the exponential at 128s no matter how long the 429s lasted.
  nextState.rateLimitAttempt = Math.min(MAX_429_BACKOFF_EXPONENT, attempt + 1);
  nextState.backoffCause = X_BACKOFF_CAUSES.RATE_LIMIT;
}

function isAuthFailureStatus(status) {
  return status === 401 || status === 403;
}

/**
 * An auth rejection stops the whole cycle, not just one account.
 *
 * Only 429 used to break the loop; every other status incremented accountsFailed
 * and moved on. One bad bearer therefore cost ~111 rejected requests per cycle
 * (64 timelines + 47 uncached username lookups) — ~10.6k/day, indefinitely, with
 * no backoff. Park the cycle on the same deadline a 429 uses: the poll loop and
 * the cross-replica merge already honour it, and one shared bearer means a
 * peer's auth failure is ours too. The message must NOT read as a rate limit —
 * the operator response is to provision or rotate X_BEARER_TOKEN, not to wait
 * for quota — and the 429 attempt counter is deliberately untouched, since an
 * auth failure neither escalates nor resolves the exponential.
 */
function recordAuthFailure(nextState, status, context, now) {
  nextState.rateLimitedUntil = now() + AUTH_FAILURE_BACKOFF_MS;
  nextState.backoffCause = X_BACKOFF_CAUSES.AUTH;
  nextState.lastError = `X auth failed (HTTP ${status}) ${context}: check X_BEARER_TOKEN — deferring polls for ${Math.round(AUTH_FAILURE_BACKOFF_MS / 60000)}m`;
}

function isCreditsExhaustedStatus(status) {
  return status === CREDITS_EXHAUSTED_STATUS;
}

/**
 * Membership drift is a CONFIGURATION fault, not a transient upstream one, and
 * it does not heal on API time: every slot re-reads the same List, gets the same
 * off-registry author, discards the whole page in buildXListReceiptResult, and
 * is never refunded -- settle() rejects the null receipt before it reaches the
 * refund script. Left unbounded that is 5 Posts x 96 slots = 480 of the 600-Post
 * daily budget spent on pages the relay throws away, while the feed goes stale
 * anyway. Reuse the auth breaker's bounded window so an operator repairing the
 * List still recovers automatically, without paying for every slot in between.
 */
function recordMembershipDrift(nextState, detail, now) {
  nextState.rateLimitedUntil = now() + AUTH_FAILURE_BACKOFF_MS;
  nextState.backoffCause = X_BACKOFF_CAUSES.MEMBERSHIP_DRIFT;
  nextState.lastError = `X List membership drift: ${detail} — re-run scripts/verify-x-accounts.mjs and repair the List — deferring polls for ${Math.round(AUTH_FAILURE_BACKOFF_MS / 60000)}m`;
}

function recordCreditsExhausted(nextState, context, now) {
  nextState.rateLimitedUntil = now() + AUTH_FAILURE_BACKOFF_MS;
  nextState.backoffCause = X_BACKOFF_CAUSES.CREDITS;
  nextState.lastError = `X credits depleted (HTTP ${CREDITS_EXHAUSTED_STATUS}) ${context}: the bearer is valid — top up the X API plan — deferring polls for ${Math.round(AUTH_FAILURE_BACKOFF_MS / 60000)}m`;
}

function sharedBackoffMessage(cause) {
  if (cause === X_BACKOFF_CAUSES.MEMBERSHIP_DRIFT) {
    return 'X List membership drift: re-run scripts/verify-x-accounts.mjs and repair the List; shared backoff window still open; deferring poll';
  }
  if (cause === X_BACKOFF_CAUSES.CREDITS) {
    return 'X credits depleted: top up the X API plan; shared backoff window still open; deferring poll';
  }
  if (cause === X_BACKOFF_CAUSES.AUTH) {
    return 'X auth failed: check X_BEARER_TOKEN; shared backoff window still open; deferring poll';
  }
  return 'shared X rate-limit window still open; deferring poll';
}

/**
 * X reports an unreadable ACCOUNT with HTTP 200 and a top-level `errors` array,
 * not a 4xx: a protected account yields `Authorization Error`, a renamed or
 * deleted one `Not Found Error`, a suspended one `Forbidden`. Only the payload
 * distinguishes them from a genuinely quiet timeline, so a caller that trusts
 * `response.ok` reads all three as "polled successfully, no new posts".
 *
 * A resource-level error alongside usable `data` is a different thing — the
 * deleted-post tombstone path relies on exactly that shape — so this reports a
 * fault only when the payload carries no data at all.
 */
function describeResourceError(body) {
  if (Array.isArray(body?.data) && body.data.length > 0) return null;
  if (body?.data && !Array.isArray(body.data)) return null;
  const error = (Array.isArray(body?.errors) ? body.errors : [])[0];
  if (!error) return null;
  const title = typeof error.title === 'string' && error.title ? error.title : 'API error';
  const detail = typeof error.detail === 'string' && error.detail ? `: ${error.detail}` : '';
  return `${title}${detail}`;
}

function classifyDeletionLookup(body, requestedIds) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { complete: false, deletedIds: [] };
  }
  const requested = new Set(requestedIds.map(String));
  const data = body.data == null ? [] : body.data;
  const errors = body.errors == null ? [] : body.errors;
  if (!Array.isArray(data) || !Array.isArray(errors)) return { complete: false, deletedIds: [] };

  const found = new Set();
  for (const row of data) {
    const id = normalizeAccountId(row?.id);
    if (!id || !requested.has(id) || found.has(id)) return { complete: false, deletedIds: [] };
    found.add(id);
  }
  const deleted = new Set();
  for (const error of errors) {
    const id = lookupErrorResourceId(error);
    if (!id || !requested.has(id) || found.has(id) || deleted.has(id)
      || !isTweetNotFoundLookupError(error)) return { complete: false, deletedIds: [] };
    deleted.add(id);
  }
  return {
    complete: found.size + deleted.size === requested.size,
    deletedIds: [...deleted],
  };
}

function buildTweetsLookupUrl(ids) {
  const unique = [...new Set(ids.map((id) => normalizeAccountId(id)).filter(Boolean))].slice(0, MAX_TWEET_LOOKUP_IDS);
  const url = new URL('/2/tweets', X_API_ORIGIN);
  url.searchParams.set('ids', unique.join(','));
  url.searchParams.set('tweet.fields', 'id');
  return { url, ids: unique };
}

async function xFetchJson(fetchImpl, url, bearerToken, {
  timeoutMs = 15_000,
  signal,
  postBudgetAdmission,
} = {}) {
  assertXPostBudgetAdmission(url, postBudgetAdmission);
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${bearerToken}`,
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
    },
    signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { response, body };
}

function deletionAuditIsDue(lastDeletionAuditAt, nowMs) {
  const last = Math.max(0, Number(lastDeletionAuditAt) || 0);
  return last === 0 || nowMs < last || (nowMs - last) >= DELETION_AUDIT_INTERVAL_MS;
}

function utcDayStartMs(day, fallback) {
  const value = Date.parse(`${day}T00:00:00.000Z`);
  return Number.isFinite(value) ? value : fallback;
}

/** Fetch one bounded List page, then run the optional daily deletion audit. */
async function pollXListFeed({
  accounts,
  state,
  bearerToken,
  listId,
  slot,
  coverageId,
  fetchImpl,
  now = Date.now,
  maxFeedItems = DEFAULT_MAX_FEED_ITEMS,
  maxTextChars = DEFAULT_MAX_TEXT_CHARS,
  lookupDeletions = true,
  verifyMembership = true,
  withReturnedPosts,
  signal,
} = {}) {
  const configuredAccounts = Array.isArray(accounts) ? accounts : [];
  const pollCycleNow = now();
  // The caller owns the slot. Prefer the structured value it already holds over
  // re-parsing the `list-slot:` prefix off coverageId, and take its endsAt
  // directly so the Redis-side deadline cannot drift from the slot the coverage
  // marker is keyed on. The prefix parse remains as a fallback for callers that
  // pass only a coverageId.
  const sourceSlot = normalizeSlot(slot?.id)
    || (typeof coverageId === 'string' && coverageId.startsWith('list-slot:')
      ? normalizeSlot(coverageId.slice('list-slot:'.length))
      : null);
  const slotEndsAt = Number(slot?.endsAt);
  const sourceSlotEndsAt = Number.isFinite(slotEndsAt) && slotEndsAt > 0
    ? slotEndsAt
    : (sourceSlot ? Date.parse(sourceSlot) + X_LIST_POLL_INTERVAL_MS : 0);
  const activeBackoffDeadline = Number(state?.rateLimitedUntil) > pollCycleNow
    ? Number(state.rateLimitedUntil)
    : 0;
  const nextState = {
    items: Array.isArray(state?.items) ? [...state.items] : [],
    lookupOffset: Number(state?.lookupOffset) || 0,
    lastDeletionAuditAt: Math.max(0, Number(state?.lastDeletionAuditAt) || 0),
    lastMembershipCheckAt: Math.max(0, Number(state?.lastMembershipCheckAt) || 0),
    postBudget: normalizePostBudget(state?.postBudget),
    lastError: null,
    rateLimitedUntil: activeBackoffDeadline,
    rateLimitAttempt: Math.max(0, Math.floor(Number(state?.rateLimitAttempt) || 0)),
    backoffCause: activeBackoffDeadline ? normalizeBackoffCause(state?.backoffCause) : null,
    accountsPolled: 0,
    accountsFailed: 0,
    accountsAttempted: 0,
    newCount: 0,
    requestsUsed: 0,
    cycleComplete: false,
    providerSuccess: false,
    providerSuccessAt: 0,
    providerSuccessSlot: null,
    listAccepted: false,
    receiptAcks: [],
  };
  if (activeBackoffDeadline) {
    nextState.lastError = sharedBackoffMessage(nextState.backoffCause);
    return nextState;
  }
  if (!bearerToken) {
    nextState.lastError = 'X_BEARER_TOKEN is not configured';
    return nextState;
  }
  if (!normalizeAccountId(listId)) {
    nextState.lastError = 'X_CURATED_LIST_ID is not configured';
    return nextState;
  }
  if (!sourceSlot) {
    nextState.lastError = 'X List poll slot is not configured';
    return nextState;
  }

  let requestsUsed = 0;
  let postsRead = 0;
  let postReadLimit = 0;
  let listValidationError = null;
  const countedFetch = (url, options = {}) => {
    requestsUsed += 1;
    return xFetchJson(fetchImpl, url, bearerToken, { signal, ...options });
  };
  const executePostRead = async ({ execute, ...budgetRequest }) => {
    if (typeof withReturnedPosts !== 'function') {
      return { allowed: false, reason: 'budget_unavailable' };
    }
    let outcome;
    try {
      outcome = await withReturnedPosts({
        ...budgetRequest,
        consumer: 'curated-feed',
        coverageTotal: (96 * X_LIST_POST_LIMIT) + DEFAULT_DELETION_AUDIT_MAX_POSTS,
        deadlineMs: sourceSlotEndsAt,
        execute: async (admission, postBudgetAdmission) => {
          postReadLimit += budgetRequest.requestedPosts;
          return execute(admission, postBudgetAdmission);
        },
      });
    } catch (error) {
      if (error?.xPostBudgetStatus) nextState.postBudget = normalizePostBudget(error.xPostBudgetStatus);
      throw error;
    }
    if (outcome?.status) nextState.postBudget = normalizePostBudget(outcome.status);
    if (outcome?.completed === true && Number.isSafeInteger(outcome.returnedPosts)) {
      postsRead += outcome.returnedPosts;
    }
    return outcome || { allowed: false, reason: 'budget_unavailable' };
  };

  try {
    const url = buildXListPostsUrl(listId);
    const outcome = await executePostRead({
      operation: 'list-feed',
      requestedPosts: X_LIST_POST_LIMIT,
      coverageId: coverageId.trim(),
      coverageUnitPosts: X_LIST_POST_LIMIT,
      receiptScope: `list:${normalizeAccountId(listId)}`,
      receiptFromResult: ({ result }) => {
        const built = buildXListReceiptResult({
          listId,
          sourceSlot,
          providerSuccessAt: now(),
          accounts: configuredAccounts,
          body: result?.body,
          maxTextChars,
        });
        listValidationError = built.error;
        return built.receipt;
      },
      execute: (_admission, postBudgetAdmission) => countedFetch(url, { postBudgetAdmission }),
    });
    if (outcome?.allowed !== true) {
      nextState.lastError = `X Post budget ${outcome?.reason || 'unavailable'}; List page deferred`;
    } else {
      const receipt = normalizeXListReceipt(outcome.receipt, listId, configuredAccounts);
      const receiptWasPublished = outcome.reusedReceipt === true
        && receipt?.sourceSlot === state?.lastProviderSuccessSlot;
      if (outcome.reusedReceipt === true && !receipt && outcome.receiptAck) {
        nextState.lastError = 'X List receipt is no longer valid; acknowledgement pending';
        nextState.receiptAcks.push(outcome.receiptAck);
      } else if (receiptWasPublished && outcome.receiptAck) {
        nextState.lastError = 'X List receipt was already published; acknowledgement pending';
        nextState.receiptAcks.push(outcome.receiptAck);
      } else {
        const response = outcome.result?.response || (receipt
          ? { ok: true, status: 200, headers: new Headers() }
          : null);
        if (!response) {
          nextState.lastError = 'X List page response was unavailable';
        } else if (response.status === 429) {
          recordRateLimit(nextState, response.headers, now);
          nextState.lastError = 'rate limited polling the X List';
        } else if (isAuthFailureStatus(response.status)) {
          recordAuthFailure(nextState, response.status, 'polling the X List', now);
        } else if (isCreditsExhaustedStatus(response.status)) {
          recordCreditsExhausted(nextState, 'polling the X List', now);
        } else if (!response.ok) {
          nextState.lastError = `X List page failed: HTTP ${response.status}`;
        } else {
          nextState.providerSuccess = true;
          nextState.providerSuccessAt = receipt?.providerSuccessAt || now();
          nextState.providerSuccessSlot = receipt?.sourceSlot || sourceSlot;
          if (outcome.completed !== true) {
            if (listValidationError === 'unknown_author') {
              recordMembershipDrift(nextState, 'page contains an author outside the enabled registry', now);
            } else {
              nextState.lastError = 'X List page receipt was invalid; retained the full reservation';
            }
          } else if (!receipt || !outcome.receiptAck) {
            nextState.lastError = 'X List page receipt was unavailable after settlement';
          } else {
            const newItems = listItemsFromReceipt(receipt, configuredAccounts);
            nextState.items = mergeAndDedup(nextState.items, newItems, maxFeedItems);
            nextState.newCount = newItems.length;
            nextState.accountsAttempted = configuredAccounts.length;
            nextState.accountsPolled = configuredAccounts.length;
            nextState.cycleComplete = configuredAccounts.length > 0;
            nextState.listAccepted = nextState.cycleComplete;
            nextState.receiptAcks.push(outcome.receiptAck);
          }
        }
      }
    }
  } catch (error) {
    nextState.lastError = `X List poll failed: ${error?.message || String(error)}`;
  }

  // Coverage is asserted from the registry size above, which is only honest if
  // the List still holds the registry. Nothing else re-checks that at runtime:
  // verifyXListMembership was reachable only from the operator-run
  // scripts/verify-x-accounts.mjs, so a List that silently lost members -- or was
  // emptied outright -- kept publishing "N/N complete" and stayed healthy, and
  // an empty page is a valid result now that xFeed is in ZERO_RECORD_DATA_OK_KEYS.
  // Deliberately NOT gated on items.length: an emptied List is the case that
  // matters most, and it has no items by definition.
  if (
    nextState.cycleComplete
    && verifyMembership
    && membershipCheckIsDue(nextState.lastMembershipCheckAt, pollCycleNow)
    && !nextState.rateLimitedUntil
  ) {
    try {
      const [listOutcome, membersOutcome] = await Promise.all([
        countedFetch(buildXListDetailsUrl(listId)),
        countedFetch(buildXListMembersUrl(listId)),
      ]);
      const listResponse = listOutcome?.response;
      const membersResponse = membersOutcome?.response;
      if (listResponse?.status === 429 || membersResponse?.status === 429) {
        recordRateLimit(nextState, (listResponse?.status === 429 ? listResponse : membersResponse).headers, now);
        nextState.lastError = 'rate limited verifying X List membership';
      } else if (isAuthFailureStatus(listResponse?.status) || isAuthFailureStatus(membersResponse?.status)) {
        recordAuthFailure(nextState, listResponse?.status ?? membersResponse?.status, 'verifying X List membership', now);
      } else if (!listResponse?.ok || !membersResponse?.ok) {
        nextState.lastMembershipCheckAt = pollCycleNow;
        nextState.lastError = `X List membership check failed: HTTP ${listResponse?.ok ? membersResponse?.status : listResponse?.status}`;
      } else {
        const verdict = verifyXListMembership({
          listId,
          accounts: configuredAccounts,
          listBody: listOutcome.body,
          membersBody: membersOutcome.body,
        });
        nextState.lastMembershipCheckAt = pollCycleNow;
        const findings = verdict.findings || [];
        const unverifiable = findings.find((finding) => MEMBERSHIP_UNVERIFIABLE_KINDS.has(finding.kind));
        const drift = findings.filter((finding) => MEMBERSHIP_DRIFT_KINDS.has(finding.kind));
        if (unverifiable) {
          nextState.lastError = `X List membership check inconclusive: ${unverifiable.message}`;
        } else if (drift.length) {
          // Publish the page anyway -- the Posts it carried are real. Only the
          // coverage claim is wrong, so degrade that and let sourceState follow.
          const unaccounted = verdict.missingIds.length || drift.length;
          nextState.accountsFailed = unaccounted;
          nextState.accountsPolled = Math.max(0, configuredAccounts.length - unaccounted);
          nextState.cycleComplete = false;
          nextState.lastError = `X List membership drift: ${drift[0].message}`;
        }
      }
    } catch (error) {
      nextState.lastError = `X List membership check failed: ${error?.message || String(error)}`;
    }
  }

  if (
    nextState.cycleComplete
    && lookupDeletions
    && deletionAuditIsDue(nextState.lastDeletionAuditAt, pollCycleNow)
    && nextState.items.length
    && !nextState.rateLimitedUntil
  ) {
    const activeIds = nextState.items
      .filter((item) => item.contentState !== 'deleted')
      .map((item) => item.postId)
      .filter(Boolean);
    const offset = nextState.lookupOffset;
    const rotated = activeIds.length
      ? [...activeIds.slice(offset % activeIds.length), ...activeIds.slice(0, offset % activeIds.length)]
      : [];
    if (rotated.length) {
      const { url, ids } = buildTweetsLookupUrl(rotated.slice(0, DEFAULT_DELETION_AUDIT_MAX_POSTS));
      try {
        const outcome = await executePostRead({
          operation: 'deletion-lookup',
          requestedPosts: ids.length,
          coverageId: 'deletion-audit',
          coverageUnitPosts: DEFAULT_DELETION_AUDIT_MAX_POSTS,
          oncePerDay: true,
          execute: (_admission, postBudgetAdmission) => countedFetch(url, { postBudgetAdmission }),
        });
        if (outcome?.allowed !== true) {
          if (outcome?.reason === 'already_run') {
            nextState.lastError = 'X deletion audit was already attempted without a recorded successful result';
          } else {
            nextState.lastError = `X Post budget ${outcome?.reason || 'unavailable'}; deletion audit deferred`;
          }
        } else {
          const { response, body } = outcome.result || {};
          if (outcome.completed !== true) {
            nextState.lastError = 'X Post budget settlement failed after deletion audit';
          } else if (!response) {
            nextState.lastError = 'deletion lookup returned no response';
          } else if (response.status === 429) {
            recordRateLimit(nextState, response.headers, now);
            nextState.lastError = 'rate limited during deletion lookup';
          } else if (isAuthFailureStatus(response.status)) {
            recordAuthFailure(nextState, response.status, 'during deletion lookup', now);
          } else if (isCreditsExhaustedStatus(response.status)) {
            recordCreditsExhausted(nextState, 'during deletion lookup', now);
          } else if (response.status === 200) {
            const audit = classifyDeletionLookup(body, ids);
            if (!audit.complete) {
              nextState.lastError = 'deletion lookup was incomplete or returned a non-deletion error';
            } else {
              nextState.lastDeletionAuditAt = utcDayStartMs(outcome?.status?.day, pollCycleNow);
              if (audit.deletedIds.length) {
                nextState.items = tombstonePosts(nextState.items, audit.deletedIds, now());
              }
              nextState.lookupOffset = activeIds.length ? (offset + ids.length) % activeIds.length : 0;
            }
          } else {
            nextState.lastError = `deletion lookup failed: HTTP ${response.status}`;
          }
        }
      } catch (error) {
        nextState.lastError = `deletion lookup failed: ${error?.message || String(error)}`;
      }
    }
  }

  if (nextState.cycleComplete && !nextState.rateLimitedUntil) {
    nextState.rateLimitAttempt = 0;
    nextState.backoffCause = null;
  }
  nextState.requestsUsed = requestsUsed;
  nextState.lastCycleUsage = {
    requestsUsed,
    requestLimit: 1 + (lookupDeletions ? 1 : 0) + (verifyMembership ? 2 : 0),
    postsRead,
    postReadLimit,
  };
  nextState.items = purgeExpiredTombstones(nextState.items, now(), TOMBSTONE_TTL_MS);
  return nextState;
}

module.exports = {
  X_API_ORIGIN,
  USER_AGENT,
  TOMBSTONE_TTL_MS,
  DEFAULT_MAX_FEED_ITEMS,
  DELETION_AUDIT_INTERVAL_MS,
  DEFAULT_DELETION_AUDIT_MAX_POSTS,
  X_LIST_POST_LIMIT,
  AUTH_FAILURE_BACKOFF_MS,
  X_BACKOFF_CAUSES,
  X_FEED_SNAPSHOT_VERSION,
  X_CURATED_LIST_NAME,
  X_CURATED_LIST_DESCRIPTION,
  loadXAccounts,
  countEnabledAccounts,
  verifyXListMembership,
  normalizeHandle,
  normalizeAccountId,
  normalizeXPost,
  derivedAlertFacts,
  collectXAlertCandidates,
  mergeAndDedup,
  tombstonePosts,
  purgeExpiredTombstones,
  buildXPollState,
  buildXFeedSnapshot,
  hydrateXFeedSnapshot,
  alertSourcePassesTierGate,
  mergeRefreshedPollState,
  parseRetryAfterMs,
  parseRateLimitResetMs,
  compute429BackoffMs,
  isAuthFailureStatus,
  sharedBackoffMessage,
  MAX_429_BACKOFF_MS,
  MAX_429_BACKOFF_EXPONENT,
  buildXListPostsUrl,
  buildXListDetailsUrl,
  buildXListMembersUrl,
  membershipCheckIsDue,
  buildXListReceipt,
  normalizeXListReceipt,
  listItemsFromReceipt,
  buildTweetsLookupUrl,
  xFetchJson,
  pollXFeed: pollXListFeed,
};
