#!/usr/bin/env node
import { runBorderSource } from './lib/border-route-sources.mjs';
await runBorderSource('cbp', import.meta.url);
