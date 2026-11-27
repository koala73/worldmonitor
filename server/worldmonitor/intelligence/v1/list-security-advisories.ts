import type {
  ServerContext,
  ListSecurityAdvisoriesRequest,
  ListSecurityAdvisoriesResponse,
} from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';

import { readRequiredSeed } from '../../../_shared/required-seed';
import {
  normalizeAdvisoryRegisterLevels,
  normalizeAdvisorySnapshot,
} from '../../../../shared/intelligence-snapshots.js';

const ADVISORY_KEY = 'intelligence:advisories:v1';

/** The seed's fetch time in Unix epoch ms, or 0 when absent or unparseable. */
function fetchedAtMs(value: unknown): number {
  const raw = (value as { fetchedAt?: unknown } | null)?.fetchedAt;
  const ms = typeof raw === 'number' ? raw : Date.parse(String(raw ?? ''));
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

export async function listSecurityAdvisories(
  _ctx: ServerContext,
  _req: ListSecurityAdvisoriesRequest,
): Promise<ListSecurityAdvisoriesResponse> {
  // Invalid advisories are dropped; a malformed, thin-coverage or all-invalid
  // snapshot is 503. Confirmed-empty `{ advisories: [], byCountry: {} }` is 200.
  const data = await readRequiredSeed(ADVISORY_KEY, (value) => {
    const snapshot = normalizeAdvisorySnapshot(value);
    return snapshot
      ? { ...snapshot, registerLevels: normalizeAdvisoryRegisterLevels(value), fetchedAt: fetchedAtMs(value) }
      : undefined;
  });
  return {
    advisories: data.advisories.map(a => ({
      title: a.title,
      link: a.link,
      pubDate: a.pubDate,
      source: a.source,
      sourceCountry: a.sourceCountry,
      level: a.level || 'info',
      country: a.country || '',
    })),
    byCountry: data.byCountry,
    registerLevels: data.registerLevels,
    fetchedAt: data.fetchedAt,
  };
}
