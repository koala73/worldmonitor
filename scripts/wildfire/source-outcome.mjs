import { BC_SNAPSHOT_TTL_SECONDS } from './bc-fire-points.mjs';
import { CWFIS_RETAIN_MS } from './cwfis-wfs.mjs';

export function wildfireDiagnosticContext(runId, env = {}) {
  return {
    runId: typeof runId === 'string' && /^\d{1,16}-[a-z0-9]{1,6}$/.test(runId) ? runId : null,
    deploymentId: typeof env.RAILWAY_DEPLOYMENT_ID === 'string'
      && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(env.RAILWAY_DEPLOYMENT_ID)
      ? env.RAILWAY_DEPLOYMENT_ID : null,
    commitSha: typeof env.RAILWAY_GIT_COMMIT_SHA === 'string' && /^[a-f0-9]{40}$/i.test(env.RAILWAY_GIT_COMMIT_SHA)
      ? env.RAILWAY_GIT_COMMIT_SHA : null,
  };
}

export async function observeWildfireSource(source, fetchSource, context) {
  const startedAt = Date.now();
  let value;
  let failure;
  try {
    value = await fetchSource();
    return value;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    // A diagnostic failure must not replace the source result or original error.
    try {
      const snapshot = (value ?? failure)?.[source === 'bc' ? '_bcSnapshot' : '_cwfisSnapshot'];
      const snapshotClock = Number.isSafeInteger(snapshot?.fetchedAt) && snapshot.fetchedAt > 0
        ? snapshot.fetchedAt : null;
      let outcome = 'failed';
      if (source === 'firms') {
        if (value?._firmsFulfilledCalls > 0) outcome = value._firmsFailedCalls > 0 ? 'partial' : 'fresh';
      } else {
        const state = value?.[source === 'bc' ? '_bcState' : '_cwfisState'];
        if (state === 'ok') outcome = 'fresh';
        else if (state === 'degraded') outcome = 'partial';
        else if (value && snapshotClock !== null) outcome = 'retained';
      }
      const current = outcome === 'fresh' || outcome === 'partial';
      const retained = snapshotClock !== null && outcome !== 'fresh';
      const route = current ? (source === 'bc' ? value._bcVia : source === 'firms' ? 'area' : 'wfs') : null;
      console.log(JSON.stringify({
        event: 'wildfire_source_outcome',
        runId: context?.runId ?? null, deploymentId: context?.deploymentId ?? null, commitSha: context?.commitSha ?? null,
        source, outcome,
        recordCount: Array.isArray(value?.fireDetections) ? value.fireDetections.length : null,
        retainedRecordCount: Array.isArray(snapshot?.fireDetections)
          ? (retained ? snapshot.fireDetections.length : 0) : source === 'firms' ? 0 : null,
        fetchedAt: outcome === 'partial' ? null : snapshotClock,
        lastAttemptAt: snapshot?.lastAttemptAt ?? startedAt,
        retainedFetchedAt: retained ? snapshotClock : null,
        retainedUntil: snapshotClock === null ? null
          : snapshotClock + (source === 'bc' ? BC_SNAPSHOT_TTL_SECONDS * 1_000 : CWFIS_RETAIN_MS),
        route: ['kml', 'wfs', 'area'].includes(route) ? route : null,
      }));
    } catch {}
  }
}
