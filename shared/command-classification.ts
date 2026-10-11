import type { PrReadinessCommand } from "./types/sandbox.js";

/**
 * The single command classifier shared by the bridge and control plane.
 *
 * The optimistic publish verdict needs exactly one predicate from a command:
 * "is this a recognized check (test / lint / typecheck / build / functional
 * smoke) rather than exploratory shell noise?" `commandLabel` provides the
 * short display label PR bodies render.
 *
 * This replaces the per-ecosystem proof taxonomies that were duplicated across
 * the bridge and control-plane apps.
 */

/** Read-only / inspection commands that must never count as a check. */
const EXPLORATORY_COMMAND_PATTERN =
  /^(?:env\s+\S+=\S+\s+)*(?:rg|grep|sed|awk|cat|head|tail|less|more|ls|find|fd|pwd|which|type|tree|stat|wc|git\s+(?:status|diff|show|log|branch|blame|rev-parse)|npm\s+(?:pkg\s+get|ls|list|view|outdated)|pnpm\s+(?:list|ls|why|outdated)|yarn\s+(?:list|why|info)|cargo\s+(?:tree|search)|go\s+(?:env|list|version)|pip\s+(?:show|list|freeze))\b/i;

/**
 * Recognized check commands across the common ecosystems. Grouped per ecosystem
 * for readability; the exported predicate ORs them together.
 */
const RELEVANT_CHECK_PATTERNS: RegExp[] = [
  // JS / TS
  /\b(?:npm|pnpm|yarn)\s+(?:--workspace\s+\S+\s+|-w\s+\S+\s+)?(?:run\s+)?(?:test(?::[\w:-]+)?|lint(?::[\w:-]+)?|build|typecheck|type-check|check(?::types?)?)\b/i,
  /\bnpm\s+run\s+(?:--workspace(?:=|\s+)\S+\s+|-w\s+\S+\s+)(?:test(?::[\w:-]+)?|lint(?::[\w:-]+)?|build|typecheck|type-check|check(?::types?)?)\b/i,
  /\b(?:npx\s+)?(?:vitest|jest|playwright|tsc|eslint|prettier|biome|oxlint|oxfmt|pyright)\b/i,
  /\btsc\s+--noEmit\b/i,
  /\bnode\s+--test\b/i,
  /\bpre-commit\b/i,
  // Go
  /\bgo\s+(?:test|vet|build)\b/i,
  /\b(?:golangci-lint|staticcheck)\b/i,
  /\bgo(?:fmt)\b|\bgo\s+fmt\b/i,
  // Rust
  /\bcargo\s+(?:test|build|check|clippy|fmt|nextest)\b/i,
  // Python
  /\b(?:uv\s+run(?:\s+--project\s+\S+)?\s+|poetry\s+run\s+|pipenv\s+run\s+|python[\d.]*\s+-m\s+)?(?:pytest|ruff|mypy|pyright|tox|nox|flake8|pylint)\b/i,
  /\bblack\s+(?:--check|\.)/i,
  // JVM
  /\bmvn\b[^\n]*\b(?:test|verify|compile|package|install)\b/i,
  /\b(?:\.\/)?gradlew?\b[^\n]*\b(?:test|build|check|assemble)\b/i,
  // Ruby
  /\b(?:bundle\s+exec\s+)?rspec\b/i,
  /\brake\s+(?:test|spec)\b/i,
  /\brubocop\b/i,
  // DB / migrations / data transforms
  /\b(?:psql|sqlite3|mysql|alembic|goose|flyway|dbt|prisma|drizzle|knex|sequelize|typeorm)\b/i,
  /\bwrangler\s+d1\b/i,
  // Infra
  /\b(?:terraform|terragrunt|tofu|opentofu|helm|wrangler|actionlint|yamllint)\b/i,
  /\bkubectl\b[^\n]*--dry-run\b/i,
  // Functional smoke
  /\bcurl\b/i,
];

// Only consulted when a command's outcome is genuinely unknown (no exit code and
// not completed). The bare `Error:\s` token was removed: passing test logs and
// negative-path assertions routinely print "Error:" ("✓ throws Error: not
// found"), so it produced false failures on clean-exit commands. The remaining
// connection-level and explicit HTTP 4xx/5xx tokens only fire in the
// unknown-outcome branch now.
const FAILED_VERIFICATION_OUTPUT_PATTERN =
  /\b(?:EADDRINUSE|ERR_SERVER_ALREADY_LISTEN|address already in use|ECONNREFUSED|ECONNRESET|ETIMEDOUT|Cannot\s+(?:GET|POST|PUT|PATCH|DELETE)\b|HTTP\/\d(?:\.\d)?\s+[45]\d\d|status(?:\s+code|Code)?[=:\s]+[45]\d\d)\b/i;

function stripOuterQuotes(value: string): string {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  return (first === "'" && last === "'") || (first === '"' && last === '"') ? value.slice(1, -1) : value;
}

/**
 * Normalized forms of a command. For a `bash -c "..."` wrapper, the inner
 * payload REPLACES the wrapper form: the wrapper's only classification-relevant
 * content is its quoted payload, and matching patterns textually against the
 * raw `bash -c "..."` string would treat tokens inside the quotes (e.g. a
 * `grep 'npm test'` argument) as if they were the command itself. Returning the
 * unwrapped payload lets the per-segment classifier see the real command and
 * apply the exploratory guard to it.
 */
