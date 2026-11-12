#!/usr/bin/env node
import { runFoodPriceSource } from './lib/food-prices-seed.mjs';
await runFoodPriceSource('ucda', import.meta.url);
