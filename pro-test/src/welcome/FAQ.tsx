import { ChevronDown } from 'lucide-react';
import { t } from '../i18n';

export const FAQ = () => {
  const faqs = [1, 2, 3, 4, 5, 6, 7, 8].map(n => ({
    q: t(`welcome.faq.q${n}`),
    a: t(`welcome.faq.a${n}`),
    open: n === 1,
  }));

  return (
    <section id="faq" className="py-24 px-6 max-w-3xl mx-auto border-t border-wm-border">
      <h2 className="text-3xl font-display font-bold mb-12 text-center">{t('welcome.faq.title')}</h2>
      <div className="space-y-4">
        {faqs.map((faq, i) => (
          <details key={i} open={faq.open} className="group bg-wm-card border border-wm-border rounded-sm [&_summary::-webkit-details-marker]:hidden">
            <summary className="flex items-center justify-between p-6 cursor-pointer font-medium">
              {faq.q}
              <ChevronDown className="w-5 h-5 text-wm-muted group-open:rotate-180 transition-transform shrink-0 ml-4" aria-hidden="true" />
            </summary>
            <div className="px-6 pb-6 text-wm-muted text-sm border-t border-wm-border pt-4 mt-2">
              {faq.a}
            </div>
          </details>
        ))}
      </div>
    </section>
  );
};
