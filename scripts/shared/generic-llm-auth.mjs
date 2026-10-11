/**
 * Authentication for an operator-configured OpenAI-compatible endpoint.
 * Keep this dependency-free so both Edge handlers and standalone seeders use
 * the same contract. Unknown modes must never send the credential.
 *
 * @param {string | undefined} apiKey
 * @param {string | undefined} authType
 * @returns {Record<string, string> | null}
 */
export function getGenericLlmAuthHeaders(apiKey, authType) {
  if (!apiKey) return null;
  switch (authType?.trim() || 'bearer') {
    case 'bearer':
      return { Authorization: `Bearer ${apiKey}` };
    case 'x-bf-vk':
      return { 'x-bf-vk': apiKey };
    default:
      return null;
  }
}
