'use strict';

const { createHash, randomUUID } = require('node:crypto');

const DEFAULT_X_POST_DAILY_LIMIT = 600;
const DEFAULT_X_POST_MONTHLY_LIMIT = 20_000;
const DEFAULT_X_CURATED_DAILY_COVERAGE_POSTS = 597;
const X_POST_COST_USD_MICROS = 5_000;
const DEFAULT_RESERVATION_TTL_SECONDS = 60 * 60;
const MAX_RECEIPT_BYTES = 64 * 1024;
const DEFAULT_KEY_PREFIX = 'intelligence:x-post-budget:v1';
const X_POST_RETURNING_PATHS = [
  /^\/2\/tweets$/,
  /^\/2\/tweets\/[1-9]\d{1,18}$/,
  /^\/2\/tweets\/[1-9]\d{1,18}\/quote_tweets$/,
  /^\/2\/tweets\/(?:search\/(?:recent|all|stream)|sample\/stream)$/,
  /^\/2\/users\/[^/]+\/(?:tweets|mentions|liked_tweets|bookmarks)$/,
  /^\/2\/lists\/[^/]+\/tweets$/,
];
const unusedTransportAdmissions = new WeakSet();

function isXPostReturningUrl(value) {
  let url;
  try {
    url = value instanceof URL ? value : new URL(String(value), 'https://api.x.com');
  } catch {
    return false;
  }
  return url.origin === 'https://api.x.com'
    && X_POST_RETURNING_PATHS.some((pattern) => pattern.test(url.pathname));
}

function issueXPostBudgetAdmission() {
  const admission = Object.freeze({});
  unusedTransportAdmissions.add(admission);
  return admission;
}

function assertXPostBudgetAdmission(url, admission) {
  if (isXPostReturningUrl(url) && !unusedTransportAdmissions.delete(admission)) {
    throw new Error('X Post-returning request requires unused shared budget admission');
  }
}

const RESERVE_LUA = [
  'local requested = tonumber(ARGV[1])',
  'local coverageTotal = tonumber(ARGV[2]) or 0',
  'local dailyLimit = tonumber(ARGV[3])',
  'local monthlyLimit = tonumber(ARGV[4])',
  'local coverageUnit = tonumber(ARGV[9]) or 0',
  'local hasCoverageUnit = ARGV[10] == "1"',
  'local hasReceipt = ARGV[11] == "1"',
  'local dayUsed = tonumber(redis.call("get", KEYS[1]) or "0")',
  'local monthUsed = tonumber(redis.call("get", KEYS[2]) or "0")',
  'local coverageRaw = redis.call("get", KEYS[5])',
  'local coverageHeld = tonumber(coverageRaw or "0") or 0',
  'if hasReceipt then',
  '  local pendingReceipt = redis.call("get", KEYS[7])',
  '  if pendingReceipt ~= false then return {0, dayUsed, monthUsed, 4, coverageHeld, pendingReceipt} end',
  '  if redis.call("exists", KEYS[8]) == 1 then return {0, dayUsed, monthUsed, 5, coverageHeld, ""} end',
  'end',
  'if coverageRaw == false and coverageTotal > 0 then',
  '  coverageHeld = coverageTotal',
  '  redis.call("set", KEYS[5], coverageHeld, "EXAT", tonumber(ARGV[5]))',
  'end',
  'local coverageAccounted = hasCoverageUnit and redis.call("exists", KEYS[6]) == 1',
  'local coverageAfter = coverageHeld',
  'if hasCoverageUnit and not coverageAccounted then coverageAfter = math.max(0, coverageHeld - coverageUnit) end',
  'local oncePerDay = ARGV[8] == "1"',
  'if oncePerDay and redis.call("exists", KEYS[4]) == 1 then return {0, dayUsed, monthUsed, 3, coverageHeld} end',
  'if dayUsed + requested + coverageAfter > dailyLimit then return {0, dayUsed, monthUsed, 1, coverageHeld} end',
  'if monthUsed + requested + coverageAfter > monthlyLimit then return {0, dayUsed, monthUsed, 2, coverageHeld} end',
  'dayUsed = redis.call("incrby", KEYS[1], requested)',
  'monthUsed = redis.call("incrby", KEYS[2], requested)',
  'redis.call("expireat", KEYS[1], tonumber(ARGV[5]))',
  'redis.call("expireat", KEYS[2], tonumber(ARGV[6]))',
  'redis.call("set", KEYS[3], requested, "EX", tonumber(ARGV[7]))',
  'if hasReceipt then redis.call("set", KEYS[8], KEYS[3], "EX", tonumber(ARGV[7])) end',
  'if oncePerDay then redis.call("set", KEYS[4], "1", "EXAT", tonumber(ARGV[5])) end',
  'if hasCoverageUnit and not coverageAccounted then',
  '  coverageHeld = coverageAfter',
  '  redis.call("set", KEYS[5], coverageHeld, "EXAT", tonumber(ARGV[5]))',
  '  redis.call("set", KEYS[6], "1", "EXAT", tonumber(ARGV[5]))',
  'end',
  'return {1, dayUsed, monthUsed, 0, coverageHeld, ""}',
].join('\n');

