import { useEffect } from 'react';
import { Nav } from './welcome/Nav';
import { Hero } from './welcome/Hero';
import { LiveStrip } from './welcome/LiveStrip';
import { Moments } from './welcome/Moments';
import { FirstFive } from './welcome/FirstFive';
import { Depth } from './welcome/Depth';
import { Agents } from './welcome/Agents';
import { PricingTeaser } from './welcome/PricingTeaser';
import { FAQ } from './welcome/FAQ';
import { FinalCta } from './welcome/FinalCta';
import { Footer } from './components/Footer';
import { maybeRedirectWelcomeVisitor } from './services/welcome-redirect';

export default function WelcomeApp() {
  useEffect(() => {
    // Send a returning, actively-signed-in visitor straight to the app. We
    // decide this from the live `__session` JWT alone so the Clerk SDK (~3MB)
    // never loads on the welcome critical path (issue #4428). Idle signed-in
    // users (expired `__session`) stay here and use the Launch CTA; /dashboard
    // validates auth either way, so it never bounces a signed-out visitor back
    // to /, and no redirect loop is possible.
    maybeRedirectWelcomeVisitor(document.cookie, window.location);
  }, []);

  return (
    <div className="min-h-screen selection:bg-wm-green/30 selection:text-wm-green">
      <Nav />
      <main>
        <Hero />
        <LiveStrip />
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
