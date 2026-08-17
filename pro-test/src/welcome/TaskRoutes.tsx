import { Anchor, Newspaper, ShieldCheck } from 'lucide-react';
import { CardLinkArrow, cardLinkFocusRing } from './CardLink';
import { t } from '../i18n';

const TASK_ROUTES = [
  {
    key: 'verify',
    href: '/crises/?utm_source=welcome&utm_content=task-verify',
    eventTarget: 'welcome-task-verify',
    Icon: Newspaper,
  },
  {
    key: 'chokepoint',
    href: '/chokepoints/?utm_source=welcome&utm_content=task-chokepoint',
    eventTarget: 'welcome-task-chokepoint',
    Icon: Anchor,
  },
  {
    key: 'countryRisk',
    href: '/countries/?utm_source=welcome&utm_content=task-country-risk',
    eventTarget: 'welcome-task-country-risk',
    Icon: ShieldCheck,
  },
] as const;

export const TaskRoutes = () => (
  <section id="task-routes" className="border-y border-wm-border bg-wm-bg px-4 py-14 sm:px-6 md:py-16">
    <div className="mx-auto grid max-w-7xl gap-8 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.7fr)] lg:items-center lg:gap-12">
      <div className="max-w-xl">
        <div className="mb-3 font-mono text-[11px] uppercase tracking-[3px] text-wm-green">
          {t('welcome.tasks.eyebrow')}
        </div>
        <h2 className="font-display text-3xl font-bold tracking-tight md:text-4xl">
          {t('welcome.tasks.title')}
        </h2>
        <p className="mt-4 text-sm leading-relaxed text-wm-muted md:text-base">
          {t('welcome.tasks.sub')}
        </p>
      </div>

      <div className="grid overflow-hidden rounded-sm border border-wm-border bg-wm-card md:grid-cols-3">
        {TASK_ROUTES.map(({ key, href, eventTarget, Icon }, index) => (
          <a
            key={key}
            href={href}
            data-umami-event="welcome-cta"
            data-umami-event-target={eventTarget}
            className={`group flex min-h-48 flex-col p-5 transition-colors hover:bg-white/[0.03] ${cardLinkFocusRing} sm:p-6 ${index > 0 ? 'border-t border-wm-border md:border-s md:border-t-0' : ''}`}
          >
            <div className="mb-8 flex items-center justify-between">
              <Icon className="h-5 w-5 text-wm-green" aria-hidden="true" />
              <span className="font-mono text-[10px] tracking-[2px] text-wm-muted" aria-hidden="true">
                {String(index + 1).padStart(2, '0')}
              </span>
            </div>
            <h3 className="font-display text-xl font-bold leading-tight text-wm-text">
              {t(`welcome.tasks.${key}Title`)}
            </h3>
            <p className="mt-3 text-sm leading-relaxed text-wm-muted">
              {t(`welcome.tasks.${key}Desc`)}
            </p>
            <span className="mt-6 inline-flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wider text-wm-green">
              {t('welcome.tasks.open')}
              <CardLinkArrow />
            </span>
          </a>
        ))}
      </div>
    </div>
  </section>
);
