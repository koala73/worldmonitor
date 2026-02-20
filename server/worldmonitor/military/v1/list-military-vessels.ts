import type {
  ServerContext,
  ListMilitaryVesselsRequest,
  ListMilitaryVesselsResponse,
} from '../../../../src/generated/server/worldmonitor/military/v1/service_server';

export async function listMilitaryVessels(
  _ctx: ServerContext,
  _req: ListMilitaryVesselsRequest,
): Promise<ListMilitaryVesselsResponse> {
  // Vessel tracking is client-side via AIS stream callbacks.
  throw new Error('UNIMPLEMENTED: ListMilitaryVessels — vessel tracking is client-side only');
}