const SETTLE_LUA = [
  'local actual = tonumber(ARGV[1])',
  'local hasReceipt = ARGV[3] == "1"',
  'local receiptJson = ARGV[4]',
  'local receiptHash = ARGV[5]',
  'local dayUsed = tonumber(redis.call("get", KEYS[1]) or "0")',
  'local monthUsed = tonumber(redis.call("get", KEYS[2]) or "0")',
  'local coverageHeld = tonumber(redis.call("get", KEYS[4]) or "0") or 0',
  'local raw = redis.call("get", KEYS[3])',
  'if raw == false or raw == nil then return {0, dayUsed, monthUsed, 0, actual, coverageHeld} end',
  'local priorActual, priorHash = string.match(raw, "^settled:(%d+):([%x%-]+)$")',
  'if priorActual ~= nil then',
  '  priorActual = tonumber(priorActual)',
  '  if priorActual ~= actual or priorHash ~= receiptHash then return {-2, dayUsed, monthUsed, 0, priorActual, coverageHeld} end',
  '  return {2, dayUsed, monthUsed, 0, priorActual, coverageHeld}',
  'end',
  'local reserved = tonumber(raw)',
  'if reserved == nil or actual == nil or actual < 0 or actual > reserved then',
  '  return {-1, dayUsed, monthUsed, reserved or 0, actual or 0, coverageHeld}',
  'end',
  'if hasReceipt then',
  '  local pendingReceipt = redis.call("get", KEYS[5])',
  '  if receiptJson == "" or receiptHash == "" then return {-1, dayUsed, monthUsed, reserved, actual, coverageHeld} end',
  '  if pendingReceipt ~= false and pendingReceipt ~= receiptJson then return {-3, dayUsed, monthUsed, reserved, actual, coverageHeld} end',
  'end',
  'local refund = reserved - actual',
  'if refund > 0 then',
  '  dayUsed = redis.call("incrby", KEYS[1], -refund)',
  '  monthUsed = redis.call("incrby", KEYS[2], -refund)',
  'end',
  'if hasReceipt then redis.call("set", KEYS[5], receiptJson) end',
  'if hasReceipt and redis.call("get", KEYS[6]) == KEYS[3] then redis.call("del", KEYS[6]) end',
  'redis.call("set", KEYS[3], "settled:" .. actual .. ":" .. receiptHash, "EXAT", tonumber(ARGV[2]))',
  'return {1, dayUsed, monthUsed, reserved, actual, coverageHeld}',
].join('\n');

const ACK_RECEIPTS_LUA = [
  'local acknowledged = 0',
  'for index = 1, #KEYS do',
  '  local current = redis.call("get", KEYS[index])',
  '  if current == false then',
  '    acknowledged = acknowledged + 1',
  '  elseif current == ARGV[index] then',
  '    redis.call("del", KEYS[index])',
  '    acknowledged = acknowledged + 1',
  '  end',
  'end',
  'return acknowledged',
].join('\n');

const STATUS_LUA = [
  'local dayUsed = tonumber(redis.call("get", KEYS[1]) or "0")',
  'local monthUsed = tonumber(redis.call("get", KEYS[2]) or "0")',
  'local coverageHeld = tonumber(redis.call("get", KEYS[3]) or "0") or 0',
  'return {dayUsed, monthUsed, coverageHeld}',
].join('\n');

