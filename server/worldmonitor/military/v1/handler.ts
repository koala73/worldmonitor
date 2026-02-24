import type { MilitaryServiceHandler } from '../../../../src/generated/server/worldmonitor/military/v1/service_server';

import { listMilitaryFlights } from './list-military-flights';
import { getTheaterPosture } from './get-theater-posture';
import { getAircraftDetails } from './get-aircraft-details';
import { getAircraftDetailsBatch } from './get-aircraft-details-batch';
import { getWingbitsStatus } from './get-wingbits-status';
import { getUSNIFleetReport } from './get-usni-fleet-report';

export const militaryHandler: MilitaryServiceHandler = {
  listMilitaryFlights,
  getTheaterPosture,
  getAircraftDetails,
  getAircraftDetailsBatch,
  getWingbitsStatus,
  getUSNIFleetReport,
};
