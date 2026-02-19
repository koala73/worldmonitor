const DEFAULT_BASE_URL = 'https://api.ai4u.now/v1';

export function getAi4uApiKey() {
  return String(
    process.env.AI4U_API_KEY
      || process.env.GROQ_API_KEY
      || process.env.OPENROUTER_API_KEY
      || ''
  ).trim();
}

export function getAi4uBaseUrl() {
  const configured = String(process.env.AI4U_BASE_URL || '').trim();
  const base = configured || DEFAULT_BASE_URL;
  return base.replace(/\/+$/, '');
}

export function getAi4uModel(envKey, fallbackModel) {
  const specific = String(process.env[envKey] || '').trim();
  if (specific) return specific;

  const shared = String(process.env.AI4U_CHAT_MODEL || '').trim();
  if (shared) return shared;

  return fallbackModel;
}

export async function postAi4u(path, apiKey, payload, extraHeaders = {}) {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return fetch(`${getAi4uBaseUrl()}${normalizedPath}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
    body: JSON.stringify(payload),
  });
}

export { DEFAULT_BASE_URL as AI4U_DEFAULT_BASE_URL };
