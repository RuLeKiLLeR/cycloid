/**
 * KEY=VALUE secret import format shared by UI validation and control-plane ingest.
 *
 * Lines are one secret each. Blank lines and full-line `#` comments are ignored.
 * Inline `#` comments after a value become usage notes (unquoted values only;
 * `#` inside single- or double-quoted values is kept as part of the secret).
 */

export const SECRET_IMPORT_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const SECRET_IMPORT_MAX_BYTES = 2 * 1024 * 1024;
export const SECRET_IMPORT_MAX_ENTRIES = 200;
export const SECRET_IMPORT_MAX_USAGE_NOTE_CHARS = 500;

export type ParsedSecretImportEntry = {
  key: string;
  value: string;
  usageNote: string | null;
  lineNumber: number;
};

export type SecretImportParseError = {
  lineNumber: number;
  message: string;
};

export type SecretImportParseResult =
  { ok: true; entries: ParsedSecretImportEntry[] } | { ok: false; errors: SecretImportParseError[] };

export class SecretImportValidationError extends Error {
  readonly errors: SecretImportParseError[];

  constructor(errors: SecretImportParseError[]) {
    super(errors[0]?.message ?? "Invalid secret import");
    this.name = "SecretImportValidationError";
    this.errors = errors;
  }
}

function decodeQuotedValue(rawValue: string, lineNumber: number): string {
  const value = rawValue.trim();
  if (!value) return "";

  const quote = value[0];
  if (quote !== "'" && quote !== '"') return value;

  if (value.length < 2 || value[value.length - 1] !== quote) {
    throw new SecretImportValidationError([
      { lineNumber, message: `Line ${lineNumber}: multiline or unclosed quoted values are not supported` },
    ]);
  }

  const inner = value.slice(1, -1);
  if (quote === "'") return inner;

  return inner.replace(/\\([\\rt"])/g, (_match, escaped: string) => {
    switch (escaped) {
      case "r":
        return "\r";
      case "t":
        return "\t";
      case "\\":
        return "\\";
      case '"':
        return '"';
      default:
        return escaped;
    }
  });
}

/**
 * Split an unquoted `value # note` assignment. Quoted values keep `#` inside quotes.
 * Returns `{ valuePart, usageNote }` where usageNote is trimmed or null.
 */
export function splitInlineUsageNote(rawRightHandSide: string): { valuePart: string; usageNote: string | null } {
  const rhs = rawRightHandSide.trimEnd();
  if (!rhs) return { valuePart: "", usageNote: null };

  const first = rhs[0];
  if (first === '"' || first === "'") {
    // Find the closing quote (accounting for escapes in double quotes), then optional # note.
    let i = 1;
    while (i < rhs.length) {
      const ch = rhs[i];
      if (first === '"' && ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === first) {
        const after = rhs.slice(i + 1);
        const hashIndex = after.indexOf("#");
        if (hashIndex < 0) return { valuePart: rhs.slice(0, i + 1).trim(), usageNote: null };
        const between = after.slice(0, hashIndex).trim();
        if (between.length > 0) {
          // Trailing junk between closing quote and # — treat whole RHS as value (no note).
          return { valuePart: rhs.trim(), usageNote: null };
        }
        const note = after.slice(hashIndex + 1).trim();
        return {
          valuePart: rhs.slice(0, i + 1).trim(),
          usageNote: note.length > 0 ? note : null,
        };
      }
      i += 1;
    }
    return { valuePart: rhs.trim(), usageNote: null };
  }

  const hashIndex = rhs.indexOf("#");
  if (hashIndex < 0) return { valuePart: rhs.trim(), usageNote: null };
  const valuePart = rhs.slice(0, hashIndex).trimEnd();
  const note = rhs.slice(hashIndex + 1).trim();
  return {
    valuePart,
    usageNote: note.length > 0 ? note : null,
  };
}

export function parseSecretImportText(rawText: string): SecretImportParseResult {
  const bytes = new TextEncoder().encode(rawText).byteLength;
  if (bytes > SECRET_IMPORT_MAX_BYTES) {
    return {
      ok: false,
      errors: [{ lineNumber: 0, message: `Import is too large (max ${SECRET_IMPORT_MAX_BYTES} bytes)` }],
    };
  }

  const errors: SecretImportParseError[] = [];
  const entries: ParsedSecretImportEntry[] = [];
  const seen = new Map<string, number>();

  const lines = rawText.split(/\r?\n/);
  for (const [index, rawLine] of lines.entries()) {
    const lineNumber = index + 1;
    if (rawLine.includes("\0")) {
      errors.push({ lineNumber, message: `Line ${lineNumber}: contains an invalid character` });
      continue;
    }

    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const assignment = trimmed.startsWith("export ") ? trimmed.slice("export ".length).trimStart() : trimmed;
    const equalsIndex = assignment.indexOf("=");
    if (equalsIndex <= 0) {
      errors.push({ lineNumber, message: `Line ${lineNumber} must be KEY=VALUE` });
      continue;
    }

    const key = assignment.slice(0, equalsIndex).trim();
    if (!SECRET_IMPORT_KEY_PATTERN.test(key)) {
      errors.push({
        lineNumber,
        message: `Line ${lineNumber}: keys must use letters, numbers, and underscores, and cannot start with a number`,
      });
      continue;
    }

    const previousLine = seen.get(key);
    if (previousLine !== undefined) {
      errors.push({
        lineNumber,
        message: `Line ${lineNumber}: duplicate key ${key} (also on line ${previousLine})`,
      });
      continue;
    }

    const { valuePart, usageNote } = splitInlineUsageNote(assignment.slice(equalsIndex + 1));
    if (usageNote && usageNote.length > SECRET_IMPORT_MAX_USAGE_NOTE_CHARS) {
      errors.push({
        lineNumber,
        message: `Line ${lineNumber}: usage note is too long (max ${SECRET_IMPORT_MAX_USAGE_NOTE_CHARS} characters)`,
      });
      continue;
    }

    let value: string;
    try {
      value = decodeQuotedValue(valuePart, lineNumber);
    } catch (error) {
      if (error instanceof SecretImportValidationError) {
        errors.push(...error.errors);
        continue;
      }
      throw error;
    }

    if (value.includes("\0") || value.includes("\n") || value.includes("\r")) {
      errors.push({
        lineNumber,
        message: `Line ${lineNumber}: multiline values are not supported`,
      });
      continue;
    }

    if (value.trim().length === 0) {
      errors.push({ lineNumber, message: `Line ${lineNumber}: value for ${key} must not be empty` });
      continue;
    }

    seen.set(key, lineNumber);
    entries.push({ key, value, usageNote, lineNumber });
  }

  if (errors.length > 0) return { ok: false, errors };
  if (entries.length === 0) {
    return { ok: false, errors: [{ lineNumber: 0, message: "Add at least one KEY=VALUE secret to import" }] };
  }
  if (entries.length > SECRET_IMPORT_MAX_ENTRIES) {
    return {
      ok: false,
      errors: [
        {
          lineNumber: 0,
          message: `Too many secrets (max ${SECRET_IMPORT_MAX_ENTRIES} per import)`,
        },
      ],
    };
  }

  return { ok: true, entries };
}

export function assertSecretImportText(rawText: string): ParsedSecretImportEntry[] {
  const parsed = parseSecretImportText(rawText);
  if (!parsed.ok) throw new SecretImportValidationError(parsed.errors);
  return parsed.entries;
}
