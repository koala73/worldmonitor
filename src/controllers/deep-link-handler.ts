import { dataFreshness } from '@/services/data-freshness';

interface DeepLinkHandlerDeps {
  getLatestClustersCount: () => number;
  consumePendingCountry: () => string | null;
  openCountryStory: (code: string, name: string) => void;
  openCountryBriefByCode: (code: string, name: string) => void;
  resolveCountryName: (code: string) => string;
}

export class DeepLinkHandler {
  constructor(private readonly deps: DeepLinkHandlerDeps) {}

  public handle(): void {
    const url = new URL(window.location.href);

    if (url.pathname === '/story' || url.searchParams.has('c')) {
      const countryCode = url.searchParams.get('c');
      if (countryCode) {
        const countryNames: Record<string, string> = {
          UA: 'Ukraine', RU: 'Russia', CN: 'China', US: 'United States',
          IR: 'Iran', IL: 'Israel', TW: 'Taiwan', KP: 'North Korea',
          SA: 'Saudi Arabia', TR: 'Turkey', PL: 'Poland', DE: 'Germany',
          FR: 'France', GB: 'United Kingdom', IN: 'India', PK: 'Pakistan',
          SY: 'Syria', YE: 'Yemen', MM: 'Myanmar', VE: 'Venezuela',
        };
        const countryName = countryNames[countryCode.toUpperCase()] || countryCode;

        const checkAndOpen = () => {
          if (dataFreshness.hasSufficientData() && this.deps.getLatestClustersCount() > 0) {
            this.deps.openCountryStory(countryCode.toUpperCase(), countryName);
          } else {
            setTimeout(checkAndOpen, 500);
          }
        };
        setTimeout(checkAndOpen, 2000);
        history.replaceState(null, '', '/');
        return;
      }
    }

    const deepLinkCountry = this.deps.consumePendingCountry();
    if (deepLinkCountry) {
      const cName = this.deps.resolveCountryName(deepLinkCountry);
      const checkAndOpenBrief = () => {
        if (dataFreshness.hasSufficientData()) {
          this.deps.openCountryBriefByCode(deepLinkCountry, cName);
        } else {
          setTimeout(checkAndOpenBrief, 500);
        }
      };
      setTimeout(checkAndOpenBrief, 2000);
    }
  }
}
