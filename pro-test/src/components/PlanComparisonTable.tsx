import { Check } from 'lucide-react';
import { currentLanguageBase, t } from '../i18n';
import tiersJson from '../generated/tiers.json';

/**
 * Plan comparison on /pro. Every quota cell is read from the generated catalog
 * (pro-test/src/generated/tiers.json, written by scripts/generate-product-config.mjs)
 * so the table cannot drift from the pricing cards or public/pricing.md. Columns
 * follow the pricing cards' Personal / Commercial axis.
 */

interface PlanLimits {
  apiRequestsPerDay: number;
  mcpCallsPerDay: number;
  dashboardAiCallsPerDay: number;
  mcpDailyBudgetSharedWithRest: boolean;
}

interface GeneratedTier {
  name: string;
  localeKey: string;
  price?: number | null;
  monthlyPrice?: number;
  planLimits: PlanLimits;
  maxDashboards: number;
  dataExport: boolean;
}

const TIERS = tiersJson as unknown as GeneratedTier[];

const PERSONAL = ['free', 'pro'];
const COMMERCIAL = ['proBusiness', 'api', 'apiBusiness', 'enterprise'];
const ORDER = [...PERSONAL, ...COMMERCIAL];

// Seat counts are licence terms, not catalog limits: one named user on every
// self-serve plan, five bundled Pro seats on API Business (public/pricing.md).
const SEATS: Record<string, number> = { pro: 1, proBusiness: 1, api: 1, apiBusiness: 5 };
const SUPPORT: Record<string, string> = {
  free: 'pricingTable.supportStandard',
  pro: 'pricingTable.supportStandard',
  proBusiness: 'pricingTable.supportPriority',
  api: 'pricingTable.supportStandard',
  apiBusiness: 'pricingTable.supportPriority',
  enterprise: 'pricingTable.supportDedicated',
};
const LICENSE: Record<string, string> = {
  free: 'pricing.axisPersonal',
  pro: 'pricing.axisPersonal',
  proBusiness: 'pricingTable.licClient',
  api: 'pricingTable.licInternal',
  apiBusiness: 'pricingTable.licCustomer',
  enterprise: 'pricing.amountCustom',
};

type Cell = { text: string; note?: string; included?: boolean; strong?: boolean };

const NONE: Cell = { text: '—' };

