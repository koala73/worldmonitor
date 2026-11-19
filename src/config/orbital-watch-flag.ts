/**
 * Orbital Watch ships dark (#10710): the satellite-pass lookup's entry points stay
 * off unless the build sets VITE_ENABLE_ORBITAL_WATCH=true.
 */
export const ORBITAL_WATCH_ENABLED = import.meta.env.VITE_ENABLE_ORBITAL_WATCH === 'true';
