import { fetchLatestRelease } from './_github-release.js';

// Non-sebuf: returns XML/HTML, stays as standalone Vercel function
export const config = { runtime: 'edge' };

const RELEASES_PAGE = 'https://github.com/koala73/worldmonitor/releases/latest';

const PLATFORM_PATTERNS = {
  'windows-exe': (name) => name.endsWith('_x64-setup.exe'),
  'windows-msi': (name) => name.endsWith('_x64_en-US.msi'),
  'macos-arm64': (name) => name.endsWith('_aarch64.dmg'),
  'macos-x64': (name) => name.endsWith('_x64.dmg') && !name.includes('setup'),
  'linux-appimage': (name) => name.endsWith('_amd64.AppImage'),
  'linux-appimage-arm64': (name) => name.endsWith('_aarch64.AppImage'),
};

// #5908: there is one published desktop binary — World Monitor — and every
// variant is selected in-app after install. `variant` is therefore an identity
// hint, not an asset selector: each supported variant resolves to that same
// artifact. It is still validated so an unsupported value stays a visible
// redirect to the releases page rather than a silent success.
//
// This set is the in-app switcher's variants (src/config/variant.ts) plus the
// `world` alias for `full`. tests/desktop-one-binary-model.test.mjs fails if the
// two drift apart.
export const SUPPORTED_VARIANTS = new Set([
  'full',
  'world',
  'tech',
  'finance',
  'commodity',
  'energy',
  'happy',
]);

const DESKTOP_ASSET_IDENTIFIER = 'worldmonitor';

function canonicalAssetName(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function findDesktopAsset(assets, platformMatcher) {
  return assets.find((asset) => {
    const assetName = String(asset?.name || '');
    return canonicalAssetName(assetName).includes(DESKTOP_ASSET_IDENTIFIER)
      && platformMatcher(assetName);
  }) ?? null;
}

export default async function handler(req) {
  const url = new URL(req.url);
  const platform = url.searchParams.get('platform');
  const variant = (url.searchParams.get('variant') || '').toLowerCase();

  // `Object.hasOwn`, not a bare lookup: `?platform=constructor` inherits a
  // truthy, callable value from Object.prototype, which passed the guard and
  // then matched every asset name.
  if (!platform || !Object.hasOwn(PLATFORM_PATTERNS, platform)) {
    return Response.redirect(RELEASES_PAGE, 302);
  }

  // Validated alongside `platform`, before the upstream call: an unsupported
  // variant has one answer regardless of what GitHub returns.
  if (variant && !SUPPORTED_VARIANTS.has(variant)) {
    return Response.redirect(RELEASES_PAGE, 302);
  }

  try {
    const release = await fetchLatestRelease('WorldMonitor-Download-Redirect');
    if (!release) {
      return Response.redirect(RELEASES_PAGE, 302);
    }

    const matcher = PLATFORM_PATTERNS[platform];
    const assets = Array.isArray(release.assets) ? release.assets : [];
    // Identity-filtered on every path, with or without `variant`. The desktop
    // updater stopped sending `variant` once one binary served all variants, so
    // a variant-only filter would have left the app's own download — the single
    // most important caller — matching any asset that fit the platform suffix.
    const asset = findDesktopAsset(assets, matcher);

    if (!asset) {
      return Response.redirect(RELEASES_PAGE, 302);
    }

    return new Response(null, {
      status: 302,
      headers: {
        'Location': asset.browser_download_url,
        'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=60, stale-if-error=600',
      },
    });
  } catch {
    return Response.redirect(RELEASES_PAGE, 302);
  }
}
