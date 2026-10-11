import { useState } from "react";

import type { McpHeaderConfig, McpServerInput, McpServerRecord, McpTransport } from "../../../../../shared/types/mcp";
import {
  createMcpServer,
  deleteMcpServer,
  fetchMcpServers,
  updateMcpServer,
  validateMcpServer,
} from "../../api/integrations";
import { useSyncEffect } from "../../hooks/useEffects";
import { useConfirm } from "../ConfirmDialog";
import { Badge, type BadgeTone, Button, Input, Select, Textarea } from "../ui";
import {
  SettingsField,
  SettingsPageHeader,
  SettingsScopeBadge,
  SettingsSection,
  SettingsSkeleton,
} from "./SettingsLayout";
import { AdminOnlyNotice, useWorkspaceAdminAccess } from "./workspaceSettingsShared";

type McpFormState = {
  name: string;
  description: string;
  transport: McpTransport;
  command: string;
  url: string;
  args: string;
  headersJson: string;
  secretRefs: string;
  scopeType: "business" | "repositories";
  repositories: string;
  enabled: boolean;
};

const EMPTY_FORM: McpFormState = {
  name: "",
  description: "",
  transport: "http",
  command: "",
  url: "",
  args: "",
  headersJson: "",
  secretRefs: "",
  scopeType: "business",
  repositories: "",
  enabled: false,
};

const VALIDATION_POLL_INTERVAL_MS = 1500;

function splitDelimited(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function splitLineEntries(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseRepositories(value: string): Array<{ owner: string; name: string }> {
  return splitDelimited(value).map((entry) => {
    const parts = entry.split("/");
    if (parts.length !== 2) throw new Error("Repositories must use owner/repo format.");
    const [owner, name] = parts;
    if (!owner || !name) throw new Error("Repositories must use owner/repo format.");
    return { owner, name };
  });
}

function parseHeaders(value: string): Record<string, McpHeaderConfig> {
  const trimmed = value.trim();
  if (!trimmed) return {};
  const parsed = JSON.parse(trimmed) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Headers must be a JSON object.");
  }
  const headers: Record<string, McpHeaderConfig> = {};
  for (const [name, config] of Object.entries(parsed)) {
    if (!name.trim()) throw new Error("Header names must be non-empty.");
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      throw new Error(`Header ${name} must be an object like {"secretRef":"MY_SECRET"}.`);
    }
    const secretRef = (config as Record<string, unknown>).secretRef;
    if (secretRef !== undefined && (typeof secretRef !== "string" || !secretRef.trim())) {
      throw new Error(`Header ${name} secretRef must be a non-empty string.`);
    }
    headers[name] = secretRef === undefined ? {} : { secretRef: secretRef.trim() };
  }
  return headers;
}

function buildInput(form: McpFormState): McpServerInput {
  const scope =
    form.scopeType === "business"
      ? { type: "business" as const }
      : { type: "repositories" as const, repositories: parseRepositories(form.repositories) };
  const url = form.url.trim();
  if (form.transport !== "stdio" && !url) {
    throw new Error("URL is required for HTTP and SSE MCP servers.");
  }
  return {
    name: form.name.trim(),
    description: form.description.trim() || null,
    transport: form.transport,
    command: form.transport === "stdio" ? form.command.trim() : null,
    url: form.transport === "stdio" ? null : url,
    args: splitLineEntries(form.args),
    headers: parseHeaders(form.headersJson),
    secretRefs: splitDelimited(form.secretRefs),
    scope,
    enabled: form.enabled,
  };
}

// Plain-language status chip for the raw validation state machine
// (untested/validating/valid/invalid). The raw value stays in `title`.
function validationBadge(status: McpServerRecord["validationStatus"]): { label: string; tone: BadgeTone } {
  if (status === "valid") return { label: "Working", tone: "success" };
  if (status === "invalid") return { label: "Failed", tone: "error" };
  if (status === "validating") return { label: "Checking", tone: "default" };
  return { label: "Not tested", tone: "default" };
}

function formatScope(server: McpServerRecord): string {
  if (server.scope.type === "business") return "Business";
  return server.scope.repositories.map((repo) => `${repo.owner}/${repo.name}`).join(", ");
}

function formFromServer(server: McpServerRecord): McpFormState {
  return {
    name: server.name,
    description: server.description ?? "",
    transport: server.transport,
    command: server.command ?? "",
    url: server.url ?? "",
    args: server.args.join("\n"),
    headersJson: Object.keys(server.headers).length > 0 ? JSON.stringify(server.headers, null, 2) : "",
    secretRefs: server.secretRefs.join("\n"),
    scopeType: server.scope.type,
    repositories:
      server.scope.type === "repositories"
        ? server.scope.repositories.map((repo) => `${repo.owner}/${repo.name}`).join("\n")
        : "",
    enabled: server.enabled,
  };
}

