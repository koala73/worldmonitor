/**
 * RFC 9728 §5.1 bearer challenge shared by every entry point that answers a
 * 401: the MCP transport, /agent/auth and the REST gateway (#4840). One
 * definition keeps `realm` and the protected-resource pointer identical
 * across surfaces, and the pointer is derived from the request Host through
 * `resolveMetadataOrigin` so a spoofed Host can never be reflected into it.
 */
import { resolveMetadataOrigin } from './_agent-metadata';

export const PROTECTED_RESOURCE_METADATA_PATH = '/.well-known/oauth-protected-resource';

/** `WWW-Authenticate` value for a given protected-resource metadata URL. */
export function wwwAuthHeader(resourceMetadataUrl: string, errorParam = ''): string {
  const errSegment = errorParam ? `, error="${errorParam}"` : '';
  return `Bearer realm="worldmonitor"${errSegment}, resource_metadata="${resourceMetadataUrl}"`;
}

/** Host-derived URL of the resource-wide RFC 9728 metadata document. */
export function protectedResourceMetadataUrl(req: Request): string {
  return `${resolveMetadataOrigin(req)}${PROTECTED_RESOURCE_METADATA_PATH}`;
}

/** The challenge a REST entry point attaches to its 401 for `req`. */
export function bearerChallenge(req: Request, errorParam = ''): string {
  return wwwAuthHeader(protectedResourceMetadataUrl(req), errorParam);
}
