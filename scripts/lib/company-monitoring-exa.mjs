// @ts-check

import { createHash } from 'node:crypto';

const encoder = new TextEncoder();
const EXA_ENDPOINT = 'https://api.exa.ai/search';
const QUERY_HEADER = 'WorldMonitor discovery v1 | recent factual company news | candidate-only attribution';
const CONFIRMATION_HEADER = 'WorldMonitor confirmation v1 | exact-company source check';
const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const SAFE_TEXT_TOKEN = /[\p{L}\p{M}\p{N}]+(?:[&'-][\p{L}\p{M}\p{N}]+)*/gu;
const DISCOVERY_CLAIM_TYPES = new Set(['alias', 'domain', 'legal_identifier', 'location']);
const RETRYABLE_STATUS = new Set([401, 402, 429, 500, 502, 503, 504]);
const DEFAULT_TIMEOUT_MS = 12_000;
const PACKING_WINDOW_MS = 24 * 60 * 60 * 1000;
const LEGAL_IDENTIFIER_MAX_UTF8_BYTES = 512;

export const COMPANY_MONITORING_EXA_CONTRACT = Object.freeze({
  contractVersion: 'cm_exa_discovery_v1',
  queryVersion: 'exa-company-discovery-v1',
  confirmationQueryVersion: 'exa-company-confirmation-v1',
  limits: Object.freeze({
    cohortCompanies: 25,
    queryUtf8Bytes: 2048,
    resultsPerSearch: 25,
    providerResultsMaximum: 100,
    providerAttemptsMaximum: 2,
    providerRequestTimeoutMs: DEFAULT_TIMEOUT_MS,
  }),
  pricing: Object.freeze({
    baseUsdMicrosPerSearch: 7_000,
    includedResults: 10,
    additionalResultUsdMicros: 1_000,
  }),
  // The frozen Stage 0 protocol permits this dark contract and forbids paid
  // provider runtime. Activation therefore requires a reviewed code change;
  // an environment variable cannot bypass the stop decision.
  paidRuntimeApproved: false,
});

function utf8Bytes(value) {
  return encoder.encode(value).byteLength;
}

function safeText(value, maxUtf8Bytes = 256) {
  if (typeof value !== 'string') return null;
  const tokens = value.normalize('NFC').match(SAFE_TEXT_TOKEN);
  if (!tokens?.length) return null;
  const normalized = tokens.join(' ').replace(/\s+/g, ' ').trim();
  return normalized && utf8Bytes(normalized) <= maxUtf8Bytes ? normalized : null;
}

function safeOpaqueText(value, maxUtf8Bytes) {
  if (typeof value !== 'string') return null;
  const normalized = value.normalize('NFC').trim();
  return normalized && !/[\u0000-\u001f\u007f]/u.test(normalized) && utf8Bytes(normalized) <= maxUtf8Bytes
    ? normalized
    : null;
}

function safeDomain(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.normalize('NFC').trim().toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  return DOMAIN.test(normalized) ? normalized : null;
}

function quoted(value) {
  // All values passed here were reduced to a grammar without double quotes,
  // backslashes, colons, parentheses, or wildcard characters. Only the fixed
  // compiler can emit query delimiters and operators.
  return `"${value}"`;
}

function uniqueSorted(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right, 'en-US'));
}

function uniqueInOrder(values) {
  return [...new Set(values)];
}

function normalizedCompany(obligation) {
  const companyId = typeof obligation?.companyId === 'string' ? obligation.companyId.trim() : '';
  const company = obligation?.company;
  const name = safeText(company?.name);
  const domicileCountry = company?.domicileCountry;
  if (!companyId || !name || (domicileCountry !== 'US' && domicileCountry !== 'GB')) return null;

  const claims = Array.isArray(company?.claims) ? company.claims : [];
  const aliases = [];
  const domains = [];
  const identifiers = [];
  const locations = [];
  for (const claim of claims) {
    if (!claim || !DISCOVERY_CLAIM_TYPES.has(claim.type)) continue;
    if (claim.type === 'domain') {
      const domain = safeDomain(claim.value);
      if (domain) domains.push(domain);
      continue;
    }
    const value = safeText(
      claim.value,
      claim.type === 'legal_identifier' ? LEGAL_IDENTIFIER_MAX_UTF8_BYTES : undefined,
    );
    if (!value) continue;
    if (claim.type === 'alias') aliases.push(value);
    else if (claim.type === 'legal_identifier') identifiers.push(value);
    else if (claim.type === 'location') locations.push(value);
  }

  return {
    companyId,
    name,
    domicileCountry,
    aliases: uniqueSorted(aliases),
    domains: uniqueSorted(domains),
    identifiers: uniqueSorted(identifiers),
    locations: uniqueSorted(locations),
  };
}

