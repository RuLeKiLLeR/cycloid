/**
 * Redaction for exported traces. Harness transcripts contain raw tool output and
 * tool inputs, which can include secrets (tokens, keys, auth headers, private
 * keys) the agent saw. Anything leaving the machine must be scrubbed first.
 *
 * Defense in depth:
 *  1. `redactSecrets` - pattern scrubber for known secret shapes.
 *  2. `deepRedact`    - recursively scrubs every string in an assembled trace,
 *                       so no individual call site can forget to redact a field.
 *  3. `scanForSecrets` - a final detector the CLI runs over the rendered output;
 *                       if anything still looks secret, we refuse to ship rather
 *                       than leak silently.
 *
 * Patterns are intentionally broad: false positives (over-redaction) are safe;
 * a leaked credential is not.
 */

import type { RedactionOptions } from "./types.js";

const REDACTED = "[REDACTED]";

/**
 * HIGH-CONFIDENCE secret shapes: structured prefixes/formats that are almost
 * never anything but a real credential. A surviving match here means redaction
 * was bypassed, so the CLI refuses to ship (see `scanForSecrets`). Each entry's
 * first capture group (when present) is a label/prefix to preserve.
 */
const HIGH_CONFIDENCE_PATTERNS: RegExp[] = [
  // PEM private key blocks (RSA/EC/OPENSSH/PGP) - redact the whole block.
  /-----BEGIN[ A-Z]*PRIVATE KEY-----[\s\S]*?-----END[ A-Z]*PRIVATE KEY-----/g,
  // Anthropic (check before the generic sk- rule).
  /\bsk-ant-[A-Za-z0-9_-]{16,}/g,
  // OpenAI project/user keys and generic sk-/pk-/rk- DASH-prefixed tokens.
  /\bsk-proj-[A-Za-z0-9_-]{16,}/g,
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g,
  // Stripe and similar UNDERSCORE-prefixed keys: sk_live_, pk_test_, rk_live_.
  /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g,
  // GitHub: classic PATs/app tokens (ghp_, gho_, ghu_, ghs_, ghr_) and
  // fine-grained PATs (github_pat_...).
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  // Slack: bot/user/app/config tokens and webhook URLs.
  /\bxox[baprsce]-[A-Za-z0-9-]{10,}/g,
  /\bxapp-[A-Za-z0-9-]{10,}/g,
  /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]+/g,
  // Google API keys.
  /\bAIza[0-9A-Za-z_-]{16,}/g,
  // E2B keys.
  /\be2b_[A-Za-z0-9]{16,}/g,
  // AWS access key ids (the secret access key has no prefix; caught via the
  // KEY=value heuristic below when named).
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  // JWTs.
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  // Authorization headers (the header name makes this high-confidence).
  /(authorization\s*:\s*(?:bearer\s+|token\s+)?)[A-Za-z0-9._~+/=-]{12,}/gi,
];

/**
 * HEURISTIC secret shapes: name-based assignments and credential-in-URL forms.
 * These can false-positive on benign code, so they are applied for redaction
 * (over-redaction is safe) but do NOT gate the ship-blocking scan. The value
 * side is tightened to a token-like run of >=16 chars so short/benign values
 * (`apiKeys: {}`, `canManageTokens: true`, `apiKey: "ui"`) are left alone.
 */
const HEURISTIC_PATTERNS: RegExp[] = [
  // Bare `Bearer <token>` without an Authorization label.
  /\b(bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi,
  // URLs embedding credentials: scheme://user:secret@host (covers
  // x-access-token:<pat>@github.com clone URLs).
  /([a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s/@]{6,}(@)/gi,
  // KEY=value / "token": "value" for secret-named fields. Separator kept in the
  // capture group so it reads `API_KEY=[REDACTED]`; value must be a token-like
  // run of >=16 chars to avoid matching benign short code values.
  /\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIAL|AUTH)[A-Z0-9_]*\s*[=:]\s*["']?)[A-Za-z0-9._\-/+=]{16,}/gi,
];

const SECRET_PATTERNS: RegExp[] = [...HIGH_CONFIDENCE_PATTERNS, ...HEURISTIC_PATTERNS];

/** Scrub secret-shaped substrings from a single string. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (match, ...groups) => {
      // `groups` ends with (offset, fullString[, namedGroups]); the leading
      // entries are capture groups. A pattern may keep a prefix and/or a
      // trailing suffix (e.g. the `@` for credentialed URLs).
      const prefix = typeof groups[0] === "string" ? groups[0] : "";
      const suffix = typeof groups[1] === "string" ? groups[1] : "";
      if (prefix && match.startsWith(prefix)) {
        return suffix && match.endsWith(suffix) ? `${prefix}${REDACTED}${suffix}` : `${prefix}${REDACTED}`;
      }
      return REDACTED;
    });
  }
  return out;
}

/**
 * Recursively scrub every string in a value (object/array/scalar), returning a
 * structurally identical copy with secrets redacted. This is the guarantee that
 * nothing leaves un-scrubbed regardless of which field a secret landed in.
 */
export function deepRedact<T>(value: T): T {
  if (typeof value === "string") return redactSecrets(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => deepRedact(v)) as unknown as T;
  // Only recurse into PLAIN objects. `Object.entries` would collapse a Date to
  // {} and drop Map/Set contents; those cannot hold a secret string in our
  // trace shape, so pass any non-plain object through unchanged.
  if (value && typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = deepRedact(v);
    return out as T;
  }
  return value;
}

/**
 * Final detector: return the distinct secret-shaped substrings still present in
 * `text`. Used as a ship-blocking check after redaction. An empty array means
 * no known secret shape survived. Only HIGH_CONFIDENCE_PATTERNS are tested;
 * heuristic patterns are excluded so benign code never blocks a clean export.
 */
export function scanForSecrets(text: string): string[] {
  const hits = new Set<string>();
  // Only HIGH-CONFIDENCE shapes gate the ship: heuristic name-based matches
  // false-positive on benign code and must not block a clean export.
  for (const pattern of HIGH_CONFIDENCE_PATTERNS) {
    for (const m of text.matchAll(pattern)) {
      const whole = m[0];
      if (whole.includes(REDACTED)) continue;
      hits.add(whole.slice(0, 40));
    }
  }
  return [...hits];
}

/**
 * Truncate to `maxOutputChars`, keeping the head and tail (the interesting parts
 * of command output are usually at both ends). Records the elided byte count so
 * a reader can see the output was bounded, not empty.
 */
export function truncateOutput(text: string, maxOutputChars: number): string {
  if (text.length <= maxOutputChars) return text;
  const marker = (n: number) => `\n... [${n} chars truncated] ...\n`;
  // Reserve room for the marker; split the remainder head/tail.
  const budget = Math.max(0, maxOutputChars - marker(text.length).length);
  const headLen = Math.ceil(budget * 0.6);
  const tailLen = budget - headLen;
  const elided = text.length - headLen - tailLen;
  return text.slice(0, headLen) + marker(elided) + text.slice(text.length - tailLen);
}

/** Redact then truncate. Order matters: scrub secrets before dropping bytes. */
export function redactAndTruncate(text: string, opts: RedactionOptions): string {
  return truncateOutput(redactSecrets(text), opts.maxOutputChars);
}
