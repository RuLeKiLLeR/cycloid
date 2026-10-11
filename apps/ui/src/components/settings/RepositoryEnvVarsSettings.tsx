import { useId, useRef, useState } from "react";

import {
  deleteRepositoryEnvironmentVariable,
  fetchRepositoryEnvironmentConfig,
  importRepositoryEnvironmentVariables,
  type RepositoryEnvironmentConfig,
  upsertRepositoryEnvironmentVariable,
} from "../../api/repository-settings";
import { useLayoutSyncEffect, useSyncEffect } from "../../hooks/useEffects";
import { useConfirm } from "../ConfirmDialog";
import { useLayoutContext } from "../Layout";
import { Button, Input } from "../ui";
import { ImportSecretsModal } from "./ImportSecretsModal";
import { SettingsField, SettingsSkeleton } from "./SettingsLayout";
import { parseRepoFullName } from "./workspaceSettingsShared";

type VariableDraft = {
  originalKey: string | null;
  key: string;
  value: string;
  usageNote: string;
  sensitive: boolean;
};

const EMPTY_DRAFT: VariableDraft = {
  originalKey: null,
  key: "",
  value: "",
  usageNote: "",
  sensitive: true,
};

function upsertSortedKeyNames(keyNames: string[], nextKey: string, previousKey: string | null): string[] {
  const next = keyNames.filter((key) => key !== previousKey && key !== nextKey);
  next.push(nextKey);
  return next.sort((left, right) => left.localeCompare(right));
}

function displayValue(sensitive: boolean): string {
  return sensitive ? "••••••••" : "(set)";
}

/**
 * Per-repo environment-variable editor for the Repositories page. Driven by the
 * page-level repo picker (`selectedRepo`), not its own selector. Values stay
 * write-only: existing values are never returned to the browser.
 */
