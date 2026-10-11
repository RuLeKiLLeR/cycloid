import { useState } from "react";

import { normalizeEgressDomains } from "../../../../../shared/types/business-egress-policy";
import type { BusinessEgressAllowlistSourceResponse } from "../../api/integrations";
import { useSyncEffect } from "../../hooks/useEffects";
import { safeHttpsUrl } from "../../utils/safe-url";
import { ChevronDownIcon } from "../icons";
import { useLayoutContext } from "../Layout";
import { Toggle } from "../Toggle";
import { Badge, Button, Input } from "../ui";
import { SandboxEnvironmentSettings } from "./SandboxEnvironmentSettings";
import {
  SettingsPageHeader,
  SettingsRow,
  SettingsScopeBadge,
  SettingsSection,
  SettingsSkeleton,
} from "./SettingsLayout";
import { AdminOnlyNotice, useWorkspaceAdminAccess } from "./workspaceSettingsShared";

function parseEgressAllowlistText(value: string): string[] | null {
  const domains = value
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  return domains.length > 0 ? normalizeEgressDomains(domains) : null;
}

function buildNextEgressAllowlistDraft(currentDraft: string[], pendingInput: string): string[] {
  const pendingDomains = parseEgressAllowlistText(pendingInput);
  return pendingDomains ? normalizeEgressDomains([...currentDraft, ...pendingDomains]) : currentDraft;
}

function formatDomainCount(count: number): string {
  return `${count} ${count === 1 ? "domain" : "domains"}`;
}

function formatEgressAllowlistSummary(domains: string[]): string {
  if (domains.length === 0) return "No custom domains configured.";
  const preview = domains.slice(0, 2).join(", ");
  return domains.length > 2 ? `${preview} +${domains.length - 2}` : preview;
}

export function WorkspacePoliciesSettings() {
  const access = useWorkspaceAdminAccess();
  return (
    <div className="space-y-10">
      <SettingsPageHeader
        title="Workspace policies"
        description="Defaults and sandbox settings that apply to everyone in this workspace."
      />
      {access === "admin" ? (
        <WorkspacePoliciesPanel />
      ) : access === "loading" ? (
        <SettingsSkeleton rows={4} />
      ) : (
        <AdminOnlyNotice message="Ask a workspace admin to change workspace policies." />
      )}
    </div>
  );
}

