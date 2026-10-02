const VERCEL_COMMIT_SHA = /^[0-9a-f]{40}$/i;

interface SentryBuildMetadata {
  release?: string;
  dist?: string;
  initialScope?: {
    tags: {
      build_sha: string;
      app_version: string;
    };
  };
}

/**
 * Match the Edge release and GitHub commit identity. A stable semver release
 * cannot advance past a commit-based resolution when the app version stays
 * unchanged. Keep the app version as a tag for cross-deployment searches.
 */
export function getSentryBuildMetadata(
  appVersion: string,
  buildHash: string,
  environment = 'production',
): SentryBuildMetadata {
  const release = `worldmonitor@${appVersion}`;
  const normalizedBuildHash = buildHash.trim();
  if (!VERCEL_COMMIT_SHA.test(normalizedBuildHash)) return { release: environment === 'production' ? release : undefined };

  return {
    release: environment === 'production' ? normalizedBuildHash : undefined,
    dist: environment === 'production' ? normalizedBuildHash : undefined,
    initialScope: {
      tags: {
        build_sha: normalizedBuildHash,
        app_version: appVersion,
      },
    },
  };
}

/** Environments share a Sentry project, so preview errors need separate groups. */
export function isolateNonProductionSentryEvent(
  event: { release?: string; dist?: string; fingerprint?: string[] },
  environment: string,
): void {
  if (environment === 'production') return;
  delete event.release;
  delete event.dist;
  event.fingerprint = [...(event.fingerprint ?? ['{{ default }}']), `worldmonitor:${environment}`];
}