export function RepositoryEnvVarsSettings({ selectedRepo }: { selectedRepo: string }) {
  const { user } = useLayoutContext();
  const [repoConfig, setRepoConfig] = useState<RepositoryEnvironmentConfig | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<VariableDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deleteKey, setDeleteKey] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const confirm = useConfirm();
  const keyInputId = useId();
  const valueInputId = useId();
  const noteInputId = useId();

  // Async mutation handlers capture the repo they were fired for; if the page-level
  // picker switches repos mid-flight, their late responses must not write state for
  // the no-longer-selected repo. This ref holds the latest committed selection so a
  // resolving handler can re-check it before touching per-repo view state. Synced in
  // a layout effect (not during render) so it reflects the committed selection.
  const selectedRepoRef = useRef(selectedRepo);
  useLayoutSyncEffect(() => {
    selectedRepoRef.current = selectedRepo;
  }, [selectedRepo]);

  useSyncEffect(() => {
    setDraft(null);
    setSaveError(null);
  }, [selectedRepo]);

  useSyncEffect(() => {
    if (!user?.businessId || !selectedRepo) {
      setRepoConfig(null);
      setLoadError(null);
      return;
    }
    const parsed = parseRepoFullName(selectedRepo);
    if (!parsed) {
      setRepoConfig(null);
      setLoadError("Selected repository is invalid.");
      return;
    }

    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    fetchRepositoryEnvironmentConfig(user.businessId, parsed.repoOwner, parsed.repoName)
      .then((config) => {
        if (!cancelled) setRepoConfig(config);
      })
      .catch((error) => {
        if (cancelled) return;
        setRepoConfig(null);
        setLoadError(error instanceof Error ? error.message : "Failed to load repository environment variables");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedRepo, user?.businessId]);

  const parsedRepo = selectedRepo ? parseRepoFullName(selectedRepo) : null;
  const keyNames = repoConfig?.keyNames ?? [];
  const entryByKey = new Map((repoConfig?.entries ?? []).map((entry) => [entry.key, entry]));

  async function saveVariable() {
    if (!user?.businessId || !parsedRepo || !draft) return;
    const nextKey = (draft.originalKey ?? draft.key).trim();
    if (!nextKey) {
      setSaveError("Key is required.");
      return;
    }

    const requestedRepo = selectedRepo;
    const isStillCurrent = () => selectedRepoRef.current === requestedRepo;
    setSaving(true);
    setSaveError(null);
    try {
      const saved = await upsertRepositoryEnvironmentVariable(
        user.businessId,
        parsedRepo.repoOwner,
        parsedRepo.repoName,
        nextKey,
        draft.value,
        { usageNote: draft.usageNote.trim() || null, sensitive: draft.sensitive },
      );
      // Drop the response if the user switched repos while it was in flight, so it
      // cannot clobber the newly selected repo's config or clear its draft.
      if (!isStillCurrent()) return;
      setRepoConfig({
        ...saved,
        keyNames: upsertSortedKeyNames(saved.keyNames, nextKey, draft.originalKey),
      });
      setDraft(null);
    } catch (error) {
      if (!isStillCurrent()) return;
      setSaveError(error instanceof Error ? error.message : "Failed to save repository environment variable");
    } finally {
      setSaving(false);
    }
  }

  async function removeVariable(key: string) {
    if (!user?.businessId || !parsedRepo) return;
    const confirmed = await confirm({
      title: "Delete environment variable",
      message: `Delete ${key} from ${selectedRepo}? The value cannot be recovered.`,
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!confirmed) return;
    const requestedRepo = selectedRepo;
    const isStillCurrent = () => selectedRepoRef.current === requestedRepo;
    setDeleteKey(key);
    setSaveError(null);
    try {
      const result = await deleteRepositoryEnvironmentVariable(
        user.businessId,
        parsedRepo.repoOwner,
        parsedRepo.repoName,
        key,
      );
      // Drop the response if the user switched repos while it was in flight, so it
      // cannot clobber the newly selected repo's config or clear its draft.
      if (!isStillCurrent()) return;
      setRepoConfig(result.loginEnv);
      if (draft?.originalKey === key || draft?.key === key) setDraft(null);
    } catch (error) {
      if (!isStillCurrent()) return;
      setSaveError(error instanceof Error ? error.message : "Failed to delete repository environment variable");
    } finally {
      setDeleteKey(null);
    }
  }

  if (!selectedRepo) {
    return <p className="text-sm text-text-muted">Select a repository to manage its environment variables.</p>;
  }
  if (loading) {
    return <SettingsSkeleton showHeader={false} control={false} />;
  }
  if (loadError) {
    return <p className="text-sm text-error">{loadError}</p>;
  }

  return (
    <div className="editorial-fade space-y-5">
      <div className="flex flex-wrap gap-3">
        <Button type="button" onClick={() => setImportOpen(true)} disabled={!selectedRepo}>
          Import
        </Button>
      </div>

      {keyNames.length === 0 ? (
        <p className="text-base text-text-muted">No environment variables configured for this repository.</p>
      ) : (
        <ul className="border-t border-border divide-y divide-border">
          {keyNames.map((key) => {
            const entry = entryByKey.get(key);
            const sensitive = entry?.sensitive !== false;
            return (
              <li key={key} className="flex items-center justify-between gap-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono-tabular text-base text-text-primary">{key}</p>
                  <p className="mt-0.5 text-sm text-text-muted">{displayValue(sensitive)}</p>
                  {entry?.usageNote ? <p className="mt-1 text-sm text-text-secondary">{entry.usageNote}</p> : null}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setDraft({
                        originalKey: key,
                        key,
                        value: "",
                        usageNote: entry?.usageNote ?? "",
                        sensitive,
                      });
                      setSaveError(null);
                    }}
                  >
                    Edit
                  </Button>
                  <Button
                    type="button"
                    variant="danger"
                    size="sm"
                    onClick={() => void removeVariable(key)}
                    disabled={deleteKey === key}
                  >
                    {deleteKey === key ? "Deleting…" : "Delete"}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {saveError ? <p className="text-sm text-error">{saveError}</p> : null}

      {draft ? (
        <div className="space-y-4 border border-border bg-surface-1 p-4">
          <div className="grid gap-4 md:grid-cols-2">
            <SettingsField
              label="Key"
              htmlFor={keyInputId}
              hint={draft.originalKey ? "Key cannot be changed when replacing an existing value." : undefined}
            >
              <Input
                id={keyInputId}
                value={draft.key}
                disabled={saving || Boolean(draft.originalKey)}
                onChange={(event) =>
                  setDraft((current) => (current ? { ...current, key: event.target.value } : current))
                }
                controlSize="lg"
              />
            </SettingsField>
            <SettingsField
              label={draft.originalKey ? "New value" : "Value"}
              htmlFor={valueInputId}
              hint={draft.originalKey ? "Enter a replacement value. The current value is not retrievable." : undefined}
            >
              <Input
                id={valueInputId}
                type="password"
                value={draft.value}
                disabled={saving}
                onChange={(event) =>
                  setDraft((current) => (current ? { ...current, value: event.target.value } : current))
                }
                controlSize="lg"
              />
            </SettingsField>
          </div>
          <SettingsField label="Usage note" htmlFor={noteInputId}>
            <Input
              id={noteInputId}
              value={draft.usageNote}
              disabled={saving}
              onChange={(event) =>
                setDraft((current) => (current ? { ...current, usageNote: event.target.value } : current))
              }
              controlSize="lg"
              placeholder="Optional hint shown in the UI"
            />
          </SettingsField>
          <div className="flex flex-wrap gap-3">
            <Button type="button" variant="primary" onClick={() => void saveVariable()} disabled={saving}>
              {saving ? "Saving…" : draft.originalKey ? "Save variable" : "Add variable"}
            </Button>
            <Button
              type="button"
              onClick={() => {
                setDraft(null);
                setSaveError(null);
              }}
              disabled={saving}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button
          type="button"
          variant="primary"
          onClick={() => {
            setDraft(EMPTY_DRAFT);
            setSaveError(null);
          }}
          disabled={!selectedRepo}
        >
          Add variable
        </Button>
      )}

      {user?.businessId && parsedRepo ? (
        <ImportSecretsModal
          open={importOpen}
          onClose={() => setImportOpen(false)}
          allowedScopes={["repository"]}
          defaultScope="repository"
          onStore={async ({ text, sensitive }) => {
            const requestedRepo = selectedRepo;
            const result = await importRepositoryEnvironmentVariables(
              user.businessId!,
              parsedRepo.repoOwner,
              parsedRepo.repoName,
              text,
              sensitive,
            );
            // Drop the response if the user switched repos while the import was in
            // flight, so it cannot clobber the newly selected repo's config. Errors
            // still bubble to ImportSecretsModal as before.
            if (selectedRepoRef.current !== requestedRepo) return;
            setRepoConfig(result.loginEnv);
          }}
        />
      ) : null}
    </div>
  );
}
