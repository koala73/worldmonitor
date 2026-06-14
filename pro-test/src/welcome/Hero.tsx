import { motion } from 'motion/react';
import { ArrowRight, Github } from 'lucide-react';
import { WiredBadge } from '../components/WiredBadge';
import { t } from '../i18n';
import { DASHBOARD_PATH } from '../routes';
import dashboardScreenshot from '../assets/worldmonitor-7-mar-2026.jpg';

const HERO_PROOF_STATS = [
  { valueKey: 'welcome.depth.s1v', labelKey: 'welcome.depth.s1l' },
  { valueKey: 'welcome.depth.s2v', labelKey: 'welcome.depth.s2l' },
  { valueKey: 'welcome.depth.s3v', labelKey: 'welcome.depth.s3l' },
  { valueKey: 'welcome.depth.s15v', labelKey: 'welcome.depth.s15l' },
] as const;

const HeroProofRail = () => (
  <motion.div
    initial={{ opacity: 0, y: 16 }}
    animate={{ opacity: 1, y: 0 }}
    transition={{ duration: 0.6, delay: 0.28 }}
    className="mt-8 mx-auto grid w-full max-w-[22rem] sm:max-w-3xl grid-cols-2 sm:grid-cols-4 overflow-hidden rounded-sm border border-wm-border bg-wm-card/70 text-left backdrop-blur-sm"
  >
    {HERO_PROOF_STATS.map(({ valueKey, labelKey }, i) => (
      <div
        key={valueKey}
        className={`px-4 py-3 ${i % 2 === 1 ? 'border-l border-wm-border' : ''} ${i > 1 ? 'border-t border-wm-border sm:border-t-0' : ''} ${i > 0 ? 'sm:border-l sm:border-wm-border' : ''}`}
      >
        <div className="font-display text-2xl font-bold text-wm-text">{t(valueKey)}</div>
        <div className="mt-1 font-mono text-[10px] uppercase tracking-[1px] leading-relaxed break-words text-wm-muted">{t(labelKey)}</div>
      </div>
    ))}
  </motion.div>
);

const ConsoleFrame = () => (
  <motion.div
    initial={{ opacity: 0, y: 32 }}
    animate={{ opacity: 1, y: 0 }}
    transition={{ duration: 0.7, delay: 0.35 }}
    className="relative max-w-5xl mx-auto mt-10 sm:mt-14"
  >
    <div className="absolute -inset-8 bg-wm-green/5 blur-[60px] rounded-full pointer-events-none" aria-hidden="true" />
    <a
      href={`${DASHBOARD_PATH}?ref=welcome-plate`}
      className="relative block border border-wm-border rounded-md overflow-hidden border-glow bg-wm-card hover:border-wm-green/40 transition-colors"
    >
      <div className="flex items-center justify-between gap-3 px-3 sm:px-4 h-9 border-b border-wm-border bg-wm-bg/80 font-mono text-[10px] uppercase tracking-widest text-wm-muted">
        <div className="flex items-center gap-1.5" aria-hidden="true">
          <span className="w-2.5 h-2.5 rounded-full bg-[#ff5f57]" />
          <span className="w-2.5 h-2.5 rounded-full bg-[#febc2e]" />
          <span className="w-2.5 h-2.5 rounded-full bg-[#28c840]" />
        </div>
        <span className="hidden sm:block">worldmonitor.app — global operations</span>
        <span className="inline-flex min-w-0 items-center gap-1.5 text-wm-green">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-wm-green opacity-60" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-wm-green" />
          </span>
          <span>{t('welcome.hero.plateNote')}</span>
        </span>
      </div>
      <img
        src={dashboardScreenshot}
        alt={t('welcome.hero.screenshotAlt')}
        className="w-full block"
        width="2752"
        height="1538"
        fetchPriority="high"
      />
    </a>
  </motion.div>
);

export const Hero = () => (
  <section className="pt-28 sm:pt-32 pb-16 px-4 sm:px-6 relative overflow-hidden">
    <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_0%,rgba(74,222,128,0.10)_0%,transparent_55%)] pointer-events-none" aria-hidden="true" />
    <div className="max-w-5xl mx-auto text-center relative z-10">
      <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6 }}>
        <div className="inline-flex max-w-full flex-wrap items-center justify-center gap-2 font-mono text-[11px] uppercase tracking-[4px] text-wm-green mb-5 px-3 py-1.5 rounded-full border border-wm-green/30 bg-wm-green/10 leading-relaxed">
          <span className="relative flex h-1.5 w-1.5" aria-hidden="true">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-wm-green opacity-60" />
            <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-wm-green" />
          </span>
          {t('welcome.hero.eyebrow')}
        </div>
        <h1 className="text-4xl sm:text-5xl md:text-7xl font-display font-bold tracking-tight leading-[1.08] sm:leading-[1.05]">
          {t('welcome.hero.headline1')}
          <br />
          <span className="text-wm-green text-glow">{t('welcome.hero.headline2')}</span>
        </h1>
        <p className="text-base md:text-lg text-wm-muted max-w-2xl mx-auto mt-6">
          {t('welcome.hero.sub')}
        </p>
      </motion.div>

      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, delay: 0.15 }}
        className="mt-9 mx-auto flex max-w-[22rem] sm:max-w-none flex-col sm:flex-row items-stretch sm:items-center justify-center gap-4"
      >
        <a
          href={`${DASHBOARD_PATH}?ref=welcome-hero`}
          className="w-full sm:w-auto justify-center bg-wm-green text-wm-bg px-5 sm:px-8 py-3.5 rounded-sm font-mono text-sm uppercase tracking-wide sm:tracking-wider font-bold hover:bg-green-400 transition-colors inline-flex items-center gap-2"
        >
          {t('welcome.hero.ctaPrimary')} <ArrowRight className="w-4 h-4" aria-hidden="true" />
        </a>
        <a
          href="#moments"
          className="w-full sm:w-auto justify-center border border-wm-border text-wm-text px-5 sm:px-8 py-3.5 rounded-sm font-mono text-sm uppercase tracking-wide sm:tracking-wider font-bold hover:border-wm-green/50 transition-colors inline-flex items-center"
        >
          {t('welcome.hero.ctaSecondary')}
        </a>
      </motion.div>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.6, delay: 0.25 }}
        className="mt-3 font-mono text-[11px] uppercase tracking-widest text-wm-muted"
      >
        {t('welcome.hero.ctaFree')}
      </motion.div>
      <HeroProofRail />

      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.6, delay: 0.3 }}
        className="mt-8 flex flex-wrap items-center justify-center gap-x-6 gap-y-3 text-xs font-mono text-wm-muted"
      >
        <WiredBadge />
        <span>{t('welcome.hero.trustUsers')}</span>
        <span aria-hidden="true" className="text-wm-border">|</span>
        <a
          href="https://github.com/koala73/worldmonitor"
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 hover:text-wm-text transition-colors"
        >
          <Github className="w-3.5 h-3.5" aria-hidden="true" /> {t('welcome.hero.trustOpenSource')}
        </a>
      </motion.div>
    </div>
    <ConsoleFrame />
  </section>
);
