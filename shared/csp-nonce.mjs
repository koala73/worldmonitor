// Build HTML with CSP_NONCE_PLACEHOLDER. No static CSP header allows that
// token or the retired public nonce. Vercel middleware and nginx sub_filter
// each replace the placeholder with a fresh value and set the same script-src
// nonce. Stamped HTML is no-store so a shared cache cannot replay the pair.

export const CSP_NONCE_PLACEHOLDER = '__WM_CSP_NONCE__';
export const RETIRED_STATIC_SCRIPT_NONCE = 'wm-static-bootstrap';

export const STAMPED_DOCUMENT_CACHE_CONTROL = 'private, no-store';
export const STAMPED_DOCUMENT_CDN_CACHE_CONTROL = 'no-store';

const NONCE_BYTES = 18;

export function createCspNonce() {
  const bytes = new Uint8Array(NONCE_BYTES);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

export function contentSecurityPolicyWithNonce(policy, nonce) {
  if (typeof policy !== 'string' || !policy.includes('script-src')) {
    throw new Error('CSP policy is missing script-src');
  }
  if (typeof nonce !== 'string' || nonce.length < 16 || /[^A-Za-z0-9_-]/.test(nonce)) {
    throw new Error('CSP nonce is not a safe token');
  }
  if (nonce === CSP_NONCE_PLACEHOLDER || nonce === RETIRED_STATIC_SCRIPT_NONCE) {
    throw new Error('CSP nonce must be unpredictable');
  }
  const token = `'nonce-${nonce}'`;
  const hadTrailingSemicolon = /;\s*$/.test(policy);
  const directives = policy.split(';').map((part) => part.trim()).filter(Boolean);
  let sawScriptSrc = false;
  const next = directives.map((directive) => {
    const [name, ...sources] = directive.split(/\s+/);
    if (name !== 'script-src') return directive;
    sawScriptSrc = true;
    const kept = sources.filter((source) => !source.startsWith("'nonce-"));
    return ['script-src', token, ...kept].join(' ');
  });
  if (!sawScriptSrc) throw new Error('CSP policy is missing script-src');
  const body = next.join('; ');
  return hadTrailingSemicolon ? `${body};` : body;
}

export function stampCspDocument(html, policy, nonce = createCspNonce()) {
  if (typeof html !== 'string' || !html.includes(CSP_NONCE_PLACEHOLDER)) return null;
  return {
    nonce,
    html: html.replaceAll(CSP_NONCE_PLACEHOLDER, nonce),
    policy: contentSecurityPolicyWithNonce(policy, nonce),
  };
}

export function attributeNonces(html) {
  return [...html.matchAll(/\bnonce=["']([^"']+)["']/g)].map((match) => match[1]);
}

export function policyNonces(policy) {
  return [...policy.matchAll(/'nonce-([^']+)'/g)].map((match) => match[1]);
}
