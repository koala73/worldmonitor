'use strict';

const { isGenericLlmSelected } = require('../shared/generic-llm-provider.mjs');
const HOSTED_API_ORIGIN = 'https://api.worldmonitor.app';

function getWidgetDataConfig(env = process.env) {
  const explicitBase = env.API_BASE_URL?.trim();
  const generic = isGenericLlmSelected(env);
  if (generic && !explicitBase) throw new Error('Local widget data requires API_BASE_URL');
  const url = new URL(explicitBase || HOSTED_API_ORIGIN);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Widget API_BASE_URL must be an HTTP(S) origin');
  }
  const hosted = url.hostname === 'worldmonitor.app' || url.hostname.endsWith('.worldmonitor.app');
  if (generic && hosted) throw new Error('Local widget data requires your own API_BASE_URL');
  // Only a separately configured self-host installation may use its operator
  // credential. Model-chosen paths never control the origin or the header.
  const localMode = ['docker', 'desktop-sidecar', 'tauri-sidecar'].includes(env.LOCAL_API_MODE || '');
  const operatorKey = explicitBase && !hosted && localMode
    ? (env.WORLDMONITOR_API_KEY || '').trim() : '';
  return { origin: url.origin, operatorKey };
}

module.exports = { getWidgetDataConfig };
