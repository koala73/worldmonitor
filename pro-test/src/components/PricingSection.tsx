import { useState, useEffect, useCallback } from 'react';
import { motion } from 'motion/react';
import { Check, ArrowRight, Zap } from 'lucide-react';
import { startCheckout } from '../services/checkout';

// Static fallback from build-time generation (used while fetching live prices)
import fallbackTiers from '../generated/tiers.json';

interface Tier {
  name: string;
  description: string;
  features: string[];
  highlighted?: boolean;
  price?: number | null;
  period?: string;
  monthlyPrice?: number;
  annualPrice?: number | null;
  cta?: string;
  href?: string;
  monthlyProductId?: string;
  annualProductId?: string;
}

const CATALOG_API = 'https://api.worldmonitor.app/api/product-catalog';

function usePricingData(): Tier[] {
  const [tiers, setTiers] = useState<Tier[]>(fallbackTiers as Tier[]);

  useEffect(() => {
    let cancelled = false;
    fetch(CATALOG_API, { signal: AbortSignal.timeout(5000) })
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (!cancelled && data?.tiers?.length) {
          setTiers(data.tiers as Tier[]);
        }
      })
      .catch(() => { /* keep fallback */ });
    return () => { cancelled = true; };
  }, []);

  return tiers;
}

function formatPrice(tier: Tier, billing: 'monthly' | 'annual'): { amount: string; suffix: string } {
  // Free tier
  if (tier.price === 0) {
    return { amount: "$0", suffix: "forever" };
  }
  // Enterprise / custom
  if (tier.price === null && tier.monthlyPrice === undefined) {
    return { amount: "Custom", suffix: "tailored to you" };
  }
  // API tier (monthly only)
  if (tier.annualPrice === null && tier.monthlyPrice !== undefined) {
    return { amount: `$${tier.monthlyPrice}`, suffix: "/mo" };
  }
  // Pro tier with toggle
  if (billing === 'annual' && tier.annualPrice != null) {
    return { amount: `$${tier.annualPrice}`, suffix: "/yr" };
  }
  return { amount: `$${tier.monthlyPrice}`, suffix: "/mo" };
}

type CtaProps =
  | { type: 'link'; label: string; href: string; external: boolean }
  | { type: 'checkout'; label: string; productId: string };

function getCtaProps(tier: Tier, billing: 'monthly' | 'annual'): CtaProps {
  if (tier.cta && tier.href && tier.price === 0) {
    return { type: 'link', label: tier.cta, href: tier.href, external: true };
  }
  if (tier.cta && tier.href && tier.price === null) {
    return { type: 'link', label: tier.cta, href: tier.href, external: true };
  }
  if (tier.monthlyProductId) {
    const productId = (billing === 'annual' && tier.annualProductId) ? tier.annualProductId : tier.monthlyProductId;
    return { type: 'checkout', label: 'Get Started', productId };
  }
  return { type: 'link', label: 'Learn More', href: '#', external: false };
}

