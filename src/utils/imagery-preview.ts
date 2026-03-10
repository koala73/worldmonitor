const IMAGERY_PREVIEW_HOSTS = [
  'sentinel-s1-l1c.s3.amazonaws.com',
  'sentinel-cogs.s3.us-west-2.amazonaws.com',
  'earth-search.aws.element84.com',
];

export function isAllowedPreviewUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && IMAGERY_PREVIEW_HOSTS.some(h => parsed.hostname === h);
  } catch { return false; }
}
