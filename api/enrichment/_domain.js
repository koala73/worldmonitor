const DOMAIN_SUFFIX_RE = /\.(com|io|co|org|net|ai|dev|app)$/;

export function toOrgSlugFromDomain(domain) {
  return (domain || '')
    .trim()
    .toLowerCase()
    .replace(DOMAIN_SUFFIX_RE, '')
    .split('.')
    .pop() || '';
}

export function inferCompanyNameFromDomain(domain) {
  const orgSlug = toOrgSlugFromDomain(domain);
  if (!orgSlug) return domain || '';

  return orgSlug
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
