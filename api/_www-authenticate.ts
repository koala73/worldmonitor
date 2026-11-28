/**
 * RFC 9728 §5.1 challenges for MCP OAuth and REST API-key discovery (#4840).
 * REST describes its own accepted credentials rather than advertising MCP
 * OAuth tokens it cannot consume. The pointer is derived from the Host through
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

/** RFC 9728 §5.1 permits resource_metadata with schemes other than Bearer. */
export function apiKeyChallenge(req: Request): string {
  return `ApiKey realm="worldmonitor", header="X-WorldMonitor-Key", resource_metadata="${protectedResourceMetadataUrl(req)}/api"`;
}
