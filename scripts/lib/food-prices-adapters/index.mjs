// Per-source collectors for food-price publishers added after the original seven.
import * as tcb from './tcb.mjs';
import * as nabc from './nabc.mjs';
import * as nsckg from './nsckg.mjs';
import * as statkz from './statkz.mjs';
import * as statuz from './statuz.mjs';
import * as maga from './maga.mjs';
import * as ocpv from './ocpv.mjs';
import * as sima from './sima.mjs';
import * as mit from './mit.mjs';
import * as ucda from './ucda.mjs';
import * as amman from './amman.mjs';

export const FOOD_PRICE_ADAPTERS = { tcb, nabc, nsckg, statkz, statuz, maga, ocpv, sima, mit, ucda, amman };
