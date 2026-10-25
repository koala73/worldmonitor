export const COUNTRY_SIGNAL_PATH = '/api/intelligence/v1/get-country-signal-observations';
export const COUNTRY_SIGNAL_BYTES = 131072;
export const COUNTRY_SIGNAL_FAMILIES = ['outages', 'unrest', 'fires', 'radiation', 'sanctions', 'conflict', 'posture'] as const;
export type CountrySignalFamily = typeof COUNTRY_SIGNAL_FAMILIES[number];
export const COUNTRY_SIGNAL_WIRE_FAMILIES = ['COUNTRY_SIGNAL_FAMILY_OUTAGES', 'COUNTRY_SIGNAL_FAMILY_UNREST', 'COUNTRY_SIGNAL_FAMILY_FIRES', 'COUNTRY_SIGNAL_FAMILY_RADIATION', 'COUNTRY_SIGNAL_FAMILY_SANCTIONS', 'COUNTRY_SIGNAL_FAMILY_CONFLICT', 'COUNTRY_SIGNAL_FAMILY_POSTURE', 'COUNTRY_SIGNAL_FAMILY_FLIGHT_PAGE'] as const;
