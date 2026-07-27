/**
 * Entity registry — re-export of the dependency-free dataset in
 * `shared/entities-data.ts` so server-side (Edge/esbuild) consumers can import
 * it without pulling in anything from `src/`.
 *
 * Client code keeps importing `@/config/entities`; the data lives in shared/.
 */

export * from '../../shared/entities-data';
