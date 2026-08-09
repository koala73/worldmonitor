import { v } from "convex/values";
import { COMPANY_MONITORING_IMPORT_VERSION } from "../../shared/company-monitoring-contract";

const monitoredCompanyInputFields = {
  name: v.string(),
  domicileCountry: v.string(),
  aliases: v.optional(v.array(v.string())),
  domains: v.optional(v.array(v.string())),
  identifiers: v.optional(v.array(v.string())),
  xHandles: v.optional(v.array(v.string())),
  locations: v.optional(v.array(v.string())),
  customerReference: v.optional(v.string()),
};

export const monitoredCompanyInputValidator = v.object(monitoredCompanyInputFields);

export const companyImportRowInputValidator = v.object({
  ...monitoredCompanyInputFields,
  clientImportId: v.string(),
  ordinal: v.number(),
});

export const normalizedCompanyImportRowValidator = v.object({
  name: v.string(),
  domicileCountry: v.union(v.literal("US"), v.literal("GB")),
  aliases: v.array(v.string()),
  domains: v.array(v.string()),
  identifiers: v.array(v.string()),
  xHandles: v.array(v.string()),
  locations: v.array(v.string()),
  customerReference: v.optional(v.string()),
  contractVersion: v.literal(COMPANY_MONITORING_IMPORT_VERSION),
  clientImportId: v.string(),
  ordinal: v.number(),
});

export const companyPatchValidator = v.object({
  name: v.optional(v.string()),
  domicileCountry: v.optional(v.string()),
  customerReference: v.optional(v.string()),
  addClaims: v.optional(v.array(v.object({
    type: v.string(),
    value: v.string(),
  }))),
  removeClaimIds: v.optional(v.array(v.string())),
});
