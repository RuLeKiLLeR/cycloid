import { type ChangeEvent, type DragEvent, useId, useRef, useState } from "react";

import {
  parseSecretImportText,
  SECRET_IMPORT_MAX_BYTES,
  type SecretImportParseError,
} from "../../../../../shared/secrets/import-format";
import { Toggle } from "../Toggle";
import { Button, Modal, Tabs, Textarea } from "../ui";
import { SettingsField } from "./SettingsLayout";

export type SecretImportScope = "repository" | "personal";

const PLACEHOLDER = `API_KEY=your-api-key-here # Use this API Key for GitHub
DATABASE_URL=postgresql://user:pass@localhost:5432/db # RDS on us-west-2
ENVIRONMENT=production`;

type ImportSecretsModalProps = {
  open: boolean;
  onClose: () => void;
  /** Scopes the user may choose. Repository-only surfaces omit the personal option. */
  allowedScopes: SecretImportScope[];
  defaultScope?: SecretImportScope;
  onStore: (args: { scope: SecretImportScope; text: string; sensitive: boolean }) => Promise<void>;
  /** Test-only: render inline instead of portaling to document.body. */
  portal?: boolean;
};

function formatParseErrors(errors: SecretImportParseError[]): string {
  return errors
    .slice(0, 5)
    .map((error) => error.message)
    .join("\n");
}

export function ImportSecretsModal({
  open,
  onClose,
  allowedScopes,
  defaultScope,
  onStore,
  portal = true,
}: ImportSecretsModalProps) {
  const initialScope =
    defaultScope && allowedScopes.includes(defaultScope) ? defaultScope : (allowedScopes[0] ?? "repository");
  const [scope, setScope] = useState<SecretImportScope>(initialScope);
  const [text, setText] = useState("");
  const [sensitive, setSensitive] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [loadedFileName, setLoadedFileName] = useState<string | null>(null);
  const fileInputId = useId();
  const pasteId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);

  function resetAndClose() {
    if (saving) return;
    setError(null);
    setLoadedFileName(null);
    onClose();
  }

  async function readFile(file: File) {
    if (file.size > SECRET_IMPORT_MAX_BYTES) {
      setError(`File is too large (max ${SECRET_IMPORT_MAX_BYTES / (1024 * 1024)}MB)`);
      return;
    }
    const contents = await file.text();
    setText(contents);
    setLoadedFileName(file.name || "Imported file");
    setError(null);
  }

  async function onFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      await readFile(file);
    } catch (readError) {
      setError(readError instanceof Error ? readError.message : "Failed to read file");
    }
  }

  async function onDrop(event: DragEvent<HTMLButtonElement>) {
    event.preventDefault();
    setDragActive(false);
    const file = event.dataTransfer.files?.[0];
    if (!file) return;
    try {
      await readFile(file);
    } catch (readError) {
      setError(readError instanceof Error ? readError.message : "Failed to read file");
    }
  }

  async function handleStore() {
    const parsed = parseSecretImportText(text);
    if (!parsed.ok) {
      setError(formatParseErrors(parsed.errors));
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await onStore({ scope, text, sensitive });
      setText("");
      setSensitive(true);
      setLoadedFileName(null);
      onClose();
    } catch (storeError) {
      setError(storeError instanceof Error ? storeError.message : "Failed to store secrets");
    } finally {
      setSaving(false);
    }
  }

  const showScopeToggle = allowedScopes.length > 1;

  return (
    <Modal
      open={open}
      onClose={resetAndClose}
      title="Import secrets"
      className="max-w-2xl p-6"
      portal={portal}
      footer={
        <Button type="button" onClick={() => void handleStore()} disabled={saving}>
          {saving ? "Storing…" : "Store"}
        </Button>
      }
    >
      <p className="text-sm text-text-muted">Add multiple secrets from a file or by pasting directly.</p>

      <div className="mt-5 space-y-5">
        {showScopeToggle ? (
          <SettingsField label="Secret scope">
            <Tabs
              ariaLabel="Secret scope"
              idBase="secret-scope"
              tabs={allowedScopes.map((option) => ({
                id: option,
                label: option === "repository" ? "Repository" : "Personal",
              }))}
              value={scope}
              onValueChange={(id) => setScope(id as SecretImportScope)}
            />
          </SettingsField>
        ) : null}

        <SettingsField label="Upload file" htmlFor={fileInputId}>
          <button
            type="button"
            onDragEnter={(event) => {
              event.preventDefault();
              setDragActive(true);
            }}
            onDragOver={(event) => {
              event.preventDefault();
              setDragActive(true);
            }}
            onDragLeave={(event) => {
              event.preventDefault();
              // Browsers fire dragleave on the parent when the cursor crosses into a
              // child element, so only clear the highlight when the drag truly leaves
              // the drop zone. Without this guard the highlight flickers off and back on.
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                setDragActive(false);
              }
            }}
            onDrop={(event) => void onDrop(event)}
            className={`flex cursor-pointer flex-col items-center justify-center gap-2 border border-dashed px-4 py-8 text-center transition-colors ${
              dragActive ? "border-accent bg-surface-2" : "border-border bg-surface-1"
            }`}
            onClick={() => fileInputRef.current?.click()}
          >
            <input
              ref={fileInputRef}
              id={fileInputId}
              type="file"
              accept=".env,.txt,text/plain"
              className="hidden"
              onChange={(event) => void onFileChange(event)}
            />
            <p className="text-sm text-text-primary">
              Choose a file or drag and drop (Max size: {SECRET_IMPORT_MAX_BYTES / (1024 * 1024)}MB)
            </p>
          </button>
          {loadedFileName ? <p className="mt-2 text-xs text-text-muted">Loaded: {loadedFileName}</p> : null}
        </SettingsField>

        <SettingsField label="Paste secrets" htmlFor={pasteId}>
          <ul className="mb-3 list-disc space-y-1 pl-5 text-sm text-text-muted">
            <li>
              The file should contain one secret per line in <span className="font-mono-tabular">Key=Value</span>{" "}
              format.
            </li>
            <li>Keys must contain only letters, numbers, and underscores, and cannot start with a number.</li>
            <li>
              Use inline comments with the <span className="font-mono-tabular">#</span> character to add notes
              explaining how to best use each secret.
            </li>
            <li>You can paste your file below to validate format.</li>
          </ul>
          <Textarea
            id={pasteId}
            value={text}
            placeholder={PLACEHOLDER}
            onChange={(event) => {
              setText(event.target.value);
              setLoadedFileName(null); // User edited the content manually (paste), clear loaded filename.
            }}
            rows={8}
            className="font-mono-tabular text-sm"
            disabled={saving}
          />
        </SettingsField>

        <div className="flex items-center justify-between gap-4 border border-border bg-surface-1 px-4 py-3">
          <div>
            <p className="text-sm text-text-primary">Sensitive</p>
            <p className="mt-0.5 text-sm text-text-muted">Secrets marked as Sensitive are redacted from the UI</p>
          </div>
          <Toggle
            checked={sensitive}
            onChange={() => setSensitive((current) => !current)}
            label="Redacted"
            disabled={saving}
          />
        </div>

        {error ? <p className="whitespace-pre-wrap text-sm text-error">{error}</p> : null}
      </div>
    </Modal>
  );
}
