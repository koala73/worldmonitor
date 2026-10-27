import { resolveSessionUserId } from '../../server/_shared/auth-session';
import { MarketplaceError } from '../../server/_shared/aws-marketplace';

export const config = { runtime: 'edge' };
export const COOKIE_REGISTRATION = '__Secure-wm_aws_registration';
export const COOKIE_BINDING = '__Secure-wm_aws_binding';
export const COOKIE_MAX_AGE = 10 * 60;
export const BASE_HEADERS = {
  'Cache-Control': 'private, no-store',
  'Referrer-Policy': 'no-referrer',
  'Content-Type': 'application/json; charset=utf-8',
};

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...BASE_HEADERS, ...headers } });
}

export function errorResponse(error: unknown): Response {
  if (error instanceof MarketplaceError) {
    const status = error.code === 'BACKEND_FORBIDDEN' ? 403 : error.code === 'BACKEND_NOT_FOUND' ? 404 :
      error.code === 'BACKEND_CONFLICT' || error.code === 'REGISTRATION_EXPIRED' || error.code === 'REGISTRATION_REQUIRED' ? 409 :
      error.code === 'BACKEND_INVALID' || error.code === 'AWS_INVALID' ? 400 : 503;
    return json({ error: error.code }, status);
  }
  return json({ error: 'SERVICE_UNAVAILABLE' }, 503);
}

export function sameOriginMutation(request: Request): boolean {
  const expected = process.env.AWS_MARKETPLACE_BUYER_ORIGIN;
  if (!expected) return false;
  try {
    const origin = request.headers.get('origin');
    const url = new URL(expected);
    return url.protocol === 'https:' && origin === url.origin && new URL(request.url).origin === url.origin &&
      request.headers.get('content-type')?.toLowerCase().startsWith('application/json') === true;
  } catch { return false; }
}

export async function authenticatedUser(request: Request): Promise<string | Response> {
  const result = await resolveSessionUserId(request);
  if (result instanceof Response) return json({ error: 'AUTH_UNAVAILABLE' }, 503);
  if (!result) return json({ error: 'UNAUTHENTICATED' }, 401);
  return result;
}

export async function readSmallText(request: Request, maxBytes: number): Promise<string> {
  const length = Number(request.headers.get('content-length') || 0);
  if (length > maxBytes) throw new MarketplaceError('BACKEND_INVALID');
  const reader = request.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) { await reader.cancel(); throw new MarketplaceError('BACKEND_INVALID'); }
    chunks.push(value);
  }
  const data = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder('utf-8', { fatal: true }).decode(data);
}

export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readSmallText(request, 4096)) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    throw new MarketplaceError('BACKEND_INVALID');
  }
  throw new MarketplaceError('BACKEND_INVALID');
}

export function cookieValue(request: Request, name: string): string | null {
  const field = request.headers.get('cookie') || '';
  const part = field.split(';').map(s => s.trim()).find(s => s.startsWith(`${name}=`));
  const value = part?.slice(name.length + 1);
  return value && /^[a-f0-9]{64}$/.test(value) ? value : null;
}

export function cookieHeader(name: string, value: string, maxAge = COOKIE_MAX_AGE): string {
  return `${name}=${value}; Max-Age=${maxAge}; Path=/api/marketplace; HttpOnly; Secure; SameSite=Lax`;
}

export function randomSecret(bytes = 32): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), b => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}
