import { motion } from 'motion/react';
import { Crosshair, TrendingUp, Ship, Bot, Check } from 'lucide-react';
import { t } from '../i18n';
import { SectionHeading } from './SectionHeading';

const PERSONAS = [
  { icon: Crosshair, key: 'analyst' },
  { icon: TrendingUp, key: 'trader' },
  { icon: Ship, key: 'ops' },
  { icon: Bot, key: 'builder' },
] as const;

export const UseCases = () => (
  <section id="use-cases" className="py-24 px-6 border-t border-wm-border">
    <div className="max-w-7xl mx-auto">
      <SectionHeading eyebrow={t('welcome.useCases.eyebrow')} title={t('welcome.useCases.title')} />
      <div className="grid md:grid-cols-2 gap-6">
        {PERSONAS.map(({ icon: Icon, key }, i) => (
          <motion.div
            key={key}
            initial={{ opacity: 0, y: 24 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-60px' }}
            transition={{ duration: 0.5, delay: (i % 2) * 0.1 }}
            className="bg-wm-card border border-wm-border rounded-sm p-8"
          >
            <div className="flex items-center gap-3 mb-3">
              <Icon className="w-6 h-6 text-wm-green" aria-hidden="true" />
              <h3 className="text-lg font-display font-bold">{t(`welcome.useCases.${key}Title`)}</h3>
            </div>
            <p className="text-sm text-wm-muted mb-5">{t(`welcome.useCases.${key}Desc`)}</p>
            <ul className="grid sm:grid-cols-2 gap-x-6 gap-y-2.5">
              {[1, 2, 3, 4].map(n => (
                <li key={n} className="flex items-start gap-2 text-sm">
                  <Check className="w-4 h-4 text-wm-green shrink-0 mt-0.5" aria-hidden="true" />
                  {t(`welcome.useCases.${key}F${n}`)}
                </li>
              ))}
            </ul>
          </motion.div>
        ))}
      </div>
    </div>
  </section>
);
