import { Nav } from './welcome/Nav';
import { Hero } from './welcome/Hero';
import { LiveStrip } from './welcome/LiveStrip';
import { Pillars } from './welcome/Pillars';
import { UseCases } from './welcome/UseCases';
import { Nuggets } from './welcome/Nuggets';
import { Stats } from './welcome/Stats';
import { Variants } from './welcome/Variants';
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
        <Pillars />
        <UseCases />
        <Nuggets />
        <Stats />
        <Variants />
        <PricingTeaser />
        <FAQ />
        <FinalCta />
      </main>
      <Footer />
    </div>
  );
}
