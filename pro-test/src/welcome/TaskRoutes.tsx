import { Anchor, Newspaper, ShieldCheck } from 'lucide-react';
import { CardLinkArrow, cardLinkFocusRing } from './CardLink';
import { t } from '../i18n';
import depthProofStats from '../generated/depth-stats.json';

const TASK_ROUTES = [
  {
    key: 'verify',
    href: '/crises/',
    workflowHref: '/use-cases/verify-breaking-news/',
    eventTarget: 'welcome-task-verify',
    Icon: Newspaper,
  },
  {
    key: 'chokepoint',
    href: '/chokepoints/',
    workflowHref: '/use-cases/monitor-supply-chain-disruptions/',
    eventTarget: 'welcome-task-chokepoint',
    Icon: Anchor,
  },
  {
    key: 'countryRisk',
    href: '/countries/',
    workflowHref: '/use-cases/monitor-country-risk/',
    eventTarget: 'welcome-task-country-risk',
    Icon: ShieldCheck,
  },
] as const;

export const TaskRoutes = () => (
  <section id="task-routes" className="border-y border-wm-border bg-wm-bg px-4 py-14 sm:px-6 md:py-16">
    <div className="mx-auto grid max-w-7xl gap-8 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.7fr)] lg:items-center lg:gap-12">
      <div className="max-w-xl">
        <div className="mb-3 font-mono text-xs uppercase tracking-[3px] text-wm-green">
          {t('welcome.tasks.eyebrow')}
        </div>
        <h2 className="font-display text-3xl font-bold tracking-tight md:text-4xl">
          {t('welcome.tasks.title')}
        </h2>
        <p className="mt-4 text-sm leading-relaxed text-wm-muted md:text-base">
          {t('welcome.tasks.sub', { routes: TASK_ROUTES.length })}
        </p>
      </div>

      <div className="grid overflow-hidden rounded-sm border border-wm-border bg-wm-card md:grid-cols-3">
        {TASK_ROUTES.map(({ key, href, workflowHref, eventTarget, Icon }, index) => (
          // Two sibling links rather than one card-wide anchor: the evidence
          // view and the monitoring workflow for the same job.
          <div
            key={key}
            className={`flex min-h-48 flex-col transition-colors hover:bg-white/[0.03] ${index > 0 ? 'border-t border-wm-border md:border-s md:border-t-0' : ''}`}
          >
            <a
              href={href}
              data-umami-event="welcome-cta"
              data-umami-event-target={eventTarget}
              className={`group flex flex-1 flex-col p-5 pb-0 ${cardLinkFocusRing} sm:p-6 sm:pb-0`}
            >
              <div className="mb-8 flex items-center justify-between">
                <Icon className="h-5 w-5 text-wm-green" aria-hidden="true" />
                <span className="font-mono text-xs tracking-[2px] text-wm-muted" aria-hidden="true">
                  {String(index + 1).padStart(2, '0')}
                </span>
              </div>
              <h3 id={`task-${key}-title`} className="font-display text-xl font-bold leading-tight text-wm-text">
                {t(`welcome.tasks.${key}Title`)}
              </h3>
              <p className="mt-3 text-sm leading-relaxed text-wm-muted">
                {t(`welcome.tasks.${key}Desc`, depthProofStats)}
              </p>
              <span className="mt-auto inline-flex items-center gap-1.5 pt-6 font-mono text-xs uppercase tracking-wider text-wm-green">
                {t('welcome.tasks.open')}
                <CardLinkArrow />
              </span>
            </a>
            <a
              href={workflowHref}
              data-umami-event="welcome-cta"
              data-umami-event-target={`${eventTarget}-workflow`}
              // All three share the visible label; the card title makes each name unique.
              aria-labelledby={`task-${key}-workflow task-${key}-title`}
              className={`group inline-flex items-center gap-1.5 self-start px-5 pb-5 pt-3 font-mono text-xs uppercase tracking-wider text-wm-muted transition-colors hover:text-wm-text ${cardLinkFocusRing} sm:px-6 sm:pb-6`}
            >
              <span id={`task-${key}-workflow`}>{t('welcome.tasks.workflow')}</span>
              <CardLinkArrow />
            </a>
          </div>
        ))}
      </div>
    </div>
  </section>
);
