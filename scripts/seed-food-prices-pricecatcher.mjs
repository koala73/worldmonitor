#!/usr/bin/env node
import { runFoodPriceSource } from './lib/food-prices-seed.mjs';
await runFoodPriceSource('pricecatcher', import.meta.url);
