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
import * as madr from './madr.mjs';
import * as nsomn from './nsomn.mjs';
import { FEWS_COUNTRIES, fewsAdapter } from './fews.mjs';
import * as twmoa from './twmoa.mjs';
import * as geostat from './geostat.mjs';
import * as pricecatcher from './pricecatcher.mjs';
import * as mcba from './mcba.mjs';
import * as cso from './cso.mjs';
import * as statec from './statec.mjs';
import { FOAG_CUBES, foagAdapter } from './foag.mjs';
import * as csblv from './csblv.mjs';
import * as makstat from './makstat.mjs';

export const FOOD_PRICE_ADAPTERS = { tcb, nabc, nsckg, statkz, statuz, maga, ocpv, sima, mit, ucda, amman, madr, nsomn,
  ...Object.fromEntries(Object.entries(FEWS_COUNTRIES).map(([id, country]) => [id, fewsAdapter(country)])),
  twmoa, geostat, pricecatcher, mcba, cso, statec,
  ...Object.fromEntries(Object.entries(FOAG_CUBES).map(([id, cube]) => [id, foagAdapter(cube)])), csblv, makstat };
