import type { AviationServiceHandler } from '../../../../src/generated/server/worldmonitor/aviation/v1/service_server';

import { listAirportDelays } from './list-airport-delays';
import { getAirportOpsSummary } from './get-airport-ops-summary';
import { listAirportFlights } from './list-airport-flights';
import { getCarrierOps } from './get-carrier-ops';
import { getFlightStatus } from './get-flight-status';
import { trackAircraft } from './track-aircraft';
import { searchFlightPrices } from './search-flight-prices';
import { listAviationNews } from './list-aviation-news';
import { getYoutubeLiveStreamInfo } from './get-youtube-live-stream-info';
import { searchGoogleFlights } from './search-google-flights';
import { searchGoogleDates } from './search-google-dates';

export const aviationHandler: AviationServiceHandler = {
  listAirportDelays,
  getAirportOpsSummary,
  listAirportFlights,
  getCarrierOps,
  getFlightStatus,
  trackAircraft,
  searchFlightPrices,
  listAviationNews,
  getYoutubeLiveStreamInfo,
  searchGoogleFlights,
  searchGoogleDates,
};
