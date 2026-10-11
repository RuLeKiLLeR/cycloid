import { parseGithubActionArgv } from "../../../../shared/github-action.js";
import { GITHUB_ACTION_BROKER_REDIRECT } from "../constants/bridge.js";
import { type BlockedBashCommand, executableName, parseBashCommand } from "./bash-parser.js";

export type CycloidCliAuthState = "ready" | "pending" | "failed";

export type WorkflowRoutingViolation = {
  message: string;
  blockedCommands: BlockedBashCommand[];
};

export type WorkflowRoutingOptions = {
  reviewLoopMode?: boolean;
  cycloidCliAuthState?: CycloidCliAuthState;
};

const SHELL_EXECUTABLES = new Set(["bash", "sh", "zsh", "dash", "ash"]);
const VALUE_TAKING_SHORT_OPT_CHARS = new Set(["o", "O"]);
const VALUE_TAKING_LONG_OPTS = new Set(["--rcfile", "--init-file"]);
const SHORT_OPT_FLAG_RE = /^[-+][a-zA-Z]+$/;
const LONG_OPT_FLAG_RE = /^--[a-zA-Z][\w-]*$/;
const SHELL_SCRIPT_BODY_MAX_DEPTH = 5;

function findShellScriptBodyIdx(args: string[]): number {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const isCommandFlag =
      arg === "-c" ||
      arg === "--command" ||
      (arg.length >= 2 && arg[0] === "-" && arg[1] !== "-" && /^-[a-zA-Z]+$/.test(arg) && arg.includes("c"));
    if (!isCommandFlag) continue;

    for (let j = i + 1; j < args.length; j++) {
      const next = args[j]!;
      if (next === "--") return j + 1 < args.length ? j + 1 : -1;
      if (LONG_OPT_FLAG_RE.test(next)) {
        if (VALUE_TAKING_LONG_OPTS.has(next)) j++;
        continue;
      }
      if (SHORT_OPT_FLAG_RE.test(next)) {
        if (VALUE_TAKING_SHORT_OPT_CHARS.has(next[next.length - 1]!)) j++;
        continue;
      }
      return j;
    }
    return -1;
  }
  return -1;
}

function cycloidCliAuthBlockedCommand(
  raw: string,
  authState: Exclude<CycloidCliAuthState, "ready">,
): BlockedBashCommand {
  if (authState === "pending") {
    return {
      raw,
      executable: "cycloid",
      message:
        "Policy block: Cycloid CLI auth is still being prepared. Wait for auth to finish before running `cycloid ...`.",
      actionKey: "cycloid.cli_auth_pending",
      reasonKey: "cycloid_cli_auth_pending",
    };
  }
  return {
    raw,
    executable: "cycloid",
    message:
      "Policy block: Cycloid CLI auth setup failed earlier in this session. Do not run `cycloid ...`; start a new session or repair auth first.",
    actionKey: "cycloid.cli_auth_failed",
    reasonKey: "cycloid_cli_auth_failed",
  };
}

function collectCycloidCliAuthBlocks(
  command: string,
  authState: Exclude<CycloidCliAuthState, "ready">,
  depth = 0,
): BlockedBashCommand[] {
  const parsed = parseBashCommand(command);
  const blocked: BlockedBashCommand[] = [];

  for (const segment of parsed.segments) {
    const exec = executableName(segment.executable);
    if (exec === "cycloid") {
      blocked.push(cycloidCliAuthBlockedCommand(segment.raw, authState));
    }
    if (!exec || !SHELL_EXECUTABLES.has(exec) || depth >= SHELL_SCRIPT_BODY_MAX_DEPTH) continue;
    const scriptIdx = findShellScriptBodyIdx(segment.args);
    if (scriptIdx === -1) continue;
    const scriptBody = segment.args[scriptIdx];
    if (!scriptBody) continue;
    blocked.push(...collectCycloidCliAuthBlocks(scriptBody, authState, depth + 1));
  }

  return blocked;
}

/**
 * Review-loop specific command blocks. These are mutations the bridge's
 * publish/reply machinery owns; the agent must not bypass them by shelling
 * out to gh/git directly.
 */
