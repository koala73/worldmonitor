#!/usr/bin/env node
import { runFoodPriceSource } from './lib/food-prices-seed.mjs';
await runFoodPriceSource('ocpv', import.meta.url);