export function PricingSection({ refCode }: { refCode?: string }) {
  const [billing, setBilling] = useState<'monthly' | 'annual'>('monthly');
  const TIERS = usePricingData();

  const handleCheckout = useCallback((productId: string) => {
    startCheckout(productId, { referralCode: refCode });
  }, [refCode]);

  return (
    <section id="pricing" className="py-24 px-6 border-t border-wm-border bg-[#060606]">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="text-center mb-16">
          <motion.h2
            className="text-3xl md:text-5xl font-display font-bold mb-4"
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5 }}
          >
            Choose Your Plan
          </motion.h2>
          <motion.p
            className="text-wm-muted max-w-xl mx-auto mb-8"
            initial={{ opacity: 0, y: 10 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5, delay: 0.1 }}
          >
            From real-time monitoring to full intelligence infrastructure.
            Pick the tier that fits your mission.
          </motion.p>

          {/* Billing toggle */}
          <motion.div
            className="inline-flex items-center gap-3 bg-wm-card border border-wm-border rounded-sm p-1"
            initial={{ opacity: 0, y: 10 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5, delay: 0.2 }}
          >
            <button
              onClick={() => setBilling('monthly')}
              className={`px-4 py-2 rounded-sm font-mono text-xs uppercase tracking-wider transition-colors ${
                billing === 'monthly'
                  ? 'bg-wm-green text-wm-bg font-bold'
                  : 'text-wm-muted hover:text-wm-text'
              }`}
            >
              Monthly
            </button>
            <button
              onClick={() => setBilling('annual')}
              className={`px-4 py-2 rounded-sm font-mono text-xs uppercase tracking-wider transition-colors flex items-center gap-2 ${
                billing === 'annual'
                  ? 'bg-wm-green text-wm-bg font-bold'
                  : 'text-wm-muted hover:text-wm-text'
              }`}
            >
              Annual
              <span className={`text-[10px] px-1.5 py-0.5 rounded-sm ${
                billing === 'annual'
                  ? 'bg-wm-bg/20 text-wm-bg'
                  : 'bg-wm-green/10 text-wm-green'
              }`}>
                Save 17%
              </span>
            </button>
          </motion.div>
        </div>

        {/* Tier cards grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          {TIERS.map((tier, i) => {
            const price = formatPrice(tier, billing);
            const cta = getCtaProps(tier, billing);

            return (
              <motion.div
                key={tier.name}
                className={`relative bg-zinc-900 rounded-lg p-6 flex flex-col ${
                  tier.highlighted
                    ? 'border-2 border-wm-green shadow-lg shadow-wm-green/10'
                    : 'border border-wm-border'
                }`}
                initial={{ opacity: 0, y: 30 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.5, delay: i * 0.1 }}
              >
                {/* Most Popular badge */}
                {tier.highlighted && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2 inline-flex items-center gap-1 bg-wm-green text-wm-bg px-3 py-1 rounded-full text-xs font-mono font-bold uppercase tracking-wider">
                    <Zap className="w-3 h-3" aria-hidden="true" />
                    Most Popular
                  </div>
                )}

                {/* Tier name */}
                <h3 className={`font-display text-lg font-bold mb-1 ${
                  tier.highlighted ? 'text-wm-green' : 'text-wm-text'
                }`}>
                  {tier.name}
                </h3>

                {/* Description */}
                <p className="text-xs text-wm-muted mb-4">{tier.description}</p>

                {/* Price */}
                <div className="mb-6">
                  <span className="text-4xl font-display font-bold">{price.amount}</span>
                  <span className="text-sm text-wm-muted ml-1">/{price.suffix}</span>
                </div>

                {/* Features */}
                <ul className="space-y-3 mb-8 flex-1">
                  {tier.features.map((feature, fi) => (
                    <li key={fi} className="flex items-start gap-2 text-sm">
                      <Check className={`w-4 h-4 shrink-0 mt-0.5 ${
                        tier.highlighted ? 'text-wm-green' : 'text-wm-muted'
                      }`} aria-hidden="true" />
                      <span className="text-wm-muted">{feature}</span>
                    </li>
                  ))}
                </ul>

                {/* CTA button */}
                {cta.type === 'link' ? (
                  <a
                    href={cta.href}
                    target={cta.external ? "_blank" : undefined}
                    rel={cta.external ? "noreferrer" : undefined}
                    className={`block text-center py-3 rounded-sm font-mono text-xs uppercase tracking-wider font-bold transition-colors ${
                      tier.highlighted
                        ? 'bg-wm-green text-wm-bg hover:bg-green-400'
                        : 'border border-wm-border text-wm-muted hover:text-wm-text hover:border-wm-text'
                    }`}
                  >
                    {cta.label} <ArrowRight className="w-3.5 h-3.5 inline-block ml-1" aria-hidden="true" />
                  </a>
                ) : (
                  <button
                    onClick={() => handleCheckout(cta.productId)}
                    className={`block w-full text-center py-3 rounded-sm font-mono text-xs uppercase tracking-wider font-bold transition-colors cursor-pointer ${
                      tier.highlighted
                        ? 'bg-wm-green text-wm-bg hover:bg-green-400'
                        : 'border border-wm-border text-wm-muted hover:text-wm-text hover:border-wm-text'
                    }`}
                  >
                    {cta.label} <ArrowRight className="w-3.5 h-3.5 inline-block ml-1" aria-hidden="true" />
                  </button>
                )}
              </motion.div>
            );
          })}
        </div>

        {/* Discount code note */}
        <p className="text-center text-xs text-wm-muted font-mono mt-8">
          Have a promo code? Enter it during checkout.
        </p>
      </div>
    </section>
  );
}
