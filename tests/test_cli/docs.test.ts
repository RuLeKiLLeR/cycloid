import { execFile, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { cpus } from "node:os";
import { promisify } from "node:util";

import { beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

const TSX_BIN = "node_modules/.bin/tsx";
const CLI_ENTRY = "apps/cli/src/index.ts";
const HELP_ONLY_OPTIONS = new Set(["--help", "--version"]);
const DOC_ONLY_GLOBAL_OPTIONS = new Set(["--json"]);

type GuardedCommand = {
  heading: string;
  args: string[];
  allowedDocOnlyOptions?: string[];
};

const CUSTOMER_COMMANDS: GuardedCommand[] = [
  { heading: "cycloid auth login", args: ["auth", "login"] },
  { heading: "cycloid auth whoami", args: ["auth", "whoami"] },
  { heading: "cycloid codex login", args: ["codex", "login"] },
  { heading: "cycloid codex use <on|off>", args: ["codex", "use"] },
  { heading: "cycloid codex status", args: ["codex", "status"] },
  { heading: "cycloid codex logout", args: ["codex", "logout"] },
  { heading: "cycloid sessions create <repo-url> [prompt]", args: ["sessions", "create"] },
  { heading: "cycloid sessions qa <pr-url>", args: ["sessions", "qa"] },
  { heading: "cycloid sessions send <session-id> [prompt]", args: ["sessions", "send"] },
  {
    heading: "cycloid sessions respond <session-id> [answer]",
    args: ["sessions", "respond"],
    allowedDocOnlyOptions: ["--follow"],
  },
  { heading: "cycloid sessions stop <session-id>", args: ["sessions", "stop"] },
  { heading: "cycloid sessions get <session-id>", args: ["sessions", "get"] },
  { heading: "cycloid sessions list", args: ["sessions", "list"] },
  { heading: "cycloid sessions search <query>", args: ["sessions", "search"] },
  { heading: "cycloid sessions events <session-id>", args: ["sessions", "events"] },
  { heading: "cycloid sessions transcript <session-id>", args: ["sessions", "transcript"] },
  { heading: "cycloid sessions watch <session-id>", args: ["sessions", "watch"], allowedDocOnlyOptions: ["--follow"] },
  { heading: "cycloid sessions usage <session-id>", args: ["sessions", "usage"] },
  { heading: "cycloid repos list", args: ["repos", "list"] },
  { heading: "cycloid repos branches [repo]", args: ["repos", "branches"] },
  { heading: "cycloid repos skills [repo]", args: ["repos", "skills"] },
  { heading: "cycloid models list", args: ["models", "list"] },
  { heading: "cycloid automations create <repo-url> [prompt]", args: ["automations", "create"] },
  { heading: "cycloid automations list", args: ["automations", "list"] },
  { heading: "cycloid automations delete <id>", args: ["automations", "delete"] },
  { heading: "cycloid tokens list", args: ["tokens", "list"] },
  { heading: "cycloid tokens create", args: ["tokens", "create"] },
  { heading: "cycloid tokens revoke <id>", args: ["tokens", "revoke"] },
];

const INTERNAL_ONLY_COMMANDS: GuardedCommand[] = [
  { heading: "cycloid test-creds list <repo>", args: ["test-creds", "list"] },
  { heading: "cycloid test-creds set <repo> <name>", args: ["test-creds", "set"] },
  { heading: "cycloid test-creds delete <repo> <name>", args: ["test-creds", "delete"] },
  { heading: "cycloid sandbox build [source-repo]", args: ["sandbox", "build"] },
  { heading: "cycloid sandbox logs <build-id>", args: ["sandbox", "logs"] },
  { heading: "cycloid egress source set <source-repo>", args: ["egress", "source", "set"] },
  { heading: "cycloid egress source get", args: ["egress", "source", "get"] },
  { heading: "cycloid egress add <domains...>", args: ["egress", "add"] },
  { heading: "cycloid egress sync", args: ["egress", "sync"] },
  { heading: "cycloid egress validate [path]", args: ["egress", "validate"] },
];

// docs/cli.md is the internal reference (all commands); apps/cli/README.md is
// the customer-facing doc published to npm and must not document internal
// commands such as test-creds.
const GUARDED_DOCS: { path: string; commands: GuardedCommand[]; excludedHeadings: string[] }[] = [
  {
    path: "docs/cli.md",
    commands: [...CUSTOMER_COMMANDS, ...INTERNAL_ONLY_COMMANDS],
    excludedHeadings: [],
  },
  {
    path: "apps/cli/README.md",
    commands: CUSTOMER_COMMANDS,
    excludedHeadings: INTERNAL_ONLY_COMMANDS.map((command) => command.heading),
  },
];

// Each helpText call cold-boots tsx + the whole CLI entry (~250ms). The same
// commands are checked across both guarded docs (docs/cli.md and the README
// share CUSTOMER_COMMANDS), and the events example reuses "sessions events", so
// memoizing by args avoids spawning the identical `--help` invocation twice.
const helpTextCache = new Map<string, string>();
function helpText(args: string[]): string {
  // JSON.stringify, not args.join(" "): a joined key would collide for arrays
  // that differ only in token boundaries (e.g. ["sessions events"] vs
  // ["sessions", "events"]). Current call sites use single-word tokens, but the
  // unambiguous key keeps the cache correct if a multi-word arg is ever added.
  const key = JSON.stringify(args);
  const cached = helpTextCache.get(key);
  if (cached !== undefined) return cached;
  const help = execFileSync(TSX_BIN, [CLI_ENTRY, ...args, "--help"], { encoding: "utf8", timeout: 15_000 });
  helpTextCache.set(key, help);
  return help;
}

// Each helpText() above cold-boots tsx serially (~250ms each); run sequentially
// that is ~4.5s of pure process spawn inside one synchronous `it`. Prefetch every
// unique `--help` invocation concurrently in beforeAll so the sync assertions read
// from cache. Keys are derived from the same sources helpText() is called with, so
// JSON.stringify(args) matches exactly. Concurrency is bounded (don't bypass the
// suite's deliberate maxWorkers cap) and failures are isolated: a key that fails to
// prefetch stays uncached and helpText() falls back to its sync spawn for that arg.
async function warmHelpCache(): Promise<void> {
  const seen = new Set<string>();
  const argSets: string[][] = [];
  const enqueue = (args: string[]) => {
    const key = JSON.stringify(args);
    if (seen.has(key)) return;
    seen.add(key);
    argSets.push(args);
  };
  for (const guardedDoc of GUARDED_DOCS) {
    for (const command of guardedDoc.commands) enqueue(command.args);
  }
  // The "sessions events" assertion below calls helpText(["sessions", "events"])
  // directly, independent of GUARDED_DOCS. CUSTOMER_COMMANDS happens to enqueue
  // the same args today (so this dedupes to a no-op), but keep it explicit so the
  // standalone call stays warm if "sessions events" is ever dropped from the docs
  // command list.
  enqueue(["sessions", "events"]);

  const concurrency = Math.max(2, Math.min(4, cpus().length));
  let next = 0;
  const worker = async () => {
    while (next < argSets.length) {
      const args = argSets[next++];
      try {
        const { stdout } = await execFileAsync(TSX_BIN, [CLI_ENTRY, ...args, "--help"], {
          encoding: "utf8",
          timeout: 15_000,
        });
        helpTextCache.set(JSON.stringify(args), stdout);
      } catch {
        // Leave uncached; the sync helpText() fallback re-spawns just this arg.
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
}

function documentedSection(doc: string, docPath: string, heading: string): string {
  const marker = `### \`${heading}\``;
  const start = doc.indexOf(marker);
  expect(start, `Missing ${docPath} heading: ${marker}`).toBeGreaterThanOrEqual(0);

  const rest = doc.slice(start + marker.length);
  const nextHeading = rest.search(/\n##+ /);
  return nextHeading === -1 ? rest : rest.slice(0, nextHeading);
}

function longOptionsFromHelp(help: string): string[] {
  const options = new Set<string>();
  for (const line of help.split("\n")) {
    const match = line.match(/^\s+(?:-\w,\s+)?(--[a-z][\w-]*)/);
    if (match?.[1] && !HELP_ONLY_OPTIONS.has(match[1])) {
      options.add(match[1]);
    }
  }
  return [...options].sort();
}

function longOptionsFromDocs(section: string): string[] {
  const options = new Set<string>();
  for (const match of section.matchAll(/--[a-z][\w-]*/g)) {
    if (!HELP_ONLY_OPTIONS.has(match[0]) && !DOC_ONLY_GLOBAL_OPTIONS.has(match[0])) {
      options.add(match[0]);
    }
  }
  return [...options].sort();
}

describe("CLI docs", () => {
  // 60s budget mirrors the slow assertion below; the default 10s hookTimeout can
  // flake under CI contention while ~18 tsx cold boots run concurrently.
  beforeAll(warmHelpCache, 60_000);

  for (const guardedDoc of GUARDED_DOCS) {
    it(`keeps ${guardedDoc.path} command flags aligned with CLI help`, () => {
      const doc = readFileSync(guardedDoc.path, "utf8");
      const missing: string[] = [];
      const stale: string[] = [];

      for (const command of guardedDoc.commands) {
        const section = documentedSection(doc, guardedDoc.path, command.heading);
        const helpOptions = new Set(longOptionsFromHelp(helpText(command.args)));
        const docOptions = new Set(longOptionsFromDocs(section));
        const allowedDocOnlyOptions = new Set(command.allowedDocOnlyOptions ?? []);
        for (const option of helpOptions) {
          if (!docOptions.has(option)) {
            missing.push(`${command.heading}: ${option}`);
          }
        }
        for (const option of docOptions) {
          if (!helpOptions.has(option) && !allowedDocOnlyOptions.has(option)) {
            stale.push(`${command.heading}: ${option}`);
          }
        }
      }

      expect(missing).toEqual([]);
      expect(stale).toEqual([]);
    }, 60_000);

    it(`keeps internal-only commands out of ${guardedDoc.path} when excluded`, () => {
      const doc = readFileSync(guardedDoc.path, "utf8");
      for (const heading of guardedDoc.excludedHeadings) {
        expect(doc, `${guardedDoc.path} must not document internal command: ${heading}`).not.toContain(
          `### \`${heading}\``,
        );
      }
    });
  }

  it("shows a paginated replay example in sessions events help", () => {
    const help = helpText(["sessions", "events"]);

    expect(help).toContain("cycloid sessions events <session-id> --after-sequence 540 --limit 250 --json");
  });

  it("documents agent-critical JSON shapes in session command help", () => {
    expect(helpText(["sessions", "create"])).toContain(
      "--wait --json also includes best-effort result fields when available: prUrl?, publishedBranch?, lastBranch?",
    );
    expect(helpText(["sessions", "qa"])).toContain(
      "JSON mode returns {sessionId, sessionUrl?, repoUrl, targetPrUrl, model?, agentRuntimeBackend?, reasoningEffort?, promptId?}",
    );
    expect(helpText(["sessions", "get"])).toContain(
      "Result fields are at .session.prUrl, .session.publishedBranch, and .session.lastBranch.",
    );
    expect(helpText(["sessions", "events"])).toContain(
      "--follow --json emits NDJSON, one {sequence, type, data} object per line.",
    );
    expect(helpText(["sessions", "events"])).toContain(
      "Actionable follow types: pr_created/pr_updated use data.prUrl; question uses data.question; terminal types are prompt_completed, prompt_failed, and session_idle.",
    );
  });
});
