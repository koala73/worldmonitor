// Credit lines the open archives ask for, worded as in the source attribution manifest.
// The browser lookup, the analyst and the MCP tools all credit an image with these.
export const COPERNICUS_CREDIT = (years) => `Contains modified Copernicus Sentinel data ${years}`;
export const USGS_LANDSAT_CREDIT = 'Landsat imagery courtesy of the U.S. Geological Survey';
export const CELESTRAK_CREDIT = 'Orbit elements from CelesTrak';

/** The credit for one archive scene, from its sensor profile and acquisition time; '' when none applies. */
export function sceneCredit(profileId, datetime) {
  if (profileId === 'landsat') return USGS_LANDSAT_CREDIT;
  const year = new Date(datetime).getUTCFullYear();
  return typeof profileId === 'string' && profileId.startsWith('sentinel-') && Number.isFinite(year) ? COPERNICUS_CREDIT(year) : '';
}