function commandForms(command: string | undefined): string[] {
  const trimmed = command?.replace(/\s+/g, " ").trim();
  if (!trimmed) return [];
  const shellPayload = trimmed.match(/^(?:\/bin\/)?(?:bash|sh|zsh)\s+-[A-Za-z]*c[A-Za-z]*\s+(.+)$/i)?.[1];
  const forms = shellPayload ? [stripOuterQuotes(shellPayload.trim())] : [trimmed];
  return Array.from(new Set(forms));
}

/**
 * Split a command into top-level segments on the shell control operators `&&`,
 * `||`, `;`, and `|`, respecting single/double quotes so an operator inside a
 * quoted string (e.g. `grep "a; npm test"`) does NOT create a false segment.
 * This is a classification aid, not a full shell parser.
 */
export function splitTopLevelSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (inSingle) {
      if (ch === "'") inSingle = false;
      current += ch;
      continue;
    }
    if (inDouble) {
      if (ch === '"') inDouble = false;
      current += ch;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      current += ch;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      current += ch;
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "&") {
      // `&&`/`||` consume two chars; a lone `|` (pipe) also separates segments.
      // A lone `&` (background) is not a separator we care about, so keep it.
      if ((ch === "&" || ch === "|") && command[i + 1] === ch) {
        segments.push(current);
        current = "";
        i++;
        continue;
      }
      if (ch === "|" || ch === ";") {
        segments.push(current);
        current = "";
        continue;
      }
    }
    current += ch;
  }
  segments.push(current);
  return segments.map((segment) => segment.trim()).filter((segment) => segment.length > 0);
}

/**
 * True when the command runs a recognized check: some top-level segment is a
 * known test/lint/typecheck/build/functional-smoke command AND is not itself a
 * read-only inspection command. Classifying per segment (rather than over the
 * whole string) means a check chained after an inspection command still counts
 * (`git diff && npm test`), while a check token that only appears inside an
 * inspection command's argument does not (`grep "npm test"`).
 */
export function isRelevantCheckCommand(command: string | undefined): boolean {
  return commandForms(command).some((form) =>
    splitTopLevelSegments(form).some(
      (segment) =>
        !EXPLORATORY_COMMAND_PATTERN.test(segment) && RELEVANT_CHECK_PATTERNS.some((pattern) => pattern.test(segment)),
    ),
  );
}

function commandOutputText(command: Pick<PrReadinessCommand, "summary" | "failureOutput" | "skipReason">): string {
  return [command.summary, command.failureOutput, command.skipReason].filter(Boolean).join("\n");
}

export function commandLooksFailed(
  command: Pick<PrReadinessCommand, "status" | "exitCode" | "summary" | "failureOutput" | "skipReason">,
): boolean {
  if (command.status === "error") return true;
  // A numeric exit code is fully authoritative: exit 0 is a pass regardless of
  // benign substrings in the output ("✓ throws Error: not found"), and any
  // non-zero code is a failure. Only when no numeric code is available (Codex
  // exposes terminal tool status, not the underlying process code — see
  // PrReadinessCommand.exitCode) do we fall back to scanning output text.
  if (typeof command.exitCode === "number") return command.exitCode !== 0;
  return FAILED_VERIFICATION_OUTPUT_PATTERN.test(commandOutputText(command));
}

/** Ordered category → label rules for PR-body display. First match wins. */
const LABEL_RULES: Array<{ label: string; pattern: RegExp }> = [
  { label: "typecheck", pattern: /\b(?:tsc|typecheck|type-check|check:types?|mypy|pyright)\b/i },
  {
    label: "tests",
    pattern:
      /\b(?:vitest|jest|playwright|pytest|rspec|nextest|node\s+--test|cargo\s+test|go\s+test|(?:npm|pnpm|yarn)\s+(?:run\s+)?test|rake\s+(?:test|spec)|mvn\b[^\n]*\btest|gradlew?\b[^\n]*\btest)\b/i,
  },
  {
    label: "lint",
    pattern:
      /\b(?:eslint|prettier|biome|oxlint|oxfmt|ruff|flake8|pylint|rubocop|clippy|golangci-lint|staticcheck|gofmt|go\s+fmt|cargo\s+fmt|black|actionlint|yamllint|pre-commit)\b/i,
  },
  { label: "build", pattern: /\b(?:(?:npm|pnpm|yarn)\s+(?:run\s+)?build|cargo\s+build|go\s+build|cargo\s+check)\b/i },
  {
    label: "migration",
    pattern: /\b(?:psql|sqlite3|mysql|alembic|goose|flyway|dbt|prisma|drizzle|knex|sequelize|typeorm|wrangler\s+d1)\b/i,
  },
  { label: "infra", pattern: /\b(?:terraform|terragrunt|tofu|opentofu|helm|wrangler|kubectl)\b/i },
  { label: "smoke", pattern: /\bcurl\b/i },
];

/**
 * Short, stable label for a command, used in PR-body evidence rows. Falls back
 * to the leading executable token when no category matches.
 */
export function commandLabel(command: string | undefined): string {
  const forms = commandForms(command);
  if (forms.length === 0) return "command";
  for (const { label, pattern } of LABEL_RULES) {
    if (forms.some((form) => pattern.test(form))) return label;
  }
  const head = forms[forms.length - 1].split(/\s+/)[0];
  return head || "command";
}
