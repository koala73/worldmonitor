import { motion } from 'motion/react';
import { Globe, Cpu, Landmark, Pickaxe, Fuel, Sun } from 'lucide-react';
import { t } from '../i18n';
import { SectionHeading } from './SectionHeading';

const VARIANTS = [
  { icon: Globe, key: 'world', name: 'World Monitor', url: 'https://www.worldmonitor.app/' },
  { icon: Cpu, key: 'tech', name: 'Tech Monitor', url: 'https://tech.worldmonitor.app/' },
  { icon: Landmark, key: 'finance', name: 'Finance Monitor', url: 'https://finance.worldmonitor.app/' },
  { icon: Pickaxe, key: 'commodity', name: 'Commodity Monitor', url: 'https://commodity.worldmonitor.app/' },
  { icon: Fuel, key: 'energy', name: 'Energy Monitor', url: 'https://energy.worldmonitor.app/' },
  { icon: Sun, key: 'happy', name: 'Happy Monitor', url: 'https://happy.worldmonitor.app/' },
] as const;

export const Variants = () => (
  <section className="py-24 px-6 border-t border-wm-border">
    <div className="max-w-7xl mx-auto">
      <SectionHeading eyebrow={t('welcome.variants.eyebrow')} title={t('welcome.variants.title')} />
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {VARIANTS.map(({ icon: Icon, key, name, url }, i) => (
          <motion.a
            key={key}
            href={url}
            initial={{ opacity: 0, y: 16 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-40px' }}
            transition={{ duration: 0.4, delay: (i % 3) * 0.08 }}
            className="group flex items-center gap-4 bg-wm-card border border-wm-border rounded-sm p-5 hover:border-wm-green/40 transition-colors"
          >
            <Icon className="w-6 h-6 text-wm-muted group-hover:text-wm-green transition-colors shrink-0" aria-hidden="true" />
            <div>
              <div className="font-display font-bold text-sm">{name}</div>
              <div className="text-xs text-wm-muted mt-0.5">{t(`welcome.variants.${key}`)}</div>
            </div>
          </motion.a>
        ))}
      </div>
    </div>
  </section>
);
