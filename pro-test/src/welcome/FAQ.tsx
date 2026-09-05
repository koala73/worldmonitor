import { ChevronDown } from 'lucide-react';
import { t } from '../i18n';
import { SectionHeading } from './SectionHeading';

type FaqLink = { label: string; href: string };

// An answer that ends in a destination carries it as a bare host-relative
// label inside the translated string, so the FAQPage JSON-LD (which mirrors
// the string verbatim) keeps the destination while the DOM renders it as a
// real anchor. The label is a URL, so the translator pins it and crawlers
// that do not run JavaScript still see the link (#7746).
const FAQ_LINKS: Record<number, FaqLink> = {
  5: { label: 'worldmonitor.app/compare/liveuamap-alternatives', href: '/compare/liveuamap-alternatives/' },
  11: { label: 'worldmonitor.app/docs/terms', href: '/docs/terms' },
};

const renderAnswer = (answer: string, link?: FaqLink) => {
  if (!link) return answer;
  const parts = answer.split(link.label);
  if (parts.length === 1) return answer;
  return parts.flatMap((part, i) => (i === 0
    ? [part]
    : [
        <a key={i} className="text-wm-green hover:text-green-300 transition-colors" href={link.href}>
          {link.label}
        </a>,
        part,
      ]));
};

export const FAQ = () => {
  const faqs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map(n => ({
    q: t(`welcome.faq.q${n}`),
    a: t(`welcome.faq.a${n}`),
    link: FAQ_LINKS[n],
    open: n === 1,
  }));

  return (
    <section id="faq" className="py-24 px-6 max-w-3xl mx-auto border-t border-wm-border">
      <SectionHeading eyebrow={t('welcome.faq.eyebrow')} title={t('welcome.faq.title')} />
      <div className="space-y-4">
        {faqs.map((faq, i) => (
          <details key={i} open={faq.open} className="group bg-wm-card border border-wm-border rounded-sm [&_summary::-webkit-details-marker]:hidden">
            <summary className="flex items-center justify-between p-6 cursor-pointer font-medium">
              {faq.q}
              <ChevronDown className="w-5 h-5 text-wm-muted group-open:rotate-180 transition-transform shrink-0 ml-4" aria-hidden="true" />
            </summary>
            <div className="px-6 pb-6 text-wm-muted text-sm border-t border-wm-border pt-4 mt-2">
              {renderAnswer(faq.a, faq.link)}
            </div>
          </details>
        ))}
      </div>
    </section>
  );
};
