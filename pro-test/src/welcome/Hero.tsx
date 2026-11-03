import { motion } from 'motion/react';
import { ArrowRight, Github } from 'lucide-react';
import { WiredBadge } from '../components/WiredBadge';
import { currentLanguageBase, t } from '../i18n';
import { DASHBOARD_PATH } from '../routes';
import {
  DASHBOARD_SCREENSHOT_JPG,
  DASHBOARD_SCREENSHOT_WIDTH,
  DASHBOARD_SCREENSHOT_HEIGHT,
  DASHBOARD_SCREENSHOT_AVIF_SRCSET,
  DASHBOARD_SCREENSHOT_WEBP_SRCSET,
} from '../assets/dashboard-screenshot';
import { SILICON_CANALS_2M_URL } from '../../../shared/press';
import heroProofStats from '../generated/hero-stats.json';
import depthProofStats from '../generated/depth-stats.json';
import { PUBLISHED_PULSE_DATE, formatLocalizedDate } from '../services/teasers';

const HERO_IMAGE_SIZES = '(min-width: 1072px) 1024px, (min-width: 640px) calc(100vw - 3rem), calc(100vw - 2rem)';

// Homepage proof numerals are measured at build time (see heroProofStats in
// scripts/generate-public-product-facts.mjs), never hardcoded adjectives.
// Labels stay in locale files; numerals bypass i18n because they are universal.
const HERO_PROOF_STATS = [
  { value: String(heroProofStats.mapLayers), labelKey: 'welcome.depth.s1l' },
  { value: String(heroProofStats.feeds), labelKey: 'welcome.depth.s2l' },
  {
    value: String(heroProofStats.providers),
    labelKey: 'welcome.depth.s3l',
    href: '/sources/',
  },
  { value: String(heroProofStats.alertOrigins), labelKey: 'welcome.depth.s15l' },
] as const;

const HeroProofRail = () => (
  <motion.div
    initial={false}
    animate={{ opacity: 1, y: 0 }}
    transition={{ duration: 0.6, delay: 0.28 }}
    className="mt-12 mx-auto grid w-full max-w-[22rem] sm:max-w-3xl grid-cols-2 sm:grid-cols-4 overflow-hidden rounded-md border border-wm-border bg-wm-card text-left"
  >
    {HERO_PROOF_STATS.map((stat, i) => {
      const className = `px-4 py-3 ${i % 2 === 1 ? 'border-l border-wm-border' : ''} ${i > 1 ? 'border-t border-wm-border sm:border-t-0' : ''} ${i > 0 ? 'sm:border-l sm:border-wm-border' : ''}`;
      const content = (
        <>
          <div className="font-display text-2xl font-medium tabular-nums text-wm-text">{stat.value}</div>
          <div className="mt-1 font-mono text-xs leading-relaxed break-words text-wm-muted">{t(stat.labelKey)}</div>
        </>
      );
      return 'href' in stat ? (
        <a
          key={stat.labelKey}
          href={stat.href}
          data-umami-event="welcome-cta"
          data-umami-event-target="welcome-sources-proof"
          className={`${className} hover:bg-white/[0.03] transition-colors`}
        >
          {content}
        </a>
      ) : <div key={stat.labelKey} className={className}>{content}</div>;
    })}
  </motion.div>
);

// The product is the hero's visual, so it rises into the first screen right
// under the actions. The bar names the window and carries the one live dot on
// the page; the image itself is a capture, so the dot is static, not pinging.
const ConsoleFrame = () => (
  <motion.div
    initial={false}
    animate={{ opacity: 1, y: 0 }}
    transition={{ duration: 0.7, delay: 0.2 }}
    className="relative max-w-5xl mx-auto mt-12 sm:mt-16"
  >
    <a
      href={DASHBOARD_PATH}
      data-umami-event="welcome-cta"
      data-umami-event-target="welcome-plate"
      className="relative block border border-wm-border rounded-xl overflow-hidden bg-wm-card hover:border-white/20 transition-colors"
    >
      <div className="flex items-center justify-between gap-3 px-4 h-10 border-b border-wm-border bg-wm-bg font-mono text-xs text-wm-muted">
        <span className="hidden sm:block truncate">worldmonitor.app/dashboard</span>
        <span className="inline-flex min-w-0 items-center gap-2">
          <span className="h-2 w-2 shrink-0 rounded-full bg-wm-green" aria-hidden="true" />
          <span className="truncate">{t('welcome.hero.plateNote')}</span>
        </span>
      </div>
      <picture>
        <source type="image/avif" srcSet={DASHBOARD_SCREENSHOT_AVIF_SRCSET} sizes={HERO_IMAGE_SIZES} />
        <source type="image/webp" srcSet={DASHBOARD_SCREENSHOT_WEBP_SRCSET} sizes={HERO_IMAGE_SIZES} />
        <img
          src={DASHBOARD_SCREENSHOT_JPG}
          alt={t('welcome.hero.screenshotAlt')}
          className="w-full block"
          width={DASHBOARD_SCREENSHOT_WIDTH}
          height={DASHBOARD_SCREENSHOT_HEIGHT}
          fetchPriority="high"
          decoding="async"
        />
      </picture>
    </a>
  </motion.div>
);

