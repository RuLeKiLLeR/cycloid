export type GithubActionRequest = { argv: string[] };

export type GithubActionOperation =
  | { kind: "close" | "reopen"; prNumber: number; repo?: string }
  | { kind: "edit_title"; prNumber: number; title: string; repo?: string };

export type GithubActionParseResult =
  { ok: true; operation: GithubActionOperation } | { ok: false; code: "invalid_input"; message: string };

function parseTarget(value: string): number | null {
  if (/^[1-9]\d*$/.test(value)) return Number(value) <= Number.MAX_SAFE_INTEGER ? Number(value) : null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com") return null;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 4 || parts[2] !== "pull" || !/^[1-9]\d*$/.test(parts[3])) return null;
  return Number(parts[3]) <= Number.MAX_SAFE_INTEGER ? Number(parts[3]) : null;
}

export function parseGithubActionArgv(argv: unknown): GithubActionParseResult {
  if (!Array.isArray(argv) || argv.some((arg) => typeof arg !== "string")) {
    return { ok: false, code: "invalid_input", message: "argv must be an array of strings" };
  }
  const args = argv as string[];
  if (args.length < 3 || args[0] !== "pr") {
    return { ok: false, code: "invalid_input", message: "Only gh pr close, reopen, and title-only edit are supported" };
  }
  const action = args[1];
  if (action !== "close" && action !== "reopen" && action !== "edit") {
    return { ok: false, code: "invalid_input", message: "Unsupported pull-request action" };
  }
  let target: number | null = null;
  let repo: string | undefined;
  let title: string | undefined;
  for (let i = 2; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--repo" || arg === "--title") {
      if (i + 1 >= args.length || args[i + 1].startsWith("-")) {
        return { ok: false, code: "invalid_input", message: `${arg} requires a value` };
      }
      const value = args[++i];
      if (arg === "--repo") {
        if (repo !== undefined || !/^[^/\s]+\/[^/\s]+$/.test(value)) {
          return { ok: false, code: "invalid_input", message: "Invalid or repeated --repo" };
        }
        repo = value;
      } else {
        if (title !== undefined || value.length === 0 || value.length > 256) {
          return { ok: false, code: "invalid_input", message: "Invalid or repeated --title" };
        }
        title = value;
      }
      continue;
    }
    if (arg.startsWith("--repo=") || arg.startsWith("--title=")) {
      const [flag, ...rest] = arg.split("=");
      const value = rest.join("=");
      if (!value) return { ok: false, code: "invalid_input", message: `${flag} requires a value` };
      if (flag === "--repo") {
        if (repo !== undefined || !/^[^/\s]+\/[^/\s]+$/.test(value)) {
          return { ok: false, code: "invalid_input", message: "Invalid or repeated --repo" };
        }
        repo = value;
      } else {
        if (title !== undefined || value.length > 256) {
          return { ok: false, code: "invalid_input", message: "Invalid or repeated --title" };
        }
        title = value;
      }
      continue;
    }
    if (arg.startsWith("-")) return { ok: false, code: "invalid_input", message: `Unsupported flag ${arg}` };
    if (target !== null) return { ok: false, code: "invalid_input", message: "Exactly one PR target is required" };
    target = parseTarget(arg);
    if (target === null)
      return { ok: false, code: "invalid_input", message: "PR target must be a number or GitHub URL" };
  }
  if (target === null) return { ok: false, code: "invalid_input", message: "Exactly one PR target is required" };
  if (action === "edit" && title === undefined) {
    return { ok: false, code: "invalid_input", message: "Title-only edit requires --title" };
  }
  if (action !== "edit" && title !== undefined) {
    return { ok: false, code: "invalid_input", message: "--title is only supported for edit" };
  }
  return action === "edit"
    ? { ok: true, operation: { kind: "edit_title", prNumber: target, title: title!, repo } }
    : { ok: true, operation: { kind: action, prNumber: target, repo } };
}
