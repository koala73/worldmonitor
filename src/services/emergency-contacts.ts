/**
 * Emergency contacts and resource links by country and hazard type
 *
 * Static lookup table: country ISO code → emergency management agency,
 * emergency phone numbers, official disaster info portal, and
 * hazard-specific resources.
 *
 * Used by the emergency brief to surface actionable contact info
 * alongside monitoring data — knowing that a disaster is happening
 * is only useful if you also know who to call.
 */

export interface EmergencyAgency {
  name: string;
  url: string;
  alertsUrl?: string;       // official public alert page
  shelterFinderUrl?: string;
  donateUrl?: string;
}

export interface CountryEmergencyInfo {
  iso2: string;
  countryName: string;
  emergencyNumber: string;   // general emergency (like 911)
  policeNumber?: string;
  fireNumber?: string;
  ambulanceNumber?: string;
  agency: EmergencyAgency;
  redCrossUrl?: string;
  hazardSpecific?: Partial<Record<HazardResourceType, string>>;
}

export type HazardResourceType =
  | 'flood'
  | 'earthquake'
  | 'hurricane'
  | 'wildfire'
  | 'nuclear'
  | 'chemical'
  | 'tsunami'
  | 'shelter';

const EMERGENCY_DIRECTORY: Record<string, CountryEmergencyInfo> = {
  US: {
    iso2: 'US',
    countryName: 'United States',
    emergencyNumber: '911',
    agency: {
      name: 'FEMA',
      url: 'https://www.fema.gov',
      alertsUrl: 'https://www.fema.gov/emergency',
      shelterFinderUrl: 'https://www.redcross.org/get-help/disaster-relief-and-recovery-services/find-an-open-shelter.html',
      donateUrl: 'https://www.redcross.org/donate',
    },
    redCrossUrl: 'https://www.redcross.org',
    hazardSpecific: {
      flood: 'https://www.weather.gov/safety/flood',
      earthquake: 'https://earthquake.usgs.gov/earthquakes/events/',
      hurricane: 'https://www.nhc.noaa.gov',
      wildfire: 'https://inciweb.wildfire.gov',
      nuclear: 'https://www.nrc.gov/about-nrc/emerg-preparedness/emergency-info.html',
      chemical: 'https://www.epa.gov/emergency-response',
      tsunami: 'https://www.tsunami.gov',
      shelter: 'https://www.fema.gov/disaster/recover/shelter',
    },
  },
  GB: {
    iso2: 'GB',
    countryName: 'United Kingdom',
    emergencyNumber: '999',
    agency: {
      name: 'Cabinet Office Emergency Briefing Room',
      url: 'https://www.gov.uk/government/organisations/civil-contingencies-secretariat',
      alertsUrl: 'https://www.gov.uk/alerts',
    },
    redCrossUrl: 'https://www.redcross.org.uk',
    hazardSpecific: { flood: 'https://www.gov.uk/check-flooding', wildfire: 'https://www.gov.uk/guidance/wildfire-suppression' },
  },
  CA: {
    iso2: 'CA',
    countryName: 'Canada',
    emergencyNumber: '911',
    agency: { name: 'Public Safety Canada', url: 'https://www.publicsafety.gc.ca', alertsUrl: 'https://www.getprepared.gc.ca' },
    redCrossUrl: 'https://www.redcross.ca',
    hazardSpecific: { wildfire: 'https://ciffc.ca/firewx/summary', flood: 'https://www.canada.ca/en/environment-climate-change/services/water-overview/quantity/monitoring/flood-forecasting.html' },
  },
  AU: {
    iso2: 'AU',
    countryName: 'Australia',
    emergencyNumber: '000',
    agency: { name: 'Emergency Management Australia', url: 'https://www.homeaffairs.gov.au/emergency/ema', alertsUrl: 'https://www.abc.net.au/emergency' },
    redCrossUrl: 'https://www.redcross.org.au',
    hazardSpecific: { wildfire: 'https://www.rfs.nsw.gov.au', flood: 'https://www.bom.gov.au/australia/flood/' },
  },
  JP: {
    iso2: 'JP',
    countryName: 'Japan',
    emergencyNumber: '119',
    policeNumber: '110',
    agency: { name: 'Japan Meteorological Agency', url: 'https://www.jma.go.jp/jma/indexe.html', alertsUrl: 'https://www.jma.go.jp/en/warn/' },
    redCrossUrl: 'https://www.jrc.or.jp/english/',
    hazardSpecific: { earthquake: 'https://earthquake.usgs.gov/', tsunami: 'https://www.tsunami.gov', nuclear: 'https://www.nsr.go.jp/english/' },
  },
  IN: {
    iso2: 'IN',
    countryName: 'India',
    emergencyNumber: '112',
    agency: { name: 'National Disaster Management Authority', url: 'https://ndma.gov.in', alertsUrl: 'https://imd.gov.in' },
    redCrossUrl: 'https://www.indianredcross.org',
    hazardSpecific: { flood: 'https://cpcb.nic.in', cyclone: 'https://imd.gov.in/pages/cyclone_main.php' } as Partial<Record<HazardResourceType, string>>,
  },
  PH: {
    iso2: 'PH',
    countryName: 'Philippines',
    emergencyNumber: '911',
    agency: { name: 'NDRRMC', url: 'https://ndrrmc.gov.ph', alertsUrl: 'https://bagong.pagasa.dost.gov.ph' },
    redCrossUrl: 'https://www.redcross.org.ph',
    hazardSpecific: { hurricane: 'https://bagong.pagasa.dost.gov.ph/tropical-cyclone' },
  },
  ID: {
    iso2: 'ID',
    countryName: 'Indonesia',
    emergencyNumber: '112',
    agency: { name: 'BNPB', url: 'https://www.bnpb.go.id', alertsUrl: 'https://inatews.bmkg.go.id' },
    redCrossUrl: 'https://www.pmi.or.id',
    hazardSpecific: { tsunami: 'https://inatews.bmkg.go.id', earthquake: 'https://bmkg.go.id' },
  },
  MX: {
    iso2: 'MX',
    countryName: 'Mexico',
    emergencyNumber: '911',
    agency: { name: 'CENAPRED', url: 'https://www.cenapred.unam.mx', alertsUrl: 'https://www.smn.conagua.gob.mx' },
    redCrossUrl: 'https://www.cruzrojamexicana.org.mx',
    hazardSpecific: { hurricane: 'https://www.smn.conagua.gob.mx/es/ciclones-tropicales', earthquake: 'http://www.ssn.unam.mx' },
  },
  DE: {
    iso2: 'DE',
    countryName: 'Germany',
    emergencyNumber: '112',
    agency: { name: 'BBK (Federal Office of Civil Protection)', url: 'https://www.bbk.bund.de', alertsUrl: 'https://warnung.bund.de' },
    redCrossUrl: 'https://www.drk.de',
    hazardSpecific: { flood: 'https://www.hochwasserzentralen.de' },
  },
  FR: {
    iso2: 'FR',
    countryName: 'France',
    emergencyNumber: '112',
    agency: { name: 'Météo-France / Préfectures', url: 'https://vigilance.meteofrance.fr', alertsUrl: 'https://www.gouvernement.fr/risques' },
    redCrossUrl: 'https://www.croix-rouge.fr',
  },
  BR: {
    iso2: 'BR',
    countryName: 'Brazil',
    emergencyNumber: '193',
    policeNumber: '190',
    ambulanceNumber: '192',
    agency: { name: 'CEMADEN', url: 'https://cemaden.gov.br', alertsUrl: 'https://www.inmet.gov.br' },
    redCrossUrl: 'https://www.cruzvermelha.org.br',
  },
  UA: {
    iso2: 'UA',
    countryName: 'Ukraine',
    emergencyNumber: '112',
    agency: { name: 'DSNS Ukraine', url: 'https://dsns.gov.ua', alertsUrl: 'https://www.ukrhydromet.com.ua' },
    redCrossUrl: 'https://redcross.org.ua',
  },
  TR: {
    iso2: 'TR',
    countryName: 'Turkey',
    emergencyNumber: '112',
    agency: { name: 'AFAD', url: 'https://www.afad.gov.tr', alertsUrl: 'https://www.afad.gov.tr/deprem' },
    redCrossUrl: 'https://www.kizilay.org.tr',
    hazardSpecific: { earthquake: 'http://www.koeri.boun.edu.tr/scripts/lasteq.asp' },
  },
  NZ: {
    iso2: 'NZ',
    countryName: 'New Zealand',
    emergencyNumber: '111',
    agency: { name: 'NEMA', url: 'https://www.nema.govt.nz', alertsUrl: 'https://alerts.metservice.com' },
    redCrossUrl: 'https://www.redcross.org.nz',
    hazardSpecific: { earthquake: 'https://www.geonet.org.nz', tsunami: 'https://www.tsunami.gov' },
  },
};

