#!/usr/bin/env node
import { runBorderSource } from './lib/border-route-sources.mjs';
await runBorderSource('uk', import.meta.url);
