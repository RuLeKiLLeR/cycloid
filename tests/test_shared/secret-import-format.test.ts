import { describe, expect, it } from "vitest";

import {
  assertSecretImportText,
  parseSecretImportText,
  SecretImportValidationError,
  splitInlineUsageNote,
} from "../../shared/secrets/import-format";

describe("splitInlineUsageNote", () => {
  it("extracts unquoted value and usage note", () => {
    expect(splitInlineUsageNote("secret-value # for GitHub")).toEqual({
      valuePart: "secret-value",
      usageNote: "for GitHub",
    });
  });

  it("keeps hash characters inside quoted values", () => {
    expect(splitInlineUsageNote('"abc#def" # note')).toEqual({
      valuePart: '"abc#def"',
      usageNote: "note",
    });
    expect(splitInlineUsageNote("'abc#def'")).toEqual({
      valuePart: "'abc#def'",
      usageNote: null,
    });
  });
});

describe("parseSecretImportText", () => {
  it("parses KEY=VALUE lines with usage notes and export prefixes", () => {
    const parsed = parseSecretImportText(
      [
        "# header",
        "export API_KEY=sk-test # Use this API Key for GitHub",
        "DATABASE_URL=postgresql://user:pass@localhost:5432/db # RDS on us-west-2",
        "ENVIRONMENT=production",
      ].join("\n"),
    );

    expect(parsed).toEqual({
      ok: true,
      entries: [
        {
          key: "API_KEY",
          value: "sk-test",
          usageNote: "Use this API Key for GitHub",
          lineNumber: 2,
        },
        {
          key: "DATABASE_URL",
          value: "postgresql://user:pass@localhost:5432/db",
          usageNote: "RDS on us-west-2",
          lineNumber: 3,
        },
        {
          key: "ENVIRONMENT",
          value: "production",
          usageNote: null,
          lineNumber: 4,
        },
      ],
    });
  });

  it("rejects invalid keys, duplicates, and empty files", () => {
    expect(parseSecretImportText("1BAD=value").ok).toBe(false);
    expect(parseSecretImportText("A=1\nA=2").ok).toBe(false);
    expect(parseSecretImportText("# only comments").ok).toBe(false);
    expect(parseSecretImportText("EMPTY=\n").ok).toBe(false);
  });

  it("throws SecretImportValidationError from assert helper", () => {
    expect(() => assertSecretImportText("not-an-assignment")).toThrow(SecretImportValidationError);
  });
});
