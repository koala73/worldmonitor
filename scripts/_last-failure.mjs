const CODE = /^[A-Z][A-Z0-9_]{0,79}$/u;

function timestamp(value) {
  const ms = typeof value === 'number' ? value
    : typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/u.test(value) ? Date.parse(value) : NaN;
  return Number.isFinite(ms) && ms > 0 && ms <= 8.64e15
    ? new Date(ms).toISOString() : null;
}

function sanitize(value) {
  const checkedAt = timestamp(value?.checkedAt);
  if (!checkedAt || typeof value?.errorCode !== 'string' || !CODE.test(value.errorCode)) return null;
  const lastSuccessAt = timestamp(value.lastSuccessAt);
  const receipt = {
    checkedAt,
    lastSuccessAt: lastSuccessAt && lastSuccessAt <= checkedAt ? lastSuccessAt : null,
    errorCode: value.errorCode,
  };
  for (const field of ['fallbackReason', 'proxyFailureReason']) {
    if (typeof value[field] === 'string' && CODE.test(value[field])) receipt[field] = value[field];
  }
  if (['direct', 'proxy'].includes(value.transportPath)) receipt.transportPath = value.transportPath;
  if (Number.isSafeInteger(value.requestCount) && value.requestCount >= 0) receipt.requestCount = value.requestCount;
  if (value.requestBudget && typeof value.requestBudget === 'object') {
    const budget = {};
    for (const field of ['page', 'directRequests', 'proxyRequests', 'maxRequests', 'maxDirectRequests', 'maxProxyRequests']) {
      const count = value.requestBudget[field];
      if (Number.isSafeInteger(count) && count >= 0) budget[field] = count;
    }
    if (Object.keys(budget).length) receipt.requestBudget = budget;
  }
  return receipt;
}

export function retainLastFailure(previous, current = null) {
  const prior = sanitize(previous);
  const next = sanitize(current);
  if (!next) return prior;
  return prior && prior.checkedAt > next.checkedAt ? prior : next;
}
