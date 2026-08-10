#!/usr/bin/env node
// Railway: dockerfilePath=Dockerfile.seed-bundle-resilience-validation.
// The Dockerfile wires NODE_OPTIONS --import to tsx's loader via absolute
// path so that dynamic imports of ../server/*.ts work in spawned children.
import { runBundle } from './_bundle-runner.mjs';
import {
  RESILIENCE_VALIDATION_BUNDLE_MEMBERS,
  RESILIENCE_VALIDATION_BUNDLE_NAME,
} from './resilience-validation-bundle.mjs';

await runBundle(RESILIENCE_VALIDATION_BUNDLE_NAME, RESILIENCE_VALIDATION_BUNDLE_MEMBERS);
