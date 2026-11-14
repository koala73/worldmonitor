import type { OrbitalServiceHandler } from '../../../../src/generated/server/worldmonitor/orbital/v1/service_server';
import { listImagingSatellites } from './list-imaging-satellites';

export const orbitalHandler: OrbitalServiceHandler = {
  listImagingSatellites,
};
