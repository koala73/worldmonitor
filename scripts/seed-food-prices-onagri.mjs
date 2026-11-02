#!/usr/bin/env node
import { runFoodPriceSource } from './lib/food-prices-seed.mjs';
await runFoodPriceSource('onagri', import.meta.url);
