import { expect, it, vi } from 'vitest';
const source = vi.hoisted(() => ({ hydrated: undefined as unknown, read: vi.fn() }));
vi.mock('@/services/bootstrap', () => ({ getHydratedData: () => source.hydrated }));
vi.mock('@/services/generated-rpc-clients', () => ({ InfrastructureServiceClient: class {
  listTemporalAnomalies = source.read;
} }));
import { consumeServerAnomalies, fetchLiveAnomalies, hasTemporalBaselineSnapshot } from '@/services/temporal-baseline';

it('distinguishes absent, failed, valid empty and recovered temporal snapshots', async () => {
  source.hydrated = undefined;
  consumeServerAnomalies();
  expect(hasTemporalBaselineSnapshot()).toBe(false);

  const goodSnapshot = { anomalies: [], trackedTypes: ['news'], computedAt: '2026-09-15T00:00:00Z' };
  source.hydrated = goodSnapshot;
  consumeServerAnomalies();
  expect(hasTemporalBaselineSnapshot()).toBe(true);

  source.read.mockRejectedValueOnce(new Error('Synthetic upstream failure'));
  const recovered = await fetchLiveAnomalies();
  expect(hasTemporalBaselineSnapshot()).toBe(true);
  expect(recovered).toEqual({ anomalies: [], trackedTypes: ['news'] });

  // Soft-miss empty computedAt must preserve last-known-good, unlike a cleared snapshot.
  source.read.mockResolvedValueOnce({ anomalies: [], trackedTypes: [], computedAt: '' });
  const softMiss = await fetchLiveAnomalies();
  expect(hasTemporalBaselineSnapshot()).toBe(true);
  expect(softMiss).toEqual({ anomalies: [], trackedTypes: ['news'] });

  source.hydrated = undefined;
  consumeServerAnomalies();
  expect(hasTemporalBaselineSnapshot()).toBe(false);

  source.read.mockRejectedValueOnce(new Error('Synthetic upstream failure'));
  await fetchLiveAnomalies();
  expect(hasTemporalBaselineSnapshot()).toBe(false);

  source.read.mockResolvedValueOnce({ anomalies: [], trackedTypes: [], computedAt: '' });
  await fetchLiveAnomalies();
  expect(hasTemporalBaselineSnapshot()).toBe(false);

  source.read.mockResolvedValueOnce({ anomalies: [], trackedTypes: ['news'], computedAt: '2026-09-15T00:01:00Z' });
  await fetchLiveAnomalies();
  expect(hasTemporalBaselineSnapshot()).toBe(true);
});