function reviewLoopBlockedCommand(command: string): BlockedBashCommand | null {
  const normalized = command.replace(/\s+/g, " ").trim();
  if (/\bgh\s+api\b/.test(normalized)) {
    return {
      raw: command,
      executable: "gh",
      message: "Raw gh api is blocked in review-loop mode. Use the guarded review-loop publish/reply path.",
      actionKey: "review_loop.gh_api",
      reasonKey: "review_loop_mutation_blocked",
    };
  }
  const prEditSegments = parseBashCommand(command).segments.filter(
    (segment) => executableName(segment.executable) === "gh" && segment.args[0] === "pr" && segment.args[1] === "edit",
  );
  const allPrEditsAreBrokerSupported =
    prEditSegments.length > 0 &&
    prEditSegments.every((segment) => {
      const parsed = parseGithubActionArgv(segment.args);
      return parsed.ok && parsed.operation.kind === "edit_title";
    });
  if (/\bgh\s+pr\s+edit\b/.test(normalized) && !allPrEditsAreBrokerSupported) {
    return {
      raw: command,
      executable: "gh",
      message: `GitHub PR edit commands are blocked in review-loop mode. ${GITHUB_ACTION_BROKER_REDIRECT}`,
      actionKey: "review_loop.gh_pr_edit",
      reasonKey: "review_loop_mutation_blocked",
    };
  }
  if (/\bgh\s+(?:pr\s+(?:review|comment)|issue\s+comment)\b/.test(normalized)) {
    return {
      raw: command,
      executable: "gh",
      message:
        "GitHub review/comment commands are blocked in review-loop mode. Use the guarded review-loop publish/reply path.",
      actionKey: "review_loop.gh_review_comment",
      reasonKey: "review_loop_mutation_blocked",
    };
  }
  if (/\bgit\s+remote\s+set-url\b/.test(normalized)) {
    return {
      raw: command,
      executable: "git",
      message: "git remote set-url is blocked in review-loop mode.",
      actionKey: "review_loop.git_remote_set_url",
      reasonKey: "review_loop_mutation_blocked",
    };
  }
  const githubHttpMutation =
    /\b(?:curl|wget|fetch)\b/.test(normalized) &&
    /https?:\/\/api\.github\.com\b/i.test(normalized) &&
    (/(?:^|\s)-X\s*(?:POST|PUT|PATCH|DELETE)\b/i.test(normalized) ||
      /(?:^|\s)--request(?:\s+|=)(?:POST|PUT|PATCH|DELETE)\b/i.test(normalized) ||
      /(?:^|\s)(?:-d\b|--data\b|--data-binary\b|--data-raw\b|--upload-file\b|-T\b)/.test(normalized));
  if (githubHttpMutation) {
    return {
      raw: command,
      executable: "http",
      message:
        "Raw GitHub HTTP mutations are blocked in review-loop mode. Use the guarded review-loop publish/reply path.",
      actionKey: "review_loop.github_http_mutation",
      reasonKey: "review_loop_mutation_blocked",
    };
  }
  return null;
}

/**
 * Check a bash command for workflow-routing violations: blocked git/gh
 * patterns and review-loop-only mutation blocks. Returns null when the
 * command is allowed. Path-side protection lives in `protection.ts`.
 */
export function checkWorkflowRouting(
  tool: string,
  input: Record<string, unknown>,
  options: WorkflowRoutingOptions = {},
): WorkflowRoutingViolation | null {
  if (tool.toLowerCase() !== "bash" || typeof input.command !== "string") return null;

  if (options.reviewLoopMode) {
    const reviewBlocked = reviewLoopBlockedCommand(input.command);
    if (reviewBlocked) {
      return {
        message: `Blocked command(s): ${reviewBlocked.message}`,
        blockedCommands: [reviewBlocked],
      };
    }
  }

  const parsed = parseBashCommand(input.command);
  if (parsed.isDangerous) {
    return {
      message: `Blocked command(s): ${parsed.blockedCommands.join(", ")}`,
      blockedCommands: parsed.blockedCommandDetails,
    };
  }

  if (options.cycloidCliAuthState === "pending" || options.cycloidCliAuthState === "failed") {
    const blockedCommands = collectCycloidCliAuthBlocks(input.command, options.cycloidCliAuthState);
    if (blockedCommands.length > 0) {
      const distinctMessages = [...new Set(blockedCommands.map((detail) => detail.message))];
      return {
        message: `Blocked command(s): ${distinctMessages.join(" ")}`,
        blockedCommands,
      };
    }
  }

  return null;
}