export const Hero = () => (
  <section data-wm-hero="welcome" className="pt-28 sm:pt-32 pb-24 px-4 sm:px-6">
    <div className="max-w-5xl mx-auto text-center">
      <motion.div initial={false} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}>
        <div className="mb-6 font-mono text-xs text-wm-muted">{t('welcome.hero.eyebrow')}</div>
        <h1 className="text-4xl sm:text-5xl md:text-7xl font-display font-medium tracking-tight leading-[1.05]">
          {t('welcome.hero.headline1')}
          <br />
          <span className="text-wm-green">{t('welcome.hero.headline2')}</span>
        </h1>
        <p className="mx-auto mt-6 max-w-2xl text-base md:text-lg text-wm-muted">
          {t('welcome.hero.sub')}
        </p>
        <p className="mt-2 font-mono text-xs text-wm-muted">
          <time dateTime={PUBLISHED_PULSE_DATE}>
            {t('welcome.hero.asOf', { date: formatLocalizedDate(PUBLISHED_PULSE_DATE, currentLanguageBase()) })}
          </time>
        </p>
      </motion.div>

      <div className="mt-8 mx-auto flex max-w-[22rem] sm:max-w-none flex-col sm:flex-row items-stretch sm:items-center justify-center gap-2 sm:gap-4">
        <a
          href={DASHBOARD_PATH}
          data-umami-event="welcome-cta"
          data-umami-event-target="welcome-hero"
          className="inline-flex min-h-12 py-3 items-center justify-center gap-2 rounded-md bg-wm-green px-6 text-sm font-medium text-wm-bg transition-colors hover:bg-green-300"
        >
          {t('welcome.hero.ctaPrimary')} <ArrowRight className="w-4 h-4" aria-hidden="true" />
        </a>
        <a
          href="#moments"
          className="inline-flex min-h-12 py-3 items-center justify-center rounded-md px-4 text-sm font-medium text-wm-text transition-colors hover:bg-white/[0.06]"
        >
          {t('welcome.hero.ctaSecondary')}
        </a>
      </div>
      <div className="mt-4 font-mono text-xs text-wm-muted">
        {t('welcome.hero.ctaFree')}
      </div>
    </div>

    <ConsoleFrame />

    <div className="max-w-5xl mx-auto text-center">
      <HeroProofRail />

      <div className="mt-8 flex flex-wrap items-center justify-center gap-x-6 gap-y-3 text-xs font-mono text-wm-muted">
        <WiredBadge />
        <a
          href={SILICON_CANALS_2M_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-wm-text transition-colors"
          title="2M+ users — Silicon Canals"
        >
          {t('welcome.hero.trustUsers')}
        </a>
        <span aria-hidden="true" className="text-wm-border">|</span>
        <a
          href="https://github.com/koala73/worldmonitor"
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-2 hover:text-wm-text transition-colors"
        >
          <Github className="w-3.5 h-3.5" aria-hidden="true" /> {t('welcome.hero.trustOpenSource')}
        </a>
        <span aria-hidden="true" className="text-wm-border">|</span>
        {/* Builder self-identification cue — surface names stay untranslated. */}
        <a href="#agents" className="hover:text-wm-text transition-colors">
          <span className="text-wm-text">{t('welcome.hero.trustBuild')}</span> REST API · MCP · npm · PyPI · Go · RubyGems
        </a>
      </div>
      <div className="mx-auto mt-16 max-w-2xl text-center">
        <h2 className="font-display text-xl font-medium text-wm-text">{t('welcome.hero.whatIsTitle')}</h2>
        <p className="welcome-seo-summary mt-3 text-sm leading-relaxed text-wm-muted">{t('welcome.hero.whatIsBody', depthProofStats)}</p>
        <p className="mt-3 text-sm leading-relaxed text-wm-muted">{t('welcome.hero.whatIsBestFor')}</p>
        <a
          href="/blog/posts/worldmonitor-is-not-palantir/"
          data-umami-event="welcome-cta"
          data-umami-event-target="welcome-positioning"
          className="mt-4 inline-flex items-center gap-2 font-mono text-xs text-wm-muted hover:text-wm-green transition-colors"
        >
          {t('welcome.hero.positioningLink')} <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
        </a>
      </div>
    </div>
  </section>
);
