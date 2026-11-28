// UCDP appends a former name: "Yemen (North Yemen)", "DR Congo (Zaire)".
// Classification and forecast code key on the raw name, so strip it for display only.
export function currentUcdpCountryName(country: string): string {
  return country.replace(/\s*\([^)]*\)\s*$/, '').trim() || country;
}

/** Exposure labels follow the density country for Palestinian points UCDP labels Israel. */
export function ucdpExposureName(place: string, reportedCountry: string, densityCountry: string): string {
  const country = densityCountry === 'PSE' ? 'Palestine' : currentUcdpCountryName(reportedCountry);
  return place ? [place, country].filter(Boolean).join(', ') : `Conflict event${country ? ` — ${country}` : ''}`;
}