// Global fallback
const GLOBAL_FALLBACK: CountryEmergencyInfo = {
  iso2: 'XX',
  countryName: 'Global',
  emergencyNumber: '112',
  agency: {
    name: 'OCHA (UN Office for Coordination of Humanitarian Affairs)',
    url: 'https://www.unocha.org',
    alertsUrl: 'https://reliefweb.int',
    donateUrl: 'https://www.ifrc.org/donate',
  },
  redCrossUrl: 'https://www.ifrc.org',
  hazardSpecific: {
    earthquake: 'https://earthquake.usgs.gov',
    tsunami: 'https://www.tsunami.gov',
    hurricane: 'https://www.nhc.noaa.gov',
    nuclear: 'https://www.iaea.org',
    chemical: 'https://www.unep.org/explore-topics/disasters-conflicts',
    shelter: 'https://www.unhcr.org/emergency',
    flood: 'https://www.gdacs.org',
    wildfire: 'https://inciweb.wildfire.gov',
  },
};

export function getEmergencyInfo(iso2: string): CountryEmergencyInfo {
  return EMERGENCY_DIRECTORY[iso2.toUpperCase()] ?? GLOBAL_FALLBACK;
}

export function getHazardResourceUrl(iso2: string, hazard: HazardResourceType): string | null {
  const info = getEmergencyInfo(iso2);
  return info.hazardSpecific?.[hazard] ?? GLOBAL_FALLBACK.hazardSpecific?.[hazard] ?? null;
}

export function getAllCountryCodes(): string[] {
  return Object.keys(EMERGENCY_DIRECTORY);
}

export function searchEmergencyInfo(query: string): CountryEmergencyInfo[] {
  const q = query.toLowerCase();
  return Object.values(EMERGENCY_DIRECTORY).filter(
    info =>
      info.countryName.toLowerCase().includes(q) ||
      info.iso2.toLowerCase().includes(q) ||
      info.agency.name.toLowerCase().includes(q)
  );
}
