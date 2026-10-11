import { useRef, useState } from "react";

// eslint-disable-next-line no-restricted-imports -- pre-existing: remove in Phase 1
import {
  CUSTOMER_FACING_API_KEY_PROVIDER_IDS,
  INTEGRATION_DISPLAY_NAMES,
  TOGGLEABLE_INTEGRATION_IDS,
  USER_API_KEY_PROVIDER_IDS,
  type UserApiKeyProviderId,
} from "../../../../../shared/constants/integration-helpers";
import {
  CREDENTIAL_VALIDATION_STATUS,
  type CredentialValidationStatus,
  ONBOARDING_REASON_CODES,
  type OnboardingReasonCode,
  type ProviderApiKeyState,
} from "../../../../../shared/constants/onboarding";
import { ApiError } from "../../api/client";
import { fetchUserIntegrations } from "../../api/integrations";
import {
  clearCodexSubscriptionAuthJson,
  clearProviderApiKey,
  fetchCodexSubscriptionState,
  fetchSettings,
  setCodexSubscriptionAuthJson,
  setProviderApiKey,
  updateSettings,
} from "../../api/settings";
import { useMountEffect, useSyncEffect } from "../../hooks/useEffects";
import type { UserIntegrations } from "../../types";
import { useLayoutContext } from "../Layout";
import { Button, Input, Textarea } from "../ui";
import {
  SettingsError,
  SettingsPageHeader,
  SettingsScopeBadge,
  SettingsSection,
  SettingsSkeleton,
} from "./SettingsLayout";

const API_KEY_FORM_CONFIG: Record<UserApiKeyProviderId, { prefix: string; placeholder: string }> = {
  openai: { prefix: "sk-", placeholder: "sk-…" },
  anthropic: { prefix: "sk-ant-", placeholder: "sk-ant-…" },
  baseten: { prefix: "", placeholder: "Baseten API key" },
};

type KeyState = ProviderApiKeyState & { input: string; error: string | null; saving: boolean };
const VALIDATION_STATUSES = new Set<CredentialValidationStatus>(Object.values(CREDENTIAL_VALIDATION_STATUS));
const VALIDATION_REASON_CODES = new Set<OnboardingReasonCode>(Object.values(ONBOARDING_REASON_CODES));
const CUSTOMER_FACING_API_KEY_PROVIDER_ID_SET = new Set<string>(CUSTOMER_FACING_API_KEY_PROVIDER_IDS);
const TOGGLEABLE_INTEGRATION_ID_SET = new Set<string>(TOGGLEABLE_INTEGRATION_IDS);

function emptyKeyState(): KeyState {
  return {
    isSet: false,
    input: "",
    error: null,
    saving: false,
    lastValidatedAt: null,
    lastValidationStatus: null,
    lastValidationReasonCode: null,
  };
}

function getApiKeysSignature(apiKeys: Record<string, ProviderApiKeyState> | null | undefined): string {
  if (!apiKeys) return "";
  return USER_API_KEY_PROVIDER_IDS.map((provider) => {
    const state = apiKeys[provider];
    if (!state) return `${provider}:missing`;
    return [
      provider,
      state.isSet ? "1" : "0",
      state.lastValidatedAt ?? "",
      state.lastValidationStatus ?? "",
      state.lastValidationReasonCode ?? "",
    ].join(":");
  }).join("|");
}

function getValidationMessage(state: ProviderApiKeyState): { tone: "muted" | "warning" | "error"; text: string } {
  if (!state.isSet) {
    return { tone: "muted", text: "No key saved" };
  }

  switch (state.lastValidationStatus) {
    case CREDENTIAL_VALIDATION_STATUS.VALIDATED:
      return { tone: "muted", text: "Key validated" };
    case CREDENTIAL_VALIDATION_STATUS.SAVED_UNVERIFIED:
      return {
        tone: "warning",
        text: "Saved (unverified).",
      };
    case CREDENTIAL_VALIDATION_STATUS.INVALID:
      return { tone: "error", text: "Saved key is marked invalid. Remove it and save a new key." };
    default:
      return { tone: "muted", text: "Key is set" };
  }
}