export const PlanComparisonTable = () => {
  const nf = new Intl.NumberFormat(currentLanguageBase());
  const tiers = ORDER
    .map(key => TIERS.find(tier => tier.localeKey === key))
    .filter((tier): tier is GeneratedTier => !!tier);
  const isEnterprise = (tier: GeneratedTier) => tier.localeKey === 'enterprise';
  // Enterprise quotas are the contract default; more is sold by contract.
  const quota = (tier: GeneratedTier, n: number): Cell =>
    n > 0 ? { text: isEnterprise(tier) ? `${nf.format(n)}+` : nf.format(n) } : NONE;

  const rows: Array<{ label: string; cell: (tier: GeneratedTier) => Cell }> = [
    {
      label: t('pricingTable.rowPrice'),
      cell: tier => {
        if (tier.price === 0) return { text: '$0', strong: true };
        if (typeof tier.monthlyPrice === 'number') {
          return { text: `$${tier.monthlyPrice.toFixed(2)}${t('pricing.suffixPerMonth')}`, strong: true };
        }
        return { text: t('pricing.amountCustom'), strong: true };
      },
    },
    { label: t('pricingTable.rowLicense'), cell: tier => ({ text: t(LICENSE[tier.localeKey] ?? 'pricing.amountCustom') }) },
    {
      label: t('pricingTable.rowUsers'),
      cell: tier => {
        if (tier.localeKey === 'free') return { text: t('pricingTable.noAccount') };
        const seats = SEATS[tier.localeKey];
        return seats ? { text: nf.format(seats) } : { text: t('pricing.amountCustom') };
      },
    },
    {
      label: t('pricingTable.rowDashboards'),
      cell: tier => ({ text: tier.maxDashboards < 0 ? t('pricingTable.fUnlimited') : nf.format(tier.maxDashboards) }),
    },
    { label: t('pricingTable.rowAi'), cell: tier => quota(tier, tier.planLimits.dashboardAiCallsPerDay) },
    {
      label: t('pricingTable.rowMcp'),
      cell: tier => {
        if (tier.localeKey === 'free') return { text: t('pricingTable.freeMcp') };
        const cell = quota(tier, tier.planLimits.mcpCallsPerDay);
        return tier.planLimits.mcpDailyBudgetSharedWithRest ? { ...cell, note: t('pricingTable.sharedWithRest') } : cell;
      },
    },
    { label: t('pricingTable.rowApi'), cell: tier => quota(tier, tier.planLimits.apiRequestsPerDay) },
    {
      label: t('pricingTable.rowExport'),
      cell: tier => (tier.dataExport ? { text: t('pricingTable.fIncluded'), included: true } : { text: t('pricingTable.notIncluded'), included: false }),
    },
    {
      label: t('pricingTable.rowRedistribution'),
      cell: tier => {
        if (tier.localeKey === 'apiBusiness') return { text: 'R1–R3' };
        if (isEnterprise(tier)) return { text: t('pricing.amountCustom') };
        return NONE;
      },
    },
    { label: t('pricingTable.rowSupport'), cell: tier => ({ text: t(SUPPORT[tier.localeKey] ?? 'pricingTable.supportStandard') }) },
  ];

  const highlight = (tier: GeneratedTier) => tier.localeKey === 'pro';
  const groupStart = (tier: GeneratedTier) => tier.localeKey === COMMERCIAL[0];

  const renderCell = (cell: Cell) => {
    if (cell.included === true) {
      return (
        <>
          <Check className="w-4 h-4 text-wm-green inline-block" aria-hidden="true" />
          <span className="sr-only">{cell.text}</span>
        </>
      );
    }
    if (cell.included === false) {
      return (
        <>
          <span aria-hidden="true">{'—'}</span>
          <span className="sr-only">{cell.text}</span>
        </>
      );
    }
    return (
      <>
        <span className={cell.strong ? 'font-bold text-wm-text' : undefined}>{cell.text}</span>
        {cell.note && <span className="block text-xs text-wm-muted mt-0.5">{cell.note}</span>}
      </>
    );
  };

  return (
    <section className="py-24 px-6 max-w-7xl mx-auto" id="compare">
      <div className="text-center mb-12">
        <h2 className="text-3xl md:text-5xl font-display font-bold mb-6">{t('pricingTable.title')}</h2>
      </div>
      <p className="lg:hidden text-center font-mono text-xs text-wm-muted mb-3">{t('pricingTable.scrollHint')}</p>
      {/* relative: positioned descendants (sticky cells) must resolve inside the scroll box, or a phone lays the whole page out at the table's 820px width. */}
      <div className="relative overflow-x-auto border border-wm-border rounded-sm">
        <table className="w-full min-w-[820px] border-collapse text-sm">
          <caption className="sr-only">{t('pricingTable.title')}</caption>
          <thead>
            <tr className="font-mono text-xs uppercase tracking-widest text-wm-muted bg-wm-card">
              <th scope="col" className="sticky left-0 z-10 bg-wm-card" />
              <th scope="colgroup" colSpan={PERSONAL.length} className="px-4 pt-4 pb-1 text-left font-normal">
                {t('pricing.axisPersonal')} <span className="normal-case tracking-normal">· {t('pricing.axisPersonalNote')}</span>
              </th>
              <th scope="colgroup" colSpan={COMMERCIAL.length} className="px-4 pt-4 pb-1 text-left font-normal border-l border-wm-border">
                {t('pricing.axisCommercial')} <span className="normal-case tracking-normal">· {t('pricing.axisCommercialNote')}</span>
              </th>
            </tr>
            <tr className="border-b border-wm-border bg-wm-card">
              <th scope="col" className="sticky left-0 z-10 bg-wm-card px-4 py-3 text-left font-mono text-xs uppercase tracking-widest text-wm-muted font-normal">
                {t('pricingTable.feature')}
              </th>
              {tiers.map(tier => (
                <th
                  key={tier.localeKey}
                  scope="col"
                  className={`px-4 py-3 text-left font-display text-base font-bold ${highlight(tier) ? 'text-wm-green' : 'text-wm-text'} ${groupStart(tier) ? 'border-l border-wm-border' : ''}`}
                >
                  {tier.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(row => (
              <tr key={row.label} className="border-b border-wm-border/50 last:border-b-0 hover:bg-wm-card/50 transition-colors">
                <th scope="row" className="sticky left-0 z-10 bg-wm-bg px-4 py-3 text-left font-medium align-top w-36 min-w-[9rem] lg:w-56">
                  {row.label}
                </th>
                {tiers.map(tier => (
                  <td
                    key={tier.localeKey}
                    className={`px-4 py-3 align-top text-wm-muted ${highlight(tier) ? 'bg-wm-green/5' : ''} ${groupStart(tier) ? 'border-l border-wm-border' : ''}`}
                  >
                    {renderCell(row.cell(tier))}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-center text-sm text-wm-muted mt-8">
        {t('pricingTable.noteBelow')}
      </p>
    </section>
  );
};
