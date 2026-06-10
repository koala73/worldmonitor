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

export default function WelcomeApp() {
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