function getPersistedKeyState(error: unknown): ProviderApiKeyState | null {
  if (!(error instanceof ApiError) || typeof error.data !== "object" || error.data === null) {
    return null;
  }

  const state = (error.data as { state?: unknown }).state;
  if (typeof state !== "object" || state === null) {
    return null;
  }

  const candidate = state as Record<string, unknown>;
  const lastValidatedAt = candidate.lastValidatedAt;
  const lastValidationStatus = candidate.lastValidationStatus;
  const lastValidationReasonCode = candidate.lastValidationReasonCode;

  if (typeof candidate.isSet !== "boolean") {
    return null;
  }
  if (lastValidatedAt !== null && typeof lastValidatedAt !== "number") {
    return null;
  }
  if (
    lastValidationStatus !== null &&
    (typeof lastValidationStatus !== "string" ||
      !VALIDATION_STATUSES.has(lastValidationStatus as CredentialValidationStatus))
  ) {
    return null;
  }
  if (
    lastValidationReasonCode !== null &&
    (typeof lastValidationReasonCode !== "string" ||
      !VALIDATION_REASON_CODES.has(lastValidationReasonCode as OnboardingReasonCode))
  ) {
    return null;
  }

  return {
    isSet: candidate.isSet,
    lastValidatedAt: lastValidatedAt ?? null,
    lastValidationStatus: (lastValidationStatus as CredentialValidationStatus | null) ?? null,
    lastValidationReasonCode: (lastValidationReasonCode as OnboardingReasonCode | null) ?? null,
  };
}

function getKeyStatePatchForSaveError(error: unknown): Partial<KeyState> {
  const persistedState = getPersistedKeyState(error);
  if (persistedState) {
    return {
      ...persistedState,
      input: "",
      error: null,
      saving: false,
    };
  }

  return {
    error: error instanceof Error ? error.message : "Failed to save key",
    saving: false,
  };
}

