import { describe, expect, it } from 'vitest';

import { CountryIntelManager } from '@/app/country-intel';

describe('country brief news matching', () => {
  it('recognizes French demonym headlines for France', () => {
    expect(
      CountryIntelManager.isCountryHeadline('French unions announce a national protest', 'France', 'FR'),
    ).toBe(true);
  });

  it('recognizes the common US and U.S. headline forms', () => {
    expect(
      CountryIntelManager.isCountryHeadline('US announces new sanctions package', 'United States', 'US'),
    ).toBe(true);
    expect(
      CountryIntelManager.isCountryHeadline('U.S. announces new sanctions package', 'United States', 'us'),
    ).toBe(true);
  });

  it('does not treat the lowercase pronoun us as the US country code', () => {
    expect(
      CountryIntelManager.isCountryHeadline('Officials ask us to remain calm', 'United States', 'US'),
    ).toBe(false);
  });

  it('does not treat US as a country boundary inside an uppercase word', () => {
    const title = 'USD rises as China cuts rates';

    expect(CountryIntelManager.isCountryHeadline(title, 'United States', 'US')).toBe(false);
    expect(CountryIntelManager.isCountryHeadline(title, 'China', 'CN')).toBe(true);
  });

  it('keeps the first-country-mentioned rule for multi-country headlines', () => {
    expect(
      CountryIntelManager.isCountryHeadline('Iran considers latest US proposal', 'United States', 'US'),
    ).toBe(false);
    expect(
      CountryIntelManager.isCountryHeadline('US sends latest proposal to Iran', 'United States', 'US'),
    ).toBe(true);
  });
});
