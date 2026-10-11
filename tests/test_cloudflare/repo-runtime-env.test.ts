import { describe, expect, it } from "vitest";

import {
  formatRepoRuntimeEnv,
  parseRepoRuntimeEnv,
  RepoRuntimeEnvValidationError,
} from "../../apps/control-plane-worker/src/env-blobs/login-env";

const VALID_RUNTIME_ENV = [
  "DATABASE_URL=postgres://app:secret@db:5432/app",
  "POSTGRES_PASSWORD=s3cret",
  "OPENAI_API_KEY=sk-test",
].join("\n");

describe("parseRepoRuntimeEnv", () => {
  it("accepts arbitrary repository runtime env keys", () => {
    expect(parseRepoRuntimeEnv(VALID_RUNTIME_ENV)).toEqual({
      DATABASE_URL: "postgres://app:secret@db:5432/app",
      POSTGRES_PASSWORD: "s3cret",
      OPENAI_API_KEY: "sk-test",
    });
  });

  it("supports comments, export prefixes, and quoted values", () => {
    const parsed = parseRepoRuntimeEnv(
      [
        "# repo runtime env",
        'export DATABASE_URL="postgres://app:secret@db:5432/app"',
        "POSTGRES_PASSWORD='s3cret value'",
        "OPENAI_API_KEY=sk-test",
      ].join("\n"),
    );

    expect(parsed.DATABASE_URL).toBe("postgres://app:secret@db:5432/app");
    expect(parsed.POSTGRES_PASSWORD).toBe("s3cret value");
  });

  it("keeps escaped newlines literal in double-quoted values", () => {
    expect(parseRepoRuntimeEnv('PRIVATE_KEY="line1\\nline2"')).toEqual({
      PRIVATE_KEY: "line1\\nline2",
    });
  });

  it("allows the existing Cycloid login keys without requiring all of them", () => {
    expect(parseRepoRuntimeEnv("ARCANIST_LOGIN_USERNAME=admin@example.com")).toEqual({
      ARCANIST_LOGIN_USERNAME: "admin@example.com",
    });
  });

  it("formats env maps into a stable parseable string", () => {
    const formatted = formatRepoRuntimeEnv({
      Z_KEY: "later",
      DATABASE_URL: "postgres://app:secret@db:5432/app",
      EMPTY_VALUE: "",
      QUOTED_VALUE: 'value with spaces and "quotes"',
    });

    expect(formatted).toContain('EMPTY_VALUE=""');
    expect(parseRepoRuntimeEnv(formatted)).toEqual({
      DATABASE_URL: "postgres://app:secret@db:5432/app",
      EMPTY_VALUE: "",
      QUOTED_VALUE: 'value with spaces and "quotes"',
      Z_KEY: "later",
    });
  });

  it("rejects duplicate keys", () => {
    expect(() => parseRepoRuntimeEnv(`${VALID_RUNTIME_ENV}\nDATABASE_URL=postgres://other`)).toThrow(
      /Duplicate env key/,
    );
  });

  it("rejects invalid keys", () => {
    expect(() => parseRepoRuntimeEnv("1DATABASE_URL=value")).toThrow(RepoRuntimeEnvValidationError);
    expect(() => parseRepoRuntimeEnv("DATABASE-URL=value")).toThrow(/invalid key/);
  });

  it("rejects runtime-breaking exact keys", () => {
    for (const key of ["PATH", "HOME", "PWD", "SHELL", "USER"]) {
      expect(() => parseRepoRuntimeEnv(`${key}=value`)).toThrow(/reserved runtime key/);
    }
  });

  it("rejects literal multiline values", () => {
    expect(() => parseRepoRuntimeEnv('PRIVATE_KEY="first\nsecond"')).toThrow(/Multiline/);
    expect(() => parseRepoRuntimeEnv("PRIVATE_KEY='first\nsecond'")).toThrow(/Multiline/);
  });

  it("rejects null bytes on blank or comment lines", () => {
    expect(() => parseRepoRuntimeEnv(`${VALID_RUNTIME_ENV}\n# hidden\0value`)).toThrow(/invalid character/);
    expect(() => parseRepoRuntimeEnv(`${VALID_RUNTIME_ENV}\n \0 `)).toThrow(/invalid character/);
  });
});
