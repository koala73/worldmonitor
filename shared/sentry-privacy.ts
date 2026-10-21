/** Browser telemetry keeps routes and error evidence, but not URL credentials or user identifiers. */
const PRIVATE_FIELD = /^(?:authorization|proxy-authorization|cookie|set-cookie|password|passwd|secret|token|access[_-]?token|refresh[_-]?token|client[_-]?secret|query_string|(?:url|http)\.(?:query|fragment)|(?:x[_-]?)?api[_-]?key|email|ip_address|username)$/i;
const ABSOLUTE_URL = /(?:https?|wss?):\/\/[^\s<>"']+/gi;

function sanitizeUrl(value: string): string {
  try {
    const url = new URL(value, 'https://telemetry.invalid');
    if (!/^(?:https?|wss?):$/.test(url.protocol)) return '[Filtered URL]';
    const path = url.pathname;
    if (value.startsWith('//')) return `//${url.host}${path}`;
    if (value.startsWith('/')) return path;
    if (!/^[a-z][a-z0-9+.-]*:/i.test(value)) return value.split(/[?#]/, 1)[0] ?? '';
    return `${url.protocol}//${url.host}${path}`;
  } catch {
    return '[Invalid URL]';
  }
}

function sanitizeText(value: string, key: string): string {
  if (/^(?:data|javascript):/i.test(value)) return '[Filtered URL]';
  if (value.startsWith('/') || /^(?:url|uri|from|to|filename|abs_path|http\.target|url\.full)$/i.test(key)) return sanitizeUrl(value);
  return value.replace(ABSOLUTE_URL, sanitizeUrl).replace(/(^|\s)(\/[^\s<>"']*[?#][^\s<>"']*)/g, (_, prefix, url) => prefix + sanitizeUrl(url));
}

export function sanitizeSentryTelemetry<T>(value: T): T {
  const seen = new WeakMap<object, unknown>();
  function visit(input: unknown, key = '', depth = 0): unknown {
    if (typeof input === 'string') return sanitizeText(input, key);
    if (!input || typeof input !== 'object') return input;
    if (seen.has(input)) return seen.get(input);
    if (depth >= 10) return '[Filtered nested data]';
    const output: Record<string, unknown> | unknown[] = Array.isArray(input) ? [] : {};
    seen.set(input, output);
    for (const [key, item] of Object.entries(input)) {
      const filtered = key === 'user' ? {} : PRIVATE_FIELD.test(key) ? '[Filtered]' : visit(item, key, depth + 1);
      Object.defineProperty(output, key, { value: filtered, enumerable: true, writable: true, configurable: true });
    }
    return output;
  }
  return visit(value) as T;
}

export const sentryPrivacyOptions = {
  sendDefaultPii: false,
  integrations: [{
    name: 'WorldMonitorSessionPrivacy',
    setup(client: { on(hook: 'beforeSendSession', callback: (session: object) => void): unknown }) {
      client.on('beforeSendSession', (session) => {
        Reflect.deleteProperty(session, 'ipAddress');
        Reflect.deleteProperty(session, 'did');
      });
    },
  }],
  beforeBreadcrumb: sanitizeSentryTelemetry,
  beforeSendTransaction: sanitizeSentryTelemetry,
  beforeSendSpan: sanitizeSentryTelemetry,
};
