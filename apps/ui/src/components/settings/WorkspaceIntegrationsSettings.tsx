import { useId, useState } from "react";
import { useSearchParams } from "react-router";

// eslint-disable-next-line no-restricted-imports -- pre-existing: remove in Phase 1
import {
  BUSINESS_ONLY_INTEGRATION_IDS,
  BUSINESS_WIDE_INTEGRATION_IDS,
  INTEGRATION_DISPLAY_NAMES,
  isCustomerFacingIntegration,
  TOGGLEABLE_INTEGRATION_IDS,
} from "../../../../../shared/constants/integration-helpers";
import {
  buildNeonBranchCredentialConfig,
  serializeNeonBranchCredentialConfig,
} from "../../../../../shared/integrations/neon";
import type { BusinessIntegrationInfo } from "../../api/integrations";
import { useSyncEffect } from "../../hooks/useEffects";
import type { IntegrationScope } from "../../types";
import { useConfirm } from "../ConfirmDialog";
import { CheckIcon } from "../icons";
import { useLayoutContext } from "../Layout";
import { Badge, Button, Input, Select } from "../ui";
import { IntegrationStatusLine } from "./IntegrationHealthBadge";
import { JiraSitePicker } from "./IntegrationsSettings";
import { CallbackBanner, resolveCallbackMessage } from "./integrationsShared";
import {
  SettingsError,
  SettingsField,
  SettingsPageHeader,
  SettingsScopeBadge,
  SettingsSection,
  SettingsSkeleton,
} from "./SettingsLayout";
import { AdminOnlyNotice, useWorkspaceAdminAccess } from "./workspaceSettingsShared";

const SCOPE_OPTIONS: { value: IntegrationScope; label: string }[] = [
  { value: "disabled", label: "Disabled" },
  { value: "user", label: "User-managed" },
  { value: "business", label: "Business-wide" },
];

type CredentialFormState = {
  apiKey: string;
  serviceUrl: string;
  applicationKey: string;
  neonProjectId: string;
  neonParentBranchId: string;
};

const EMPTY_CREDENTIAL_FORM: CredentialFormState = {
  apiKey: "",
  serviceUrl: "",
  applicationKey: "",
  neonProjectId: "",
  neonParentBranchId: "",
};

const BUSINESS_ONLY_IDS = new Set<string>(BUSINESS_ONLY_INTEGRATION_IDS);
const BUSINESS_WIDE_IDS = new Set<string>(BUSINESS_WIDE_INTEGRATION_IDS);

