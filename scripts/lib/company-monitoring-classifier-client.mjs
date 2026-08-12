import {
  buildCompanyMonitoringClassificationRequest,
} from './company-monitoring-classification.mjs';

export const COMPANY_MONITORING_CLASSIFIER_ENDPOINT =
  'https://openrouter.ai/api/v1/chat/completions';
const COMPANY_MONITORING_CLASSIFIER_DEFAULT_TIMEOUT_MS = 20_000;
export const COMPANY_MONITORING_CLASSIFIER_MAX_TIMEOUT_MS = 60_000;

const OPENROUTER_SITE_URL = 'https://worldmonitor.app';
const OPENROUTER_APP_TITLE = 'World Monitor';
const SERVICE_USER_AGENT = 'WorldMonitor-CompanyMonitoring/1.0 (+https://worldmonitor.app)';
const MAX_PROVIDER_RESPONSE_BYTES = 256 * 1024;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export class CompanyMonitoringClassifierTransportError extends Error {
  constructor(message, { code, status, cause } = {}) {
    super(message, { cause });
    this.name = 'CompanyMonitoringClassifierTransportError';
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

function configurationError(message) {
  return new CompanyMonitoringClassifierTransportError(message, {
    code: 'configuration',
  });
}

function requireConfiguredString(value, name) {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    throw configurationError(`${name} must be a configured non-empty string`);
  }
  return value;
}

function checkedTimeoutMs(timeoutMs) {
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > COMPANY_MONITORING_CLASSIFIER_MAX_TIMEOUT_MS
  ) {
    throw configurationError(
      `timeoutMs must be a positive integer no greater than ${COMPANY_MONITORING_CLASSIFIER_MAX_TIMEOUT_MS}`,
    );
  }
  return timeoutMs;
}

function providerResponseError(message, cause) {
  return new CompanyMonitoringClassifierTransportError(message, {
    code: 'provider_response',
    cause,
  });
}

async function readBoundedProviderResponse(response) {
  if (response.body === null) {
    throw providerResponseError('Classifier provider returned an empty response envelope');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks = [];
  let byteLength = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      byteLength += value.byteLength;
      if (byteLength > MAX_PROVIDER_RESPONSE_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // The size violation is authoritative even if cancellation fails.
        }
        throw providerResponseError('Classifier provider response exceeded the byte limit');
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
  } catch (cause) {
    if (cause instanceof CompanyMonitoringClassifierTransportError) throw cause;
    throw providerResponseError('Classifier provider response could not be read', cause);
  } finally {
    reader.releaseLock();
  }

  return chunks.join('');
}

function approvedResolvedModels(configuredModel, approvedResolvedModels) {
  if (!Array.isArray(approvedResolvedModels)) {
    throw configurationError('approvedResolvedModels must be an array of exact model identifiers');
  }
  const approved = new Set([configuredModel]);
  for (const value of approvedResolvedModels) {
    approved.add(requireConfiguredString(value, 'approvedResolvedModels entry'));
  }
  return approved;
}

async function parseProviderEnvelope(response, approvedModels) {
  const responseText = await readBoundedProviderResponse(response);
  let envelope;
  try {
    envelope = JSON.parse(responseText);
  } catch (cause) {
    throw providerResponseError('Classifier provider returned an invalid JSON envelope', cause);
  }

  if (!isRecord(envelope) || ('error' in envelope && envelope.error != null)) {
    throw providerResponseError('Classifier provider returned an invalid response envelope');
  }
  if (typeof envelope.model !== 'string' || envelope.model.length === 0 || envelope.model !== envelope.model.trim()) {
    throw providerResponseError('Classifier provider did not attest the resolved model identity');
  }
  if (!approvedModels.has(envelope.model)) {
    throw providerResponseError('Classifier provider returned an unapproved resolved model identity');
  }
  if (!Array.isArray(envelope.choices) || envelope.choices.length !== 1) {
    throw providerResponseError('Classifier provider must return exactly one choice');
  }

  const choice = envelope.choices[0];
  if (
    !isRecord(choice) ||
    choice.finish_reason !== 'stop' ||
    !isRecord(choice.message)
  ) {
    throw providerResponseError('Classifier provider returned an incomplete choice');
  }

  const message = choice.message;
  if (
    message.role !== 'assistant' ||
    typeof message.content !== 'string' ||
    ('refusal' in message && message.refusal != null && message.refusal !== '') ||
    ('tool_calls' in message && message.tool_calls != null)
  ) {
    throw providerResponseError('Classifier provider returned invalid or refused content');
  }

  // Deliberately do not parse or validate this string. The deterministic
  // policy evaluator owns all model-output validation and fail-closed reasons.
  return {
    content: message.content,
    resolvedModel: envelope.model,
  };
}

/**
 * Execute one bounded OpenRouter JSON-schema classification request.
 *
 * Credentials and the model are caller supplied. No environment fallback is
 * used, and the returned model content remains untrusted for the deterministic
 * policy evaluator.
 */
export async function requestCompanyMonitoringClassification({
  candidate,
  evidence,
  apiKey,
  model,
  fetchImpl = (...args) => globalThis.fetch(...args),
  timeoutMs = COMPANY_MONITORING_CLASSIFIER_DEFAULT_TIMEOUT_MS,
  approvedResolvedModels: configuredApprovedResolvedModels = [],
}) {
  const configuredApiKey = requireConfiguredString(apiKey, 'apiKey');
  const configuredModel = requireConfiguredString(model, 'model');
  const approvedModels = approvedResolvedModels(configuredModel, configuredApprovedResolvedModels);
  const requestTimeoutMs = checkedTimeoutMs(timeoutMs);
  if (typeof fetchImpl !== 'function') {
    throw configurationError('fetchImpl must be a function');
  }

  const requestBody = buildCompanyMonitoringClassificationRequest({
    candidate,
    evidence,
    model: configuredModel,
  });
  const signal = AbortSignal.timeout(requestTimeoutMs);

  let response;
  try {
    response = await fetchImpl(COMPANY_MONITORING_CLASSIFIER_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${configuredApiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': OPENROUTER_SITE_URL,
        'X-Title': OPENROUTER_APP_TITLE,
        'User-Agent': SERVICE_USER_AGENT,
      },
      body: JSON.stringify(requestBody),
      signal,
    });
  } catch (cause) {
    if (signal.aborted) {
      throw new CompanyMonitoringClassifierTransportError(
        `Classifier provider timed out after ${requestTimeoutMs}ms`,
        { code: 'timeout', cause },
      );
    }
    throw new CompanyMonitoringClassifierTransportError(
      'Classifier provider request failed',
      { code: 'network', cause },
    );
  }

  if (!(response instanceof Response)) {
    throw providerResponseError('Classifier provider did not return a Response');
  }
  if (!response.ok) {
    throw new CompanyMonitoringClassifierTransportError(
      `Classifier provider returned HTTP ${response.status}`,
      { code: 'http', status: response.status },
    );
  }

  return await parseProviderEnvelope(response, approvedModels);
}
