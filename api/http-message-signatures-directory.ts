/**
 * GET /.well-known/http-message-signatures-directory
 * (rewritten to /api/http-message-signatures-directory)
 *
 * Web Bot Auth key directory — draft-meunier-web-bot-auth-architecture +
 * draft-meunier-http-message-signatures-directory (the Cloudflare/IETF
 * emerging standard for cryptographically-identified automated traffic).
 *
 * Publishes WorldMonitor's Ed25519 bot-signing public key as a JWK Set so a
 * server receiving a WorldMonitor-originated automated request can fetch this
 * directory, match the request's `Signature-Input` keyid (the RFC 8037 JWK
 * thumbprint) to a key here, and verify the RFC 9421 HTTP Message Signature.
 *
 * Served dynamically (not a static public/ file) because the spec RECOMMENDs a
 * key validity window of no more than 24h. `nbf`/`exp` are computed per request
 * as a rolling 24h window so the published key never reads as expired; a static
 * file would freeze a validity window that eventually lapses. The public key
 * `x` is fixed — its private half is held out-of-repo (operator vault + Vercel
 * env), mirroring the Ed25519 key already published at
 * /.well-known/mcp-registry-auth. Only the validity window rolls.
 *
 * `kid` is derived from `x` at request time (RFC 8037 App. A.3 thumbprint) so
 * the advertised key id can never drift from the key material it names.
 *
 * Content-Type is the spec-mandated
 * `application/http-message-signatures-directory+json`.
 */

import { guardMetadataMethod } from './_agent-metadata';

export const config = { runtime: 'edge' };

// Ed25519 public key, base64url without padding (43 chars = 32 bytes). The
// private half lives out-of-repo (operator vault + Vercel env
// WEB_BOT_AUTH_ED25519_PRIVATE_KEY), exactly like the Ed25519 key published at
// /.well-known/mcp-registry-auth. Rotating the key = regenerate the pair and
// replace this constant; `kid` re-derives from it automatically.
const ED25519_PUBLIC_KEY_X = 'haxeg7usB7Giri_2DP_UNE0LcFhrPd1IkNZs9RDI0k4';

// Backdate `nbf` an hour for verifier clock skew; `exp` is `nbf` + a 24h TTL, so
// the total advertised validity window is exactly KEY_TTL_SECONDS (the spec:
// expiry SHOULD be <= 24h — computing exp from now instead of nbf would make the
// window 25h). max-age keeps any cached copy inside it.
const CLOCK_SKEW_SECONDS = 3600;
const KEY_TTL_SECONDS = 86400;

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// RFC 8037 App. A.3: base64url(SHA-256(canonical JWK)) where the canonical form
// is the required members in lexicographic order with no whitespace. Memoised
// across invocations in a warm isolate (the key is constant).
let cachedKid: string | null = null;
async function jwkThumbprint(x: string): Promise<string> {
  if (cachedKid) return cachedKid;
  const canonical = `{"crv":"Ed25519","kty":"OKP","x":"${x}"}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  cachedKid = base64url(new Uint8Array(digest));
  return cachedKid;
}

export default async function handler(req: Request): Promise<Response> {
  const guarded = guardMetadataMethod(req);
  if (guarded) return guarded;

  const notBefore = Math.floor(Date.now() / 1000) - CLOCK_SKEW_SECONDS;
  const kid = await jwkThumbprint(ED25519_PUBLIC_KEY_X);

  const body = JSON.stringify({
    keys: [
      {
        kty: 'OKP',
        crv: 'Ed25519',
        x: ED25519_PUBLIC_KEY_X,
        kid,
        use: 'sig',
        nbf: notBefore,
        exp: notBefore + KEY_TTL_SECONDS,
      },
    ],
  });

  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/http-message-signatures-directory+json',
      'Cache-Control': 'public, max-age=3600',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
