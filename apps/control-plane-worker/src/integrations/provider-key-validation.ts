// Provider API-key liveness validation shared by user and business credential flows.
import {
  CREDENTIAL_VALIDATION_STATUS,
  type CredentialValidationStatus,
  ONBOARDING_REASON_CODES,
  type OnboardingReasonCode,
} from "../../../../shared/constants/onboarding.js";
import { createLogger } from "../logger";
import { tracedFetch } from "../observability/wrappers";
import type { KeyProvider } from "./db";

const log = createLogger({ bindings: { component: "provider-key-validation" } });

export const PROVIDER_KEY_CONFIG: Record<
  KeyProvider,
  { prefix?: string; validateUrl: string; authHeaders: (key: string) => Record<string, string> }
> = {
  openai: {
    prefix: "sk-",
    validateUrl: "https://api.openai.com/v1/models",
    authHeaders: (key) => ({ Authorization: `Bearer ${key}` }),
  },
  anthropic: {
    prefix: "sk-ant-",
    validateUrl: "https://api.anthropic.com/v1/models",
    authHeaders: (key) => ({ "x-api-key": key, "anthropic-version": "2023-06-01" }),
  },
  baseten: {
    validateUrl: "https://inference.baseten.co/v1/models",
    authHeaders: (key) => ({ Authorization: `Bearer ${key}` }),
  },
};

export type ProviderKeyValidation =
  | {
      accepted: true;
      lastValidatedAt: number;
      lastValidationStatus: CredentialValidationStatus;
      lastValidationReasonCode: OnboardingReasonCode | null;
    }
  | {
      accepted: false;
      error: string;
      lastValidatedAt: number;
      lastValidationStatus: CredentialValidationStatus;
      lastValidationReasonCode: OnboardingReasonCode | null;
    };

export async function validateProviderApiKey(provider: KeyProvider, apiKey: string): Promise<ProviderKeyValidation> {
  const config = PROVIDER_KEY_CONFIG[provider];
  const lastValidatedAt = Date.now();
  try {
    const response = await tracedFetch(
      config.validateUrl,
      { method: "GET", headers: config.authHeaders(apiKey) },
      `${provider}.models.validate`,
    );
    if (response.status === 200) {
      return {
        accepted: true,
        lastValidatedAt,
        lastValidationStatus: CREDENTIAL_VALIDATION_STATUS.VALIDATED,
        lastValidationReasonCode: null,
      };
    }
    if (
      response.status === 401 ||
      response.status === 403 ||
      (response.status >= 400 && response.status < 500 && response.status !== 429)
    ) {
      return {
        accepted: false,
        error: "API key is invalid. Please check the key and try again.",
        lastValidatedAt,
        lastValidationStatus: CREDENTIAL_VALIDATION_STATUS.INVALID,
        lastValidationReasonCode: ONBOARDING_REASON_CODES.CREDENTIALS_INVALID,
      };
    }
    log.warn({ provider, status: response.status }, "Provider API-key validation degraded; saving as unverified");
    return {
      accepted: true,
      lastValidatedAt,
      lastValidationStatus: CREDENTIAL_VALIDATION_STATUS.SAVED_UNVERIFIED,
      lastValidationReasonCode: ONBOARDING_REASON_CODES.NETWORK_VALIDATION_SKIPPED,
    };
  } catch (error) {
    log.warn({ provider, error: String(error) }, "Provider API-key validation request failed; saving as unverified");
    return {
      accepted: true,
      lastValidatedAt,
      lastValidationStatus: CREDENTIAL_VALIDATION_STATUS.SAVED_UNVERIFIED,
      lastValidationReasonCode: ONBOARDING_REASON_CODES.NETWORK_VALIDATION_SKIPPED,
    };
  }
}
