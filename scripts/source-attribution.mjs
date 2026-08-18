#!/usr/bin/env node
/**
 * Source attribution inventory.
 *
 * The runtime source tree is the authority for which source hosts are used.
 * The committed manifest supplies the human-facing provider name,
 * license posture, and required credit for each discovered host.  Keeping the
 * discovery pass deliberately lexical makes this gate runnable in a bare Node
 * checkout (and prevents a credentials-dependent import graph from becoming a
 * documentation check).
 */
import {
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST_PATH = 'shared/source-attribution-manifest.json';
const DOCS_PATH = 'docs/source-attribution.mdx';
// MDX comments, not HTML ones: Mintlify parses docs/source-attribution.mdx as MDX v3,
// which rejects `<!--` ("Unexpected character `!` before name") and fails the
// whole deployment. The markers are interpolated into RegExp below, and `{`,
// `*`, `}` are metacharacters, so every interpolation must go through
// escapeRegExp — writing them raw silently stops the generator finding its own
// block.
const BEGIN_MARKER = '{/* BEGIN GENERATED SOURCE ATTRIBUTION */}';
const END_MARKER = '{/* END GENERATED SOURCE ATTRIBUTION */}';
const MANIFEST_STATUSES = new Set(['terms-review', 'reviewed', 'excluded']);
const CREDIT_BEARING_STATUSES = new Set(['terms-review', 'reviewed']);
const ERROR_PRINT_LIMIT = 20;
const REGENERATE_HINT = 'run node scripts/source-attribution.mjs --write';
const REFERENCE_DISPLAY_LIMIT = 4;
const MANIFEST_KIND_RE = /^(?:structured|feed|operational-status)(?:\+(?:structured|feed|operational-status))*$/;
const LOGICAL_KIND_RE = /^(?:candidate|structured|feed|operational-status)(?:\+(?:structured|feed|operational-status))*$/;

const SOURCE_ROOTS = ['scripts', 'server', 'api', 'src'];
const SOURCE_EXTENSIONS = new Set(['.cjs', '.js', '.mjs', '.ts', '.tsx']);
const FEED_FILES = new Set([
  'src/config/feeds.ts',
  // LiveNewsPanel owns optional native-video HLS feeds. They are observed for
  // completeness, but their playback transport is excluded from the data
  // provider count below.
  'src/components/LiveNewsPanel.ts',
  'server/worldmonitor/news/v1/_feeds.ts',
]);
const PRESENTATION_ONLY_FILES = new Set(['src/components/LiveNewsPanel.ts']);
const STATUS_FILE = 'server/worldmonitor/infrastructure/v1/list-service-statuses.ts';

// URL literals are intentionally parsed before classification.  This catches
// both quoted URLs and template literals such as the CFTC dataset endpoint.
const URL_LITERAL_RE = /https?:\/\/[A-Za-z0-9][A-Za-z0-9.-]*(?::\d+)?(?:\/[^\s"'`<>)}\]]*)?/gi;
const SOURCE_HINT_RE = /\b(?:fetch\w*|new\s+URL|axios|rss|feed|statusPage|endpoint|dataUrl|downloadUrl|csvUrl)\b|(?:\b(?:url|base|endpoint)\s*[:=])|(?:\b[A-Z][A-Z0-9_]*(?:URL|BASE|ENDPOINT|FEED|SOURCE|HOST|API)[A-Z0-9_]*\s*=)/i;
// Uppercase URL constants do not always carry a semantic suffix (for example
// BASE_V2), so retain the declaration context separately from the narrower
// source-hint matcher. This keeps the lexical pass fail-closed for fetched
// hosts without treating every ordinary string literal as an upstream source.
const DECLARATION_RE = /\b(?:const|let|var)\s+[A-Z][A-Z0-9_]*\s*=\s*$/;

const licensedPublisherFeed = (provider) => ({
  provider,
  license: 'Licensed publisher content; redistribution governed by the World Monitor agreement',
  attribution: `Credit ${provider} and link to the original item.`,
  status: 'reviewed',
});

const publisherMetadataFeed = (provider) => ({
  provider,
  license: 'Publisher-provided feed or Google News link metadata; ingest is limited to headlines, summaries, timestamps, publisher credit, and link-out',
  attribution: `Credit ${provider} and link to the original publisher item.`,
  status: 'reviewed',
});

/**
 * A provider identity is allowed to span multiple hosts only when the grouping
 * is declared here. The stable key is for review history; the display provider
 * remains the manifest/catalog identity. Host retirement does not delete a
 * member from this declaration, so a source lifecycle change cannot silently
 * become a provider rename or regroup.
 */
export const PROVIDER_IDENTITY_GROUPS = Object.freeze({
  'bc-evacuation-orders-alerts': Object.freeze({
    provider: 'B.C. Evacuation Orders and Alerts',
    memberHosts: Object.freeze(['catalogue.data.gov.bc.ca', 'services6.arcgis.com']),
    reason: 'The B.C. catalogue record supplies the licence for the ArcGIS evacuation dataset.',
    reviewReference: 'Issue #6659 source-rights probe',
  }),
  interfax: Object.freeze({
    provider: 'Interfax',
    memberHosts: Object.freeze(['interfax.com', 'www.interfax.ru']),
    reason: 'The English publisher host and the direct feed host belong to one Interfax provider identity.',
    reviewReference: 'PR #6840 follow-up',
  }),
  'opensky-network': Object.freeze({
    provider: 'opensky-network.org',
    memberHosts: Object.freeze(['auth.opensky-network.org', 'opensky-network.org']),
    reason: 'The authentication and product hosts belong to one OpenSky Network provider identity.',
    reviewReference: 'PR #6717',
  }),
  'our-world-in-data': Object.freeze({
    provider: 'Our World in Data',
    memberHosts: Object.freeze(['ourworldindata.org', 'owid-public.owid.io']),
    reason: 'The public data host and dataset landing host belong to one Our World in Data provider identity.',
    reviewReference: 'PR #6250',
  }),
  'uspto-open-data': Object.freeze({
    provider: 'USPTO Open Data Portal',
    memberHosts: Object.freeze(['api.uspto.gov', 'data.uspto.gov']),
    reason: 'The two official USPTO data hosts belong to one Open Data Portal provider identity.',
    reviewReference: 'PR #6250',
  }),
  wingbits: Object.freeze({
    provider: 'wingbits.com',
    memberHosts: Object.freeze(['customer-api.wingbits.com', 'ecs-api.wingbits.com', 'wingbits.com']),
    reason: 'The customer and ECS API hosts and excluded product link belong to one Wingbits provider identity.',
    reviewReference: 'PR #6717',
  }),
});

const PROVIDER_OVERRIDES = {
  'api.adsb.lol': { provider: 'adsb.lol' },
  'api.airplanes.live': { provider: 'airplanes.live' },
  'api.worldbank.org': {
    provider: 'World Bank Open Data',
    license: 'World Development Indicators are licensed under CC BY 4.0. UNESCO UIS indicators mirrored through WDI also require the UIS attribution stated in the public source documentation.',
    attribution: 'World Bank Open Data. For education indicators: UNESCO Institute for Statistics via World Bank WDI; include the UIS source URL and extraction date.',
    status: 'reviewed',
  },
  'api.x.com': { provider: 'X API' },
  'atbackend.sipri.org': { provider: 'SIPRI Arms Transfers Database' },
  'opendata.adsb.fi': { provider: 'adsb.fi Open Data' },
  'population.un.org': {
    provider: 'United Nations Population Division',
    license: 'UN World Population Prospects 2024 is licensed under CC BY 3.0 IGO.',
    attribution: 'United Nations, Department of Economic and Social Affairs, Population Division (2024). World Population Prospects 2024.',
    status: 'reviewed',
  },
  'sdmx.ilo.org': {
    provider: 'ILOSTAT',
    license: 'ILOSTAT datasets and metadata published from 3 May 2023 are licensed under CC BY 4.0.',
    attribution: 'International Labour Organization, ILOSTAT database; include the dataset and extraction date.',
    status: 'reviewed',
  },
  'auth.opensky-network.org': { provider: 'opensky-network.org', identityGroup: 'opensky-network' },
  'opensky-network.org': { provider: 'opensky-network.org', identityGroup: 'opensky-network' },
  'customer-api.wingbits.com': { provider: 'wingbits.com', identityGroup: 'wingbits' },
  'ecs-api.wingbits.com': { provider: 'wingbits.com', identityGroup: 'wingbits' },
  'wingbits.com': {
    provider: 'wingbits.com',
    identityGroup: 'wingbits',
    license: 'Excluded: first-party, control-plane, UI, or rendering transport',
    attribution: 'Excluded from the external-provider count: not an ingested upstream dataset.',
    status: 'excluded',
  },
  'moxie.foxbusiness.com': licensedPublisherFeed('Fox Business'),
  'www.wired.com': licensedPublisherFeed('Wired'),
  'www.businessinsider.com': licensedPublisherFeed('Business Insider'),
  'www.handelsblatt.com': licensedPublisherFeed('Handelsblatt'),
  'www.welt.de': licensedPublisherFeed('Welt'),
  'www.telegraph.co.uk': licensedPublisherFeed('The Telegraph'),
  'www.globenewswire.com': licensedPublisherFeed('GlobeNewswire'),
  'feed.businesswire.com': licensedPublisherFeed('Business Wire'),
  'chainwire.org': licensedPublisherFeed('Chainwire'),
  'www.interfax.ru': { ...licensedPublisherFeed('Interfax'), identityGroup: 'interfax' },
  'interfax.com': { ...licensedPublisherFeed('Interfax'), identityGroup: 'interfax' },
  'prnewswire.com': licensedPublisherFeed('PR Newswire'),
  'coinbase.com': licensedPublisherFeed('Coinbase'),
  'binance.com': licensedPublisherFeed('Binance'),
  'jin10.com': licensedPublisherFeed('Jin10'),
  'yemenonline.info': publisherMetadataFeed('Yemen Online'),
  'sanaacenter.org': publisherMetadataFeed("Sana'a Center"),
  'syriadirect.org': publisherMetadataFeed('Syria Direct'),
  'english.enabbaladi.net': publisherMetadataFeed('Enab Baladi English'),
  'www.972mag.com': publisherMetadataFeed('+972 Magazine'),
  'english.wafa.ps': publisherMetadataFeed('WAFA English'),
  'www.haitilibre.com': publisherMetadataFeed('HaitiLibre English'),
  'ayibopost.com': publisherMetadataFeed('AyiboPost'),
  'amu.tv': publisherMetadataFeed('Amu TV'),
  'pajhwok.com': publisherMetadataFeed('Pajhwok Afghan News'),
  'www.naharnet.com': publisherMetadataFeed('Naharnet Lebanon'),
  'lorientlejour.com': publisherMetadataFeed("L'Orient Today"),
  'annahar.com': publisherMetadataFeed('Annahar'),
  'pap.pl': publisherMetadataFeed('PAP'),
  'wyborcza.pl': publisherMetadataFeed('Gazeta Wyborcza'),
  'polityka.pl': publisherMetadataFeed('Polityka'),
  'wiadomosci.onet.pl': publisherMetadataFeed('Onet'),
  'oko.press': publisherMetadataFeed('OKO.press'),
  'tvp.info': publisherMetadataFeed('TVP Info'),
  'www.studiotamani.org': publisherMetadataFeed('Studio Tamani'),
  'lefaso.net': publisherMetadataFeed('leFaso.net'),
  'actuniger.com': publisherMetadataFeed('ActuNiger'),
  'airinfoagadez.com': publisherMetadataFeed('Aïr Info'),
  'www.caracaschronicles.com': publisherMetadataFeed('Caracas Chronicles'),
  'efectococuyo.com': publisherMetadataFeed('Efecto Cocuyo'),
  'havanatimes.org': publisherMetadataFeed('Havana Times'),
  'www.14ymedio.com': publisherMetadataFeed('14ymedio'),
  'libyaherald.com': publisherMetadataFeed('Libya Herald'),
  'www.egyptindependent.com': publisherMetadataFeed('Egypt Independent'),
  'madamasr.com': publisherMetadataFeed('Mada Masr'),
  'thedailystar.net': publisherMetadataFeed('The Daily Star'),
  'dhakatribune.com': publisherMetadataFeed('Dhaka Tribune'),
  'nation.africa': publisherMetadataFeed('Daily Nation'),
  'theguardianpostcameroon.com': publisherMetadataFeed('The Guardian Post'),
  'tchadinfos.com': publisherMetadataFeed('Tchadinfos'),
  'www.alwihdainfo.com': publisherMetadataFeed('Alwihda Info'),
  'www.radiondekeluka.org': publisherMetadataFeed('Radio Ndeke Luka'),
  'ustr.gov': {
    provider: 'Office of the U.S. Trade Representative',
    license: 'U.S. government public information; site and document-specific notices apply',
    attribution: 'Office of the U.S. Trade Representative; link to the original release.',
    status: 'reviewed',
  },
  '511on.ca': {
    provider: 'Ontario 511',
    license: 'Ontario 511 API terms; Government of Ontario data; attribution required',
    attribution: 'Ontario 511 (Ministry of Transportation). https://511on.ca/',
    status: 'terms-review',
  },
  '511.alberta.ca': {
    provider: 'Alberta 511',
    license: 'Alberta 511 terms (https://511.alberta.ca/about/about): non-commercial/educational reproduction allowed; commercial reproduction needs written permission from Alberta Transportation and Economic Corridors. https://511.alberta.ca/help/terms returned 404.',
    attribution: 'Alberta 511 (Alberta Transportation and Economic Corridors). https://511.alberta.ca/',
    status: 'terms-review',
  },
  'www.manitoba511.ca': {
    provider: 'Manitoba 511',
    license: 'Contains information from the Government of Manitoba, licensed under the OpenMB Information and Data Use License (Manitoba.ca/OpenMB). Manitoba 511 developer copy permits creating traffic apps; no separate developer access agreement is published.',
    attribution: 'Manitoba 511 (Government of Manitoba). Contains information from the Government of Manitoba, licensed under the OpenMB Information and Data Use License. https://www.manitoba511.ca/',
    status: 'terms-review',
  },
  'secure.toronto.ca': {
    provider: 'City of Toronto Open Data',
    license: 'CKAN package_show for road-restrictions: license_id=notspecified, license_title="License not specified" (https://ckan0.cf.opendata.inter.prod-toronto.ca/api/3/action/package_show?id=road-restrictions). Portal dataset page chrome links OGL-Toronto but is not data-bound to this dataset.',
    attribution: 'City of Toronto, Road Restrictions. https://open.toronto.ca/dataset/road-restrictions/',
    status: 'terms-review',
  },
  'api.open511.gov.bc.ca': {
    provider: 'BC Open511',
    license: 'Open Government Licence - British Columbia (OGL-BC). Confirmed on https://api.open511.gov.bc.ca/help. API Terms of Use for OGL-BC information also apply.',
    attribution: 'DriveBC Open511 (Province of British Columbia). Licensed under OGL-BC. https://api.open511.gov.bc.ca/help',
    status: 'reviewed',
  },
  'catalogue.data.gov.bc.ca': {
    provider: 'B.C. Evacuation Orders and Alerts',
    identityGroup: 'bc-evacuation-orders-alerts',
    license: 'Open Government Licence - British Columbia (OGL-BC). The B.C. Data Catalogue record 7efd46d0-b5d3-4dff-af80-d376c42aec33 explicitly assigns OGL-BC to this ArcGIS layer.',
    attribution: 'Contains information licensed under the Open Government Licence - British Columbia. https://catalogue.data.gov.bc.ca/dataset/7efd46d0-b5d3-4dff-af80-d376c42aec33',
    status: 'reviewed',
  },
  'services6.arcgis.com': {
    provider: 'B.C. Evacuation Orders and Alerts',
    identityGroup: 'bc-evacuation-orders-alerts',
    license: 'Open Government Licence - British Columbia (OGL-BC). The B.C. Data Catalogue record 7efd46d0-b5d3-4dff-af80-d376c42aec33 explicitly assigns OGL-BC to this ArcGIS layer.',
    attribution: 'Contains information licensed under the Open Government Licence - British Columbia. https://catalogue.data.gov.bc.ca/dataset/7efd46d0-b5d3-4dff-af80-d376c42aec33',
    status: 'reviewed',
  },
  'www.alberta.ca': {
    provider: 'Alberta Emergency Alert',
    license: 'Alberta.ca terms of use. Open Government Licence - Alberta exists on the open.alberta.ca licence page but is not bound to the AEA Atom feed on a live dataset page (the alberta-emergency-alert.aspx page has no OGL statement).',
    attribution: 'Alberta Emergency Alert, Government of Alberta. https://www.alberta.ca/alberta-emergency-alert.aspx',
    status: 'terms-review',
  },
  'emergencyalert.saskatchewan.ca': {
    provider: 'SaskAlert',
    license: 'Public SaskAlert mobile JSON at /sapublic/feed.json plus same-host CAP 1.2 JSON details. Government of Saskatchewan website terms exclude some connected subsites; this host is the official public alert feed authorized for canadaAlerts ingest under #6659. Not Pelmorex LMD.',
    attribution: 'SaskAlert, Government of Saskatchewan. https://emergencyalert.saskatchewan.ca/',
    status: 'terms-review',
  },
  'api.elections.kalshi.com': {
    provider: 'Kalshi',
    license: 'Kalshi API terms; commercial-use and redistribution terms require review',
    attribution: 'Kalshi prediction markets; link to the relevant market/API response.',
    status: 'terms-review',
  },
  'api.hyperliquid.xyz': {
    provider: 'Hyperliquid',
    license: 'Hyperliquid API terms',
    attribution: 'Hyperliquid; link to the relevant market/API response.',
    status: 'terms-review',
  },
  'apps.fas.usda.gov': {
    provider: 'USDA FAS PSD',
    license: 'U.S. government public-domain PSD Open Data',
    attribution: 'USDA Foreign Agricultural Service, Production, Supply and Distribution (PSD).',
    status: 'reviewed',
  },
  'api.fas.usda.gov': {
    provider: 'USDA FAS PSD',
    license: 'U.S. government public-domain PSD Open Data',
    attribution: 'USDA Foreign Agricultural Service, Production, Supply and Distribution (PSD).',
    status: 'reviewed',
  },
  'fenixservices.fao.org': {
    provider: 'FAOSTAT',
    license: 'FAOSTAT CC-BY; attribution to FAO required',
    attribution: 'FAO. FAOSTAT. https://www.fao.org/faostat/',
    status: 'reviewed',
  },
  'publicreporting.cftc.gov': {
    provider: 'CFTC Commitments of Traders',
    license: 'U.S. government public data; endpoint terms apply',
    attribution: 'U.S. Commodity Futures Trading Commission (CFTC), Commitments of Traders.',
    status: 'reviewed',
  },
  'www.sciencebase.gov': {
    provider: 'USGS ScienceBase (Mineral Commodity Summaries)',
    license: 'U.S. government public-domain mineral statistics (USGS MCS data release)',
    attribution: 'U.S. Geological Survey Mineral Commodity Summaries; link to the ScienceBase data release (https://doi.org/10.5066/P1WKQ63T).',
    status: 'reviewed',
  },
  'geoserver.cwfif.nrcan.gc.ca': {
    provider: 'CWFIS / CWFIF (NRCan)',
    license: 'Open Government Licence - Canada; redistribution granted (copy, modify, publish, distribute, including commercial use) with attribution',
    attribution: 'Canadian Forest Service. Canadian Wildland Fire Information System (CWFIS), Natural Resources Canada, Canadian Forest Service, Northern Forestry Centre, Edmonton, Alberta. https://cwfis.cfs.nrcan.gc.ca. Contains information licensed under the Open Government Licence – Canada (https://open.canada.ca/en/open-government-licence-canada). Evidence: https://cwfis.cfs.nrcan.gc.ca/downloads/licence.txt',
    status: 'reviewed',
  },
  'openmaps.gov.bc.ca': {
    provider: 'BC Wildfire Service (OpenMaps)',
    license: 'Open Government Licence - British Columbia; redistribution granted (copy, modify, publish, distribute, including commercial use) with attribution',
    attribution: 'Contains information licensed under the Open Government Licence – British Columbia. BC Wildfire Service, Current Fire Locations (PROT_CURRENT_FIRE_PNTS_SP), Government of British Columbia. https://catalogue.data.gov.bc.ca/dataset/bc-wildfire-fire-locations-current. Evidence: https://www2.gov.bc.ca/gov/content/data/policy-standards/data-policies/open-data/open-government-licence-bc and https://open.canada.ca/data/en/dataset/2790e3f7-6395-4230-8545-04efb5a18800',
    status: 'reviewed',
  },
  'www.earthquakescanada.nrcan.gc.ca': {
    provider: 'Earthquakes Canada (NRCan)',
    license: 'Earthquakes Canada citation terms; live Atom redistribution not explicitly granted (historical catalogues on the Open Government Portal are OGL-Canada)',
    attribution: 'Natural Resources Canada, Earthquakes Canada; link to https://www.earthquakescanada.nrcan.gc.ca/index-en.php?tpl_region=canada. Event-metadata citation: https://www.earthquakescanada.nrcan.gc.ca/cite-en.php',
    status: 'terms-review',
  },
  'ogcapi.bgs.ac.uk': {
    provider: 'British Geological Survey World Mineral Statistics',
    license: 'BGS mineral statistics terms; attribution required; redistribution restricted',
    attribution: 'British Geological Survey (BGS) World Mineral Production; credit BGS and link to https://www.bgs.ac.uk/mineralsuk/statistics/world-mineral-statistics/.',
    status: 'reviewed',
  },
  'feeds.finra.org': {
    provider: 'FINRA',
    license: 'FINRA feed terms',
    attribution: 'Financial Industry Regulatory Authority (FINRA); link to the original notice.',
    status: 'terms-review',
  },
  'data.sec.gov': {
    provider: 'SEC EDGAR',
    license: 'U.S. government public data; SEC terms apply',
    attribution: 'U.S. Securities and Exchange Commission (SEC) EDGAR.',
    status: 'reviewed',
  },
  'efts.sec.gov': {
    provider: 'SEC EDGAR Full-Text Search',
    license: 'U.S. government public data; SEC terms apply',
    attribution: 'U.S. Securities and Exchange Commission (SEC) EDGAR full-text search.',
    status: 'reviewed',
  },
  'www.sec.gov': {
    provider: 'SEC',
    license: 'U.S. government public data; SEC terms apply',
    attribution: 'U.S. Securities and Exchange Commission (SEC).',
    status: 'reviewed',
  },
  'api.uspto.gov': {
    provider: 'USPTO Open Data Portal',
    identityGroup: 'uspto-open-data',
    license: 'U.S. government public data; USPTO terms apply',
    attribution: 'U.S. Patent and Trademark Office (USPTO) Open Data Portal.',
    status: 'reviewed',
  },
  'data.uspto.gov': {
    provider: 'USPTO Open Data Portal',
    identityGroup: 'uspto-open-data',
    license: 'U.S. government public data; USPTO terms apply',
    attribution: 'U.S. Patent and Trademark Office (USPTO) Open Data.',
    status: 'reviewed',
  },
  'api.openaq.org': {
    provider: 'OpenAQ',
    license: 'CC BY 4.0 (dataset/API terms may vary by measurement source)',
    attribution: 'OpenAQ, https://openaq.org/.',
    status: 'reviewed',
  },
  'api.waqi.info': {
    provider: 'World Air Quality Index (WAQI)',
    license: 'WAQI API terms; attribution required',
    attribution: 'World Air Quality Index (WAQI); link to the station/API response.',
    status: 'terms-review',
  },
  'api.safecast.org': {
    provider: 'Safecast',
    license: 'Safecast data/API terms; verify dataset license by endpoint',
    attribution: 'Safecast; link to the measurement/API response.',
    status: 'terms-review',
  },
  'radnet.epa.gov': {
    provider: 'EPA RadNet',
    license: 'U.S. government public data; EPA terms apply',
    attribution: 'U.S. Environmental Protection Agency (EPA) RadNet.',
    status: 'reviewed',
  },
  'web-api.tp.entsoe.eu': {
    provider: 'ENTSO-E Transparency Platform',
    license: 'ENTSO-E Transparency Platform terms',
    attribution: 'ENTSO-E Transparency Platform; link to the returned dataset.',
    status: 'terms-review',
  },
  'storage.googleapis.com': {
    provider: 'Ember electricity data',
    license: 'CC BY 4.0 (Ember dataset)',
    attribution: 'Ember; link to the Ember dataset and preserve its license notice.',
    status: 'reviewed',
  },
  'ourworldindata.org': {
    provider: 'Our World in Data',
    identityGroup: 'our-world-in-data',
    license: 'CC BY 4.0 for the dataset unless the dataset page states otherwise',
    attribution: 'Our World in Data; link to the dataset page.',
    status: 'reviewed',
  },
  'owid-public.owid.io': {
    provider: 'Our World in Data',
    identityGroup: 'our-world-in-data',
    license: 'CC BY 4.0 for the dataset unless the dataset page states otherwise',
    attribution: 'Our World in Data; link to the dataset page.',
    status: 'reviewed',
  },
  'globalenergymonitor.org': {
    provider: 'Global Energy Monitor',
    license: 'CC BY 4.0 for published datasets unless the dataset page states otherwise',
    attribution: 'Global Energy Monitor; link to the dataset page.',
    status: 'reviewed',
  },
  'gtfsrt.ttc.ca': {
    provider: 'Toronto Transit Commission (TTC) GTFS-RT',
    license: 'CKAN package_show for ttc-gtfs-realtime-gtfs-rt: license_id=notspecified, isopen=false (https://ckan0.cf.opendata.inter.prod-toronto.ca/api/3/action/package_show?id=ttc-gtfs-realtime-gtfs-rt). Portal dataset page chrome links OGL-Toronto but is not data-bound to this dataset.',
    attribution: 'Toronto Transit Commission GTFS-RT service alerts. https://gtfsrt.ttc.ca and https://open.toronto.ca/dataset/ttc-gtfs-realtime-gtfs-rt/. Portal HTML cites OGL-Toronto; CKAN does not.',
    status: 'terms-review',
  },
  'www.tenders.gov.au': {
    provider: 'AusTender',
    license: 'Australian Government data and feed terms',
    attribution: 'Australian Government AusTender; link to the original notice/feed.',
    status: 'terms-review',
  },
  'hdr.undp.org': {
    provider: 'UNDP Human Development Report',
    license: 'UNDP data terms; dataset-specific license applies',
    attribution: 'United Nations Development Programme (UNDP) Human Development Report.',
    status: 'terms-review',
  },
  'rsf.org': {
    provider: 'Reporters Without Borders (RSF)',
    license: 'RSF terms; attribution required',
    attribution: 'Reporters Without Borders (RSF) World Press Freedom Index.',
    status: 'terms-review',
  },
  'www.visionofhumanity.org': {
    provider: 'Vision of Humanity / Global Peace Index',
    license: 'Vision of Humanity terms; attribution required',
    attribution: 'Institute for Economics & Peace, Global Peace Index / Vision of Humanity.',
    status: 'terms-review',
  },
  'www.fatf-gafi.org': {
    provider: 'Financial Action Task Force (FATF)',
    license: 'FATF website and publication terms',
    attribution: 'Financial Action Task Force (FATF); link to the original publication.',
    status: 'terms-review',
  },
  'api.opensanctions.org': {
    provider: 'OpenSanctions',
    license: 'OpenSanctions terms; dataset-specific license varies by source',
    attribution: 'OpenSanctions; link to the matching entity/dataset.',
    status: 'terms-review',
  },
  'www.international.gc.ca': {
    provider: 'Global Affairs Canada (SEMA consolidated sanctions)',
    license: 'Government of Canada website terms; no explicit redistribution licence on the SEMA XML. Canada.ca terms restrict commercial reproduction unless otherwise specified. The Open Government Licence page on this host covers international-assistance open data sets, not this sanctions list.',
    attribution: 'Global Affairs Canada, Consolidated Canadian Autonomous Sanctions List; link to https://www.international.gc.ca/world-monde/international_relations-relations_internationales/sanctions/consolidated-consolide.aspx?lang=eng',
    status: 'terms-review',
  },
  'earth-search.aws.element84.com': {
    provider: 'Element84 Earth Search STAC',
    license: 'AWS Open Data and dataset-specific collection licenses',
    attribution: 'Element84 Earth Search; preserve the collection license and link to the item.',
    status: 'terms-review',
  },
  'www.submarinecablemap.com': {
    provider: 'TeleGeography Submarine Cable Map',
    license: 'TeleGeography proprietary/provider terms',
    attribution: 'TeleGeography Submarine Cable Map; link to the source map.',
    status: 'terms-review',
  },
  'api.firecrawl.dev': {
    provider: 'Firecrawl',
    license: 'Firecrawl API terms',
    attribution: 'Firecrawl; link to the retrieved source page.',
    status: 'terms-review',
  },
  'api.search.brave.com': {
    provider: 'Brave Search API',
    license: 'Brave Search API terms',
    attribution: 'Brave Search; link to the result and original publisher.',
    status: 'terms-review',
  },
  'serpapi.com': {
    provider: 'SerpAPI',
    license: 'SerpAPI terms',
    attribution: 'SerpAPI; link to the result and original publisher.',
    status: 'terms-review',
  },
  'api.coinpaprika.com': {
    provider: 'CoinPaprika',
    license: 'CoinPaprika API terms',
    attribution: 'CoinPaprika; link to the market/API response.',
    status: 'terms-review',
  },
  'www.barchart.com': {
    provider: 'Barchart',
    license: 'Barchart terms; redistribution requires review',
    attribution: 'Barchart; link to the source quote or page.',
    status: 'terms-review',
  },
  'www.bankofcanada.ca': {
    provider: 'Bank of Canada',
    license: 'Bank of Canada Terms of Use — permission to freely use, copy, distribute and transmit website content with attribution (https://www.bankofcanada.ca/terms/)',
    attribution: 'Bank of Canada Valet API; link to https://www.bankofcanada.ca/valet/ and the Terms of Use at https://www.bankofcanada.ca/terms/.',
    status: 'reviewed',
  },
  'www150.statcan.gc.ca': {
    provider: 'Statistics Canada',
    license: 'Statistics Canada Open Licence (Open Government Licence — Canada); use, reproduce, publish, freely distribute or sell with attribution (https://www.statcan.gc.ca/en/terms-conditions/open-licence)',
    attribution: 'Statistics Canada. Web Data Service. https://www.statcan.gc.ca/en/developers/wds/user-guide',
    status: 'reviewed',
  },
  'api.reliefweb.int': {
    provider: 'ReliefWeb (UN OCHA)',
    license: 'UN OCHA/ReliefWeb terms',
    attribution: 'ReliefWeb, United Nations Office for the Coordination of Humanitarian Affairs (OCHA).',
    status: 'terms-review',
  },
  'noaadata.apps.nsidc.org': {
    provider: 'NSIDC',
    license: 'U.S. government/public dataset terms; collection-specific license applies',
    attribution: 'National Snow and Ice Data Center (NSIDC); link to the dataset.',
    status: 'terms-review',
  },
  'www.cftc.gov': {
    provider: 'CFTC public notices',
    license: 'U.S. government public data; CFTC terms apply',
    attribution: 'U.S. Commodity Futures Trading Commission (CFTC); link to the original notice/feed.',
    status: 'reviewed',
  },
  'api.alternative.me': {
    provider: 'Alternative.me Fear & Greed Index',
    license: 'Alternative.me API terms; attribution and redistribution require review',
    attribution: 'Alternative.me Crypto Fear & Greed Index; link to the API response and methodology.',
    status: 'terms-review',
  },
  'mempool.space': {
    provider: 'mempool.space',
    license: 'mempool.space API terms; underlying Bitcoin data is public but endpoint terms apply',
    attribution: 'mempool.space; link to the mining/hashrate API response.',
    status: 'terms-review',
  },
  'api.travelpayouts.com': {
    provider: 'Travelpayouts flight-price data',
    license: 'Travelpayouts API terms; commercial use and redistribution require review',
    attribution: 'Travelpayouts; link to the returned flight-price response.',
    status: 'terms-review',
  },
  'www.swfinstitute.org': {
    provider: 'SWF Institute',
    license: 'Provider terms; attribution and redistribution require review',
    attribution: 'SWF Institute; link to the source publication.',
    status: 'terms-review',
  },
  'www.ifswf.org': {
    provider: 'International Forum of Sovereign Wealth Funds',
    license: 'Provider terms; attribution and redistribution require review',
    attribution: 'International Forum of Sovereign Wealth Funds (IFSWF); link to the source.',
    status: 'terms-review',
  },
  'api.axiom.co': {
    provider: 'Axiom telemetry',
    license: 'Excluded: World Monitor operational telemetry, not an external data provider',
    attribution: 'Excluded from the provider count: internal usage telemetry.',
    status: 'excluded',
  },
  'api.clerk.com': {
    provider: 'Clerk identity service',
    license: 'Excluded: authentication/control-plane service',
    attribution: 'Excluded from the provider count: identity-control-plane request.',
    status: 'excluded',
  },
  'api.resend.com': {
    provider: 'Resend email service',
    license: 'Excluded: transactional email/control-plane service',
    attribution: 'Excluded from the provider count: transactional email delivery.',
    status: 'excluded',
  },
  'browser.mcp.cloudflare.com': {
    provider: 'Cloudflare Browser MCP',
    license: 'Excluded: optional rendering/automation connector',
    attribution: 'Excluded from the provider count: user-configured MCP connector.',
    status: 'excluded',
  },
  'radar.mcp.cloudflare.com': {
    provider: 'Cloudflare Radar MCP',
    license: 'Excluded: optional user-configured MCP connector',
    attribution: 'Excluded from the provider count: user-configured MCP connector.',
    status: 'excluded',
  },
  'mcp.airtable.com': {
    provider: 'Airtable MCP',
    license: 'Excluded: optional user-configured MCP connector',
    attribution: 'Excluded from the provider count: user-configured MCP connector.',
    status: 'excluded',
  },
  'mcp.linear.app': {
    provider: 'Linear MCP',
    license: 'Excluded: optional user-configured MCP connector',
    attribution: 'Excluded from the provider count: user-configured MCP connector.',
    status: 'excluded',
  },
  'mcp.robtex.com': {
    provider: 'Robtex MCP',
    license: 'Excluded: optional user-configured MCP connector',
    attribution: 'Excluded from the provider count: user-configured MCP connector.',
    status: 'excluded',
  },
  'search.parallel.ai': {
    provider: 'Parallel Search MCP',
    license: 'Excluded: optional user-configured MCP connector',
    attribution: 'Excluded from the provider count: user-configured MCP connector.',
    status: 'excluded',
  },
  'api.example.com': {
    provider: 'Example API placeholder',
    license: 'Excluded: documentation/test placeholder',
    attribution: 'Excluded from the provider count: placeholder URL.',
    status: 'excluded',
  },
  'example.com': {
    provider: 'Example domain placeholder',
    license: 'Excluded: documentation/test placeholder',
    attribution: 'Excluded from the provider count: placeholder URL.',
    status: 'excluded',
  },
  'internal.example.com': {
    provider: 'Internal example placeholder',
    license: 'Excluded: documentation/test placeholder',
    attribution: 'Excluded from the provider count: placeholder URL.',
    status: 'excluded',
  },
  'localhost': {
    provider: 'Local development transport',
    license: 'Excluded: local development/test transport',
    attribution: 'Excluded from the provider count: local-only URL.',
    status: 'excluded',
  },
  '127.0.0.1': {
    provider: 'Local loopback transport',
    license: 'Excluded: local development/desktop transport',
    attribution: 'Excluded from the provider count: local-only loopback URL.',
    status: 'excluded',
  },
  'worldmonitor.invalid': {
    provider: 'WorldMonitor test origin',
    license: 'Excluded: test-only origin',
    attribution: 'Excluded from the provider count: test-only URL.',
    status: 'excluded',
  },
  'user': {
    provider: 'Proxy URL placeholder',
    license: 'Excluded: URL-format example',
    attribution: 'Excluded from the provider count: credentials placeholder.',
    status: 'excluded',
  },
  'api.worldmonitor.app': {
    provider: 'World Monitor hosted API',
    license: 'Excluded: World Monitor own service/control plane',
    attribution: 'Excluded from the external-provider count: first-party API endpoint.',
    status: 'excluded',
  },
  'proxy.worldmonitor.app': {
    provider: 'World Monitor proxy',
    license: 'Excluded: World Monitor own service/control plane',
    attribution: 'Excluded from the external-provider count: first-party proxy endpoint.',
    status: 'excluded',
  },
  'worldmonitor.app': {
    provider: 'World Monitor web app',
    license: 'Excluded: World Monitor own web application',
    attribution: 'Excluded from the external-provider count: first-party web origin.',
    status: 'excluded',
  },
  'www.worldmonitor.app': {
    provider: 'World Monitor web app',
    license: 'Excluded: World Monitor own web application',
    attribution: 'Excluded from the external-provider count: first-party web origin.',
    status: 'excluded',
  },
  'chatgpt.com': {
    provider: 'ChatGPT link',
    license: 'Excluded: documentation/UI link',
    attribution: 'Excluded from the provider count: UI link, not an ingested source.',
    status: 'excluded',
  },
  'claude.ai': {
    provider: 'Claude link',
    license: 'Excluded: documentation/UI link',
    attribution: 'Excluded from the provider count: UI link, not an ingested source.',
    status: 'excluded',
  },
  'claude.com': {
    provider: 'Claude link',
    license: 'Excluded: documentation/UI link',
    attribution: 'Excluded from the provider count: UI link, not an ingested source.',
    status: 'excluded',
  },
  'accounts.google.com': {
    provider: 'Google account sign-in',
    license: 'Excluded: authentication/UI link',
    attribution: 'Excluded from the provider count: user sign-in redirect, not an ingested source.',
    status: 'excluded',
  },
  'cdn.jsdelivr.net': {
    provider: 'jsDelivr asset CDN',
    license: 'Excluded: presentation asset/CDN',
    attribution: 'Excluded from the provider count: browser asset, not an ingested source.',
    status: 'excluded',
  },
  'purl.org': {
    provider: 'PURL namespace',
    license: 'Excluded: schema/namespace reference',
    attribution: 'Excluded from the provider count: namespace reference, not an ingested source.',
    status: 'excluded',
  },
  'api.weather.gc.ca': {
    provider: 'Environment and Climate Change Canada (ECCC)',
    license: 'ECCC Data Server End-use Licence; Government of Canada open data',
    attribution: 'Environment and Climate Change Canada (ECCC) weather alerts via MSC GeoMet (https://api.weather.gc.ca/).',
    status: 'reviewed',
  },
  'www.w3.org': {
    provider: 'W3C schema reference',
    license: 'Excluded: schema/standards reference',
    attribution: 'Excluded from the provider count: standards reference, not an ingested source.',
    status: 'excluded',
  },
  'tsimobile.viarail.ca': {
    provider: 'VIA Rail Tracker (unofficial)',
    license: 'VIA Rail Site Terms prohibit commercial use of the Site (https://www.viarail.ca/en/terms-and-conditions). Developer Resources publish GTFS only under Open Government Licence – Canada v2 (https://www.viarail.ca/en/developer-resources); that OGL grant does not cover tsimobile.viarail.ca unofficial live JSON. Terms require review.',
    attribution: 'VIA Rail Canada; unofficial live train JSON at tsimobile.viarail.ca. Not the Developer Resources GTFS feed; OGL does not apply to this host. Best-effort only.',
    status: 'terms-review',
  },
};

// Provider display identities change rarely and affect attribution, catalog
// grouping, and public provider totals. This review epoch makes any change to
// a provider-bearing override a separate, explicit lifecycle event instead of
// something `--write` can silently normalize into the manifest.
export const PROVIDER_IDENTITY_REVIEW = Object.freeze({
  sha256: '91ca746b314f3c0abf3bd5e2ba36fbf5ddc0d230d01a2242f27deac347283488',
  reason: 'Add the reviewed UN Population Division and ILOSTAT identities and replace the generic World Bank host identity with World Bank Open Data for the demographics capability stack, while retaining prior publisher identities.',
  // A URL cited here is scanned like any other: this file sits inside
  // SOURCE_ROOTS, so citing a host that is not already a registered source
  // invents a provider row for it. The B.C. catalogue URLs above are safe
  // because that host is itself an observed source; parallel.ai is not.
  reviewReference: 'Issue #6437 source-rights qualification; UN WPP 2024 data-source notice; World Bank WDI catalogue licence; UNESCO UIS Data Browser terms; ILO rights and permissions; plus the prior Issue #6622, Issue #6659, and PR #6447 identity reviews.',
});

export function providerIdentityDigest(providerOverrides = PROVIDER_OVERRIDES) {
  const identities = Object.entries(providerOverrides || {})
    .filter(([, override]) => typeof override?.provider === 'string')
    .map(([host, override]) => [host, override.provider])
    .sort(([left], [right]) => left.localeCompare(right));
  return createHash('sha256').update(JSON.stringify(identities)).digest('hex');
}

const LOGICAL_ENTRIES = [
  {
    provider: 'Fintraffic Digitraffic',
    host: 'not-currently-wired',
    kind: 'candidate',
    observed: false,
    license: 'Not applicable: no live fetch is present in this checkout',
    attribution: 'Excluded from the live-provider count: issue audit named Digitraffic, but no current source call was found.',
    status: 'excluded',
  },
];

// A few seeders build a URL from a classification/configuration document and
// therefore do not contain the provider host beside the eventual fetch call.
// Keep those dynamic hosts explicit so the lexical pass still provides a
// reviewable reference and the CI gate cannot silently drop them.  The file is
// pinned but the line deliberately is not: a line pin hard-fails the whole scan
// the moment an unrelated edit shifts it.
const DYNAMIC_HOSTS = [
  { host: 'www.swfinstitute.org', kind: 'structured', path: 'scripts/seed-sovereign-wealth.mjs' },
  { host: 'www.ifswf.org', kind: 'structured', path: 'scripts/seed-sovereign-wealth.mjs' },
  { host: 'www.visionofhumanity.org', kind: 'structured', path: 'scripts/seed-resilience-static.mjs' },
  { host: 'earth-search.aws.element84.com', kind: 'structured', path: 'server/worldmonitor/imagery/v1/search-imagery.ts' },
];

const EXCLUDED_HOSTS = new Set([
  'test',
  'test.dodopayments.com',
  'live.dodopayments.com',
  'customer.dodopayments.com',
  'worldmonitor.mintlify.dev',
  'discord.com',
  'discord.gg',
  'slack.com',
  'workos.com',
  'twitter.com',
  'x.com',
  'www.linkedin.com',
  'www.facebook.com',
  'wa.me',
  't.me',
  'reddit.com',
  'openrouter.ai',
  'api.groq.com',
  'tts.baidu.com',
  'api.indexnow.org',
  'data.worldbank.org',
  'jmespath.org',
  'site.financialmodelingprep.com',
  'web.cbr.ru',
  'search.seznam.cz',
  'searchadvisor.naver.com',
  'www.bing.com',
  'yandex.com',
  'cloudflare-dns.com',
  'challenges.cloudflare.com',
  // Browser presentation, telemetry, documentation, and namespace URLs are
  // observed for drift but are not ingested upstream datasets.
  'basemaps.cartocdn.com',
  'cdn.debugbear.com',
  'fonts.googleapis.com',
  'schemas.agentskills.io',
  'search.yahoo.com',
  'tiles.openfreemap.org',
  'webcams.windy.com',
  'openstreetmap.org',
  'protomaps.com',
  // Video-page URLs and embeds are presentation transport, not ingested
  // upstream datasets; keep them out of the provider count like native HLS.
  'www.youtube.com',
  // Release links, documentation links, and repository links are control/UI
  // surfaces; GitHub API and raw-content hosts remain tracked separately.
  'github.com',
  // Provider landing-page link in MapPopup; the ingested Wingbits endpoints
  // are tracked as customer-api.wingbits.com and ecs-api.wingbits.com.
  'wingbits.com',
]);

function read(rootDir, path) {
  return readFileSync(join(rootDir, path), 'utf8');
}

function readdirPresentSync(absoluteDir) {
  try {
    return readdirSync(absoluteDir, { withFileTypes: true });
  } catch (error) {
    // Parallel test:data can mkdir/rm empty leftover trees under api/ (see
    // tests/docs-stats-api-endpoints.test.mts) while docs-stats --check walks
    // SOURCE_ROOTS. A vanished directory is not an inventory finding.
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return [];
    throw error;
  }
}

function walkSourceFiles(rootDir) {
  const files = [];
  const visit = (relativeDir) => {
    const absoluteDir = join(rootDir, relativeDir);
    for (const entry of readdirPresentSync(absoluteDir)) {
      const relativePath = join(relativeDir, entry.name).replaceAll('\\', '/');
      if (entry.isDirectory()) {
        if (['node_modules', '.git', 'generated', 'e2e', 'fixtures', '__fixtures__', 'test', 'tests'].includes(entry.name)) continue;
        visit(relativePath);
      } else if (SOURCE_EXTENSIONS.has(extname(entry.name)) && !/\.(test|spec)\./.test(entry.name)) {
        files.push(relativePath);
      }
    }
  };
  for (const root of SOURCE_ROOTS) visit(root);
  return files.sort();
}

function hostFromUrl(raw) {
  const match = raw.match(/^https?:\/\/([^/?#"'`<>)}\]]+)/i);
  if (!match) return null;
  const host = match[1].replace(/:\d+$/, '').toLowerCase();
  if (!host || host.length < 3 || host.includes('${') || host.includes('[') || host.includes(']') || host.includes('{')) return null;
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host)) return null;
  return host;
}

function googleNewsPublisherHosts(query) {
  let decoded;
  try {
    decoded = decodeURIComponent(String(query || '').replaceAll('+', ' '));
  } catch {
    decoded = String(query || '').replaceAll('+', ' ');
  }
  const hosts = new Set();
  for (const match of decoded.matchAll(/\bsite:([a-z0-9.-]+)(?:\/[^\s"'`)]+)?/gi)) {
    const host = hostFromUrl(`https://${match[1]}`);
    if (host) hosts.add(host);
  }
  return [...hosts];
}

export function scanUpstreamHosts(rootDir = ROOT) {
  const hosts = new Map();
  // References are recorded per file, never per line. A line number is not part
  // of the attribution (which records license posture and required credit), and
  // pinning one made every unrelated edit rewrite the committed manifest.
  const recordHost = (host, kind, path) => {
    const current = hosts.get(host) || { host, kinds: new Set(), references: [] };
    current.kinds.add(kind);
    if (!current.references.some((reference) => reference.path === path)) current.references.push({ path });
    hosts.set(host, current);
  };
  for (const relativePath of walkSourceFiles(rootDir)) {
    const source = read(rootDir, relativePath);
    const lineStarts = [0];
    for (let offset = source.indexOf('\n'); offset !== -1; offset = source.indexOf('\n', offset + 1)) {
      lineStarts.push(offset + 1);
    }
    const lineNumberAt = (index) => {
      let low = 0;
      let high = lineStarts.length;
      while (low < high) {
        const middle = (low + high) >> 1;
        if (lineStarts[middle] <= index) low = middle + 1;
        else high = middle;
      }
      return low - 1;
    };
    let pendingDeclaration = false;
    for (const match of source.matchAll(URL_LITERAL_RE)) {
      const index = match.index ?? 0;
      const lineNumberIndex = lineNumberAt(index);
      const lineStart = lineStarts[lineNumberIndex];
      const lineEnd = lineStarts[lineNumberIndex + 1] === undefined ? source.length : lineStarts[lineNumberIndex + 1] - 1;
      const line = source.slice(lineStart, lineEnd);
      const declarationBefore = source.slice(Math.max(0, index - 280), index).match(/(?:const|let|var)\s+[A-Z][A-Z0-9_]*\s*=\s*['"`]?\s*$/);
      const preceding = source.slice(Math.max(0, index - 260), index);
      const candidate = FEED_FILES.has(relativePath)
        || SOURCE_HINT_RE.test(line)
        || SOURCE_HINT_RE.test(preceding)
        || pendingDeclaration
        || Boolean(declarationBefore);
      pendingDeclaration = DECLARATION_RE.test(line);
      if (!candidate) continue;
      const host = hostFromUrl(match[0]);
      if (!host) continue;
      const kind = relativePath === STATUS_FILE
        ? 'operational-status'
        : FEED_FILES.has(relativePath)
          ? 'feed'
          : 'structured';
      recordHost(host, kind, relativePath);
      if (host === 'news.google.com' && FEED_FILES.has(relativePath)) {
        let query = '';
        try {
          query = new URL(match[0]).searchParams.get('q') || '';
        } catch {
          // The ordinary host remains accounted even if a malformed query
          // cannot yield a publisher identity.
        }
        for (const publisherHost of googleNewsPublisherHosts(query)) {
          recordHost(publisherHost, 'feed', relativePath);
        }
      }
    }
    if (FEED_FILES.has(relativePath)) {
      // Server feed mirrors build Google News URLs through gn()/gnLocale().
      // Count a site-scoped publisher under its own host as well as counting
      // the Google News URL literal above under news.google.com.
      for (const match of source.matchAll(/\bgn(?:Locale)?\(\s*(["'`])([\s\S]*?)\1/g)) {
        const lineStart = source.lastIndexOf('\n', match.index ?? 0) + 1;
        const beforeMatch = source.slice(lineStart, match.index ?? 0);
        if (beforeMatch.includes('//')) continue;
        for (const publisherHost of googleNewsPublisherHosts(match[2])) {
          recordHost(publisherHost, 'feed', relativePath);
        }
      }
    }
  }
  for (const dynamic of DYNAMIC_HOSTS) {
    if (!existsSync(join(rootDir, dynamic.path))) continue;
    const source = read(rootDir, dynamic.path);
    // Require the host in URL position rather than anywhere in the file, so a
    // leftover mention in a comment or changelog note cannot keep a provider we
    // stopped fetching in the active inventory.
    if (!source.toLowerCase().includes(`//${dynamic.host.toLowerCase()}`)) {
      throw new Error(`source-attribution: dynamic reference ${dynamic.path} no longer builds a URL for ${dynamic.host}`);
    }
    recordHost(dynamic.host, dynamic.kind, dynamic.path);
  }
  return [...hosts.values()]
    .map((entry) => ({ ...entry, kinds: [...entry.kinds].sort(), references: entry.references.sort((a, b) => a.path.localeCompare(b.path)) }))
    .sort((a, b) => a.host.localeCompare(b.host));
}

function defaultEntry(observed) {
  const provider = observed.host;
  const kindLabel = observed.kinds.includes('operational-status') ? 'service-status endpoint' : observed.kinds.includes('feed') ? 'feed publisher' : 'upstream API/dataset';
  return {
    host: observed.host,
    provider,
    kind: observed.kinds.join('+'),
    observed: true,
    license: `Provider terms for this ${kindLabel}; verify before redistribution`,
    attribution: `Credit ${provider} and link to the original ${kindLabel}.`,
    status: 'terms-review',
  };
}

/**
 * Every `excluded` row the generator writes itself carries one of these, so a
 * row still wearing the text after its rule stopped applying is stale rather
 * than curated. Human-written exclusions (PROVIDER_OVERRIDES) never match.
 */
const GENERATED_EXCLUSIONS = [
  {
    license: 'Excluded: live-video playback transport; channel/provider terms apply separately',
    attribution: 'Excluded from the external-provider count: presentation-only HLS stream, not an ingested dataset.',
    status: 'excluded',
  },
  {
    license: 'Excluded: first-party, control-plane, UI, or rendering transport',
    attribution: 'Excluded from the external-provider count: not an ingested upstream dataset.',
    status: 'excluded',
  },
];

/**
 * Return the previous row to review status when its `excluded` no longer has a
 * rule behind it. Two ways that happens: a host retired by an earlier
 * regeneration is observed again, and a host excluded by a scanner rule (a
 * playback-only origin, say) gains a real ingest reference. Both leave an
 * active provider marked excluded, which drops it from the published count and
 * from license review while every gate stays green — so exclusion is cleared
 * unless a rule still asserts it.
 */
function clearStaleExclusion(previous, observed, override) {
  const retired = previous.observed === false;
  if (!retired && (previous.status !== 'excluded' || override.status === 'excluded')) return previous;
  const fallback = defaultEntry(observed);
  const wasGenerated = GENERATED_EXCLUSIONS.some(
    (text) => text.license === previous.license && text.attribution === previous.attribution,
  );
  // The generator's own exclusion copy describes a surface this host no longer
  // is, so it goes too. A curated credit is the reviewer's and survives.
  return wasGenerated
    ? { ...previous, status: fallback.status, license: fallback.license, attribution: fallback.attribution }
    : { ...previous, status: fallback.status };
}

/**
 * Fields this script owns for a host, which therefore cannot be curated in the
 * manifest — `--write` reasserts them on every run. Kept separate from
 * mergeEntry so the validator can tell a reviewer *where* to make an edit
 * stick instead of sending them to a command that would discard it.
 */
function overrideFor(observed) {
  if (PROVIDER_OVERRIDES[observed.host]) {
    // identityGroup is review metadata for the override declaration. It is not
    // part of the public manifest schema and must never leak into generated
    // attribution rows.
    const { identityGroup, ...override } = PROVIDER_OVERRIDES[observed.host];
    return override;
  }
  const presentationOnly = observed.references.length > 0
    && observed.references.every((reference) => PRESENTATION_ONLY_FILES.has(reference.path));
  if (presentationOnly) return { provider: observed.host, ...GENERATED_EXCLUSIONS[0] };
  if (EXCLUDED_HOSTS.has(observed.host) || observed.host.endsWith('.worldmonitor.app')) {
    return { provider: observed.host, ...GENERATED_EXCLUSIONS[1] };
  }
  return {};
}

function mergeEntry(observed, previous) {
  const override = overrideFor(observed);
  const base = previous ? clearStaleExclusion(previous, observed, override) : defaultEntry(observed);
  return {
    ...base,
    ...override,
    host: observed.host,
    kind: observed.kinds.join('+'),
    observed: true,
    references: observed.references,
  };
}

export function loadManifest(rootDir = ROOT) {
  const path = join(rootDir, MANIFEST_PATH);
  if (!existsSync(path)) return { version: 1, entries: [], logicalEntries: [] };
  const raw = readFileSync(path, 'utf8');
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (error) {
    // A bare "Unexpected end of JSON input" names no file; say which one.
    throw new Error(`source-attribution: ${MANIFEST_PATH} is not valid JSON (${error.message})`);
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error(`source-attribution: invalid manifest (${MANIFEST_PATH} must be an object)`);
  }
  if (!Array.isArray(manifest.entries)) {
    throw new Error(`source-attribution: invalid manifest (${MANIFEST_PATH} entries must be an array)`);
  }
  if (manifest.logicalEntries !== undefined && !Array.isArray(manifest.logicalEntries)) {
    throw new Error(`source-attribution: invalid manifest (${MANIFEST_PATH} logicalEntries must be an array)`);
  }
  return {
    version: manifest.version || 1,
    entries: manifest.entries,
    logicalEntries: manifest.logicalEntries || [],
  };
}

function retirementRequiredMessage(host) {
  return `${host} left the scan; confirm removal with --retire ${host} or restore a discoverable reference`;
}

export function buildManifest(
  inventory,
  previous = { entries: [], logicalEntries: [] },
  { retireHosts = [] } = {},
) {
  const previousByHost = new Map((previous.entries || []).map((entry) => [entry.host, entry]));
  const entries = inventory.map((observed) => mergeEntry(observed, previousByHost.get(observed.host)));
  const observedHosts = new Set(inventory.map((entry) => entry.host));
  const retireHostSet = new Set(retireHosts);
  for (const host of retireHostSet) {
    const previousEntry = previousByHost.get(host);
    if (!previousEntry) throw new Error(`source-attribution: cannot retire unknown host ${host}`);
    if (observedHosts.has(host)) {
      throw new Error(`source-attribution: cannot retire ${host} because the scanner still finds it`);
    }
    if (previousEntry.observed === false) {
      throw new Error(`source-attribution: cannot retire ${host} because it is already retired`);
    }
  }
  // Retain retired rows as explicit exclusions rather than silently deleting a
  // credit. This makes removals reviewable and keeps historical attribution
  // visible while ensuring only currently observed hosts count as active.
  // Rows retired by an earlier run are carried through unchanged: skipping them
  // made a second regeneration delete the credit the first one preserved, which
  // also stopped --write from being a fixpoint the check could compare against.
  for (const oldEntry of previous.entries || []) {
    if (observedHosts.has(oldEntry.host)) continue;
    // A retired row keeps its credit but loses its references: the scanner no
    // longer finds the host in those files, so publishing them would assert a
    // source path that does not contain it. The docs cell falls back to
    // "No current fetch observed", which is what is actually true.
    const { references, ...retained } = oldEntry;
    if (retained.observed !== false && !MANIFEST_STATUSES.has(retained.status)) {
      throw new Error(`source-attribution: cannot retire ${retained.host} because its manifest status is invalid`);
    }
    if (
      retained.observed !== false
      && CREDIT_BEARING_STATUSES.has(retained.status)
      && !retireHostSet.has(retained.host)
    ) {
      throw new Error(`source-attribution: ${retirementRequiredMessage(retained.host)}`);
    }
    entries.push(retained.observed === false
      ? retained
      : {
        ...retained,
        observed: false,
        status: 'excluded',
        attribution: retained.attribution || `Excluded: ${retained.host} is no longer observed in the source tree.`,
      });
  }
  const logicalEntries = [...LOGICAL_ENTRIES, ...(previous.logicalEntries || [])]
    .filter((entry) => !observedHosts.has(entry.host))
    .filter((entry, index, all) => all.findIndex((candidate) => candidate.provider === entry.provider && candidate.host === entry.host) === index)
    .sort((a, b) => a.provider.localeCompare(b.provider));
  return { version: 1, entries: entries.sort((a, b) => a.host.localeCompare(b.host)), logicalEntries };
}

/**
 * Validate fields the committed ledger owns independently of the source scan.
 * Build-owned inventory facts may use this ledger only after this passes.
 */
export function validateSourceAttributionLedger(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return ['source-attribution manifest must be an object'];
  }
  if (!Array.isArray(manifest.entries)) {
    errors.push('source-attribution manifest entries must be an array');
  }
  if (manifest.logicalEntries !== undefined && !Array.isArray(manifest.logicalEntries)) {
    errors.push('source-attribution manifest logicalEntries must be an array');
  }
  const manifestEntries = Array.isArray(manifest.entries) ? manifest.entries : [];
  const manifestByHost = new Map();
  for (const entry of manifestEntries) {
    const label = entry?.host || '(unknown host)';
    if (!entry || typeof entry !== 'object') {
      errors.push(`manifest entry ${label} must be an object`);
      continue;
    }
    if (typeof entry.host !== 'string' || !entry.host || /\s/.test(entry.host)) errors.push(`invalid manifest host ${label}`);
    if (typeof entry.observed !== 'boolean') errors.push(`manifest entry ${label} observed must be boolean`);
    if (typeof entry.kind !== 'string' || !MANIFEST_KIND_RE.test(entry.kind)) errors.push(`invalid manifest kind for ${label}`);
    if (typeof entry.status !== 'string' || !MANIFEST_STATUSES.has(entry.status)) errors.push(`invalid manifest status for ${label}`);
    if (typeof entry.provider !== 'string' || !entry.provider.trim() || typeof entry.license !== 'string' || !entry.license.trim() || typeof entry.attribution !== 'string' || !entry.attribution.trim()) {
      errors.push(`incomplete attribution metadata for ${label}`);
    }
    const reviewedProvider = PROVIDER_OVERRIDES[entry.host]?.provider;
    if (typeof entry.provider === 'string' && entry.provider !== entry.host && entry.provider !== reviewedProvider) {
      errors.push(`custom provider identity for ${label} must be declared in PROVIDER_OVERRIDES`);
    }
    if (entry.references !== undefined && !Array.isArray(entry.references)) {
      errors.push(`manifest entry ${label} references must be an array`);
    }
    const references = Array.isArray(entry.references) ? entry.references : [];
    if (entry.observed === true && references.length === 0) {
      errors.push(`manifest entry ${label} observed rows need at least one reference`);
    }
    for (const reference of references) {
      if (!reference || typeof reference.path !== 'string' || !reference.path.trim()) {
        errors.push(`manifest entry ${label} has an invalid source reference`);
      } else if (Object.keys(reference).length !== 1) {
        // A line number here is the drift the rest of this validator exists to
        // stop: it changes on every unrelated edit and credits nobody.
        errors.push(`manifest entry ${label} reference ${reference.path} carries fields beyond path`);
      }
    }
    if (manifestByHost.has(entry.host)) errors.push(`duplicate manifest entry for ${entry.host}`);
    manifestByHost.set(entry.host, entry);
    const override = PROVIDER_OVERRIDES[entry.host];
    if (override) {
      const { identityGroup, ...owned } = override;
      if (entry.identityGroup !== undefined) {
        errors.push(`manifest entry ${label} must not carry script-only identityGroup metadata`);
      }
      if (entry.observed === true) {
        for (const [field, value] of Object.entries(owned)) {
          if (!isDeepStrictEqual(entry[field], value)) {
            errors.push(`manifest entry ${label} disagrees with script-owned ${field}`);
          }
        }
      }
    }
  }
  const logicalEntries = Array.isArray(manifest.logicalEntries) ? manifest.logicalEntries : [];
  for (const entry of logicalEntries) {
    const label = entry?.provider || '(unknown provider)';
    if (!entry || typeof entry !== 'object') {
      errors.push(`logical attribution entry ${label} must be an object`);
      continue;
    }
    if (typeof entry.host !== 'string' || !entry.host || /\s/.test(entry.host)) errors.push(`invalid logical attribution host ${label}`);
    if (typeof entry.observed !== 'boolean') errors.push(`logical attribution entry ${label} observed must be boolean`);
    if (typeof entry.kind !== 'string' || !LOGICAL_KIND_RE.test(entry.kind)) errors.push(`invalid logical attribution kind for ${label}`);
    if (typeof entry.status !== 'string' || !MANIFEST_STATUSES.has(entry.status)) errors.push(`invalid logical attribution status for ${label}`);
    if (typeof entry.provider !== 'string' || !entry.provider.trim() || typeof entry.license !== 'string' || !entry.license.trim() || typeof entry.attribution !== 'string' || !entry.attribution.trim()) {
      errors.push(`incomplete logical attribution metadata for ${label}`);
    }
  }
  errors.push(...validateProviderIdentityGroups({ ...manifest, entries: manifestEntries }));
  return errors;
}

export function validateManifest(inventory, manifest) {
  const errors = validateSourceAttributionLedger(manifest);
  const observedByHost = new Map(inventory.map((entry) => [entry.host, entry]));
  const manifestEntries = Array.isArray(manifest?.entries) ? manifest.entries : [];
  const manifestByHost = new Map(
    manifestEntries
      .filter((entry) => entry && typeof entry === 'object')
      .map((entry) => [entry.host, entry]),
  );
  for (const entry of inventory) {
    if (!Array.isArray(entry.references) || !Array.isArray(entry.kinds)) {
      // mergeEntry below reads both. Report the bad row instead of letting a
      // caller of this error-collecting function receive a raw TypeError.
      errors.push(`inventory entry ${entry.host || '(unknown host)'} must carry kinds and references arrays`);
      continue;
    }
    const manifestEntry = manifestByHost.get(entry.host);
    if (!manifestEntry) {
      errors.push(`missing manifest entry for ${entry.host}`);
      continue;
    }
    if (manifestEntry.observed !== true) {
      errors.push(`manifest must mark current host ${entry.host} observed; excluded rows need an explicit exclusion reason`);
      continue;
    }
    // Host-set membership alone cannot see a row whose scan-derived fields have
    // gone stale, which is how a committed manifest drifted from the source tree
    // while this gate stayed green. Every observed row must already equal what
    // --write would produce for it, so the check and the generator agree.
    const rebuilt = mergeEntry(entry, manifestEntry);
    const stale = Object.keys(rebuilt).filter((field) => !isDeepStrictEqual(rebuilt[field], manifestEntry[field]));
    if (!stale.length) continue;
    // Sending a reviewer to --write for a field this script owns would discard
    // the edit they just made to a compliance artifact. Name the real owner.
    const owned = stale.filter((field) => field in overrideFor(entry));
    errors.push(owned.length
      ? `manifest entry ${entry.host} disagrees with this script on ${owned.join(', ')}; those fields are set in scripts/source-attribution.mjs (PROVIDER_OVERRIDES or an exclusion rule) and --write will overwrite the manifest — edit the script instead`
      : `stale manifest entry for ${entry.host}: ${stale.join(', ')} no longer match the source tree; ${REGENERATE_HINT}`);
  }
  for (const entry of manifestEntries) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.observed && !observedByHost.has(entry.host)) {
      // Two very different causes, one of which --write resolves destructively:
      // the provider really was removed, or the scanner simply lost sight of a
      // URL that moved somewhere lexical discovery cannot see. Say both, because
      // regenerating on the second retires a provider the code still fetches.
      errors.push(`manifest marks ${entry.host} observed but scanner found no current reference — ${retirementRequiredMessage(entry.host)} or add it to DYNAMIC_HOSTS`);
    }
  }
  return errors;
}

export function validateProviderIdentityGroups(
  manifest,
  groups = PROVIDER_IDENTITY_GROUPS,
  providerOverrides = PROVIDER_OVERRIDES,
  providerIdentityReview = providerOverrides === PROVIDER_OVERRIDES ? PROVIDER_IDENTITY_REVIEW : null,
) {
  const errors = [];
  const entries = Array.isArray(manifest?.entries) ? manifest.entries : [];
  const claimedHostGroups = new Map();
  const claimedProviderGroups = new Map();
  const allHostsByProvider = new Map();
  const activeHostsByProvider = new Map();
  for (const entry of entries) {
    const allHosts = allHostsByProvider.get(entry?.provider) || [];
    allHosts.push(entry?.host);
    allHostsByProvider.set(entry?.provider, allHosts);
    if (!isActiveSourceAttributionEntry(entry)) continue;
    const activeHosts = activeHostsByProvider.get(entry.provider) || [];
    activeHosts.push(entry.host);
    activeHostsByProvider.set(entry.provider, activeHosts);
  }
  const requireDeclaredMembership = providerOverrides !== PROVIDER_OVERRIDES
    || entries.some((entry) => providerOverrides?.[entry?.host]);

  if (providerIdentityReview) {
    if (typeof providerIdentityReview.reason !== 'string' || !providerIdentityReview.reason.trim()) {
      errors.push('provider identity review needs a reason');
    }
    if (typeof providerIdentityReview.reviewReference !== 'string' || !providerIdentityReview.reviewReference.trim()) {
      errors.push('provider identity review needs a review reference');
    }
    const digest = providerIdentityDigest(providerOverrides);
    if (providerIdentityReview.sha256 !== digest) {
      errors.push(`provider identity overrides changed without a reviewed lifecycle epoch; expected sha256 ${providerIdentityReview.sha256}, got ${digest}`);
    }
  }

  for (const [groupId, group] of Object.entries(groups || {})) {
    const label = `provider identity group ${groupId}`;
    if (!group || typeof group !== 'object') {
      errors.push(`${label} must be an object`);
      continue;
    }
    if (typeof group.provider !== 'string' || !group.provider.trim()) errors.push(`${label} needs a provider`);
    if (typeof group.reason !== 'string' || !group.reason.trim()) errors.push(`${label} needs a reason`);
    if (typeof group.reviewReference !== 'string' || !group.reviewReference.trim()) errors.push(`${label} needs a review reference`);
    if (!Array.isArray(group.memberHosts) || group.memberHosts.length < 2) {
      errors.push(`${label} needs at least two member hosts`);
      continue;
    }
    const memberHosts = group.memberHosts.filter((host) => typeof host === 'string' && host.trim());
    if (memberHosts.length !== group.memberHosts.length) errors.push(`${label} has an invalid member host`);
    if (new Set(memberHosts).size !== memberHosts.length) errors.push(`${label} repeats a member host`);
    if (claimedProviderGroups.has(group.provider)) {
      errors.push(`${label} reuses provider ${group.provider} from ${claimedProviderGroups.get(group.provider)}`);
    } else {
      claimedProviderGroups.set(group.provider, groupId);
    }
    for (const host of memberHosts) {
      if (claimedHostGroups.has(host)) {
        errors.push(`${label} reuses host ${host} from ${claimedHostGroups.get(host)}`);
      } else {
        claimedHostGroups.set(host, groupId);
      }
      const override = providerOverrides?.[host];
      if (!override || override.identityGroup !== groupId) {
        errors.push(`${label} member ${host} must point to this group from PROVIDER_OVERRIDES`);
      } else if (override.provider !== group.provider) {
        errors.push(`${label} member ${host} overrides provider as ${override.provider}, not ${group.provider}`);
      }
    }

    // The ledger must preserve the complete group, including explicitly
    // retired rows. This makes host retirement and provider regrouping
    // separate review events and rejects deleting the whole group at once.
    const manifestHosts = [...(allHostsByProvider.get(group.provider) || [])].sort();
    const declaredHosts = [...memberHosts].sort();
    if (requireDeclaredMembership && !isDeepStrictEqual(manifestHosts, declaredHosts)) {
      errors.push(`${label} manifest membership is ${manifestHosts.join(', ') || '(empty)'}; expected ${declaredHosts.join(', ')}`);
    }
  }

  for (const [host, override] of Object.entries(providerOverrides || {})) {
    if (!override?.identityGroup) continue;
    if (!groups?.[override.identityGroup]) {
      errors.push(`provider override ${host} points to unknown identity group ${override.identityGroup}`);
    }
  }

  for (const [provider, hosts] of activeHostsByProvider) {
    if (hosts.length < 2) continue;
    const groupId = claimedProviderGroups.get(provider);
    if (!groupId) {
      errors.push(`active provider ${provider} has undeclared identity collision across ${hosts.sort().join(', ')}`);
    }
  }
  return errors;
}

export function isActiveSourceAttributionEntry(entry) {
  return entry?.observed === true && CREDIT_BEARING_STATUSES.has(entry.status);
}

export function activeSourceAttributionEntries(manifest) {
  return (Array.isArray(manifest?.entries) ? manifest.entries : [])
    .filter(isActiveSourceAttributionEntry);
}

export function isSourceAttributionManifestError(error) {
  return error instanceof Error && error.message.startsWith('source-attribution: invalid manifest');
}

/** Count the committed ledger without requiring scan-parity. */
export function sourceAttributionLedgerStats(manifest, { observedHosts } = {}) {
  const validationErrors = validateSourceAttributionLedger(manifest);
  if (validationErrors.length) throw new Error(`source-attribution: invalid manifest (${validationErrors.join('; ')})`);
  const active = activeSourceAttributionEntries(manifest);
  const structured = active.filter((entry) => String(entry.kind || '').split('+').includes('structured'));
  const feeds = active.filter((entry) => String(entry.kind || '').split('+').includes('feed'));
  const status = active.filter((entry) => String(entry.kind || '').split('+').includes('operational-status'));
  return {
    activeHosts: active.length,
    structuredHosts: structured.length,
    feedHosts: feeds.length,
    operationalStatusHosts: status.length,
    providerCount: new Set(active.map((entry) => entry.provider)).size,
    observedHosts: observedHosts ?? manifest.entries.filter((entry) => entry.observed === true).length,
    reviewNeeded: active.filter((entry) => entry.status === 'terms-review').length,
  };
}

export function sourceAttributionStats(inventory, manifest) {
  const validationErrors = validateManifest(inventory, manifest);
  if (validationErrors.length) throw new Error(`source-attribution: invalid manifest (${validationErrors.join('; ')})`);
  return sourceAttributionLedgerStats(manifest, { observedHosts: inventory.length });
}

function markdownCell(value) {
  return String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
}

export function renderAttributionSection(inventory, manifest) {
  const stats = sourceAttributionStats(inventory, manifest);
  const entries = [...(manifest.entries || []), ...(manifest.logicalEntries || [])]
    .sort((a, b) => (a.provider || '').localeCompare(b.provider || '') || a.host.localeCompare(b.host));
  const rows = entries.map((entry) => {
    const references = entry.references || [];
    // Say when the list is cut. A reader auditing where a provider is used
    // otherwise reads four paths as the complete answer.
    const refs = references.length > REFERENCE_DISPLAY_LIMIT
      ? `${references.slice(0, REFERENCE_DISPLAY_LIMIT).map((reference) => reference.path).join(', ')}, +${references.length - REFERENCE_DISPLAY_LIMIT} more`
      : references.map((reference) => reference.path).join(', ');
    const surface = entry.observed === false ? 'Excluded / candidate' : entry.kind;
    const sourceRef = refs || (entry.observed === false ? 'No current fetch observed' : 'Manifest-only review row');
    return `| ${markdownCell(entry.provider)} (${markdownCell(entry.host)}) | ${markdownCell(surface)} — ${markdownCell(sourceRef)} |`;
  });
  return [
    '## Observed Source Inventory',
    '',
    BEGIN_MARKER,
    `This generated inventory covers **${stats.activeHosts} active source hosts** representing **${stats.providerCount} active providers** (**${stats.structuredHosts} structured/API**, **${stats.feedHosts} feed**, and **${stats.operationalStatusHosts} operational-status** hosts). It is derived from source declarations in \`scripts/\`, \`server/\`, \`api/\`, and \`src/\`. Each row shows the configured provider identity and where the source is referenced.`,
    '',
    '| Provider | Observed surface |',
    '| --- | --- |',
    ...rows,
    END_MARKER,
  ].join('\n');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function inventoryMarkerPattern(leadingNewline) {
  return new RegExp(
    `${leadingNewline ? '\\n' : ''}## (?:Audited|Observed) (?:Upstream|Source) Inventory\\n+` +
      `${escapeRegExp(BEGIN_MARKER)}[\\s\\S]*?${escapeRegExp(END_MARKER)}`,
  );
}

/** Single source of truth for locating the generated block, shared with the test. */
export function matchGeneratedAttributionSection(docs) {
  return docs.match(inventoryMarkerPattern(false))?.[0];
}

function updateDocs(rootDir, section) {
  const path = join(rootDir, DOCS_PATH);
  const current = readFileSync(path, 'utf8');
  const markerPattern = inventoryMarkerPattern(true);
  const updated = markerPattern.test(current)
    // Function replacement: `section` is generated from manifest text that can
    // contain `$&`/`$'`, which String.replace would otherwise expand.
    ? current.replace(markerPattern, () => `\n${section}`)
    : `${current.trimEnd()}\n\n${section}\n`;
  writeFileSync(path, updated);
}

export function buildSourceAttributionStats({ rootDir = ROOT, validate = true } = {}) {
  const manifest = loadManifest(rootDir);
  if (!validate) return sourceAttributionLedgerStats(manifest);
  return sourceAttributionStats(scanUpstreamHosts(rootDir), manifest);
}

function printStats(stats, log = console.log) {
  log(`source-attribution: ${stats.activeHosts} active hosts across ${stats.providerCount} providers (${stats.structuredHosts} structured/API, ${stats.feedHosts} feed, ${stats.operationalStatusHosts} operational-status; ${stats.reviewNeeded} terms-review)`);
}

function serializeManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/**
 * The whole `--check` verdict, exported so a test can prove each way it fails
 * rather than only that it currently passes. Returns every error it found and,
 * when clean, the stats the CLI prints.
 */
export function checkSourceAttribution(rootDir = ROOT) {
  // Before anything else, because an absent manifest otherwise surfaces as one
  // "missing manifest entry" per host and never names the real cause.
  const manifestPath = join(rootDir, MANIFEST_PATH);
  if (!existsSync(manifestPath)) return { errors: [`${MANIFEST_PATH} is missing; ${REGENERATE_HINT}`] };
  const docsPath = join(rootDir, DOCS_PATH);
  if (!existsSync(docsPath)) return { errors: [`${DOCS_PATH} is missing; ${REGENERATE_HINT}`] };
  const inventory = scanUpstreamHosts(rootDir);
  const previous = loadManifest(rootDir);
  const errors = validateManifest(inventory, previous);
  if (errors.length) return { errors };
  // Compare the committed manifest against a rebuild, not against itself. The
  // per-row validation above covers observed hosts; this catches the rest —
  // retired rows, logical entries, and formatting — so --check and --write can
  // no longer disagree about what the committed artifact should contain.
  const rebuilt = serializeManifest(buildManifest(inventory, previous));
  if (readFileSync(manifestPath, 'utf8') !== rebuilt) {
    return { errors: [`${MANIFEST_PATH} is out of date; ${REGENERATE_HINT}`] };
  }
  const actual = matchGeneratedAttributionSection(readFileSync(docsPath, 'utf8'));
  if (actual !== renderAttributionSection(inventory, previous)) {
    return { errors: [`${DOCS_PATH} is out of date; ${REGENERATE_HINT}`] };
  }
  return { errors: [], stats: sourceAttributionStats(inventory, previous) };
}

function parseRetireHosts(args) {
  const retireHosts = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== '--retire') continue;
    const host = args[index + 1];
    if (!host || host.startsWith('--')) {
      throw new Error('source-attribution: --retire requires a host');
    }
    retireHosts.push(host);
    index += 1;
  }
  return [...new Set(retireHosts)];
}

export function runSourceAttribution({
  rootDir = ROOT,
  args = [],
  log = console.log,
  warn = console.warn,
  reportError = console.error,
} = {}) {
  let retireHosts;
  try {
    retireHosts = parseRetireHosts(args);
  } catch (error) {
    reportError(error.message);
    return 1;
  }
  if (retireHosts.length && !args.includes('--write')) {
    reportError('source-attribution: --retire requires --write');
    return 1;
  }
  if (args.includes('--write')) {
    try {
      const inventory = scanUpstreamHosts(rootDir);
      const previous = loadManifest(rootDir);
      const manifest = buildManifest(inventory, previous, { retireHosts });
      // Render and count before writing anything. Both throw on a manifest row
      // that no longer validates, and a row retired by an earlier run is now kept
      // rather than dropped — so writing first would leave the manifest rewritten,
      // the docs stale, and every rerun repeating it.
      const section = renderAttributionSection(inventory, manifest);
      const stats = sourceAttributionStats(inventory, manifest);
      const serialized = serializeManifest(manifest);
      writeFileSync(join(rootDir, MANIFEST_PATH), serialized);
      updateDocs(rootDir, section);
      const retired = manifest.entries.filter((entry) => entry.observed === false).map((entry) => entry.host);
      const newlyRetired = retired.filter(
        (host) => (previous.entries || []).some((entry) => entry.host === host && entry.observed !== false),
      );
      if (newlyRetired.length) {
        warn(`source-attribution: retired ${newlyRetired.length} host(s): ${newlyRetired.join(', ')}`);
      }
      printStats(stats, log);
    } catch (error) {
      reportError(error.message);
      return 1;
    }
    return 0;
  }
  const { errors, stats } = checkSourceAttribution(rootDir);
  if (errors.length) {
    reportError(`source-attribution: ${errors.length} manifest error(s)`);
    // A single stale scan can fault every row, so cap the listing: an unbounded
    // dump buries the first (and usually only) cause the reader needs.
    for (const error of errors.slice(0, ERROR_PRINT_LIMIT)) reportError(`- ${error}`);
    if (errors.length > ERROR_PRINT_LIMIT) reportError(`- ...and ${errors.length - ERROR_PRINT_LIMIT} more`);
    return 1;
  }
  printStats(stats, log);
  return 0;
}

if (process.argv[1] && process.argv[1].endsWith('scripts/source-attribution.mjs')) {
  process.exitCode = runSourceAttribution({ args: process.argv.slice(2) });
}
