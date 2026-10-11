import { useId, useState } from "react";

import {
  deletePersonalSecret,
  fetchPersonalSecrets,
  importPersonalSecrets,
  type PersonalSecretsConfig,
  upsertPersonalSecret,
} from "../../api/secrets";
import { useSyncEffect } from "../../hooks/useEffects";
import { useConfirm } from "../ConfirmDialog";
import { Button, Input } from "../ui";
import { ImportSecretsModal } from "./ImportSecretsModal";
import {
  SettingsField,
  SettingsPageHeader,
  SettingsScopeBadge,
  SettingsSection,
  SettingsSkeleton,
} from "./SettingsLayout";

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
 * Personal (individual) secrets: encrypted write-only values injected into the
 * owner's sessions. Available to every authenticated user for their own account.
 */
export function PersonalSecretsSettings() {
  const [config, setConfig] = useState<PersonalSecretsConfig | null>(null);
  const [loading, setLoading] = useState(true);
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

  useSyncEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    fetchPersonalSecrets()
      .then((secrets) => {
        if (!cancelled) setConfig(secrets);
      })
      .catch((error) => {
        if (cancelled) return;
        setConfig(null);
        setLoadError(error instanceof Error ? error.message : "Failed to load personal secrets");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const keyNames = config?.keyNames ?? [];
  const entryByKey = new Map((config?.entries ?? []).map((entry) => [entry.key, entry]));

  async function saveVariable() {
    if (!draft) return;
    const nextKey = (draft.originalKey ?? draft.key).trim();
    if (!nextKey) {
      setSaveError("Key is required.");
      return;
    }

    setSaving(true);
    setSaveError(null);
    try {
      const saved = await upsertPersonalSecret(nextKey, draft.value, {
        usageNote: draft.usageNote.trim() || null,
        sensitive: draft.sensitive,
      });
      setConfig({
        ...saved,
        keyNames: upsertSortedKeyNames(saved.keyNames, nextKey, draft.originalKey),
      });
      setDraft(null);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Failed to save personal secret");
    } finally {
      setSaving(false);
    }
  }

  async function removeVariable(key: string) {
    const confirmed = await confirm({
      title: "Delete secret",
      message: `Delete ${key}? The value cannot be recovered.`,
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!confirmed) return;
    setDeleteKey(key);
    setSaveError(null);
    try {
      const result = await deletePersonalSecret(key);
      setConfig(result.secrets);
      if (draft?.originalKey === key || draft?.key === key) setDraft(null);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Failed to delete personal secret");
    } finally {
      setDeleteKey(null);
    }
  }

  return (
    <div className="space-y-6">
      <SettingsPageHeader
        eyebrow="Account"
        title="Personal secrets"
        description="Secrets available only to your sessions. Values stay encrypted and write-only."
        action={
          <Button type="button" onClick={() => setImportOpen(true)}>
            Import
          </Button>
        }
      />

      <SettingsSection
        title="Secrets"
        description="Injected into sandboxes you own. Repository secrets override personal ones when keys collide."
        meta={<SettingsScopeBadge scope="user" />}
      >
        {loading ? (
          <div className="py-3">
            <SettingsSkeleton showHeader={false} control={false} />
          </div>
        ) : loadError ? (
          <p className="py-3 text-sm text-error">{loadError}</p>
        ) : (
          <div className="editorial-fade space-y-5 py-3">
            {keyNames.length === 0 ? (
              <p className="text-base text-text-muted">No personal secrets configured yet.</p>
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
                        {entry?.usageNote ? (
                          <p className="mt-1 text-sm text-text-secondary">{entry.usageNote}</p>
                        ) : null}
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
                    hint={
                      draft.originalKey ? "Enter a replacement value. The current value is not retrievable." : undefined
                    }
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
                    {saving ? "Saving…" : draft.originalKey ? "Save secret" : "Add secret"}
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
              >
                Add secret
              </Button>
            )}
          </div>
        )}
      </SettingsSection>

      <ImportSecretsModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        allowedScopes={["personal"]}
        defaultScope="personal"
        onStore={async ({ text, sensitive }) => {
          const result = await importPersonalSecrets(text, sensitive);
          setConfig(result.secrets);
        }}
      />
    </div>
  );
}
