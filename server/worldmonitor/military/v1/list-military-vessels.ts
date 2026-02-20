import type {
  ServerContext,
  ListMilitaryVesselsRequest,
  ListMilitaryVesselsResponse,
} from '../../../../src/generated/server/worldmonitor/military/v1/service_server';

export async function listMilitaryVessels(
  _ctx: ServerContext,
  _req: ListMilitaryVesselsRequest,
): Promise<ListMilitaryVesselsResponse> {
  // Vessel tracking is client-side (AIS stream).
  return { vessels: [], clusters: [], pagination: undefined };
}
