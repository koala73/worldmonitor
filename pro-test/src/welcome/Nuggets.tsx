import { motion } from 'motion/react';
import {
  Satellite, RadioTower, Anchor, Server, Cable, Megaphone,
  GitBranch, Newspaper, LayoutGrid, Monitor, Languages, Command,
} from 'lucide-react';
import { t } from '../i18n';
import { SectionHeading } from './SectionHeading';

const NUGGETS = [
  { icon: Satellite, n: 1 },
  { icon: RadioTower, n: 2 },
  { icon: Anchor, n: 3 },
  { icon: Server, n: 4 },
  { icon: Cable, n: 5 },
  { icon: Megaphone, n: 6 },
  { icon: GitBranch, n: 7 },
  { icon: Newspaper, n: 8 },
  { icon: LayoutGrid, n: 9 },
  { icon: Monitor, n: 10 },
  { icon: Languages, n: 11 },
  { icon: Command, n: 12 },
] as const;

export const Nuggets = () => (
  <section className="py-24 px-6 border-t border-wm-border relative">
    <div className="absolute inset-0 bg-[radial-gradient(circle_at_80%_20%,rgba(96,165,250,0.05)_0%,transparent_50%)] pointer-events-none" aria-hidden="true" />
    <div className="max-w-7xl mx-auto relative">
      <SectionHeading
        eyebrow={t('welcome.nuggets.eyebrow')}
        title={t('welcome.nuggets.title')}
        subtitle={t('welcome.nuggets.subtitle')}
      />
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {NUGGETS.map(({ icon: Icon, n }, i) => (
          <motion.a
            key={n}
            href="/"
            initial={{ opacity: 0, y: 16 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-40px' }}
            transition={{ duration: 0.4, delay: (i % 4) * 0.06 }}
            className="group bg-wm-card border border-wm-border rounded-sm p-5 hover:border-wm-green/40 hover:border-glow transition-all"
          >
            <Icon className="w-5 h-5 text-wm-muted group-hover:text-wm-green transition-colors mb-3" aria-hidden="true" />
            <h3 className="font-bold text-sm mb-1.5">{t(`welcome.nuggets.n${n}Title`)}</h3>
            <p className="text-xs text-wm-muted leading-relaxed">{t(`welcome.nuggets.n${n}Desc`)}</p>
          </motion.a>
        ))}
      </div>
    </div>
  </section>
);
