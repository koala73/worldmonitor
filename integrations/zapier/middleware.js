'use strict';

const { AUTH_HEADER, USER_AGENT } = require('./constants');

const addAuthHeader = (request, _z, bundle) => {
  const apiKey = bundle.authData.apiKey;
  request.headers[AUTH_HEADER] = apiKey;
  request.headers['User-Agent'] = USER_AGENT;
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
