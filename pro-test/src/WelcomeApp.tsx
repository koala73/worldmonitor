import { useEffect } from 'react';
import { Nav } from './welcome/Nav';
import { Hero } from './welcome/Hero';
import { TaskRoutes } from './welcome/TaskRoutes';
import { LiveStrip } from './welcome/LiveStrip';
import { WhatsNew } from './components/WhatsNew';
import { Moments } from './welcome/Moments';
import { FirstFive } from './welcome/FirstFive';
import { Depth } from './welcome/Depth';
import { Agents } from './welcome/Agents';
import { PricingTeaser } from './welcome/PricingTeaser';
import { FAQ } from './welcome/FAQ';
import { FinalCta } from './welcome/FinalCta';
import { Footer } from './components/Footer';
import { t } from './i18n';
import { readDocumentCookie } from './services/clerk-session';
import { maybeRedirectWelcomeVisitor } from './services/welcome-redirect';

export default function WelcomeApp() {
  useEffect(() => {
    // Send a returning, actively-signed-in visitor straight to the app. We
    // decide this from the live `__session` JWT alone so the Clerk SDK (~3MB)
    // never loads on the welcome critical path (issue #4428). Idle signed-in
    // users (expired `__session`) stay here and use the Launch CTA; /dashboard
    // validates auth either way, so it never bounces a signed-out visitor back
    // to /, and no redirect loop is possible.
    // readDocumentCookie() absorbs sandboxed-iframe SecurityError on cookie
    // access (Sentry WORLDMONITOR-14B) so the landing page still renders.
    maybeRedirectWelcomeVisitor(readDocumentCookie(), window.location);
  }, []);

  return (
    <div className="min-h-screen selection:bg-wm-green/30 selection:text-wm-green">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[60] focus:rounded-sm focus:bg-wm-green focus:px-4 focus:py-2 focus:font-mono focus:text-xs focus:font-bold focus:uppercase focus:tracking-wider focus:text-wm-bg"
      >
        {t('welcome.nav.skipToContent')}
      </a>
      <Nav />
      <main id="main-content" tabIndex={-1} className="focus:outline-none">
        <Hero />
        <TaskRoutes />
        <LiveStrip />
        <WhatsNew />
        <Moments />
        <FirstFive />
        <Depth />
        <Agents />
        <PricingTeaser />
        <FAQ />
        <FinalCta />
      </main>
      <Footer />
    </div>
  );
}
