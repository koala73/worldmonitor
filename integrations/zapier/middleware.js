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

const handleHttpError = (response, z) => {
  if (response.status >= 400) {
    throw new z.errors.Error(
      `WorldMonitor API returned ${response.status}`,
      'ApiError',
      response.status,
    );
  }
  return response;
};

module.exports = { addAuthHeader, handleHttpError };
