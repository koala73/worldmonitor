'use strict';

const { AUTH_HEADER, USER_AGENT } = require('./constants');

const addAuthHeader = (request, _z, bundle) => {
  const headers = request.headers || {};
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === 'user-agent') {
      delete headers[key];
    }
  }
  headers[AUTH_HEADER] = bundle.authData.apiKey;
  headers['User-Agent'] = USER_AGENT;
  request.headers = headers;
  return request;
};

const describeError = (response) => {
  const body = response.data && typeof response.data === 'object' ? response.data : {};
  if (Array.isArray(body.violations) && body.violations.length > 0) {
    return body.violations.map((v) => `${v.field}: ${v.description}`).join('; ');
  }
  return body.message || body.error || `HTTP ${response.status}`;
};

const handleHttpError = (response, z) => {
  // A caller that opted out of throwing (unsubscribe treats 404 as already
  // gone) inspects the status itself.
  if (response.request && response.request.skipThrowForStatus) return response;
  if (response.status === 401) {
    throw new z.errors.ExpiredAuthError(
      `WorldMonitor rejected the API key (${describeError(response)}). Reconnect with an active wm_ key from Settings, API Keys.`,
    );
  }
  // 403 also covers the User-Agent policy, which says nothing about the key.
  if (response.status === 403) {
    throw new z.errors.Error(`WorldMonitor refused the request: ${describeError(response)}`, 'Forbidden', 403);
  }
  if (response.status >= 400) {
    throw new z.errors.Error(
      `WorldMonitor API error ${response.status}: ${describeError(response)}`,
      'ApiError',
      response.status,
    );
  }
  return response;
};

module.exports = { addAuthHeader, handleHttpError };
