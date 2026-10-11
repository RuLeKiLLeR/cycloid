import { useId, useState } from "react";

import { createGithubCheckAutomation, type GithubCheckAutomationRule } from "../../api/github-check-automations";
import { useSyncEffect } from "../../hooks/useEffects";
import type { Repo } from "../../types";
import { Button, Input, Modal, Select, Textarea } from "../ui";

const DEFAULT_PROMPT =
  "Investigate the failed check on this pull request. Fix the root cause, run focused verification, and open a PR only when a safe change is needed.";
const DEFAULT_NAME = "Fix failed PR checks";

export function GithubCheckAutomationModal({
  open,
  repos,
  reposLoaded,
  onClose,
  onSaved,
}: {
  open: boolean;
  repos: Repo[];
  reposLoaded: boolean;
  onClose: () => void;
  onSaved: (rule: GithubCheckAutomationRule) => void;
}) {
  const repoId = useId(),
    checkId = useId(),
    promptId = useId(),
    nameId = useId();
  const [repo, setRepo] = useState("");
  const [checkName, setCheckName] = useState("");
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [name, setName] = useState(DEFAULT_NAME);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useSyncEffect(() => {
    if (open) {
      setRepo("");
      setCheckName("");
      setPrompt(DEFAULT_PROMPT);
      setName(DEFAULT_NAME);
      setBusy(false);
      setError(null);
    }
  }, [open]);
  const parsed = repo.split("/");
  async function submit() {
    if (parsed.length < 2 || !prompt.trim()) return;
    setBusy(true);
    setError(null);
    try {
      onSaved(
        await createGithubCheckAutomation({
          repoOwner: parsed[0]!,
          repoName: parsed.slice(1).join("/"),
          checkName: checkName.trim() || null,
          modelId: null,
          promptTemplate: prompt.trim(),
          name: name.trim() || null,
        }),
      );
    } catch (e) {
      setBusy(false);
      setError(e instanceof Error ? e.message : "Failed to create automation");
    }
  }
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Failed GitHub check automation"
      className="max-w-lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={busy || parsed.length < 2 || !prompt.trim()}>
            {busy ? "Creating…" : "Create automation"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm text-text-muted">
          Starts one fresh session per rule, pull request, and head when a check fails. Cycloid-owned PR review-loop CI
          keeps precedence.
        </p>
        <label htmlFor={repoId}>Repository</label>
        <Select id={repoId} value={repo} disabled={!reposLoaded} onChange={(e) => setRepo(e.target.value)}>
          <option value="">{reposLoaded ? "Select a repository" : "Loading repositories…"}</option>
          {repos.map((r) => (
            <option key={r.fullName} value={r.fullName}>
              {r.fullName}
            </option>
          ))}
        </Select>
        <label htmlFor={checkId}>Exact check name (optional)</label>
        <Input id={checkId} value={checkName} onChange={(e) => setCheckName(e.target.value)} placeholder="test" />
        <label htmlFor={promptId}>Instructions</label>
        <Textarea id={promptId} value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={5} />
        <label htmlFor={nameId}>Name</label>
        <Input id={nameId} value={name} onChange={(e) => setName(e.target.value)} />
        {error ? (
          <p className="text-xs text-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
