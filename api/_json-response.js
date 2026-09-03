function sanitizeJsonValue(value, depth = 0) {
  if (value instanceof Error) {
    return { error: value.message };
  }

  if (!value || typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    if (depth > 20 && value.some(item => item !== null && typeof item === 'object')) return '[truncated]';
    return value.map(item => sanitizeJsonValue(item, depth + 1));
  }

  if (depth > 20) return '[truncated]';

  const clone = {};
  for (const [key, nested] of Object.entries(value)) {
    if (key === 'stack' || key === 'stackTrace' || key === 'cause') continue;
    clone[key] = sanitizeJsonValue(nested, depth + 1);
  }
  return clone;
}

export function jsonResponse(body, status, headers = {}) {
  return new Response(JSON.stringify(sanitizeJsonValue(body)), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
  });
}
