export const CYCLOID_PROTECTED_PRE_COMMIT_MARKER = "cycloid-protected-path-pre-commit";

export function buildProtectedPathPreCommitHook(originalHookPath?: string): string {
  const runOriginalHook = originalHookPath
    ? [
        "",
        `if [ -x "${escapeDoubleQuotedShellString(originalHookPath)}" ]; then`,
        `  "${escapeDoubleQuotedShellString(originalHookPath)}" "$@" || exit $?`,
        "fi",
      ].join("\n")
    : "";

  return [
    "#!/bin/sh",
    `# ${CYCLOID_PROTECTED_PRE_COMMIT_MARKER}`,
    "",
    "protected_files=$(git diff --cached --name-only --diff-filter=ACMR | awk '",
    "  /(^|\\/)\\.env($|\\.)/ ||",
    "  /(^|\\/)\\.ssh\\// ||",
    "  /(^|\\/)\\.gnupg\\// ||",
    "  /(^|\\/)\\.aws\\/credentials$/ ||",
    "  /(^|\\/)(id_rsa|id_ed25519)$/ ||",
    "  /\\.(pem|key)$/ ||",
    "  /(^|\\/)(secrets|credentials)\\.(json|yaml|yml)$/ ||",
    "  /(^|\\/)\\.(npmrc|pypirc)$/ { print }",
    "')",
    "",
    'if [ -n "$protected_files" ]; then',
    '  echo "Cycloid blocked commit: protected files are staged." >&2',
    '  echo "$protected_files" >&2',
    "  exit 1",
    "fi",
    runOriginalHook,
    "",
  ].join("\n");
}

function escapeDoubleQuotedShellString(value: string): string {
  return value.replace(/(["\\$`])/g, "\\$1");
}
