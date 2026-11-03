import '../styles/main.css';
import '../styles/country-deep-dive.css';
import { CountryDeepDivePanel } from '@/components/CountryDeepDivePanel';
import { countrySignalsFromMilitary } from '@/services/country-signals';
import { initI18n } from '@/services/i18n';
import { COUNTRY_SIGNAL_FAMILIES, projectQualifiedCountrySignals, unavailableCountrySignal } from '../../shared/country-signal-observations';
import { qualifiedFixtureOutcomes } from './fixtures/qualified-country-signals';

await initI18n({ waitForFullTranslation: true });
const panel = new CountryDeepDivePanel();
panel.show('Iran (controlled fixture)', 'IR', null, countrySignalsFromMilitary('IR'));
const unavailable = new URLSearchParams(window.location.search).get('state') === 'unavailable';
const outcomes = unavailable ? [...COUNTRY_SIGNAL_FAMILIES, 'military' as const].map(family => unavailableCountrySignal('IR', family, `Controlled ${family} source unavailable.`)) : qualifiedFixtureOutcomes();
panel.updateQualifiedCountrySignals(projectQualifiedCountrySignals('IR', outcomes));
panel.selectTopic('security');
document.documentElement.dataset.qualifiedSignalsReady = 'true';