function CredentialInput({
  type = "text",
  label,
  placeholder,
  value,
  onChange,
  disabled,
}: {
  type?: "password" | "text";
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  const inputId = useId();
  return (
    <SettingsField label={label} htmlFor={inputId}>
      <Input
        id={inputId}
        type={type}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
      />
    </SettingsField>
  );
}
type CredentialPayload = { apiKey?: string; serviceUrl?: string; applicationKey?: string };

function buildBusinessCredentialPayload(integrationId: string, form: CredentialFormState): CredentialPayload {
  if (integrationId === "neon") {
    const config = buildNeonBranchCredentialConfig({
      projectId: form.neonProjectId,
      parentBranchId: form.neonParentBranchId,
    });
    return {
      ...(form.apiKey ? { apiKey: form.apiKey } : {}),
      ...(config ? { serviceUrl: serializeNeonBranchCredentialConfig(config) } : {}),
    };
  }
  const data: CredentialPayload = {};
  if (form.apiKey) data.apiKey = form.apiKey;
  if (form.serviceUrl) data.serviceUrl = form.serviceUrl;
  if (form.applicationKey) data.applicationKey = form.applicationKey;
  return data;
}

const SCOPE_HELP: Record<IntegrationScope, string> = {
  disabled: "Members cannot use this integration in new sessions.",
  user: "Each member connects their own account.",
  business: "Shared credentials used for all sessions in this business.",
};

function getLinearWorkspaceStatus(info: BusinessIntegrationInfo | undefined) {
  return (
    info?.linearWorkspace ?? {
      status: "not_connected" as const,
      organizationId: null,
      organizationName: null,
      organizationUrlKey: null,
      webhookId: null,
      webhookBound: false,
    }
  );
}

function getSlackWorkspaceStatus(info: BusinessIntegrationInfo | undefined) {
  return (
    info?.slackWorkspace ?? {
      status: "not_installed" as const,
      teamId: null,
      teamName: null,
      teamDomain: null,
      installedAt: null,
    }
  );
}

function getJiraWorkspaceStatus(info: BusinessIntegrationInfo | undefined) {
  return (
    info?.jiraWorkspace ?? {
      status: "not_connected" as const,
      cloudId: null,
      siteName: null,
      siteUrl: null,
      webhookBound: false,
      webhookExpiresAt: null,
      triggerLabel: null,
    }
  );
}

export function WorkspaceIntegrationsSettings() {
  const access = useWorkspaceAdminAccess();
  return (
    <div className="space-y-10">
      <SettingsPageHeader
        title="Workspace integrations"
        description="Choose how this workspace uses each integration: disabled, members connect their own accounts, or one shared credential for everyone."
      />
      {access === "admin" ? (
        <WorkspaceIntegrationsPanel />
      ) : access === "loading" ? (
        <SettingsSkeleton rows={4} />
      ) : (
        <AdminOnlyNotice message="Ask a workspace admin to manage integration policies and shared credentials." />
      )}
    </div>
  );
}

function WorkspaceIntegrationsPanel() {
  const { user, refreshUser } = useLayoutContext();
  const confirm = useConfirm();
  const [searchParams, setSearchParams] = useSearchParams();
  const [integrations, setIntegrations] = useState<Record<string, BusinessIntegrationInfo> | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [credForms, setCredForms] = useState<Record<string, CredentialFormState>>({});
  const [credErrors, setCredErrors] = useState<Record<string, string>>({});
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [lastChanged, setLastChanged] = useState<string | null>(null);
  const [integrationsReloadKey, setIntegrationsReloadKey] = useState(0);

  useSyncEffect(() => {
    if (!user?.businessId) return;
    import("../../api/integrations")
      .then(async ({ fetchBusinessIntegrations }) => {
        const integrationsResult = await fetchBusinessIntegrations(user.businessId)
          .then((value) => ({ ok: true as const, value }))
          .catch(() => ({ ok: false as const }));
        if (integrationsResult.ok) {
          setIntegrations(integrationsResult.value);
          setLoadError(null);
        } else {
          setLoadError("Failed to load business integrations.");
        }
      })
      .catch(() => {
        setLoadError("Failed to load business integrations.");
      });
  }, [user?.businessId, integrationsReloadKey]);

  useSyncEffect(() => {
    if (!integrations) return;
    const neonConfig = integrations.neon?.neonCredentialConfig;
    if (!neonConfig) return;
    setCredForms((prev) => {
      const current = prev.neon ?? EMPTY_CREDENTIAL_FORM;
      if (current.neonProjectId || current.neonParentBranchId) return prev;
      return {
        ...prev,
        neon: {
          ...current,
          neonProjectId: neonConfig.projectId,
          neonParentBranchId: neonConfig.parentBranchId ?? "",
        },
      };
    });
  }, [integrations]);

  const callbackMessage = resolveCallbackMessage(searchParams, { includeSuccess: true });
  const dismissCallbackMessage = () => {
    const next = new URLSearchParams(searchParams);
    next.delete("error");
    next.delete("warning");
    next.delete("success");
    setSearchParams(next, { replace: true });
  };
  // The business OAuth callback redirects multi-site accounts here with a
  // pending nonce; the picker must render on this page or the binding can
  // never finalize.
  const jiraSiteSelectionNonce = searchParams.get("jira_site_selection");
  const handleJiraSitePickerDone = (result: { connected: boolean }) => {
    const next = new URLSearchParams(searchParams);
    next.delete("jira_site_selection");
    setSearchParams(next, { replace: true });
    if (result.connected) {
      setIntegrationsReloadKey((key) => key + 1);
    }
  };
  const banner =
    callbackMessage || jiraSiteSelectionNonce ? (
      <>
        {callbackMessage ? <CallbackBanner message={callbackMessage} onDismiss={dismissCallbackMessage} /> : null}
        {jiraSiteSelectionNonce ? (
          <JiraSitePicker nonce={jiraSiteSelectionNonce} onDone={handleJiraSitePickerDone} />
        ) : null}
      </>
    ) : null;

  if (!user) return banner ? <div>{banner}</div> : null;

  async function handleScopeChange(integrationId: string, scope: IntegrationScope) {
    if (!user) return;
    if (scope === "business" && !BUSINESS_WIDE_IDS.has(integrationId)) return;
    setSaving(integrationId);
    setRowErrors((prev) => ({ ...prev, [integrationId]: "" }));
    try {
      const { setBusinessIntegrationScope } = await import("../../api/integrations");
      await setBusinessIntegrationScope(user.businessId, integrationId, scope);
      setIntegrations((prev) => (prev ? { ...prev, [integrationId]: { ...prev[integrationId], scope } } : prev));
      setLastChanged(integrationId);
      await refreshUser();
    } catch (error) {
      setRowErrors((prev) => ({
        ...prev,
        [integrationId]: error instanceof Error ? error.message : "Failed to update scope",
      }));
    } finally {
      setSaving(null);
    }
  }

  async function handleSaveCredentials(integrationId: string) {
    if (!user) return;
    const form = credForms[integrationId];
    if (!form) return;
    setSaving(integrationId);
    setCredErrors((prev) => ({ ...prev, [integrationId]: "" }));
    setRowErrors((prev) => ({ ...prev, [integrationId]: "" }));
    try {
      const { setBusinessCredentials } = await import("../../api/integrations");
      const data = buildBusinessCredentialPayload(integrationId, form);
      const result = await setBusinessCredentials(user.businessId, integrationId, data);
      setIntegrations((prev) =>
        prev
          ? {
              ...prev,
              [integrationId]: {
                ...prev[integrationId],
                credentialsConnected: true,
                credentialKind: "manual",
                credentialValidationStatus: result?.validationStatus ?? null,
              },
            }
          : prev,
      );
      setCredForms((prev) => ({ ...prev, [integrationId]: EMPTY_CREDENTIAL_FORM }));
    } catch (e) {
      setCredErrors((prev) => ({ ...prev, [integrationId]: e instanceof Error ? e.message : "Failed to save" }));
    } finally {
      setSaving(null);
    }
  }

  async function handleRemoveCredentials(integrationId: string) {
    if (!user) return;
    setSaving(integrationId);
    setRowErrors((prev) => ({ ...prev, [integrationId]: "" }));
    try {
      const { deleteBusinessCredentials } = await import("../../api/integrations");
      await deleteBusinessCredentials(user.businessId, integrationId);
      setIntegrations((prev) =>
        prev
          ? {
              ...prev,
              [integrationId]: {
                ...prev[integrationId],
                scope: BUSINESS_ONLY_IDS.has(integrationId) ? "disabled" : "user",
                credentialsConnected: false,
                credentialKind: null,
              },
            }
          : prev,
      );
      await refreshUser();
    } catch (error) {
      setIntegrationsReloadKey((key) => key + 1);
      setRowErrors((prev) => ({
        ...prev,
        [integrationId]: error instanceof Error ? error.message : "Failed to remove credentials",
      }));
    } finally {
      setSaving(null);
    }
  }

  async function handleValidateCredentials(integrationId: string) {
    if (!user) return;
    setSaving(integrationId);
    setRowErrors((prev) => ({ ...prev, [integrationId]: "" }));
    try {
      const { validateBusinessCredentials } = await import("../../api/integrations");
      await validateBusinessCredentials(user.businessId, integrationId);
      setIntegrationsReloadKey((key) => key + 1);
    } catch (error) {
      setIntegrationsReloadKey((key) => key + 1);
      setRowErrors((prev) => ({
        ...prev,
        [integrationId]: error instanceof Error ? error.message : "Failed to validate credentials",
      }));
    } finally {
      setSaving(null);
    }
  }

  async function handleDisconnectLinearWorkspace() {
    if (!user) return;
    if (
      !(await confirm({
        title: "Disconnect Linear workspace?",
        message:
          "Cycloid will stop receiving Linear issue events for this business until someone reconnects the workspace.",
        confirmLabel: "Disconnect",
        destructive: true,
      }))
    ) {
      return;
    }
    setSaving("linear-workspace");
    setRowErrors((prev) => ({ ...prev, linear: "" }));
    try {
      const { disconnectBusinessLinearWorkspace } = await import("../../api/integrations");
      await disconnectBusinessLinearWorkspace(user.businessId);
      setIntegrations((prev) => {
        if (!prev) return prev;
        const current = prev.linear ?? { scope: "user" as const, credentialsConnected: false };
        return {
          ...prev,
          linear: {
            ...current,
            linearWorkspace: {
              status: "revoked",
              organizationId: current.linearWorkspace?.organizationId ?? null,
              organizationName: current.linearWorkspace?.organizationName ?? null,
              organizationUrlKey: current.linearWorkspace?.organizationUrlKey ?? null,
              webhookId: current.linearWorkspace?.webhookId ?? null,
              webhookBound: Boolean(current.linearWorkspace?.webhookId),
            },
          },
        };
      });
    } catch (error) {
      setRowErrors((prev) => ({
        ...prev,
        linear: error instanceof Error ? error.message : "Failed to disconnect Linear workspace",
      }));
    } finally {
      setSaving(null);
    }
  }

  async function handleDisconnectJiraWorkspace() {
    if (!user) return;
    if (
      !(await confirm({
        title: "Disconnect Jira workspace?",
        message:
          "Cycloid will stop receiving Jira issue events for this business until someone reconnects the workspace.",
        confirmLabel: "Disconnect",
        destructive: true,
      }))
    ) {
      return;
    }
    setSaving("jira-workspace");
    setRowErrors((prev) => ({ ...prev, jira: "" }));
    try {
      const { disconnectBusinessJiraWorkspace } = await import("../../api/integrations");
      await disconnectBusinessJiraWorkspace(user.businessId);
      setIntegrations((prev) => {
        if (!prev) return prev;
        const current = prev.jira ?? { scope: "user" as const, credentialsConnected: false };
        return {
          ...prev,
          jira: {
            ...current,
            jiraWorkspace: {
              status: "revoked",
              cloudId: current.jiraWorkspace?.cloudId ?? null,
              siteName: current.jiraWorkspace?.siteName ?? null,
              siteUrl: current.jiraWorkspace?.siteUrl ?? null,
              webhookBound: false,
              webhookExpiresAt: null,
              triggerLabel: current.jiraWorkspace?.triggerLabel ?? null,
            },
          },
        };
      });
    } catch (error) {
      setRowErrors((prev) => ({
        ...prev,
        jira: error instanceof Error ? error.message : "Failed to disconnect Jira workspace",
      }));
    } finally {
      setSaving(null);
    }
  }

  function getForm(id: string) {
    return credForms[id] ?? EMPTY_CREDENTIAL_FORM;
  }

  function updateForm(id: string, field: keyof CredentialFormState, value: string) {
    setCredForms((prev) => ({
      ...prev,
      [id]: { ...getForm(id), [field]: value },
    }));
  }

  function canSaveCredentials(id: string) {
    const form = getForm(id);
    if (!form.apiKey.trim()) return false;
    if (id === "neon" && !form.neonProjectId.trim()) return false;
    if (id === "sentry" && !form.serviceUrl.trim()) return false;
    if (id === "datadog" && (!form.applicationKey.trim() || !form.serviceUrl.trim())) return false;
    if (id === "cloudflare" && (!form.applicationKey.trim() || !form.serviceUrl.trim())) return false;
    return true;
  }

  const linearWorkspace = getLinearWorkspaceStatus(integrations?.linear);
  const linearWorkspaceActive = linearWorkspace.status === "active";
  const linearWorkspaceRevoked = linearWorkspace.status === "revoked";
  const linearWorkspaceConnected = linearWorkspaceActive && linearWorkspace.webhookBound;
  const linearWorkspacePending = linearWorkspaceActive && !linearWorkspace.webhookBound;
  const linearWorkspaceLabel = linearWorkspace.organizationUrlKey ?? linearWorkspace.organizationName ?? null;
  let linearWorkspaceStatus = "Not connected";
  if (linearWorkspaceRevoked) linearWorkspaceStatus = "Connection revoked";
  else if (linearWorkspaceConnected)
    linearWorkspaceStatus = linearWorkspaceLabel ? `Connected to ${linearWorkspaceLabel}` : "Connected";
  else if (linearWorkspacePending)
    linearWorkspaceStatus = linearWorkspaceLabel
      ? `Connected to ${linearWorkspaceLabel} (pending webhook)`
      : "Connected (pending webhook)";
  const linearWorkspaceAction = linearWorkspaceActive || linearWorkspaceRevoked ? "Reconnect" : "Connect";

  const slackWorkspace = getSlackWorkspaceStatus(integrations?.slack);
  const slackWorkspaceInstalled = slackWorkspace.status === "installed";
  const slackWorkspaceLabel = slackWorkspace.teamName ?? slackWorkspace.teamDomain ?? slackWorkspace.teamId;
  const slackWorkspaceStatus = slackWorkspaceInstalled
    ? slackWorkspaceLabel
      ? `Installed in ${slackWorkspaceLabel}${slackWorkspace.installedAt ? ` on ${new Date(slackWorkspace.installedAt).toLocaleDateString()}` : ""}`
      : "Installed"
    : "Not installed";

  const jiraWorkspace = getJiraWorkspaceStatus(integrations?.jira);
  const jiraWorkspaceActive = jiraWorkspace.status === "active";
  const jiraWorkspaceDegraded = jiraWorkspace.status === "degraded";
  const jiraWorkspaceRevoked = jiraWorkspace.status === "revoked";
  const jiraWorkspaceConnected = jiraWorkspaceActive && jiraWorkspace.webhookBound;
  const jiraWorkspaceLabel = jiraWorkspace.siteName ?? jiraWorkspace.siteUrl ?? null;
  let jiraWorkspaceStatus = "Not connected";
  if (jiraWorkspaceRevoked) jiraWorkspaceStatus = "Connection revoked";
  else if (jiraWorkspaceDegraded)
    jiraWorkspaceStatus = jiraWorkspaceLabel
      ? `Connected to ${jiraWorkspaceLabel} (webhook degraded - reconnect)`
      : "Connected (webhook degraded - reconnect)";
  else if (jiraWorkspaceConnected)
    jiraWorkspaceStatus = jiraWorkspaceLabel ? `Connected to ${jiraWorkspaceLabel}` : "Connected";
  else if (jiraWorkspaceActive)
    jiraWorkspaceStatus = jiraWorkspaceLabel
      ? `Connected to ${jiraWorkspaceLabel} (pending webhook)`
      : "Connected (pending webhook)";
  const jiraWorkspaceAction =
    jiraWorkspaceActive || jiraWorkspaceDegraded || jiraWorkspaceRevoked ? "Reconnect" : "Connect";

  return (
    <div className="editorial-fade space-y-10">
      {banner}

      <SettingsSection title="Integration policies" meta={<SettingsScopeBadge scope="workspace" />}>
        {!integrations ? (
          <div className="pt-5">
            {loadError ? (
              <SettingsError message={loadError} onRetry={() => setIntegrationsReloadKey((key) => key + 1)} />
            ) : (
              <SettingsSkeleton rows={2} showHeader={false} />
            )}
          </div>
        ) : (
          <div className="editorial-fade border-t border-border divide-y divide-border">
            {integrations.github && (
              <div className="py-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-md font-medium text-text-primary">GitHub</p>
                    <p className="mt-0.5 text-sm text-text-muted">Always available.</p>
                  </div>
                </div>
                <IntegrationStatusLine info={integrations.github} />
              </div>
            )}
            {/* Cycloid admins also see customerFacing:false integrations
                (anthropic, hidden from customers in PR #4210) so internal
                businesses can onboard a shared Anthropic key for claude_code. */}
            {TOGGLEABLE_INTEGRATION_IDS.flatMap((id) => {
              if (!isCustomerFacingIntegration(id) && !user.isCycloidAdmin) return [];
              const label = INTEGRATION_DISPLAY_NAMES[id as keyof typeof INTEGRATION_DISPLAY_NAMES];
              const info = integrations[id] ?? {
                scope: BUSINESS_ONLY_IDS.has(id) ? ("disabled" as const) : ("user" as const),
                credentialsConnected: false,
                credentialKind: null,
              };
              const canBeBusiness = BUSINESS_WIDE_IDS.has(id);
              const businessOnly = BUSINESS_ONLY_IDS.has(id);
              const scopeOptions = businessOnly
                ? SCOPE_OPTIONS.filter((o) => o.value !== "user")
                : canBeBusiness
                  ? SCOPE_OPTIONS
                  : SCOPE_OPTIONS.filter((o) => o.value !== "business");
              const justChanged = lastChanged === id && saving !== id;
              const isLinear = id === "linear";

              return [
                <div key={id} className="py-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1 pt-1.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-md font-medium text-text-primary">{label}</p>
                        {justChanged && (
                          <Badge tone="success" role="status" className="editorial-fade">
                            <CheckIcon className="size-3" />
                            Saved
                          </Badge>
                        )}
                      </div>
                    </div>
                    <Select
                      value={info.scope}
                      onChange={(e) => handleScopeChange(id, e.target.value as IntegrationScope)}
                      disabled={saving === id}
                      title={SCOPE_HELP[info.scope]}
                      aria-label={`${label} availability`}
                      wrapperClassName="w-44 shrink-0"
                    >
                      {scopeOptions.map((o) => (
                        <option key={o.value} value={o.value} title={SCOPE_HELP[o.value]}>
                          {o.label}
                        </option>
                      ))}
                    </Select>
                  </div>

                  {id === "slack" && (info.scope !== "disabled" || slackWorkspaceInstalled) && (
                    <div className="mt-4 border border-border bg-surface-1 px-4 py-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <p className="text-base font-medium text-text-primary">Slack workspace app</p>
                          <p className="mt-1 text-base leading-relaxed text-text-secondary">
                            Installs the workspace bot for mentions.
                          </p>
                          <p
                            className={`mt-2 text-base ${slackWorkspaceInstalled ? "text-success" : "text-text-muted"}`}
                          >
                            {slackWorkspaceStatus}
                          </p>
                          {slackWorkspaceInstalled && info.scope === "disabled" && (
                            <p className="mt-1 text-base text-warning">
                              Installed, but Slack is disabled for this workspace. Enable it above so mentions reach
                              Cycloid.
                            </p>
                          )}
                        </div>
                        <div className="flex shrink-0 flex-col items-end gap-2 text-base">
                          {info.scope !== "disabled" && (
                            <a
                              href="/auth/slack/install"
                              className="text-accent underline underline-offset-2 hover:opacity-80"
                            >
                              {slackWorkspaceInstalled ? "Reinstall" : "Install Cycloid in Slack"}
                            </a>
                          )}
                        </div>
                      </div>
                    </div>
                  )}

                  {isLinear && (info.scope !== "disabled" || linearWorkspaceActive || linearWorkspaceRevoked) && (
                    <div className="mt-4 border border-border bg-surface-1 px-4 py-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <p className="text-base font-medium text-text-primary">Linear webhook</p>
                          <p className="mt-1 text-base leading-relaxed text-text-secondary">
                            Lets Linear notify Cycloid when issues change.
                          </p>
                          <p
                            className={`mt-2 text-base ${
                              linearWorkspaceConnected
                                ? "text-success"
                                : linearWorkspacePending || linearWorkspaceRevoked
                                  ? "text-warning"
                                  : "text-text-muted"
                            }`}
                          >
                            {linearWorkspaceStatus}
                          </p>
                        </div>
                        <div className="flex shrink-0 flex-col items-end gap-2 text-base">
                          {info.scope !== "disabled" && (
                            <a
                              href="/auth/linear/business"
                              className="text-accent underline underline-offset-2 hover:opacity-80"
                            >
                              {linearWorkspaceAction}
                            </a>
                          )}
                          {linearWorkspaceActive && (
                            <Button
                              type="button"
                              variant="danger"
                              size="sm"
                              onClick={() => void handleDisconnectLinearWorkspace()}
                              disabled={saving === "linear-workspace"}
                            >
                              {saving === "linear-workspace" ? "Removing…" : "Remove"}
                            </Button>
                          )}
                        </div>
                      </div>
                    </div>
                  )}

                  {id === "jira" &&
                    (info.scope !== "disabled" ||
                      jiraWorkspaceActive ||
                      jiraWorkspaceDegraded ||
                      jiraWorkspaceRevoked) && (
                      <div className="mt-4 border border-border bg-surface-1 px-4 py-3">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0 flex-1">
                            <p className="text-base font-medium text-text-primary">Jira webhook</p>
                            <p className="mt-1 text-base leading-relaxed text-text-secondary">
                              Lets Jira notify Cycloid when issues change. Bound to one Jira Cloud site for this
                              business; adding the{" "}
                              <code className="font-mono">{jiraWorkspace.triggerLabel ?? "cycloid"}</code> label to an
                              issue starts a session.
                            </p>
                            <p
                              className={`mt-2 text-base ${
                                jiraWorkspaceConnected
                                  ? "text-success"
                                  : jiraWorkspaceActive || jiraWorkspaceDegraded || jiraWorkspaceRevoked
                                    ? "text-warning"
                                    : "text-text-muted"
                              }`}
                            >
                              {jiraWorkspaceStatus}
                            </p>
                          </div>
                          <div className="flex shrink-0 flex-col items-end gap-2 text-base">
                            {info.scope !== "disabled" && (
                              <a
                                href="/auth/jira/business"
                                className="text-accent underline underline-offset-2 hover:opacity-80"
                              >
                                {jiraWorkspaceAction}
                              </a>
                            )}
                            {(jiraWorkspaceActive || jiraWorkspaceDegraded) && (
                              <Button
                                type="button"
                                variant="danger"
                                size="sm"
                                onClick={() => void handleDisconnectJiraWorkspace()}
                                disabled={saving === "jira-workspace"}
                              >
                                {saving === "jira-workspace" ? "Removing…" : "Remove"}
                              </Button>
                            )}
                          </div>
                        </div>
                      </div>
                    )}

                  {canBeBusiness && info.scope === "business" && (
                    <div className="mt-4 border border-border bg-surface-1 px-4 py-3">
                      {info.credentialsConnected ? (
                        <div className="flex flex-wrap items-center justify-between gap-3 text-base">
                          <div>
                            <span className="text-text-secondary">
                              {info.credentialValidationStatus === "invalid"
                                ? "Shared credential needs attention."
                                : "Shared credential configured."}
                            </span>
                            {(info.credentialValidationStatus === "saved_unverified" ||
                              info.credentialValidationStatus === "invalid") && (
                              <p className="mt-1 text-sm text-text-secondary">
                                {info.credentialValidationStatus === "invalid"
                                  ? "The provider rejected this key. Validate it again after correcting the provider issue."
                                  : "Provider unavailable when it was saved. Validate it now to enable sessions."}
                              </p>
                            )}
                          </div>
                          {(info.credentialValidationStatus === "saved_unverified" ||
                            info.credentialValidationStatus === "invalid") && (
                            <Button
                              type="button"
                              variant="secondary"
                              size="sm"
                              onClick={() => void handleValidateCredentials(id)}
                              disabled={saving === id}
                            >
                              {saving === id ? "Validating…" : "Validate key"}
                            </Button>
                          )}
                          <Button
                            type="button"
                            variant="danger"
                            size="sm"
                            onClick={async () => {
                              if (
                                !(await confirm({
                                  title: "Remove shared credential?",
                                  message: `Remove the shared ${label} credential? Every member loses access to ${label} in sessions.`,
                                  confirmLabel: "Remove",
                                  destructive: true,
                                }))
                              ) {
                                return;
                              }
                              void handleRemoveCredentials(id);
                            }}
                            disabled={saving === id}
                          >
                            Remove
                          </Button>
                        </div>
                      ) : (
                        <div className="space-y-3">
                          <p className="text-base text-text-secondary">
                            No shared credential yet. Add one below — every member will use it for {label} in sessions.
                          </p>
                          <CredentialInput
                            type="password"
                            label={
                              id === "cloudflare"
                                ? "Cloudflare API token"
                                : id === "launchdarkly"
                                  ? "LaunchDarkly access token"
                                  : id === "stripe"
                                    ? "Stripe secret key"
                                    : `${label} API key`
                            }
                            placeholder={
                              id === "cloudflare"
                                ? "Cloudflare API token (D1 Read)\u2026"
                                : id === "launchdarkly"
                                  ? "LaunchDarkly access token\u2026"
                                  : id === "stripe"
                                    ? "Stripe secret key (prefer test mode)\u2026"
                                    : `${label} API key\u2026`
                            }
                            value={getForm(id).apiKey}
                            onChange={(value) => updateForm(id, "apiKey", value)}
                            disabled={saving === id}
                          />
                          {id === "sentry" && (
                            <CredentialInput
                              label="Sentry organization slug"
                              placeholder="Sentry organization slug…"
                              value={getForm(id).serviceUrl}
                              onChange={(value) => updateForm(id, "serviceUrl", value)}
                              disabled={saving === id}
                            />
                          )}
                          {id === "datadog" && (
                            <>
                              <CredentialInput
                                type="password"
                                label="Datadog application key"
                                placeholder="Datadog application key…"
                                value={getForm(id).applicationKey}
                                onChange={(value) => updateForm(id, "applicationKey", value)}
                                disabled={saving === id}
                              />
                              <CredentialInput
                                label="Datadog site"
                                placeholder="Datadog site (for example us5.datadoghq.com)…"
                                value={getForm(id).serviceUrl}
                                onChange={(value) => updateForm(id, "serviceUrl", value)}
                                disabled={saving === id}
                              />
                            </>
                          )}
                          {id === "cloudflare" && (
                            <>
                              <CredentialInput
                                label="Cloudflare account ID"
                                placeholder="Cloudflare account ID…"
                                value={getForm(id).applicationKey}
                                onChange={(value) => updateForm(id, "applicationKey", value)}
                                disabled={saving === id}
                              />
                              <CredentialInput
                                label="Cloudflare D1 database ID"
                                placeholder="Cloudflare D1 database ID…"
                                value={getForm(id).serviceUrl}
                                onChange={(value) => updateForm(id, "serviceUrl", value)}
                                disabled={saving === id}
                              />
                              <p className="text-sm text-text-secondary">
                                Use a Cloudflare API token scoped to <span className="font-medium">D1 Read</span>.
                                Cycloid only runs read-only queries and rejects any write statement.
                              </p>
                            </>
                          )}
                          {id === "braintrust" && (
                            <CredentialInput
                              label="Braintrust API URL"
                              placeholder="Braintrust API URL (defaults to https://api.braintrust.dev)…"
                              value={getForm(id).serviceUrl}
                              onChange={(value) => updateForm(id, "serviceUrl", value)}
                              disabled={saving === id}
                            />
                          )}
                          {id === "stripe" && (
                            <p className="text-sm text-text-secondary">
                              Prefer a test-mode or restricted secret key when verifying payment flows.
                            </p>
                          )}
                          {id === "neon" && (
                            <>
                              <CredentialInput
                                label="Neon project ID"
                                placeholder="Neon project ID…"
                                value={getForm(id).neonProjectId}
                                onChange={(value) => updateForm(id, "neonProjectId", value)}
                                disabled={saving === id}
                              />
                              <CredentialInput
                                label="Neon parent branch ID"
                                placeholder="Neon parent branch ID (optional, defaults to the project default branch)…"
                                value={getForm(id).neonParentBranchId}
                                onChange={(value) => updateForm(id, "neonParentBranchId", value)}
                                disabled={saving === id}
                              />
                              <p className="text-sm text-text-secondary">
                                Cycloid creates one writable Neon branch per session and injects its connection URI into
                                declared app runtime env vars.
                              </p>
                            </>
                          )}
                          {id === "vercel" && (
                            <>
                              <CredentialInput
                                label="Vercel team ID"
                                placeholder="Vercel team ID (optional, team_...)…"
                                value={getForm(id).serviceUrl}
                                onChange={(value) => updateForm(id, "serviceUrl", value)}
                                disabled={saving === id}
                              />
                              <p className="text-sm text-text-secondary">
                                Leave blank for hobby accounts. Required for team-scoped Vercel projects.
                              </p>
                            </>
                          )}
                          {credErrors[id] && <p className="text-xs text-error">{credErrors[id]}</p>}
                          <Button
                            type="button"
                            variant="primary"
                            onClick={() => handleSaveCredentials(id)}
                            disabled={saving === id || !canSaveCredentials(id)}
                            data-testid={`business-${id}-credentials-save`}
                          >
                            Save credentials
                          </Button>
                        </div>
                      )}
                    </div>
                  )}

                  <IntegrationStatusLine info={info} />

                  {rowErrors[id] && <p className="mt-2 text-sm text-error">{rowErrors[id]}</p>}
                </div>,
              ];
            })}
          </div>
        )}
      </SettingsSection>
    </div>
  );
}