function renderedList(values) {
  return `[${values.map(quoted).join(',')}]`;
}

function companyClause(company, index) {
  return `company[${index}]{name=${quoted(company.name)};domicile=${quoted(company.domicileCountry)};aliases=${renderedList(company.aliases)};domains=${renderedList(company.domains)};identifiers=${renderedList(company.identifiers)};locations=${renderedList(company.locations)}}`;
}

/**
 * Compile one deterministic, injection-safe discovery page. The provider
 * receives only fixed grammar plus allow-listed literals. Every company that
 * cannot fit is returned with a closed omission reason.
 */
export function compileExaCohortDiscovery(obligations, options = {}) {
  const requestedMax = Number.isSafeInteger(options.maxQueryBytes) && options.maxQueryBytes > 0
    ? options.maxQueryBytes
    : COMPANY_MONITORING_EXA_CONTRACT.limits.queryUtf8Bytes;
  const maxQueryBytes = Math.min(requestedMax, COMPANY_MONITORING_EXA_CONTRACT.limits.queryUtf8Bytes);
  const byCompanyId = new Map();
  for (const obligation of Array.isArray(obligations) ? obligations : []) {
    const companyId = typeof obligation?.companyId === 'string' ? obligation.companyId : '';
    if (!byCompanyId.has(companyId)) byCompanyId.set(companyId, obligation);
  }

  const includedCompanies = [];
  const omittedCompanies = [];
  let query = QUERY_HEADER;
  const stableOrder = [...byCompanyId.values()].sort((left, right) =>
    String(left?.companyId ?? '').localeCompare(String(right?.companyId ?? ''), 'en-US')
  );
  const requestedOffset = Number.isSafeInteger(options.packingOffset) ? options.packingOffset : 0;
  const packingOffset = stableOrder.length === 0
    ? 0
    : ((requestedOffset % stableOrder.length) + stableOrder.length) % stableOrder.length;
  const ordered = [
    ...stableOrder.slice(packingOffset),
    ...stableOrder.slice(0, packingOffset),
  ];
  for (const obligation of ordered) {
    const normalized = normalizedCompany(obligation);
    const companyId = typeof obligation?.companyId === 'string' ? obligation.companyId : '';
    if (!normalized) {
      omittedCompanies.push({ companyId, reason: 'invalid_company_claims' });
      continue;
    }
    if (includedCompanies.length >= COMPANY_MONITORING_EXA_CONTRACT.limits.cohortCompanies) {
      omittedCompanies.push({ companyId, reason: 'cohort_limit' });
      continue;
    }
    const clause = companyClause(normalized, includedCompanies.length);
    const candidateQuery = `${query} | ${clause}`;
    if (utf8Bytes(candidateQuery) > maxQueryBytes) {
      omittedCompanies.push({ companyId, reason: 'query_byte_limit' });
      continue;
    }
    query = candidateQuery;
    includedCompanies.push({
      companyId,
      claimCount: normalized.aliases.length + normalized.domains.length +
        normalized.identifiers.length + normalized.locations.length,
    });
  }

  return {
    contractVersion: COMPANY_MONITORING_EXA_CONTRACT.contractVersion,
    queryVersion: COMPANY_MONITORING_EXA_CONTRACT.queryVersion,
    query,
    queryBytes: utf8Bytes(query),
    maxQueryBytes,
    packingOffset,
    requestedCompanies: byCompanyId.size,
    includedCompanies,
    omittedCompanies,
  };
}

export function compileExaConfirmationQuery({ company: obligation, candidate }) {
  const company = normalizedCompany(obligation);
  if (!company) throw new Error('confirmation company claims are invalid');
  const title = safeText(candidate?.title) ?? 'untitled candidate';
  let host = 'invalid candidate host';
  try {
    const url = new URL(candidate?.url);
    if (url.protocol === 'https:') host = safeDomain(url.hostname) ?? 'invalid candidate host';
  } catch {
    // The fixed fallback stays inside the confirmation grammar.
  }
  return {
    queryVersion: COMPANY_MONITORING_EXA_CONTRACT.confirmationQueryVersion,
    query: `${CONFIRMATION_HEADER} | company{name=${quoted(company.name)};domicile=${quoted(company.domicileCountry)}} | candidate{title=${quoted(title)};host=${quoted(host)}}`,
  };
}

