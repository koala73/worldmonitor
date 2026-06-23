import { motion } from 'motion/react';
import { Satellite, RadioTower, Anchor, Server, Cable, Megaphone } from 'lucide-react';
import { t } from '../i18n';
import { DASHBOARD_PATH } from '../routes';
import { SectionHeading } from './SectionHeading';

const STAT_CELLS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] as const;

const NUGGETS = [
  { icon: Satellite, n: 1 },
  { icon: RadioTower, n: 2 },
  { icon: Anchor, n: 3 },
  { icon: Server, n: 4 },
  { icon: Cable, n: 5 },
  { icon: Megaphone, n: 6 },
] as const;

export const Depth = () => (
  <section id="depth" className="py-24 px-6 border-t border-wm-border relative">
    <div className="absolute inset-0 bg-[radial-gradient(circle_at_80%_20%,rgba(96,165,250,0.05)_0%,transparent_50%)] pointer-events-none" aria-hidden="true" />
    <div className="max-w-7xl mx-auto relative">
      <SectionHeading
        eyebrow={t('welcome.depth.eyebrow')}
        title={t('welcome.depth.title')}
        subtitle={t('welcome.depth.sub')}
      />
      <motion.div
        initial={{ opacity: 0 }}
        whileInView={{ opacity: 1 }}
        viewport={{ once: true, margin: '-60px' }}
        transition={{ duration: 0.6 }}
        className="data-grid !grid-cols-2 sm:!grid-cols-3 xl:!grid-cols-5"
      >
        {STAT_CELLS.map(n => (
          <div key={n} className="data-cell text-center">
            <div className="text-3xl md:text-4xl font-display font-bold text-wm-green text-glow">{t(`welcome.depth.s${n}v`)}</div>
            <div className="font-mono text-[10px] uppercase tracking-widest text-wm-muted mt-2">{t(`welcome.depth.s${n}l`)}</div>
          </div>
        ))}
      </motion.div>
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4 mt-10">
        {NUGGETS.map(({ icon: Icon, n }, i) => (
          <motion.a
            key={n}
            href={`${DASHBOARD_PATH}?ref=welcome-depth-n${n}`}
            initial={{ opacity: 0, y: 16 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-40px' }}
            transition={{ duration: 0.4, delay: (i % 3) * 0.06 }}
            className="group bg-wm-card border border-wm-border rounded-sm p-5 hover:border-wm-green/40 hover:border-glow transition-all"
          >
            <Icon className="w-5 h-5 text-wm-muted group-hover:text-wm-green transition-colors mb-3" aria-hidden="true" />
            <h3 className="font-bold text-sm mb-1.5">{t(`welcome.depth.n${n}Title`)}</h3>
            <p className="text-xs text-wm-muted leading-relaxed">{t(`welcome.depth.n${n}Desc`)}</p>
          </motion.a>
        ))}
      </div>
      <p className="text-center font-mono text-xs text-wm-muted mt-8">
        {t('welcome.depth.faith')}{' '}
        <a href={`${DASHBOARD_PATH}?ref=welcome-depth`} className="text-wm-green hover:text-green-300 transition-colors">{t('welcome.depth.faithCta')}</a>{' '}
        {t('welcome.depth.faithNote')}
      </p>
    </div>
  </section>
);
