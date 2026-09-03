import {
  ApiError,
  type ServerContext,
  type RecordBaselineSnapshotRequest,
  type RecordBaselineSnapshotResponse,
} from '../../../../src/generated/server/worldmonitor/infrastructure/v1/service_server';

/**
 * Client-supplied counts cannot update shared statistical state safely.
 *
 * Anonymous sessions are intentionally easy to mint. Any scheme that chooses
 * or aggregates their submitted counts can therefore be controlled by one
 * caller. Keep the deprecated RPC registered for a clear compatibility error,
 * but fail before Redis until a server-owned producer replaces it.
 */
export async function recordBaselineSnapshot(
  _ctx: ServerContext,
  _req: RecordBaselineSnapshotRequest,
): Promise<RecordBaselineSnapshotResponse> {
  throw new ApiError(403, 'Client baseline writes are disabled', '');
}
