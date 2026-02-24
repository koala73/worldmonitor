/**
 * Unified military service module.
 *
 * Re-exports from legacy service files that have complex client-side logic
 * (OpenSky/Wingbits polling, AIS streaming, trail tracking, surge analysis).
 * Server-side theater posture is consolidated in the handler.
 */

// Military flights (client-side OpenSky/Wingbits tracking)
export * from '../military-flights';

// Military vessels (client-side AIS tracking)
export * from '../military-vessels';

// Cached theater posture (client-side cache layer)
export * from '../cached-theater-posture';

// Military surge analysis (client-side posture computation)
export * from '../military-surge';
