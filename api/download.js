// Non-sebuf: returns XML/HTML, stays as standalone Vercel function
export const config = { runtime: 'edge' };

const RELEASES_URL = 'https://api.github.com/repos/bradleybond512/crystal-ball/releases/latest';
const RELEASES_PAGE = 'https://github.com/bradleybond512/crystal-ball/releases/latest';

// In-process cache for the GitHub release response (survives warm Edge Function invocations).
// CDN s-maxage=300 is the primary protection; this is a secondary layer.
let releaseCache = null; // { data: object, expiresAt: number }
const RELEASE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

const PLATFORM_PATTERNS = {
  'windows-exe': (name) => name.endsWith('_x64-setup.exe'),
  'windows-msi': (name) => name.endsWith('_x64_en-US.msi'),
  'macos-arm64': (name) => name.endsWith('_aarch64.dmg'),
  'macos-x64': (name) => name.endsWith('_x64.dmg') && !name.includes('setup'),
  'linux-appimage': (name) => name.endsWith('_amd64.AppImage'),
  'linux-appimage-arm64': (name) => name.endsWith('_aarch64.AppImage'),
};

const VARIANT_IDENTIFIERS = {
  full: ['crystalball', 'crystal ball'],
  world: ['crystalball', 'crystal ball'],
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
    const assetName = asset?.name ?? '';
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
    let release;
    const now = Date.now();
    if (releaseCache && now < releaseCache.expiresAt) {
      release = releaseCache.data;
    } else {
      const res = await fetch(RELEASES_URL, {
        headers: {
          'Accept': 'application/vnd.github+json',
          'User-Agent': 'CrystalBall-Download-Redirect',
        },
        signal: AbortSignal.timeout(8_000),
      });

      if (!res.ok) {
        return Response.redirect(RELEASES_PAGE, 302);
      }

      release = await res.json();
      releaseCache = { data: release, expiresAt: now + RELEASE_CACHE_TTL_MS };
    }
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
