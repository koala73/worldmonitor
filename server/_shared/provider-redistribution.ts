import {
  INTERNAL_MCP_VERIFIED_HEADER,
  getInternalMcpVerifiedNonce,
} from './mcp-internal-hmac';
export {
  hasRedistributableProviderAttribution,
  isOpenSkyProvider,
} from '../../shared/provider-redistribution';

/**
 * True for paid API-key calls and gateway-verified MCP calls. Anonymous
 * browser sessions use a `wms_` token and remain on the dashboard product
 * path, where providers that are licensed for display can still be used.
 */
export function requiresRedistributableProviders(request: Request | undefined): boolean {
  if (!request) return false;

  const verifiedMcpMarker = request.headers.get(INTERNAL_MCP_VERIFIED_HEADER);
  if (verifiedMcpMarker && verifiedMcpMarker === getInternalMcpVerifiedNonce()) return true;

  const apiKey = request.headers.get('X-WorldMonitor-Key')
    ?? request.headers.get('X-Api-Key')
    ?? '';
  return apiKey.length > 0 && !apiKey.startsWith('wms_');
}
