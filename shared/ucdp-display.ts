// UCDP appends a former name: "Yemen (North Yemen)", "DR Congo (Zaire)".
// Classification and forecast code key on the raw name, so strip it for display only.
export function currentUcdpCountryName(country: string): string {
  return country.replace(/\s*\([^)]*\)\s*$/, '').trim() || country;
}
