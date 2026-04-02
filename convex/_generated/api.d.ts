/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as alertRules from "../alertRules.js";
import type * as constants from "../constants.js";
import type * as contactMessages from "../contactMessages.js";
import type * as crons from "../crons.js";
import type * as http from "../http.js";
import type * as notificationChannels from "../notificationChannels.js";
import type * as registerInterest from "../registerInterest.js";
import type * as telegramPairingTokens from "../telegramPairingTokens.js";
import type * as userPreferences from "../userPreferences.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  alertRules: typeof alertRules;
  constants: typeof constants;
  contactMessages: typeof contactMessages;
  crons: typeof crons;
  http: typeof http;
  notificationChannels: typeof notificationChannels;
  registerInterest: typeof registerInterest;
  telegramPairingTokens: typeof telegramPairingTokens;
  userPreferences: typeof userPreferences;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
