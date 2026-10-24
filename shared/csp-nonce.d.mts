export const CSP_NONCE_PLACEHOLDER: string;
export const RETIRED_STATIC_SCRIPT_NONCE: string;
export const STAMPED_DOCUMENT_CACHE_CONTROL: string;
export const STAMPED_DOCUMENT_CDN_CACHE_CONTROL: string;

export function createCspNonce(): string;
export function contentSecurityPolicyWithNonce(policy: string, nonce: string): string;
export function stampCspDocument(
  html: string,
  policy: string,
  nonce?: string,
): { nonce: string; html: string; policy: string } | null;
export function attributeNonces(html: string): string[];
export function policyNonces(policy: string): string[];
