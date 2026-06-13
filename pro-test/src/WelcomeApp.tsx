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

function mayHaveClerkSession(): boolean {
  const cookies = document.cookie;
  if (/(?:^|;\s*)(?:__session|__client_uat|__clerk_)/.test(cookies)) return true;
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key?.toLowerCase().includes('clerk')) return true;
    }
  } catch {
    // Storage can be unavailable in private contexts; fall through to anonymous.
  }
  return false;
}

export default function WelcomeApp() {
  useEffect(() => {
    if (!mayHaveClerkSession()) return;
    let cancelled = false;
    import('./services/checkout')
      .then(({ ensureClerk }) => ensureClerk())
      .then((clerk) => {
        if (!cancelled && clerk.user) window.location.replace(DASHBOARD_PATH);
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