function mergeFetchedServers(current: McpServerRecord[], fetched: McpServerRecord[]): McpServerRecord[] {
  const currentById = new Map(current.map((server) => [server.id, server]));
  return fetched.map((server) => {
    const local = currentById.get(server.id);
    if (!local) return server;
    if (
      local.validationStatus === "validating" &&
      server.validationStatus !== "validating" &&
      local.updatedAt >= server.updatedAt
    ) {
      return local;
    }
    return server;
  });
}

export function McpServersSettings() {
  const access = useWorkspaceAdminAccess();
  return (
    <div className="space-y-8">
      <SettingsPageHeader
        title="MCP servers"
        description="Customer-managed MCP servers available to new sessions after scope and secret resolution."
      />
      {access === "admin" ? (
        <McpServersPanel />
      ) : access === "loading" ? (
        <SettingsSkeleton rows={3} showHeader={false} control={false} />
      ) : (
        <AdminOnlyNotice message="Ask a workspace admin to manage MCP servers." />
      )}
    </div>
  );
}

function McpServersPanel() {
  const confirm = useConfirm();
  const [servers, setServers] = useState<McpServerRecord[] | null>(null);
  const [form, setForm] = useState<McpFormState>(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [pendingServerId, setPendingServerId] = useState<string | null>(null);
  const [editingServerId, setEditingServerId] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useSyncEffect(() => {
    fetchMcpServers()
      .then((value) => {
        setServers((current) => (current ? mergeFetchedServers(current, value) : value));
        setError(null);
      })
      .catch((loadError) => {
        setError(loadError instanceof Error ? loadError.message : "Failed to load MCP servers.");
      });
  }, [reloadKey]);

  useSyncEffect(() => {
    if (!servers?.some((server) => server.validationStatus === "validating")) return;
    const timeout = window.setTimeout(() => setReloadKey((key) => key + 1), VALIDATION_POLL_INTERVAL_MS);
    return () => window.clearTimeout(timeout);
  }, [servers]);

  function updateForm<K extends keyof McpFormState>(key: K, value: McpFormState[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function startEditing(server: McpServerRecord) {
    setEditingServerId(server.id);
    setForm(formFromServer(server));
    setError(null);
  }

  function resetForm() {
    setEditingServerId(null);
    setForm(EMPTY_FORM);
  }

  async function saveServer() {
    setSaving(true);
    setError(null);
    try {
      const input = buildInput(form);
      if (editingServerId) {
        const updated = await updateMcpServer(editingServerId, input);
        setServers((current) => current?.map((server) => (server.id === updated.id ? updated : server)) ?? [updated]);
        resetForm();
        return;
      }
      const created = await createMcpServer(input);
      setServers((current) => [created, ...(current ?? [])]);
      resetForm();
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "Failed to save MCP server.");
    } finally {
      setSaving(false);
    }
  }

  async function testServer(server: McpServerRecord) {
    if (pendingServerId === server.id || server.validationStatus === "validating") return;
    const serverId = server.id;
    setPendingServerId(serverId);
    setError(null);
    try {
      const validating = await validateMcpServer(serverId);
      setServers(
        (current) =>
          current?.map((server) => (server.id === serverId ? { ...server, ...validating } : server)) ?? current,
      );
    } catch (validateError) {
      setError(validateError instanceof Error ? validateError.message : "Failed to validate MCP server.");
    } finally {
      setPendingServerId(null);
    }
  }

  async function removeServer(server: McpServerRecord) {
    if (
      !(await confirm({
        title: "Delete MCP server?",
        message: `Delete MCP server ${server.name}? New sessions will no longer be able to use it.`,
        confirmLabel: "Delete",
        destructive: true,
      }))
    ) {
      return;
    }
    const serverId = server.id;
    setPendingServerId(serverId);
    setError(null);
    try {
      await deleteMcpServer(serverId);
      setServers((current) => current?.filter((item) => item.id !== serverId) ?? current);
      if (editingServerId === serverId) resetForm();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Failed to delete MCP server.");
    } finally {
      setPendingServerId(null);
    }
  }

  return (
    <SettingsSection
      title="Configured servers"
      meta={<SettingsScopeBadge scope="workspace" />}
      className="editorial-fade"
    >
      <div className="space-y-6 py-5">
        {error ? (
          <p className="border border-error-soft-border bg-error-soft px-3 py-2 text-sm text-error">{error}</p>
        ) : null}

        <div className="grid gap-3 border border-border bg-surface-1 p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <SettingsField label="Name">
              <Input
                value={form.name}
                onChange={(event) => updateForm("name", event.target.value)}
                placeholder="Docs MCP"
              />
            </SettingsField>
            <SettingsField label="Transport">
              <Select
                controlSize="md"
                value={form.transport}
                onChange={(event) => updateForm("transport", event.target.value as McpTransport)}
              >
                <option value="http">HTTP</option>
                <option value="sse">SSE</option>
                <option value="stdio">stdio</option>
              </Select>
            </SettingsField>
          </div>
          <SettingsField label="Description">
            <Input
              value={form.description}
              onChange={(event) => updateForm("description", event.target.value)}
              placeholder="Internal documentation search"
            />
          </SettingsField>
          {form.transport === "stdio" ? (
            <SettingsField label="Command">
              <Input
                value={form.command}
                onChange={(event) => updateForm("command", event.target.value)}
                placeholder="npx"
              />
            </SettingsField>
          ) : (
            <SettingsField label="URL">
              <Input
                value={form.url}
                onChange={(event) => updateForm("url", event.target.value)}
                placeholder="https://mcp.example.com"
              />
            </SettingsField>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <SettingsField label="Args">
              <Textarea
                className="min-h-[88px]"
                value={form.args}
                onChange={(event) => updateForm("args", event.target.value)}
                placeholder="-y&#10;@example/mcp"
              />
            </SettingsField>
            <SettingsField label="Secret refs">
              <Textarea
                className="min-h-[88px]"
                value={form.secretRefs}
                onChange={(event) => updateForm("secretRefs", event.target.value)}
                placeholder="MCP_TOKEN"
              />
            </SettingsField>
          </div>
          <SettingsField label="Headers JSON">
            <Textarea
              className="min-h-[108px] font-mono text-sm"
              value={form.headersJson}
              onChange={(event) => updateForm("headersJson", event.target.value)}
              spellCheck={false}
            />
          </SettingsField>
          <div className="grid gap-3 sm:grid-cols-[180px_minmax(0,1fr)]">
            <SettingsField label="Scope">
              <Select
                controlSize="md"
                value={form.scopeType}
                onChange={(event) => updateForm("scopeType", event.target.value as McpFormState["scopeType"])}
              >
                <option value="business">Business</option>
                <option value="repositories">Repositories</option>
              </Select>
            </SettingsField>
            <SettingsField label="Repositories">
              <Input
                value={form.repositories}
                onChange={(event) => updateForm("repositories", event.target.value)}
                disabled={form.scopeType === "business"}
                placeholder="owner/repo, owner/other"
              />
            </SettingsField>
          </div>
          <label className="flex items-center gap-2 text-base text-text-primary">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(event) => updateForm("enabled", event.target.checked)}
              className="h-4 w-4 border-border bg-surface-0"
            />
            Enabled for matching sessions
          </label>
          <div>
            <Button type="button" onClick={() => void saveServer()} disabled={saving} variant="primary">
              {saving ? "Saving…" : editingServerId ? "Update MCP server" : "Add MCP server"}
            </Button>
            {editingServerId ? (
              <Button type="button" onClick={resetForm} disabled={saving} variant="secondary" className="ml-3">
                Cancel
              </Button>
            ) : null}
          </div>
        </div>

        {!servers ? (
          <SettingsSkeleton rows={2} showHeader={false} control={false} />
        ) : servers.length === 0 ? (
          <p className="editorial-fade border-t border-border pt-4 text-base text-text-muted">
            No MCP servers configured.
          </p>
        ) : (
          <div className="editorial-fade divide-y divide-border border-t border-border">
            {servers.map((server) => (
              <div key={server.id} className="py-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-md font-medium text-text-primary">{server.name}</p>
                      <Badge>{server.transport}</Badge>
                      <Badge tone={validationBadge(server.validationStatus).tone} title={server.validationStatus}>
                        {validationBadge(server.validationStatus).label}
                      </Badge>
                    </div>
                    <p className="mt-1 break-all text-sm text-text-secondary">
                      {server.transport === "stdio" ? server.command : server.url}
                    </p>
                    <p className="mt-1 text-sm text-text-muted">
                      {server.scope.type === "business"
                        ? "Available to the whole workspace."
                        : `Available to ${formatScope(server)}.`}{" "}
                      {server.enabled ? "Enabled for new sessions." : "Disabled."}
                    </p>
                    {server.secretRefs.length > 0 ? (
                      <p className="mt-1 text-sm text-text-muted">Uses secrets {server.secretRefs.join(", ")}.</p>
                    ) : null}
                    {server.validationError ? (
                      <p className="mt-2 text-sm text-error">{server.validationError}</p>
                    ) : null}
                    {server.discoveredTools.length > 0 ? (
                      <p className="mt-2 text-sm text-text-secondary">
                        Provides {server.discoveredTools.map((tool) => tool.name).join(", ")}.
                      </p>
                    ) : null}
                    <p className="mt-1 text-sm text-text-muted">
                      {server.lastValidatedAt
                        ? `Last tested ${new Date(server.lastValidatedAt).toLocaleString()}.`
                        : "Not tested yet."}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => startEditing(server)}
                      disabled={pendingServerId === server.id || saving}
                    >
                      Edit
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => void testServer(server)}
                      disabled={pendingServerId === server.id || server.validationStatus === "validating"}
                    >
                      {pendingServerId === server.id || server.validationStatus === "validating"
                        ? "Testing…"
                        : "Test tools"}
                    </Button>
                    <Button
                      type="button"
                      variant="danger"
                      size="sm"
                      onClick={() => void removeServer(server)}
                      disabled={pendingServerId === server.id}
                    >
                      Delete
                    </Button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </SettingsSection>
  );
}
