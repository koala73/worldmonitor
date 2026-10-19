import { OverviewView } from './overview.mjs';
import { NewsView } from './news.mjs';
import { MarketsView } from './markets.mjs';
import { ConflictView } from './conflict.mjs';
import { AirSeaView } from './airsea.mjs';
import { CyberView } from './cyber.mjs';
import { ClimateView } from './climate.mjs';
import { PredictionsView } from './predictions.mjs';
import { LiveView } from './live.mjs';
import { IntelView } from './intel.mjs';
import { SystemView } from './system.mjs';

export function createViews(app) {
  return [
    new OverviewView(app),
    new NewsView(app),
    new MarketsView(app),
    new ConflictView(app),
    new AirSeaView(app),
    new CyberView(app),
    new ClimateView(app),
    new PredictionsView(app),
    new LiveView(app),
    new IntelView(app),
    new SystemView(app),
  ];
}
