// Registry of published research report editions. The corpus build renders one
// static page per entry plus the /research/ hub. Editions are append-only:
// correct a published report by bumping its `version` and `dateModified`, never
// by silently rewriting history.

import { REPORT as hormuzTransit202607 } from './strait-of-hormuz-transit-report-2026-07.mjs';

export const RESEARCH_REPORTS = [hormuzTransit202607];