function estimatedSearchCostUsdMicros(resultCap) {
  const pricing = COMPANY_MONITORING_EXA_CONTRACT.pricing;
  return pricing.baseUsdMicrosPerSearch +
    Math.max(0, resultCap - pricing.includedResults) * pricing.additionalResultUsdMicros;
}

function reportedCostUsdMicros(body) {
  const dollars = body?.costDollars?.total;
  if (typeof dollars !== 'number' || !Number.isFinite(dollars) || dollars < 0) return null;
  const micros = Math.round(dollars * 1_000_000);
  return Number.isSafeInteger(micros) && micros >= 0 ? micros : null;
}

function resultCheckpoint(rows) {
  const last = [...rows].sort((left, right) =>
    left.publishedAt - right.publishedAt || left.providerResultId.localeCompare(right.providerResultId, 'en-US')
  ).at(-1);
  const payload = last
    ? {
      v: 1,
      publishedAt: last.publishedAt,
      result: createHash('sha256').update(last.providerResultId).digest('hex').slice(0, 24),
      rows: rows.length,
    }
    : { v: 1, publishedAt: null, result: '', rows: 0 };
  return `exa_rows_v1.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
}

function providerReason(status) {
  if (status === 401) return 'authentication_failed';
  if (status === 402 || status === 429) return 'rate_limited';
  if (status === 400 || status === 403 || status === 422) return 'request_rejected';
  return 'provider_unavailable';
}

function timeoutError(error) {
  return error?.name === 'TimeoutError' || error?.name === 'AbortError' || /timed?\s*out/i.test(error?.message ?? '');
}

function reportCost(attempts) {
  const usdMicros = attempts.reduce((sum, attempt) => sum + attempt.costUsdMicros, 0);
  const bases = new Set(attempts.map((attempt) => attempt.costBasis));
  return {
    usdMicros,
    basis: bases.size === 0
      ? 'none'
      : bases.size === 1
        ? attempts[0].costBasis
        : 'mixed',
    attempts: attempts.map(({ attempt, outcome, requestId, costUsdMicros, costBasis }) => ({
      attempt,
      outcome,
      requestId,
      costUsdMicros,
      costBasis,
    })),
  };
}

function requestSummary(attempts) {
  return {
    attempted: attempts.length,
    completed: attempts.filter((attempt) => attempt.outcome === 'completed').length,
    timedOut: attempts.filter((attempt) => attempt.outcome === 'timeout').length,
  };
}

function baseReport(work, compiled, startedAt) {
  return {
    contractVersion: COMPANY_MONITORING_EXA_CONTRACT.contractVersion,
    queryVersion: compiled.queryVersion,
    queryDigest: createHash('sha256').update(compiled.query).digest('hex'),
    publicationWindow: { startAt: work.windowStart, endAt: work.windowEnd },
    retrievedWindow: { startedAt, completedAt: startedAt },
    caps: {
      cohortCompanies: COMPANY_MONITORING_EXA_CONTRACT.limits.cohortCompanies,
      queryUtf8Bytes: compiled.maxQueryBytes,
      packingOffset: compiled.packingOffset,
      requestedResults: Math.min(
        Number.isSafeInteger(work.resultCap) ? work.resultCap : COMPANY_MONITORING_EXA_CONTRACT.limits.resultsPerSearch,
        COMPANY_MONITORING_EXA_CONTRACT.limits.resultsPerSearch,
      ),
      providerMaximumResults: COMPANY_MONITORING_EXA_CONTRACT.limits.providerResultsMaximum,
      providerMaximumAttempts: COMPANY_MONITORING_EXA_CONTRACT.limits.providerAttemptsMaximum,
      providerRequestTimeoutMs: COMPANY_MONITORING_EXA_CONTRACT.limits.providerRequestTimeoutMs,
    },
    includedCompanies: compiled.includedCompanies,
    omittedCompanies: compiled.omittedCompanies,
  };
}

function errorExecution(report, attempts, reason, outcome, completedAt) {
  const cost = reportCost(attempts);
  return {
    finalizeResult: {
      type: 'provider_error',
      reason,
      costUsdMicros: cost.usdMicros,
    },
    report: {
      ...report,
      outcome,
      retrievedWindow: { ...report.retrievedWindow, completedAt },
      requests: requestSummary(attempts),
      cost,
      counts: {
        requestedCompanies: report.includedCompanies.length + report.omittedCompanies.length,
        includedCompanies: report.includedCompanies.length,
        omittedCompanies: report.omittedCompanies.length,
        providerRows: 0,
        validRows: 0,
        malformedRows: 0,
      },
      pagination: null,
      candidates: [],
    },
  };
}

/**
 * Create the dark Exa provider adapter. Tests inject `runtimeApproved: true`
 * to exercise the contract. Production uses the frozen false constant.
 */
export function createExaCohortExecutor(options = {}) {
  const keys = uniqueInOrder((Array.isArray(options.apiKeys) ? options.apiKeys : [])
    .map((key) => typeof key === 'string' ? key.trim() : '')
    .filter(Boolean))
    .slice(0, COMPANY_MONITORING_EXA_CONTRACT.limits.providerAttemptsMaximum);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const requestedTimeoutMs = Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : DEFAULT_TIMEOUT_MS;
  const timeoutMs = Math.min(
    requestedTimeoutMs,
    COMPANY_MONITORING_EXA_CONTRACT.limits.providerRequestTimeoutMs,
  );
  const runtimeApproved = options.runtimeApproved === true;

  return async (work) => {
    const startedAt = now();
    const packingOffset = Number.isSafeInteger(work?.windowStart)
      ? Math.floor(work.windowStart / PACKING_WINDOW_MS)
      : 0;
    const compiled = compileExaCohortDiscovery(work?.obligations, { packingOffset });
    const report = baseReport(work, compiled, startedAt);
    if (!runtimeApproved) {
      return errorExecution(report, [], 'provider_unavailable', 'runtime_not_approved', now());
    }
    if (compiled.includedCompanies.length === 0) {
      return errorExecution(report, [], 'request_rejected', 'no_eligible_companies', now());
    }
    if (keys.length === 0) {
      return errorExecution(report, [], 'authentication_failed', 'missing_api_keys', now());
    }

    const resultCap = report.caps.requestedResults;
    const requestBody = {
      query: compiled.query,
      type: 'auto',
      category: 'news',
      startPublishedDate: new Date(work.windowStart).toISOString(),
      endPublishedDate: new Date(work.windowEnd).toISOString(),
      numResults: resultCap,
    };
    const attempts = [];
    let responseBody = null;
    let lastReason = 'provider_unavailable';

    for (let index = 0; index < keys.length; index += 1) {
      const estimate = estimatedSearchCostUsdMicros(resultCap);
      try {
        const response = await fetchImpl(EXA_ENDPOINT, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'worldmonitor-company-monitoring-worker/1.0',
            'x-api-key': keys[index],
            'x-exa-integration': 'worldmonitor-company-monitoring',
          },
          body: JSON.stringify(requestBody),
          signal: AbortSignal.timeout(timeoutMs),
        });
        let body;
        try {
          body = await response.json();
        } catch {
          body = null;
        }
        const reported = reportedCostUsdMicros(body);
        const costUsdMicros = reported ?? estimate;
        const costBasis = reported === null ? 'frozen_protocol_estimate' : 'provider_reported';
        const requestId = typeof body?.requestId === 'string' ? body.requestId : null;
        if (!response.ok) {
          lastReason = providerReason(response.status);
          attempts.push({
            attempt: index + 1,
            outcome: lastReason,
            requestId,
            costUsdMicros,
            costBasis,
          });
          if (RETRYABLE_STATUS.has(response.status) && index + 1 < keys.length) continue;
          return errorExecution(report, attempts, lastReason, lastReason, now());
        }
        attempts.push({
          attempt: index + 1,
          outcome: 'completed',
          requestId,
          costUsdMicros,
          costBasis,
        });
        responseBody = body;
        break;
      } catch (error) {
        const isTimeout = timeoutError(error);
        lastReason = isTimeout ? 'timeout' : 'provider_unavailable';
        attempts.push({
          attempt: index + 1,
          outcome: lastReason,
          requestId: null,
          costUsdMicros: estimate,
          costBasis: 'frozen_protocol_estimate',
        });
        if (index + 1 < keys.length) continue;
        return errorExecution(report, attempts, lastReason, lastReason, now());
      }
    }

    if (!responseBody || !Array.isArray(responseBody.results)) {
      const cost = reportCost(attempts);
      return {
        finalizeResult: {
          type: 'result',
          itemCount: 0,
          hasMore: false,
          coverage: 'partial',
          emptyValidated: false,
          costUsdMicros: cost.usdMicros,
        },
        report: {
          ...report,
          outcome: 'malformed',
          retrievedWindow: { ...report.retrievedWindow, completedAt: now() },
          requests: requestSummary(attempts),
          cost,
          counts: {
            requestedCompanies: compiled.requestedCompanies,
            includedCompanies: compiled.includedCompanies.length,
            omittedCompanies: compiled.omittedCompanies.length,
            providerRows: 0,
            validRows: 0,
            malformedRows: 1,
          },
          pagination: null,
          candidates: [],
        },
      };
    }

    const providerRows = responseBody.results;
    const completedAt = now();
    const validRows = [];
    const candidates = [];
    let malformedRows = 0;
    for (let index = 0; index < Math.min(providerRows.length, resultCap); index += 1) {
      const row = providerRows[index];
      const providerResultId = safeOpaqueText(row?.id, 512) ?? safeOpaqueText(row?.url, 2_048) ?? '';
      let safeUrl = null;
      try {
        const parsed = new URL(row?.url);
        if (parsed.protocol === 'https:' && !parsed.username && !parsed.password) {
          safeUrl = safeOpaqueText(parsed.toString(), 2_048);
        }
      } catch {
        // Count the row as malformed below.
      }
      const publishedAt = Date.parse(row?.publishedDate ?? '');
      const validPublishedAt = Number.isFinite(publishedAt) &&
        publishedAt >= work.windowStart && publishedAt <= work.windowEnd;
      if (!providerResultId || !safeUrl || !validPublishedAt) {
        malformedRows += 1;
        continue;
      }
      const valid = { providerResultId, publishedAt };
      validRows.push(valid);
      candidates.push({
        providerResultId,
        providerRequestId: safeOpaqueText(responseBody.requestId, 512),
        providerRank: index + 1,
        url: safeUrl,
        title: typeof row.title === 'string' ? row.title : null,
        author: typeof row.author === 'string' ? row.author : null,
        publishedAt,
        providerPublishedAt: row.publishedDate,
        retrievedAt: completedAt,
        candidateState: 'pending_attribution',
        candidateCompanyIds: compiled.includedCompanies.map(({ companyId }) => companyId),
        acceptedCompanyIds: [],
      });
    }
    if (providerRows.length > resultCap) malformedRows += providerRows.length - resultCap;

    const hasMore = providerRows.length >= resultCap;
    const malformed = malformedRows > 0;
    const partial = compiled.omittedCompanies.length > 0;
    const checkpoint = malformed ? null : resultCheckpoint(validRows);
    const cost = reportCost(attempts);
    const outcome = malformed ? 'malformed' : hasMore ? 'capped' : partial ? 'partial' : 'complete';
    const finalizeResult = {
      type: 'result',
      itemCount: providerRows.length,
      hasMore,
      coverage: malformed || partial ? 'partial' : 'complete',
      returnedRange: { startAt: work.windowStart, endAt: work.windowEnd },
      ...(checkpoint ? { checkpoint } : {}),
      emptyValidated: providerRows.length === 0 && !malformed && !partial,
      costUsdMicros: cost.usdMicros,
      exaIngestion: {
        candidates: candidates.map((candidate) => ({
          providerResultId: candidate.providerResultId,
          ...(candidate.providerRequestId ? { providerRequestId: candidate.providerRequestId } : {}),
          providerRank: candidate.providerRank,
          url: candidate.url,
          ...(safeText(candidate.title, 512) ? { title: safeText(candidate.title, 512) } : {}),
          ...(safeText(candidate.author, 256) ? { author: safeText(candidate.author, 256) } : {}),
          publishedAt: candidate.publishedAt,
          retrievedAt: candidate.retrievedAt,
          candidateCompanyIds: candidate.candidateCompanyIds,
        })),
      },
    };
    return {
      finalizeResult,
      report: {
        ...report,
        outcome,
        providerRequestId: typeof responseBody.requestId === 'string' ? responseBody.requestId : null,
        retrievedWindow: { ...report.retrievedWindow, completedAt },
        requests: requestSummary(attempts),
        cost,
        counts: {
          requestedCompanies: compiled.requestedCompanies,
          includedCompanies: compiled.includedCompanies.length,
          omittedCompanies: compiled.omittedCompanies.length,
          providerRows: providerRows.length,
          validRows: validRows.length,
          malformedRows,
        },
        pagination: {
          kind: 'bounded_single_page',
          page: 1,
          requestedResults: resultCap,
          providerMaximumResults: COMPANY_MONITORING_EXA_CONTRACT.limits.providerResultsMaximum,
          hasMore,
          providerCursor: null,
          nextCheckpoint: outcome === 'complete' ? checkpoint : null,
        },
        candidates,
      },
    };
  };
}
