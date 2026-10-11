import { useId, useState } from "react";

import type { CliToken, CliTokenScope } from "../../api/cli-tokens";
import { createCliToken, deleteCliToken, fetchCliTokens, revokeCliToken } from "../../api/cli-tokens";
import { useMountEffect } from "../../hooks/useEffects";
import { useConfirm } from "../ConfirmDialog";
import { Badge, Button, CopyButton, Select } from "../ui";
import {
  SettingsField,
  SettingsPageHeader,
  SettingsScopeBadge,
  SettingsSection,
  SettingsSkeleton,
} from "./SettingsLayout";

function formatDate(ts: number | null) {
  if (!ts) return "—";
  return new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function formatScope(scope: CliTokenScope) {
  return scope === "write" ? "Write" : "Read";
}

export function CliTokensSettings() {
  const [tokens, setTokens] = useState<CliToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [expiry, setExpiry] = useState<string>("never");
  const [tokenScope, setTokenScope] = useState<CliTokenScope>("read");
  const [creating, setCreating] = useState(false);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [newTokenScope, setNewTokenScope] = useState<CliTokenScope | null>(null);
  const [error, setError] = useState<string | null>(null);
  const confirm = useConfirm();
  const expirySelectId = useId();
  const scopeSelectId = useId();

  async function loadTokens() {
    try {
      const result = await fetchCliTokens();
      setTokens(result.data);
    } catch {
      setError("Failed to load tokens");
    } finally {
      setLoading(false);
    }
  }

  useMountEffect(() => {
    loadTokens();
  });

  async function handleCreate() {
    setCreating(true);
    setError(null);
    try {
      const expiresInDays = expiry === "30" ? 30 : expiry === "90" ? 90 : undefined;
      const result = await createCliToken({ expiresInDays, scope: tokenScope });
      setNewToken(result.token);
      setNewTokenScope(result.scope);
      setExpiry("never");
      setTokenScope("read");
      loadTokens();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create token");
    } finally {
      setCreating(false);
    }
  }

  async function handleRevoke(token: CliToken) {
    if (
      !(await confirm({
        title: "Revoke token?",
        message: `Revoke token ${token.tokenPrefix}…? Anything authenticated with it stops working immediately.`,
        confirmLabel: "Revoke",
        destructive: true,
      }))
    ) {
      return;
    }
    try {
      await revokeCliToken(token.id);
      loadTokens();
    } catch {
      setError("Failed to revoke token");
    }
  }

  async function handleDelete(token: CliToken) {
    if (
      !(await confirm({
        title: "Delete token?",
        message: `Delete token ${token.tokenPrefix}…? This permanently removes the revoked token record.`,
        confirmLabel: "Delete",
        destructive: true,
      }))
    ) {
      return;
    }
    try {
      await deleteCliToken(token.id);
      loadTokens();
    } catch {
      setError("Failed to delete token");
    }
  }

  const installCommand = "npm install -g @trycycloid/cli";

  return (
    <div className="space-y-6">
      <SettingsPageHeader
        eyebrow="CLI tokens"
        title="CLI tokens"
        description="Install the Cycloid CLI and create tokens to authenticate it from your machine."
      />

      <SettingsSection title="Install" description="One-time setup on your local machine.">
        <div className="flex items-center gap-2">
          <code className="flex-1 truncate border border-border bg-surface-0 px-3 py-2.5 font-mono text-xs text-text-primary">
            {installCommand}
          </code>
          <CopyButton value={installCommand} label="Copy CLI install command" size="md" />
        </div>
        <p className="mt-3 text-xs text-text-muted">
          After install, run <code className="font-mono text-text-primary">cycloid login</code> with a token below.
        </p>
      </SettingsSection>

      <SettingsSection
        title="Create a token"
        description="Read for inspecting sessions; write to also drive new sessions."
        meta={<SettingsScopeBadge scope="user" />}
      >
        <div className="grid gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <SettingsField label="Expires" htmlFor={expirySelectId}>
            <Select name="expires" id={expirySelectId} value={expiry} onChange={(e) => setExpiry(e.target.value)}>
              <option value="30">30 days</option>
              <option value="90">90 days</option>
              <option value="never">Never</option>
            </Select>
          </SettingsField>
          <SettingsField label="Scope" htmlFor={scopeSelectId}>
            <Select
              name="scope"
              id={scopeSelectId}
              value={tokenScope}
              onChange={(e) => setTokenScope(e.target.value as CliTokenScope)}
            >
              <option value="read">Read</option>
              <option value="write">Write</option>
            </Select>
          </SettingsField>
          <Button type="button" onClick={handleCreate} disabled={creating} variant="primary" size="lg">
            Create
          </Button>
        </div>

        {newToken && (
          <div role="status" className="editorial-fade mt-4 border border-success-soft-border bg-success-soft p-4">
            <p className="text-xs font-medium text-success">
              {newTokenScope ? `${formatScope(newTokenScope)} token` : "Token"} created. Copy it now — it will not be
              shown again.
            </p>
            <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
              <code className="flex-1 break-all border border-border bg-surface-0 px-3 py-2 font-mono text-xs text-text-primary">
                {newToken}
              </code>
              <CopyButton value={newToken} label="Copy token" copiedChildren="Copied">
                Copy
              </CopyButton>
            </div>
          </div>
        )}

        {error && <p className="mt-3 text-xs text-error">{error}</p>}
      </SettingsSection>

      <SettingsSection
        title="Existing tokens"
        meta={
          <span className="inline-flex items-center gap-2">
            <SettingsScopeBadge scope="user" />
            {!loading && tokens.length > 0 ? (
              <span>
                <span className="numeral">{tokens.length}</span> active
              </span>
            ) : null}
          </span>
        }
      >
        {loading ? (
          <SettingsSkeleton rows={2} showHeader={false} />
        ) : tokens.length === 0 ? (
          <p className="editorial-fade text-sm text-text-muted">No tokens yet.</p>
        ) : (
          <ul className="editorial-fade divide-y divide-border">
            {tokens.map((token) => (
              <li
                key={token.id}
                className="flex flex-col gap-3 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <code className="font-mono text-sm text-text-primary">{token.tokenPrefix}…</code>
                    <Badge>{formatScope(token.scope)}</Badge>
                    {token.revokedAt && <Badge tone="error">Revoked</Badge>}
                  </div>
                  <p className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-text-muted">
                    <span>created {formatDate(token.createdAt)}</span>
                    {token.expiresAt && <span>expires {formatDate(token.expiresAt)}</span>}
                    {token.lastUsedAt && <span>last used {formatDate(token.lastUsedAt)}</span>}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  {!token.revokedAt ? (
                    <Button type="button" onClick={() => handleRevoke(token)} variant="danger" size="sm">
                      Revoke
                    </Button>
                  ) : (
                    <Button type="button" onClick={() => handleDelete(token)} variant="danger" size="sm">
                      Delete
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </SettingsSection>
    </div>
  );
}
