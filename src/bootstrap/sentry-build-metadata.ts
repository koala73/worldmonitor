const VERCEL_COMMIT_SHA = /^[0-9a-f]{40}$/i;

interface SentryBuildMetadata {
  release: string;
  dist?: string;
  initialScope?: {
    tags: {
      build_sha: string;
    };
  };
}

/**
 * Keep the semver release stable while making each Vercel deployment
 * attributable. Sentry's `dist` is the build within a release; the explicit
 * tag keeps the SHA available in issue/event searches and exports.
 */
export function getSentryBuildMetadata(
  appVersion: string,
  buildHash: string,
): SentryBuildMetadata {
  const release = `worldmonitor@${appVersion}`;
  const normalizedBuildHash = buildHash.trim();
  if (!VERCEL_COMMIT_SHA.test(normalizedBuildHash)) return { release };

  return {
    release,
    dist: normalizedBuildHash,
    initialScope: {
      tags: {
        build_sha: normalizedBuildHash,
      },
    },
  };
}
