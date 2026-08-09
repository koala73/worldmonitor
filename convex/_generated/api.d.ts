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
import type * as apiKeys from "../apiKeys.js";
import type * as apiPlanLimitEmails from "../apiPlanLimitEmails.js";
import type * as apiPlanLimitNotices from "../apiPlanLimitNotices.js";
import type * as apiPlanLimitUsage from "../apiPlanLimitUsage.js";
import type * as broadcast__localeHeuristic from "../broadcast/_localeHeuristic.js";
import type * as broadcast__poolSelection from "../broadcast/_poolSelection.js";
import type * as broadcast__resendContacts from "../broadcast/_resendContacts.js";
import type * as broadcast_audienceExport from "../broadcast/audienceExport.js";
import type * as broadcast_audienceWaveExport from "../broadcast/audienceWaveExport.js";
import type * as broadcast_backfillCanaryWaveStamps from "../broadcast/backfillCanaryWaveStamps.js";
import type * as broadcast_metrics from "../broadcast/metrics.js";
import type * as broadcast_proLaunchEmailContent from "../broadcast/proLaunchEmailContent.js";
import type * as broadcast_rampRunner from "../broadcast/rampRunner.js";
import type * as broadcast_sendBroadcast from "../broadcast/sendBroadcast.js";
import type * as broadcast_waveRuns from "../broadcast/waveRuns.js";
import type * as companyMonitoring__shared from "../companyMonitoring/_shared.js";
import type * as companyMonitoring_accounts from "../companyMonitoring/accounts.js";
import type * as companyMonitoring_companies from "../companyMonitoring/companies.js";
import type * as companyMonitoring_imports from "../companyMonitoring/imports.js";
import type * as companyMonitoring_orchestration from "../companyMonitoring/orchestration.js";
import type * as companyMonitoring_validators from "../companyMonitoring/validators.js";
import type * as config_productCatalog from "../config/productCatalog.js";
import type * as constants from "../constants.js";
import type * as contactMessages from "../contactMessages.js";
import type * as crons from "../crons.js";
import type * as emailSuppressions from "../emailSuppressions.js";
import type * as entitlements from "../entitlements.js";
import type * as followedCountries from "../followedCountries.js";
import type * as http from "../http.js";
import type * as intelHistory from "../intelHistory.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_dodo from "../lib/dodo.js";
import type * as lib_emailDomain from "../lib/emailDomain.js";
import type * as lib_emailShape from "../lib/emailShape.js";
import type * as lib_entitlements from "../lib/entitlements.js";
import type * as lib_env from "../lib/env.js";
import type * as lib_identitySigning from "../lib/identitySigning.js";
import type * as lib_iso2 from "../lib/iso2.js";
import type * as lib_shards from "../lib/shards.js";
import type * as mcpProTokens from "../mcpProTokens.js";
import type * as notificationChannels from "../notificationChannels.js";
import type * as payments_backfillCustomerNormalizedEmail from "../payments/backfillCustomerNormalizedEmail.js";
import type * as payments_billing from "../payments/billing.js";
import type * as payments_businessSeats from "../payments/businessSeats.js";
import type * as payments_cacheActions from "../payments/cacheActions.js";
import type * as payments_checkout from "../payments/checkout.js";
import type * as payments_checkoutRateLimit from "../payments/checkoutRateLimit.js";
import type * as payments_returnUrlOrigin from "../payments/returnUrlOrigin.js";
import type * as payments_seedProductPlans from "../payments/seedProductPlans.js";
import type * as payments_subscriptionEmails from "../payments/subscriptionEmails.js";
import type * as payments_subscriptionHelpers from "../payments/subscriptionHelpers.js";
import type * as payments_unattributedPayments from "../payments/unattributedPayments.js";
import type * as payments_webhookHandlers from "../payments/webhookHandlers.js";
import type * as payments_webhookMutations from "../payments/webhookMutations.js";
import type * as registerInterest from "../registerInterest.js";
import type * as resendWebhookHandler from "../resendWebhookHandler.js";
import type * as telegramPairingTokens from "../telegramPairingTokens.js";
import type * as userPreferences from "../userPreferences.js";
import type * as users from "../users.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  alertRules: typeof alertRules;
  apiKeys: typeof apiKeys;
  apiPlanLimitEmails: typeof apiPlanLimitEmails;
  apiPlanLimitNotices: typeof apiPlanLimitNotices;
  apiPlanLimitUsage: typeof apiPlanLimitUsage;
  "broadcast/_localeHeuristic": typeof broadcast__localeHeuristic;
  "broadcast/_poolSelection": typeof broadcast__poolSelection;
  "broadcast/_resendContacts": typeof broadcast__resendContacts;
  "broadcast/audienceExport": typeof broadcast_audienceExport;
  "broadcast/audienceWaveExport": typeof broadcast_audienceWaveExport;
  "broadcast/backfillCanaryWaveStamps": typeof broadcast_backfillCanaryWaveStamps;
  "broadcast/metrics": typeof broadcast_metrics;
  "broadcast/proLaunchEmailContent": typeof broadcast_proLaunchEmailContent;
  "broadcast/rampRunner": typeof broadcast_rampRunner;
  "broadcast/sendBroadcast": typeof broadcast_sendBroadcast;
  "broadcast/waveRuns": typeof broadcast_waveRuns;
  "companyMonitoring/_shared": typeof companyMonitoring__shared;
  "companyMonitoring/accounts": typeof companyMonitoring_accounts;
  "companyMonitoring/companies": typeof companyMonitoring_companies;
  "companyMonitoring/imports": typeof companyMonitoring_imports;
  "companyMonitoring/orchestration": typeof companyMonitoring_orchestration;
  "companyMonitoring/validators": typeof companyMonitoring_validators;
  "config/productCatalog": typeof config_productCatalog;
  constants: typeof constants;
  contactMessages: typeof contactMessages;
  crons: typeof crons;
  emailSuppressions: typeof emailSuppressions;
  entitlements: typeof entitlements;
  followedCountries: typeof followedCountries;
  http: typeof http;
  intelHistory: typeof intelHistory;
  "lib/auth": typeof lib_auth;
  "lib/dodo": typeof lib_dodo;
  "lib/emailDomain": typeof lib_emailDomain;
  "lib/emailShape": typeof lib_emailShape;
  "lib/entitlements": typeof lib_entitlements;
  "lib/env": typeof lib_env;
  "lib/identitySigning": typeof lib_identitySigning;
  "lib/iso2": typeof lib_iso2;
  "lib/shards": typeof lib_shards;
  mcpProTokens: typeof mcpProTokens;
  notificationChannels: typeof notificationChannels;
  "payments/backfillCustomerNormalizedEmail": typeof payments_backfillCustomerNormalizedEmail;
  "payments/billing": typeof payments_billing;
  "payments/businessSeats": typeof payments_businessSeats;
  "payments/cacheActions": typeof payments_cacheActions;
  "payments/checkout": typeof payments_checkout;
  "payments/checkoutRateLimit": typeof payments_checkoutRateLimit;
  "payments/returnUrlOrigin": typeof payments_returnUrlOrigin;
  "payments/seedProductPlans": typeof payments_seedProductPlans;
  "payments/subscriptionEmails": typeof payments_subscriptionEmails;
  "payments/subscriptionHelpers": typeof payments_subscriptionHelpers;
  "payments/unattributedPayments": typeof payments_unattributedPayments;
  "payments/webhookHandlers": typeof payments_webhookHandlers;
  "payments/webhookMutations": typeof payments_webhookMutations;
  registerInterest: typeof registerInterest;
  resendWebhookHandler: typeof resendWebhookHandler;
  telegramPairingTokens: typeof telegramPairingTokens;
  userPreferences: typeof userPreferences;
  users: typeof users;
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

export declare const components: {
  dodopayments: import("@dodopayments/convex/_generated/component.js").ComponentApi<"dodopayments">;
};
