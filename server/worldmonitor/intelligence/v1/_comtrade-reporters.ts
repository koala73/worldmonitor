import COMTRADE_REPORTER_OVERRIDES from '../../../../scripts/shared/comtrade-reporter-overrides.json';
import UN_TO_ISO2 from '../../../../scripts/shared/un-to-iso2.json';

function buildIso2ToComtrade(): Readonly<Record<string, string>> {
  const iso2ToComtrade: Record<string, string> = {};

  for (const [unCode, iso2] of Object.entries(UN_TO_ISO2 as Record<string, string>)) {
    iso2ToComtrade[iso2] = unCode;
  }

  for (const [iso2, reporterCode] of Object.entries(COMTRADE_REPORTER_OVERRIDES as Record<string, string>)) {
    iso2ToComtrade[iso2] = reporterCode;
  }

  return Object.freeze(iso2ToComtrade);
}

export const ISO2_TO_COMTRADE = buildIso2ToComtrade();
