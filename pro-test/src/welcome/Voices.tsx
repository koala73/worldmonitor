import { t } from '../i18n';
import { COUNTRY_REACH_CLAIM, USERS_CLAIM } from '../../../shared/press';
import { PressNav } from '../components/PressNav';
import { VoiceCards } from '../components/Voices';
import { SectionHeading } from './SectionHeading';

export const Voices = () => (
  <section id="voices" className="py-24 px-4 sm:px-6 border-t border-wm-border">
    <div className="max-w-6xl mx-auto">
      <SectionHeading
        eyebrow={t('welcome.voices.eyebrow')}
        title={t('welcome.voices.title')}
        subtitle={t('welcome.voices.sub', { users: USERS_CLAIM, countries: COUNTRY_REACH_CLAIM })}
      />
      <VoiceCards />
      <PressNav className="mt-6" />
    </div>
  </section>
);
