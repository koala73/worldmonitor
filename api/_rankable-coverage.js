export const EDUCATION_MIN_RANKABLE_RECORD_COUNT = 180;

// Mirrors scripts/shared/sovereign-status.json (193 UN members + HK/MO/TW).
// Edge functions may import only api/_*.js helpers, so the parity test pins
// this runtime-safe set to the canonical manifest.
const RANKABLE_COUNTRY_CODES = new Set(
  'AF,AL,DZ,AD,AO,AG,AR,AM,AU,AT,AZ,BS,BH,BD,BB,BY,BE,BZ,BJ,BT,BO,BA,BW,BR,BN,BG,BF,BI,CV,KH,CM,CA,CF,TD,CL,CN,CO,KM,CG,CD,CR,CI,HR,CU,CY,CZ,DK,DJ,DM,DO,EC,EG,SV,GQ,ER,EE,SZ,ET,FJ,FI,FR,GA,GM,GE,DE,GH,GR,GD,GT,GN,GW,GY,HT,HN,HU,IS,IN,ID,IR,IQ,IE,IL,IT,JM,JP,JO,KZ,KE,KI,KP,KR,KW,KG,LA,LV,LB,LS,LR,LY,LI,LT,LU,MG,MW,MY,MV,ML,MT,MH,MR,MU,MX,FM,MD,MC,MN,ME,MA,MZ,MM,NA,NR,NP,NL,NZ,NI,NE,NG,MK,NO,OM,PK,PW,PA,PG,PY,PE,PH,PL,PT,QA,RO,RU,RW,KN,LC,VC,WS,SM,ST,SA,SN,RS,SC,SL,SG,SK,SI,SB,SO,ZA,SS,ES,LK,SD,SR,SE,CH,SY,TJ,TZ,TH,TL,TG,TO,TT,TN,TR,TM,TV,UG,UA,AE,GB,US,UY,UZ,VU,VE,VN,YE,ZM,ZW,HK,MO,TW'.split(','),
);

export function isRankableCountryCode(value) {
  return typeof value === 'string' && RANKABLE_COUNTRY_CODES.has(value);
}

export function parseRankableRecordCount(meta) {
  if (meta == null || typeof meta !== 'object' || Array.isArray(meta)) return null;

  const rawCount = meta.rankableRecordCount;
  if (rawCount !== null && rawCount !== '' && typeof rawCount !== 'boolean') {
    const numericCount = Number(rawCount);
    if (Number.isSafeInteger(numericCount) && numericCount >= 0) return numericCount;
  }

  if (typeof meta.countrySet !== 'string' || meta.countrySet.length === 0) return null;
  const codes = meta.countrySet.split(',').map((code) => code.trim());
  if (codes.length === 0 || codes.some((code) => !isRankableCountryCode(code))) return null;
  return new Set(codes).size;
}

export function parseEducationPayloadRankableRecordCount(payload) {
  if (payload == null || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const countries = payload.countries;
  if (countries == null || typeof countries !== 'object' || Array.isArray(countries)) return null;

  let count = 0;
  for (const [countryCode, record] of Object.entries(countries)) {
    if (!isRankableCountryCode(countryCode) || record == null || typeof record !== 'object' || Array.isArray(record)) continue;
    const value = record.value;
    const year = record.year;
    if (
      typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 &&
      typeof year === 'number' && Number.isSafeInteger(year) && year >= 1900 && year <= 2200
    ) {
      count += 1;
    }
  }
  return count;
}
