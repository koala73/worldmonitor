// Non-sebuf: returns XML/HTML, stays as standalone Vercel function
export const config = { runtime: 'edge' };

const RELEASES_URL = 'https://api.github.com/repos/koala73/worldmonitor/releases/latest';
const RELEASES_PAGE = 'https://github.com/koala73/worldmonitor/releases/latest';

const PLATFORM_PATTERNS = {
  'windows-exe': (name) => name.endsWith('_x64-setup.exe'),
  'windows-msi': (name) => name.endsWith('_x64_en-US.msi'),
  'macos-arm64': (name) => name.endsWith('_aarch64.dmg'),
  'macos-x64': (name) => name.endsWith('_x64.dmg') && !name.includes('setup'),
  'linux-appimage': (name) => name.endsWith('_amd64.AppImage'),
  'linux-appimage-arm64': (name) => name.endsWith('_aarch64.AppImage'),
};

const VARIANT_IDENTIFIERS = {
  full: ['worldmonitor'],
  world: ['worldmonitor'],
  tech: ['techmonitor'],
  finance: ['financemonitor'],
};

function canonicalAssetName(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function findAssetForVariant(assets, variant, platformMatcher) {
  const identifiers = VARIANT_IDENTIFIERS[variant] ?? null;
  if (!identifiers) return null;

  return assets.find((asset) => {
    const assetName = String(asset?.name || '');
    const normalizedAssetName = canonicalAssetName(assetName);
    const hasVariantIdentifier = identifiers.some((identifier) =>
      normalizedAssetName.includes(identifier)
    );
    return hasVariantIdentifier && platformMatcher(assetName);
  }) ?? null;
}

export default async function handler(req) {
  const url = new URL(req.url);
  const platform = url.searchParams.get('platform');
  const variant = (url.searchParams.get('variant') || '').toLowerCase();

  if (!platform || !PLATFORM_PATTERNS[platform]) {
    return Response.redirect(RELEASES_PAGE, 302);
  }

  try {
    const res = await fetch(RELEASES_URL, {
      headers: {
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'WorldMonitor-Download-Redirect',
      },
    });

    if (!res.ok) {
      return Response.redirect(RELEASES_PAGE, 302);
    }

    const release = await res.json();
    const matcher = PLATFORM_PATTERNS[platform];
    const assets = Array.isArray(release.assets) ? release.assets : [];
    const asset = variant
      ? findAssetForVariant(assets, variant, matcher)
      : assets.find((a) => matcher(String(a?.name || '')));

    if (!asset) {
      return Response.redirect(RELEASES_PAGE, 302);
    }

    return new Response(null, {
      status: 302,
      headers: {
        'Location': asset.browser_download_url,
        'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=60',
      },
    });
  } catch {
    return Response.redirect(RELEASES_PAGE, 302);
  }
}