function positiveInteger(value, fallback, name) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function boundedNonNegativeInteger(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function periodFor(nowMs) {
  const date = new Date(nowMs);
  if (!Number.isFinite(date.getTime())) throw new Error('X Post budget clock returned an invalid time');
  const year = date.getUTCFullYear();
  const monthIndex = date.getUTCMonth();
  const day = date.getUTCDate();
  const dayLabel = `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const monthLabel = `${year}-${String(monthIndex + 1).padStart(2, '0')}`;
  const nextDayMs = Date.UTC(year, monthIndex, day + 1);
  const nextMonthMs = Date.UTC(year, monthIndex + 1, 1);
  return {
    day: dayLabel,
    month: monthLabel,
    dayExpiresAtSeconds: Math.floor((nextDayMs + 2 * 24 * 60 * 60 * 1000) / 1000),
    monthExpiresAtSeconds: Math.floor((nextMonthMs + 2 * 24 * 60 * 60 * 1000) / 1000),
    dayOfMonth: day,
    daysInMonth: new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate(),
  };
}

function integerAt(result, index) {
  const parsed = Number(Array.isArray(result) ? result[index] : NaN);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function nonNegativeAt(result, index) {
  const parsed = integerAt(result, index);
  return parsed == null || parsed < 0 ? null : parsed;
}

function budgetStatus({
  available,
  period,
  dailyUsed,
  monthlyUsed,
  dailyCoverageHeld,
  dailyLimit,
  monthlyLimit,
  costUsdMicrosPerPost,
}) {
  const safeDailyUsed = boundedNonNegativeInteger(dailyUsed);
  const safeMonthlyUsed = boundedNonNegativeInteger(monthlyUsed);
  const safeDailyCoverageHeld = boundedNonNegativeInteger(dailyCoverageHeld);
  const projectedMonthlyPosts = period.dayOfMonth > 0
    ? Math.ceil((safeMonthlyUsed / period.dayOfMonth) * period.daysInMonth)
    : safeMonthlyUsed;
  return {
    available: Boolean(available),
    day: period.day,
    month: period.month,
    dailyLimit,
    dailyUsed: safeDailyUsed,
    dailyRemaining: Math.max(0, dailyLimit - safeDailyUsed),
    dailyCoverageHeld: safeDailyCoverageHeld,
    dailySpendableRemaining: Math.max(0, dailyLimit - safeDailyUsed - safeDailyCoverageHeld),
    monthlyLimit,
    monthlyUsed: safeMonthlyUsed,
    monthlyRemaining: Math.max(0, monthlyLimit - safeMonthlyUsed),
    monthlyCostUsdMicros: safeMonthlyUsed * costUsdMicrosPerPost,
    projectedMonthlyPosts,
    projectedMonthlyCostUsdMicros: projectedMonthlyPosts * costUsdMicrosPerPost,
    exhausted: safeDailyUsed >= dailyLimit || safeMonthlyUsed >= monthlyLimit,
  };
}

function unavailableStatus(period, options) {
  return budgetStatus({
    available: false,
    period,
    dailyUsed: 0,
    monthlyUsed: 0,
    dailyCoverageHeld: 0,
    ...options,
  });
}

function createXPostBudget(options = {}) {
  const evalCommand = options.evalCommand;
  if (typeof evalCommand !== 'function') throw new Error('X Post budget requires evalCommand');
  const now = options.now ?? Date.now;
  const idFactory = options.idFactory ?? randomUUID;
  const keyPrefix = String(options.keyPrefix || DEFAULT_KEY_PREFIX).replace(/:+$/, '');
  const dailyLimit = positiveInteger(options.dailyLimit, DEFAULT_X_POST_DAILY_LIMIT, 'dailyLimit');
  const monthlyLimit = positiveInteger(options.monthlyLimit, DEFAULT_X_POST_MONTHLY_LIMIT, 'monthlyLimit');
  const dailyCoveragePosts = boundedNonNegativeInteger(options.dailyCoveragePosts);
  const costUsdMicrosPerPost = positiveInteger(options.costUsdMicrosPerPost, X_POST_COST_USD_MICROS, 'costUsdMicrosPerPost');
  const reservationTtlSeconds = positiveInteger(
    options.reservationTtlSeconds,
    DEFAULT_RESERVATION_TTL_SECONDS,
    'reservationTtlSeconds',
  );
  const keysFor = (period, reservationId, onceScope, coverageId, receiptScope) => ({
    dayKey: `${keyPrefix}:day:${period.day}`,
    monthKey: `${keyPrefix}:month:${period.month}`,
    coverageHoldKey: `${keyPrefix}:coverage-held:${period.day}`,
    ...(reservationId ? { reservationKey: `${keyPrefix}:reservation:${reservationId}` } : {}),
    ...(onceScope ? { onceKey: `${keyPrefix}:once:${period.day}:${onceScope}` } : {}),
    ...(coverageId ? { coverageMarkerKey: `${keyPrefix}:coverage-accounted:${period.day}:${coverageId}` } : {}),
    receiptKey: `${keyPrefix}:receipt:${receiptScope || 'none'}`,
    inflightKey: `${keyPrefix}:receipt-inflight:${receiptScope || 'none'}`,
  });

  const toStatus = (period, dailyUsed, monthlyUsed, dailyCoverageHeld = 0, available = true) => budgetStatus({
    available,
    period,
    dailyUsed,
    monthlyUsed,
    dailyCoverageHeld,
    dailyLimit,
    monthlyLimit,
    costUsdMicrosPerPost,
  });

  async function reserve(request = {}) {
    const requestedPosts = positiveInteger(request.requestedPosts, 0, 'requestedPosts');
    if (!requestedPosts) throw new Error('requestedPosts must be a positive integer');
    const coverageTotal = Math.max(dailyCoveragePosts, boundedNonNegativeInteger(request.coverageTotal));
    const coverageUnitPosts = boundedNonNegativeInteger(request.coverageUnitPosts);
    const period = periodFor(now());
    const rawId = String(idFactory());
    const reservationId = rawId.replace(/[^A-Za-z0-9:_-]/g, '');
    if (!reservationId) throw new Error('X Post budget reservation id is invalid');
    const scopePart = (value) => String(value || 'unknown').replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 80);
    const onceScope = `${scopePart(request.consumer)}:${scopePart(request.operation)}`;
    const rawCoverageId = request.coverageId == null ? '' : String(request.coverageId);
    const hasCoverageUnit = coverageUnitPosts > 0 || rawCoverageId !== '';
    if (hasCoverageUnit && (!rawCoverageId || coverageTotal <= 0 || coverageUnitPosts <= 0 || coverageUnitPosts > coverageTotal)) {
      throw new Error('X Post budget coverage unit is invalid');
    }
    const coverageId = hasCoverageUnit ? scopePart(rawCoverageId) : 'none';
    const rawReceiptScope = request.receiptScope == null ? '' : String(request.receiptScope);
    const hasReceipt = rawReceiptScope !== '';
    const receiptScope = hasReceipt ? scopePart(rawReceiptScope) : 'none';
    const keys = keysFor(period, reservationId, onceScope, coverageId, receiptScope);
    let result;
    try {
      result = await evalCommand(
        RESERVE_LUA,
        [
          keys.dayKey,
          keys.monthKey,
          keys.reservationKey,
          keys.onceKey,
          keys.coverageHoldKey,
          keys.coverageMarkerKey,
          keys.receiptKey,
          keys.inflightKey,
        ],
        [
          String(requestedPosts),
          String(coverageTotal),
          String(dailyLimit),
          String(monthlyLimit),
          String(period.dayExpiresAtSeconds),
          String(period.monthExpiresAtSeconds),
          String(reservationTtlSeconds),
          request.oncePerDay === true ? '1' : '0',
          String(coverageUnitPosts),
          hasCoverageUnit ? '1' : '0',
          hasReceipt ? '1' : '0',
        ],
      );
    } catch {
      result = null;
    }
    const admitted = nonNegativeAt(result, 0);
    const dailyUsed = nonNegativeAt(result, 1);
    const monthlyUsed = nonNegativeAt(result, 2);
    const dailyCoverageHeld = nonNegativeAt(result, 4);
    if (admitted === null || dailyUsed === null || monthlyUsed === null || dailyCoverageHeld === null) {
      return {
        allowed: false,
        reason: 'budget_unavailable',
        status: unavailableStatus(period, { dailyLimit, monthlyLimit, costUsdMicrosPerPost }),
      };
    }
    const status = toStatus(period, dailyUsed, monthlyUsed, dailyCoverageHeld);
    if (admitted !== 1) {
      const reasonCode = nonNegativeAt(result, 3);
      if (reasonCode === 4) {
        const receiptRaw = Array.isArray(result) ? result[5] : null;
        if (typeof receiptRaw !== 'string' || !receiptRaw) {
          return {
            allowed: false,
            reason: 'budget_unavailable',
            status: unavailableStatus(period, { dailyLimit, monthlyLimit, costUsdMicrosPerPost }),
          };
        }
        return {
          allowed: false,
          reason: 'pending_receipt',
          receiptRaw,
          receiptKey: keys.receiptKey,
          status,
        };
      }
      return {
        allowed: false,
        reason: reasonCode === 5
          ? 'receipt_inflight'
          : reasonCode === 3
            ? 'already_run'
            : reasonCode === 2
              ? 'monthly_limit'
              : 'daily_limit',
        status,
      };
    }
    return {
      allowed: true,
      reservation: {
        id: reservationId,
        reservedPosts: requestedPosts,
        period,
        ...(hasReceipt ? { receiptKey: keys.receiptKey, inflightKey: keys.inflightKey } : {}),
      },
      status,
    };
  }

  async function settle(reservation, actualPosts, receipt = null) {
    if (!reservation?.id || !reservation?.period?.day || !reservation?.period?.month) {
      throw new Error('X Post budget reservation is invalid');
    }
    const actual = Number(actualPosts);
    if (!Number.isSafeInteger(actual) || actual < 0 || actual > reservation.reservedPosts) {
      return {
        settled: false,
        reason: 'invalid_return_count',
        status: await status(),
      };
    }
    const hasReceipt = Boolean(reservation.receiptKey);
    let receiptJson = '';
    let receiptHash = '-';
    if (hasReceipt) {
      try {
        receiptJson = JSON.stringify(receipt);
      } catch {
        receiptJson = '';
      }
      if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)
        || typeof receiptJson !== 'string' || Buffer.byteLength(receiptJson) > MAX_RECEIPT_BYTES) {
        return {
          settled: false,
          reason: 'invalid_receipt',
          status: await status(),
        };
      }
      receiptHash = createHash('sha256').update(receiptJson).digest('hex');
    }
    const keys = keysFor(reservation.period, reservation.id);
    let result;
    try {
      result = await evalCommand(
        SETTLE_LUA,
        [
          keys.dayKey,
          keys.monthKey,
          keys.reservationKey,
          keys.coverageHoldKey,
          reservation.receiptKey || keys.receiptKey,
          reservation.inflightKey || keys.inflightKey,
        ],
        [
          String(actual),
          String(reservation.period.dayExpiresAtSeconds),
          hasReceipt ? '1' : '0',
          receiptJson,
          receiptHash,
        ],
      );
    } catch {
      result = null;
    }
    const settlementCode = integerAt(result, 0);
    const dailyUsed = nonNegativeAt(result, 1);
    const monthlyUsed = nonNegativeAt(result, 2);
    const dailyCoverageHeld = nonNegativeAt(result, 5);
    if (settlementCode === null || dailyUsed === null || monthlyUsed === null || dailyCoverageHeld === null) {
      return {
        settled: false,
        reason: 'budget_unavailable',
        status: unavailableStatus(reservation.period, { dailyLimit, monthlyLimit, costUsdMicrosPerPost }),
      };
    }
    return {
      settled: settlementCode === 1 || settlementCode === 2,
      ...(settlementCode === 2 ? { idempotent: true } : {}),
      ...(settlementCode === -3
        ? { reason: 'receipt_conflict' }
        : settlementCode < 0
          ? { reason: 'invalid_return_count' }
          : settlementCode === 0
            ? { reason: 'reservation_missing' }
            : {}),
      ...(hasReceipt && (settlementCode === 1 || settlementCode === 2)
        ? { receiptAck: { key: reservation.receiptKey, expected: receiptJson } }
        : {}),
      status: toStatus(reservation.period, dailyUsed, monthlyUsed, dailyCoverageHeld),
    };
  }

  async function withReturnedPosts(request = {}) {
    if (typeof request.execute !== 'function') throw new Error('X Post budget requires execute');
    const admission = await reserve(request);
    if (!admission.allowed) {
      if (admission.reason !== 'pending_receipt') return admission;
      let receipt;
      try {
        receipt = JSON.parse(admission.receiptRaw);
      } catch {
        receipt = null;
      }
      if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt) || receipt.version !== 1) {
        return { allowed: false, reason: 'budget_unavailable', status: admission.status };
      }
      return {
        allowed: true,
        completed: true,
        reusedReceipt: true,
        receipt,
        receiptAck: { key: admission.receiptKey, expected: admission.receiptRaw },
        returnedPosts: 0,
        status: admission.status,
      };
    }

    let result;
    try {
      result = await request.execute(admission, issueXPostBudgetAdmission());
    } catch (error) {
      if (error && typeof error === 'object') error.xPostBudgetStatus = admission.status;
      throw error;
    }

    const responseOk = result?.response?.ok === true;
    const body = result?.body;
    let returnedPosts = null;
    if (responseOk && body && typeof body === 'object' && !Array.isArray(body)) {
      if (Array.isArray(body.data)) returnedPosts = body.data.length;
      else if (body.data == null && Number(body.meta?.result_count) === 0) returnedPosts = 0;
      else if (body.data == null && Array.isArray(body.errors) && body.errors.length > 0) returnedPosts = 0;
    }
    if (returnedPosts == null || returnedPosts > admission.reservation.reservedPosts) {
      return {
        allowed: true,
        completed: false,
        reason: 'unsettled_response',
        result,
        status: admission.status,
      };
    }

    let receipt = null;
    if (typeof request.receiptFromResult === 'function') {
      try {
        receipt = await request.receiptFromResult({ result, admission, returnedPosts });
      } catch {
        receipt = null;
      }
    }
    const settlement = await settle(admission.reservation, returnedPosts, receipt);
    return {
      allowed: true,
      completed: settlement.settled,
      ...(settlement.settled ? {} : { reason: settlement.reason || 'settlement_failed' }),
      result,
      returnedPosts,
      ...(settlement.settled && receipt ? { receipt, receiptAck: settlement.receiptAck } : {}),
      status: settlement.status,
    };
  }

  async function ackReceipts(receipts = []) {
    if (!Array.isArray(receipts) || receipts.length === 0) return true;
    const valid = receipts.every((receipt) => typeof receipt?.key === 'string'
      && receipt.key.startsWith(`${keyPrefix}:receipt:`)
      && typeof receipt.expected === 'string'
      && receipt.expected.length > 0);
    if (!valid) return false;
    let result;
    try {
      result = await evalCommand(
        ACK_RECEIPTS_LUA,
        receipts.map((receipt) => receipt.key),
        receipts.map((receipt) => receipt.expected),
      );
    } catch {
      result = null;
    }
    return Number(result) === receipts.length;
  }

  async function status() {
    const period = periodFor(now());
    const keys = keysFor(period);
    let result;
    try {
      result = await evalCommand(STATUS_LUA, [keys.dayKey, keys.monthKey, keys.coverageHoldKey], []);
    } catch {
      result = null;
    }
    const dailyUsed = nonNegativeAt(result, 0);
    const monthlyUsed = nonNegativeAt(result, 1);
    const dailyCoverageHeld = nonNegativeAt(result, 2);
    if (dailyUsed === null || monthlyUsed === null || dailyCoverageHeld === null) {
      return unavailableStatus(period, { dailyLimit, monthlyLimit, costUsdMicrosPerPost });
    }
    return toStatus(period, dailyUsed, monthlyUsed, dailyCoverageHeld);
  }

  return { reserve, settle, withReturnedPosts, ackReceipts, status };
}

module.exports = {
  DEFAULT_X_POST_DAILY_LIMIT,
  DEFAULT_X_POST_MONTHLY_LIMIT,
  DEFAULT_X_CURATED_DAILY_COVERAGE_POSTS,
  X_POST_COST_USD_MICROS,
  DEFAULT_RESERVATION_TTL_SECONDS,
  MAX_RECEIPT_BYTES,
  isXPostReturningUrl,
  assertXPostBudgetAdmission,
  RESERVE_LUA,
  SETTLE_LUA,
  ACK_RECEIPTS_LUA,
  STATUS_LUA,
  createXPostBudget,
};