function WorkspacePoliciesPanel() {
  const { user, repos, reposLoaded, settings, refreshSessions, refreshUser } = useLayoutContext();
  const [sharedSessionsSaving, setSharedSessionsSaving] = useState(false);
  const [sharedSessionsError, setSharedSessionsError] = useState<string | null>(null);
  const [egressAllowlistSaved, setEgressAllowlistSaved] = useState<string[]>([]);
  const [egressAllowlistDraft, setEgressAllowlistDraft] = useState<string[]>([]);
  const [egressAllowlistInput, setEgressAllowlistInput] = useState("");
  const [egressAllowlistSaving, setEgressAllowlistSaving] = useState(false);
  const [egressAllowlistError, setEgressAllowlistError] = useState<string | null>(null);
  const [egressAllowlistOpen, setEgressAllowlistOpen] = useState(false);
  const [egressAllowlistSource, setEgressAllowlistSource] = useState<BusinessEgressAllowlistSourceResponse | null>(
    null,
  );
  const [egressAllowlistPrUrl, setEgressAllowlistPrUrl] = useState<string | null>(null);

  useSyncEffect(() => {
    const next = user?.egressAllowlist ?? [];
    setEgressAllowlistSaved(next);
    setEgressAllowlistDraft(next);
    setEgressAllowlistInput("");
    setEgressAllowlistError(null);
  }, [user?.egressAllowlist?.join("\n")]);

  useSyncEffect(() => {
    if (!user?.businessId) return;
    import("../../api/integrations")
      .then(async ({ fetchBusinessEgressAllowlistSource }) => {
        const source = await fetchBusinessEgressAllowlistSource(user.businessId).catch(() => null);
        setEgressAllowlistSource(source);
      })
      .catch(() => setEgressAllowlistSource(null));
  }, [user?.businessId]);

  if (!user) return null;

  async function handleSharedSessionsToggle() {
    if (!user) return;
    const next = !user.sharedSessions;
    setSharedSessionsSaving(true);
    setSharedSessionsError(null);
    try {
      const { updateBusinessSharedSessions } = await import("../../api/integrations");
      await updateBusinessSharedSessions(user.businessId, next);
      await refreshUser();
      await refreshSessions();
    } catch (error) {
      setSharedSessionsError(error instanceof Error ? error.message : "Failed to update shared sessions");
    } finally {
      setSharedSessionsSaving(false);
    }
  }

  async function handleEgressAllowlistSave() {
    if (!user) return;
    let nextDraft: string[];
    try {
      nextDraft = buildNextEgressAllowlistDraft(egressAllowlistDraft, egressAllowlistInput);
    } catch (error) {
      setEgressAllowlistError(error instanceof Error ? error.message : "Failed to validate egress allowlist");
      return;
    }
    setEgressAllowlistSaving(true);
    setEgressAllowlistError(null);
    try {
      const { createBusinessEgressAllowlistPr } = await import("../../api/integrations");
      const domainsToAdd = nextDraft.filter((domain) => !egressAllowlistSaved.includes(domain));
      if (domainsToAdd.length === 0) {
        setEgressAllowlistError("No new domains to add to the source file.");
        return;
      }
      const result = await createBusinessEgressAllowlistPr(user.businessId, domainsToAdd);
      setEgressAllowlistPrUrl(result.prUrl);
      setEgressAllowlistInput("");
      if (result.status === "unchanged") {
        setEgressAllowlistError("Those domains are already present in the source file.");
      }
    } catch (error) {
      setEgressAllowlistError(error instanceof Error ? error.message : "Failed to create egress allowlist PR");
    } finally {
      setEgressAllowlistSaving(false);
    }
  }

  async function handleEgressAllowlistSync() {
    if (!user) return;
    setEgressAllowlistSaving(true);
    setEgressAllowlistError(null);
    try {
      const { syncBusinessEgressAllowlistFromSource } = await import("../../api/integrations");
      const result = await syncBusinessEgressAllowlistFromSource(user.businessId);
      if (!result.applied) {
        setEgressAllowlistError(
          "Source file was not found on the default branch; runtime domains were left unchanged.",
        );
        return;
      }
      const saved = result.egressAllowlist ?? [];
      setEgressAllowlistSaved(saved);
      setEgressAllowlistDraft(saved);
      setEgressAllowlistInput("");
      setEgressAllowlistPrUrl(null);
      await refreshUser().catch(() => undefined);
    } catch (error) {
      setEgressAllowlistError(error instanceof Error ? error.message : "Failed to refresh egress allowlist from repo");
    } finally {
      setEgressAllowlistSaving(false);
    }
  }

  function handleAddEgressAllowlistEntries() {
    try {
      const nextDomains = parseEgressAllowlistText(egressAllowlistInput);
      if (!nextDomains) {
        setEgressAllowlistError("Enter at least one domain name");
        return;
      }
      const nextDraft = normalizeEgressDomains([...egressAllowlistDraft, ...nextDomains]);
      setEgressAllowlistDraft(nextDraft);
      setEgressAllowlistInput("");
      setEgressAllowlistError(null);
    } catch (error) {
      setEgressAllowlistError(error instanceof Error ? error.message : "Failed to add domains");
    }
  }

  function handleRemoveEgressAllowlistEntry(domain: string) {
    if (egressAllowlistSaved.includes(domain)) {
      setEgressAllowlistError("Synced domains must be removed from the source file PR.");
      return;
    }
    setEgressAllowlistDraft((current) => current.filter((entry) => entry !== domain));
    setEgressAllowlistError(null);
  }

  function handleEgressAllowlistReset() {
    setEgressAllowlistDraft(egressAllowlistSaved);
    setEgressAllowlistInput("");
    setEgressAllowlistError(null);
  }

  const egressAllowlistPendingDomains = egressAllowlistDraft.filter((domain) => !egressAllowlistSaved.includes(domain));
  const egressAllowlistDirty = egressAllowlistPendingDomains.length > 0;
  const egressAllowlistHasPendingInput = egressAllowlistInput.trim().length > 0;
  const egressAllowlistHasUnsavedChanges = egressAllowlistDirty || egressAllowlistHasPendingInput;
  const egressAllowlistSummary = formatEgressAllowlistSummary(egressAllowlistDraft);
  const egressAllowlistSourceLabel = egressAllowlistSource?.source
    ? `${egressAllowlistSource.source.sourceRepoOwner}/${egressAllowlistSource.source.sourceRepoName}:${egressAllowlistSource.path}`
    : "No repo source configured.";
  const egressAllowlistPrHref = safeHttpsUrl(egressAllowlistPrUrl);
  const canResetEgressAllowlist = egressAllowlistHasUnsavedChanges;

  return (
    <div className="editorial-fade space-y-10">
      <SettingsSection
        title="Member defaults"
        description="Defaults that apply to every member of this business."
        meta={<SettingsScopeBadge scope="workspace" />}
      >
        <SettingsRow
          title="Shared sessions"
          description="Business members can view each other's sessions."
          control={
            <Toggle
              checked={user.sharedSessions}
              disabled={sharedSessionsSaving}
              onChange={() => {
                if (!sharedSessionsSaving) void handleSharedSessionsToggle();
              }}
              label={
                sharedSessionsSaving
                  ? "Saving shared sessions…"
                  : user.sharedSessions
                    ? "Shared sessions enabled"
                    : "Shared sessions disabled"
              }
              showLabel={false}
            />
          }
          error={sharedSessionsError ?? undefined}
        />
        <SettingsRow
          title="Custom egress domains"
          description="Extra exact domains new sandboxes may reach."
          control={
            <div className="w-full max-w-3xl overflow-hidden border border-border bg-surface-1">
              <button
                type="button"
                aria-expanded={egressAllowlistOpen}
                aria-controls="business-egress-allowlist"
                onClick={() => setEgressAllowlistOpen((open) => !open)}
                className="flex w-full items-start justify-between gap-3 px-4 py-3.5 text-left"
              >
                <div className="min-w-0">
                  <p className="eyebrow">Custom egress domains</p>
                  <p className="mt-1.5 text-sm leading-relaxed text-text-secondary">{egressAllowlistSummary}</p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Badge>{formatDomainCount(egressAllowlistDraft.length)}</Badge>
                  {egressAllowlistHasUnsavedChanges ? <Badge tone="warning">Unsaved</Badge> : null}
                  <ChevronDownIcon
                    className={`h-3.5 w-3.5 text-text-muted transition-transform ${egressAllowlistOpen ? "rotate-180" : ""}`}
                  />
                </div>
              </button>
              <div
                id="business-egress-allowlist"
                hidden={!egressAllowlistOpen}
                className="space-y-4 border-t border-border px-4 py-4"
              >
                <div className="space-y-1 text-sm text-text-secondary">
                  <p>Exact domains only. No protocol, path, port, wildcard, or IP address.</p>
                  <p>Saving opens a policy PR. After that PR merges, refresh from repo to apply it to new sandboxes.</p>
                  <p className="font-mono text-xs text-text-muted">{egressAllowlistSourceLabel}</p>
                </div>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Input
                    value={egressAllowlistInput}
                    onChange={(event) => setEgressAllowlistInput(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter") return;
                      event.preventDefault();
                      handleAddEgressAllowlistEntries();
                    }}
                    disabled={egressAllowlistSaving}
                    aria-label="Add egress allowlist domains"
                    placeholder="api.customer.com, registry.customer.com"
                    className="flex-1 text-sm"
                  />
                  <Button
                    type="button"
                    onClick={handleAddEgressAllowlistEntries}
                    disabled={egressAllowlistSaving || egressAllowlistInput.trim().length === 0}
                  >
                    Add domains
                  </Button>
                </div>
                <div className="overflow-hidden border border-border bg-surface-0">
                  {egressAllowlistDraft.length === 0 ? (
                    <div className="px-4 py-6 text-sm text-text-muted">No custom domains configured.</div>
                  ) : (
                    <table className="min-w-full divide-y divide-border text-sm">
                      <thead className="bg-surface-1 text-left font-mono-tabular text-xs text-text-muted">
                        <tr>
                          <th scope="col" className="px-4 py-3 font-medium">
                            Domain
                          </th>
                          <th scope="col" className="px-4 py-3 text-right font-medium">
                            Action
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {egressAllowlistDraft.map((domain) => (
                          <tr key={domain}>
                            <td className="px-4 py-3 font-mono text-text-primary">{domain}</td>
                            <td className="px-4 py-3 text-right">
                              {egressAllowlistSaved.includes(domain) ? (
                                <span className="text-xs text-text-muted">Synced</span>
                              ) : (
                                <Button
                                  size="sm"
                                  variant="secondary"
                                  onClick={() => handleRemoveEgressAllowlistEntry(domain)}
                                  disabled={egressAllowlistSaving}
                                >
                                  Remove
                                </Button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="primary"
                    size="sm"
                    onClick={() => void handleEgressAllowlistSave()}
                    disabled={egressAllowlistSaving || !egressAllowlistHasUnsavedChanges}
                  >
                    {egressAllowlistSaving ? "Saving…" : "Open policy PR"}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => void handleEgressAllowlistSync()}
                    disabled={egressAllowlistSaving}
                  >
                    Refresh from repo
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={handleEgressAllowlistReset}
                    disabled={egressAllowlistSaving || !canResetEgressAllowlist}
                  >
                    Reset
                  </Button>
                </div>
                {egressAllowlistPrUrl ? (
                  <p className="text-sm text-text-secondary">
                    Policy PR:{" "}
                    {egressAllowlistPrHref ? (
                      <a
                        href={egressAllowlistPrHref}
                        target="_blank"
                        rel="noreferrer"
                        className="text-accent hover:underline"
                      >
                        {egressAllowlistPrUrl}
                      </a>
                    ) : (
                      egressAllowlistPrUrl
                    )}
                  </p>
                ) : null}
              </div>
            </div>
          }
          error={egressAllowlistError ?? undefined}
        />
      </SettingsSection>

      <SandboxEnvironmentSettings
        businessId={user.businessId}
        repos={repos}
        reposLoaded={reposLoaded}
        defaultRepo={settings?.defaultRepo}
      />
    </div>
  );
}