export function ApiKeysSection({ integrations: externalIntegrations }: { integrations?: UserIntegrations | null }) {
  const { capabilities, settings, settingsLoaded, settingsError, setSettings, refreshModels } = useLayoutContext();
  // Cycloid business members see internal customerFacing:false model-key providers.
  // Render-only gate: the control plane owns credential storage and validation.
  const providerIds = capabilities?.canUseInternalModelProviderKeys
    ? USER_API_KEY_PROVIDER_IDS
    : CUSTOMER_FACING_API_KEY_PROVIDER_IDS;
  const appliedApiKeysSignatureRef = useRef("");
  const settingsFallbackRequestedRef = useRef(false);
  const [localIntegrations, setLocalIntegrations] = useState<UserIntegrations | null>(null);
  const integrations = externalIntegrations ?? localIntegrations;
  const scopes = integrations?.integrationScopes ?? {};
  const available = new Set(integrations?.availableIntegrations ?? []);
  const [integrationsLoaded, setIntegrationsLoaded] = useState(false);
  // Bumped by the SettingsError retry to re-run the fallback settings fetch.
  const [settingsReloadKey, setSettingsReloadKey] = useState(0);
  const [codexSubscriptionState, setCodexSubscriptionState] = useState<KeyState>(emptyKeyState);
  const [codexSubscriptionEligible, setCodexSubscriptionEligible] = useState(false);
  const [keyStates, setKeyStates] = useState<Record<string, KeyState>>(() =>
    Object.fromEntries(USER_API_KEY_PROVIDER_IDS.map((provider) => [provider, emptyKeyState()])),
  );

  useMountEffect(() => {
    // Self-fetch only in standalone use (prop omitted). When embedded, the
    // parent passes `integrations` — which may briefly be `null` while it loads;
    // `null` means "wait for the parent", not "fetch my own", so guard on
    // `undefined` specifically rather than any falsy value (avoids a second
    // fetch the embedded contract promises not to make).
    if (externalIntegrations === undefined) {
      fetchUserIntegrations()
        .then(setLocalIntegrations)
        .catch(console.error)
        .finally(() => setIntegrationsLoaded(true));
      return;
    }
    setIntegrationsLoaded(true);
  });

  useSyncEffect(() => {
    const apiKeys = settings?.apiKeys;
    if (!apiKeys) return;
    const signature = getApiKeysSignature(apiKeys);
    if (signature === appliedApiKeysSignatureRef.current) return;
    appliedApiKeysSignatureRef.current = signature;
    setKeyStates((prev) => {
      const next = { ...prev };
      for (const [provider, apiKeyState] of Object.entries(apiKeys)) {
        if (next[provider]) {
          next[provider] = { ...next[provider], ...apiKeyState };
        }
      }
      return next;
    });
  }, [settings?.apiKeys]);

  useSyncEffect(() => {
    if (!settingsLoaded || settings || settingsFallbackRequestedRef.current) return;
    settingsFallbackRequestedRef.current = true;
    fetchSettings({ scope: "full" })
      .then((loadedSettings) => {
        setSettings(loadedSettings);
      })
      .catch((error) => {
        settingsFallbackRequestedRef.current = false;
        console.error(error);
      });
  }, [settings, settingsLoaded, setSettings, settingsReloadKey]);

  useSyncEffect(() => {
    // Eligibility is server-authoritative (per-business Codex BYOS opt-in, ARC-1517);
    // ineligible workspaces get `eligible: false` with an empty credential, so this is
    // safe to fetch for every authenticated user.
    fetchCodexSubscriptionState()
      .then((state) => {
        setCodexSubscriptionEligible(state.eligible);
        setCodexSubscriptionState((prev) => ({ ...prev, ...state.credential, error: null, saving: false }));
      })
      .catch((error) => {
        console.error(error);
        setCodexSubscriptionState((prev) => ({
          ...prev,
          error: error instanceof Error ? error.message : "Failed to load Codex subscription auth state.",
        }));
      });
  }, []);

  function updateKeyState(provider: string, patch: Partial<KeyState>) {
    setKeyStates((prev) => ({
      ...prev,
      [provider]: { ...prev[provider], ...patch },
    }));
  }

  function syncContextApiKeyState(provider: string, apiKeyState: ProviderApiKeyState) {
    setSettings((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        apiKeys: {
          ...(prev.apiKeys ?? {}),
          [provider]: apiKeyState,
        },
      };
    });
  }

  function syncContextCodexSubscription(useCodexSubscription: boolean) {
    setSettings((prev) => (prev ? { ...prev, useCodexSubscription } : prev));
  }

  function refreshModelsAfterKeyChange(provider: string) {
    void refreshModels().catch((error) => {
      console.error(error);
      updateKeyState(provider, {
        error:
          error instanceof Error
            ? `API key updated, but failed to refresh models: ${error.message}`
            : "API key updated, but failed to refresh models.",
      });
    });
  }

  if (!settingsLoaded || !integrationsLoaded) {
    return <SettingsSkeleton rows={3} control={false} />;
  }

  if (!settings) {
    return (
      <SettingsError
        message={settingsError ?? "Failed to load settings."}
        onRetry={() => setSettingsReloadKey((key) => key + 1)}
      />
    );
  }

  const visibleProviders = providerIds.filter((provider) => {
    if (!CUSTOMER_FACING_API_KEY_PROVIDER_ID_SET.has(provider)) return true;
    if (!TOGGLEABLE_INTEGRATION_ID_SET.has(provider)) return true;
    return available.has(provider);
  });
  // Server-authoritative: `codexSubscriptionEligible` reflects the workspace's
  // per-business Codex BYOS opt-in (ARC-1517). The connect panel is exposure only;
  // save/clear/use are enforced in the control plane.
  const showCodexSubscription = codexSubscriptionEligible;
  if (visibleProviders.length === 0 && !showCodexSubscription) return null;

  return (
    <SettingsSection
      title="Provider keys"
      description="Stored encrypted; never shown again after save."
      meta={<SettingsScopeBadge scope="user" />}
      className="editorial-fade"
    >
      <ul className="divide-y divide-border">
        {showCodexSubscription ? (
          <li className="py-4">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <p className="text-md font-medium text-text-primary">Codex subscription</p>
                <p className="mt-1 text-base text-text-muted">
                  Internal only. Uses your personal Codex auth.json for OpenAI Codex sessions.
                </p>
                <label className="mt-3 flex items-center gap-2 text-sm text-text-primary">
                  <input
                    type="checkbox"
                    checked={settings.useCodexSubscription}
                    disabled={codexSubscriptionState.saving}
                    onChange={async (event) => {
                      const useCodexSubscription = event.target.checked;
                      setCodexSubscriptionState((prev) => ({ ...prev, saving: true, error: null }));
                      try {
                        const nextSettings = await updateSettings({ useCodexSubscription });
                        setSettings(nextSettings);
                        syncContextCodexSubscription(nextSettings.useCodexSubscription);
                        void refreshModels();
                      } catch (error) {
                        console.error(error);
                        setCodexSubscriptionState((prev) => ({
                          ...prev,
                          error:
                            error instanceof Error ? error.message : "Failed to update Codex subscription setting.",
                        }));
                      } finally {
                        setCodexSubscriptionState((prev) => ({ ...prev, saving: false }));
                      }
                    }}
                  />
                  <span>Use Codex subscription auth for OpenAI sessions</span>
                </label>
                {codexSubscriptionState.error ? (
                  <p className="mt-2 text-sm text-error">{codexSubscriptionState.error}</p>
                ) : (
                  <p className="mt-2 text-sm text-text-muted">
                    {codexSubscriptionState.isSet ? "Codex auth.json saved" : "No Codex auth.json saved"}
                  </p>
                )}
              </div>
              {codexSubscriptionState.isSet ? (
                <Button
                  type="button"
                  variant="danger"
                  size="sm"
                  onClick={async () => {
                    setCodexSubscriptionState((prev) => ({ ...prev, saving: true, error: null }));
                    try {
                      const nextState = await clearCodexSubscriptionAuthJson();
                      setCodexSubscriptionState({ ...emptyKeyState(), ...nextState });
                      void refreshModels();
                    } catch (error) {
                      console.error(error);
                      setCodexSubscriptionState((prev) => ({ ...prev, saving: false }));
                    }
                  }}
                  disabled={codexSubscriptionState.saving}
                >
                  Remove
                </Button>
              ) : null}
            </div>

            {!codexSubscriptionState.isSet ? (
              <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                <Textarea
                  aria-label="Codex auth.json"
                  value={codexSubscriptionState.input}
                  onChange={(e) =>
                    setCodexSubscriptionState((prev) => ({ ...prev, input: e.target.value, error: null }))
                  }
                  placeholder='Paste ~/.codex/auth.json after running "codex login --device-auth"'
                  spellCheck={false}
                  autoComplete="off"
                  rows={4}
                  className="min-h-24 flex-1 font-mono text-sm"
                />
                <Button
                  type="button"
                  variant="primary"
                  onClick={async () => {
                    setCodexSubscriptionState((prev) => ({ ...prev, saving: true, error: null }));
                    try {
                      const nextState = await setCodexSubscriptionAuthJson(codexSubscriptionState.input);
                      setCodexSubscriptionState({ ...emptyKeyState(), ...nextState });
                      void refreshModels();
                    } catch (error) {
                      setCodexSubscriptionState((prev) => ({
                        ...prev,
                        saving: false,
                        error: error instanceof Error ? error.message : "Failed to save Codex auth.json.",
                      }));
                    }
                  }}
                  disabled={codexSubscriptionState.saving || !codexSubscriptionState.input}
                >
                  {codexSubscriptionState.saving ? "Saving…" : "Save auth.json"}
                </Button>
              </div>
            ) : null}
          </li>
        ) : null}
        {visibleProviders.map((provider) => {
          const state = keyStates[provider];
          const managed = scopes[provider] === "business";
          const config = API_KEY_FORM_CONFIG[provider];
          const providerLabel = INTEGRATION_DISPLAY_NAMES[provider];
          const validationMessage = getValidationMessage(state);
          const validationToneClass =
            validationMessage.tone === "error"
              ? "text-error"
              : validationMessage.tone === "warning"
                ? "text-warning"
                : "text-text-muted";
          return (
            <li key={provider} className="py-4">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <p className="text-md font-medium text-text-primary">{providerLabel}</p>
                  {managed ? (
                    <p className="mt-1 text-base text-text-muted">Managed by your organization.</p>
                  ) : (
                    <p className={`mt-1 text-base ${validationToneClass}`}>{validationMessage.text}</p>
                  )}
                </div>
                {!managed && state.isSet ? (
                  <Button
                    type="button"
                    onClick={async () => {
                      updateKeyState(provider, { saving: true });
                      try {
                        const nextState = await clearProviderApiKey(provider);
                        updateKeyState(provider, { ...nextState, error: null, saving: false });
                        syncContextApiKeyState(provider, nextState);
                        refreshModelsAfterKeyChange(provider);
                      } catch (e) {
                        console.error(e);
                        updateKeyState(provider, { saving: false });
                      }
                    }}
                    disabled={state.saving}
                    variant="danger"
                    size="sm"
                  >
                    Remove
                  </Button>
                ) : null}
              </div>

              {!managed && !state.isSet ? (
                <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                  <Input
                    type="password"
                    aria-label={`${providerLabel} API key`}
                    value={state.input}
                    onChange={(e) => updateKeyState(provider, { input: e.target.value, error: null })}
                    placeholder={config.placeholder}
                    spellCheck={false}
                    autoComplete="off"
                    className="flex-1"
                  />
                  <Button
                    type="button"
                    onClick={async () => {
                      if (!state.input.startsWith(config.prefix)) {
                        updateKeyState(provider, { error: `Key must start with ${config.prefix}` });
                        return;
                      }
                      updateKeyState(provider, { saving: true, error: null });
                      try {
                        const nextState = await setProviderApiKey(provider, state.input);
                        updateKeyState(provider, { ...nextState, input: "", error: null, saving: false });
                        syncContextApiKeyState(provider, nextState);
                        refreshModelsAfterKeyChange(provider);
                      } catch (e) {
                        updateKeyState(provider, getKeyStatePatchForSaveError(e));
                        const persistedState = getPersistedKeyState(e);
                        if (persistedState) syncContextApiKeyState(provider, persistedState);
                      }
                    }}
                    disabled={state.saving || !state.input}
                    variant="primary"
                    size="md"
                  >
                    {state.saving ? "Saving…" : "Save key"}
                  </Button>
                </div>
              ) : null}
              {!managed && state.error ? <p className="mt-2 text-sm text-error">{state.error}</p> : null}
            </li>
          );
        })}
      </ul>
    </SettingsSection>
  );
}

/**
 * Standalone `/settings/api-keys` page. Renders the page header, then the shared
 * `ApiKeysSection` (which self-fetches integrations when mounted without props).
 */
export function ApiKeysSettings() {
  return (
    <div className="space-y-6">
      <SettingsPageHeader
        eyebrow="Model API keys"
        title="Model API keys"
        description="Use your own model provider keys in your sessions. Some keys may be managed by your organization."
      />
      <ApiKeysSection />
    </div>
  );
}
