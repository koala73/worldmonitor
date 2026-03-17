export const SUPPORTED_RELEASE_VARIANTS = ['full', 'tech', 'finance'];

const RELEASE_PRODUCT_NAMES = {
  full: 'World Monitor',
  tech: 'Tech Monitor',
  finance: 'Finance Monitor',
};

export function assertSupportedReleaseVariant(variant) {
  if (!SUPPORTED_RELEASE_VARIANTS.includes(variant)) {
    throw new Error(`Unsupported release variant: ${variant}`);
  }
  return variant;
}

export function buildReleaseTag(version, variant) {
  assertSupportedReleaseVariant(variant);
  if (variant === 'full') return `v${version}`;
  return `v${version}-${variant}`;
}

export function buildReleaseName(version, variant) {
  return `${getReleaseProductName(variant)} v${version}`;
}

export function getReleaseProductName(variant) {
  assertSupportedReleaseVariant(variant);
  return RELEASE_PRODUCT_NAMES[variant];
}

export function parseReleaseTag(tagName) {
  const trimmed = String(tagName || '').trim();
  const match = trimmed.match(/^v(\d+\.\d+\.\d+)(?:-(tech|finance))?$/);
  if (!match) {
    throw new Error(`Unsupported release tag: ${tagName}`);
  }

  return {
    tag: trimmed,
    version: match[1],
    variant: match[2] ?? 'full',
  };
}

export function parseReleaseRef(refName) {
  const trimmed = String(refName || '').trim();
  const tagName = trimmed.startsWith('refs/tags/') ? trimmed.slice('refs/tags/'.length) : trimmed;
  return parseReleaseTag(tagName);
}
