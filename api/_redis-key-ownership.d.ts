/**
 * True when the key is written by Vercel routes and must be read (and
 * written) with the deployment key prefix. Everything else in the api layer's
 * registry surface is seeder-owned and must be read raw. See the module
 * comment in _redis-key-ownership.js for the ownership contract (#7674).
 */
export declare function isAppOwnedRedisKey(key: unknown): boolean;
