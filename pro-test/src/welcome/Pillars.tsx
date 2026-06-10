import { motion } from 'motion/react';
import { Eye, Brain, Zap } from 'lucide-react';
import { t } from '../i18n';
import { SectionHeading } from './SectionHeading';

const PILLARS = [
  { icon: Eye, key: 'see' },
  { icon: Brain, key: 'understand' },
  { icon: Zap, key: 'act' },
] as const;

export const Pillars = () => (
  <section id="features" className="py-24 px-6">
    <div className="max-w-7xl mx-auto">
      <SectionHeading eyebrow={t('welcome.pillars.eyebrow')} title={t('welcome.pillars.title')} />
      <div className="grid md:grid-cols-3 gap-6">
        {PILLARS.map(({ icon: Icon, key }, i) => (
          <motion.div
            key={key}
            initial={{ opacity: 0, y: 24 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-60px' }}
            transition={{ duration: 0.5, delay: i * 0.12 }}
            className="bg-wm-card border border-wm-border rounded-sm p-8 hover:border-wm-green/30 transition-colors"
          >
            <Icon className="w-8 h-8 text-wm-green mb-5" aria-hidden="true" />
            <h3 className="text-xl font-display font-bold mb-3">{t(`welcome.pillars.${key}Title`)}</h3>
            <p className="text-sm text-wm-muted mb-6">{t(`welcome.pillars.${key}Desc`)}</p>
            <ul className="space-y-2.5">
              {[1, 2, 3, 4].map(n => (
                <li key={n} className="flex items-start gap-2.5 text-sm">
                  <span className="text-wm-green font-mono mt-px" aria-hidden="true">▸</span>
                  {t(`welcome.pillars.${key}F${n}`)}
                </li>
              ))}
            </ul>
          </motion.div>
        ))}
      </div>
    </div>
  </section>
);
