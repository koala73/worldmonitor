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
import { DASHBOARD_PATH } from './routes';
import { hasLikelyLiveClerkSession } from './services/clerk-session';

function mayHaveClerkSession(): boolean {
  return hasLikelyLiveClerkSession(document.cookie);
}

function dashboardRedirectTarget(): string {
  return `${DASHBOARD_PATH}${window.location.search}${window.location.hash}`;
}

export default function WelcomeApp() {
  useEffect(() => {
    if (!mayHaveClerkSession()) return;
    let cancelled = false;
    import('./services/clerk')
      .then(({ ensureClerk }) => ensureClerk())
      .then((clerk) => {
        if (!cancelled && clerk.user) window.location.replace(dashboardRedirectTarget());
      })
      .catch(() => {
        // Auth is optional for the public landing page; anonymous visitors keep reading.
      });
    return () => { cancelled = true; };
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
