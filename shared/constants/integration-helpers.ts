import type { IntegrationToolEntry } from "../types/tools.js";
import {
  CredentialScope,
  INTEGRATION_REGISTRY,
  type IntegrationRegistryEntry,
  PERSONAL_SETTINGS_SECTION,
} from "./integrations.js";

type FilterKeys<T, V> = { [K in keyof T]: T[K] extends V ? K : never }[keyof T];

export type IntegrationId = keyof typeof INTEGRATION_REGISTRY;
export type ToggleableIntegrationId = FilterKeys<typeof INTEGRATION_REGISTRY, { toggleable: true }>;
export type BusinessWideIntegrationId = {
  [
    K in keyof typeof INTEGRATION_REGISTRY
  ]: typeof CredentialScope.BUSINESS extends (typeof INTEGRATION_REGISTRY)[K]["credentialScopes"][number] ? K : never;
}[keyof typeof INTEGRATION_REGISTRY];
export type UserApiKeyProviderId = {
  [
    K in keyof typeof INTEGRATION_REGISTRY
  ]: (typeof INTEGRATION_REGISTRY)[K]["personalSettingsSection"] extends typeof PERSONAL_SETTINGS_SECTION.API_KEY
    ? K
    : never;
}[keyof typeof INTEGRATION_REGISTRY];
export type UserOAuthIntegrationId = {
  [
    K in keyof typeof INTEGRATION_REGISTRY
  ]: (typeof INTEGRATION_REGISTRY)[K]["personalSettingsSection"] extends typeof PERSONAL_SETTINGS_SECTION.OAUTH
    ? K
    : never;
}[keyof typeof INTEGRATION_REGISTRY];
function integrationIds<T extends Record<string, unknown>>(obj: T): (keyof T & string)[] {
  return Object.keys(obj) as (keyof T & string)[];
}

export const INTEGRATION_IDS = integrationIds(INTEGRATION_REGISTRY) as IntegrationId[];

export const TOGGLEABLE_INTEGRATION_IDS = INTEGRATION_IDS.filter(
  (id) => INTEGRATION_REGISTRY[id].toggleable,
) as ToggleableIntegrationId[];

export const BUSINESS_WIDE_INTEGRATION_IDS = INTEGRATION_IDS.filter((id) =>
  (INTEGRATION_REGISTRY[id] as IntegrationRegistryEntry).credentialScopes.includes(CredentialScope.BUSINESS),
) as BusinessWideIntegrationId[];

export const BUSINESS_ONLY_INTEGRATION_IDS = INTEGRATION_IDS.filter((id) => {
  const credentialScopes = (INTEGRATION_REGISTRY[id] as IntegrationRegistryEntry).credentialScopes;
  return credentialScopes.includes(CredentialScope.BUSINESS) && !credentialScopes.includes(CredentialScope.USER);
}) as BusinessWideIntegrationId[];

export const USER_OAUTH_INTEGRATION_IDS = INTEGRATION_IDS.filter(
  (id) => INTEGRATION_REGISTRY[id].personalSettingsSection === PERSONAL_SETTINGS_SECTION.OAUTH,
) as UserOAuthIntegrationId[];

export const USER_API_KEY_PROVIDER_IDS = INTEGRATION_IDS.filter(
  (id) => INTEGRATION_REGISTRY[id].personalSettingsSection === PERSONAL_SETTINGS_SECTION.API_KEY,
) as UserApiKeyProviderId[];

// A customer-facing integration is shown in the product settings UI. Setting
// customerFacing:false hides it from every customer-facing settings surface (personal API
// keys, personal OAuth, and business integrations) while leaving backend allowlists,
// credential storage, validation, and spawn-time resolution intact. Honor this anywhere a
// customer-facing integration list is rendered so the flag is not silently ignored for a
// given personalSettingsSection. The cast mirrors the optional-field pattern used for `tools`.
export function isCustomerFacingIntegration(id: IntegrationId): boolean {
  return (INTEGRATION_REGISTRY[id] as IntegrationRegistryEntry).customerFacing !== false;
}

// UI-only view of USER_API_KEY_PROVIDER_IDS: drops integrations flagged customerFacing:false.
// The backend keeps using USER_API_KEY_PROVIDER_IDS; this list is for customer-facing
// rendering only. Value-level filter — it deliberately does not narrow UserApiKeyProviderId.
export const CUSTOMER_FACING_API_KEY_PROVIDER_IDS = USER_API_KEY_PROVIDER_IDS.filter(
  isCustomerFacingIntegration,
) as UserApiKeyProviderId[];

export const INTEGRATION_DISPLAY_NAMES = Object.fromEntries(
  INTEGRATION_IDS.map((id) => [id, INTEGRATION_REGISTRY[id].displayName]),
) as Record<IntegrationId, string>;

export const LIFECYCLE_DEBUG_INTEGRATION_IDS = INTEGRATION_IDS.filter(
  (id) => INTEGRATION_REGISTRY[id].lifecycleSupport === "instrumented",
) as IntegrationId[];

const LIFECYCLE_DEBUG_INTEGRATION_ID_SET = new Set<string>(LIFECYCLE_DEBUG_INTEGRATION_IDS);

export function isLifecycleDebugIntegrationId(value: string): value is IntegrationId {
  return LIFECYCLE_DEBUG_INTEGRATION_ID_SET.has(value);
}

// Integration scope values (used by business integration settings)
export const INTEGRATION_SCOPES = ["disabled", "user", "business"] as const;
export type IntegrationScope = (typeof INTEGRATION_SCOPES)[number];

// Prebuilt sets for O(1) lookups
export const BUSINESS_WIDE_SET = new Set<string>(BUSINESS_WIDE_INTEGRATION_IDS);
export const BUSINESS_ONLY_SET = new Set<string>(BUSINESS_ONLY_INTEGRATION_IDS);

export function buildIntegrationToolEntries(availableIds: readonly string[]): IntegrationToolEntry[] {
  return availableIds.flatMap((id) => {
    const integration = INTEGRATION_REGISTRY[id as IntegrationId] as IntegrationRegistryEntry | undefined;
    if (!integration?.tools?.length) return [];
    return [
      {
        key: id,
        displayName: integration.displayName,
        description: integration.description,
        tools: [...integration.tools],
      },
    ];
  });
}
