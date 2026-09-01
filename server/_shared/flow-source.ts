import type { FlowSource } from '../../src/generated/server/worldmonitor/supply_chain/v1/service_server';

/**
 * The one FlowSource taxonomy shared by every surface that serves
 * `energy:chokepoint-flows:v1` (#6101 promoted the REST/OpenAPI/TS path;
 * #6113 brought the MCP cache tool onto the same set).
 *
 * Declared as an EXHAUSTIVE record over the non-UNSPECIFIED FlowSource
 * members so that adding a member to the proto is a compile error in every
 * consumer. A plain `Set<FlowSource>` caught a typo but not an omission —
 * the new member would simply be absent, and a consumer would silently strip
 * the very value the proto had just declared legal.
 */
const FLOW_SOURCE_MEMBERS: Record<Exclude<FlowSource, 'FLOW_SOURCE_UNSPECIFIED'>, true> = {
  'portwatch-dwt': true,
  'portwatch-counts': true,
};

/**
 * Module-private, along with the record above it: `narrowFlowSource` and
 * `FLOW_SOURCE_WIRE_VALUES` are this module's whole public surface, so there is
 * no exported handle a caller could rebuild a second predicate from. The axis
 * that drifts in practice is the predicate (case-folding, trimming, a legacy
 * alias), not the member list, so exporting either the set OR the record it is
 * derived from would leave the REST/MCP divergence #6113 exists to close —
 * `new Set(Object.keys(FLOW_SOURCE_MEMBERS))` is a one-line copy of this line.
 */
const FLOW_SOURCES: ReadonlySet<string> = new Set(Object.keys(FLOW_SOURCE_MEMBERS));

/**
 * Every wire value the taxonomy admits, UNSPECIFIED first — the `enum:` list
 * a schema surface declares. Deriving it from the record keeps declare and
 * serve on one source of truth.
 */
export const FLOW_SOURCE_WIRE_VALUES: readonly string[] = [
  'FLOW_SOURCE_UNSPECIFIED',
  ...Object.keys(FLOW_SOURCE_MEMBERS),
];

/**
 * Narrow an untyped seeder value onto the taxonomy. The chokepoint-flows blob
 * is written by a seeder that deploys independently of any consumer, so a
 * served `source` is not guaranteed to be a declared member — and a closed
 * taxonomy is only honest if the boundary that declares it also enforces it.
 *
 * Total over every input, including `undefined` (an entry that omits `source`
 * entirely): both surfaces must answer FLOW_SOURCE_UNSPECIFIED for that, so no
 * caller should guard on key presence before calling this.
 */
export function narrowFlowSource(value: unknown): FlowSource {
  if (typeof value === 'string' && FLOW_SOURCES.has(value)) return value as FlowSource;
  return 'FLOW_SOURCE_UNSPECIFIED';
}
