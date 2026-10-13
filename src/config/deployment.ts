/** Explicit build setting for an operator's self-hosted dashboard. */
export const IS_SELF_HOSTED = typeof window !== 'undefined' && import.meta.env.VITE_SELF_HOSTED === '1';
