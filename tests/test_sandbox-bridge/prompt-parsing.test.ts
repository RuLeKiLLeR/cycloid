import { describe, expect, it } from "vitest";

import {
  COMPANY_MEMORY_CONTEXT_FOOTER,
  COMPANY_MEMORY_CONTEXT_HEADER,
  SIMILAR_SESSION_TASK_SEPARATOR,
} from "../../apps/sandbox-bridge/src/constants/observability.js";
import {
  extractCurrentTaskText,
  memoryRefArray,
  optionalStringArrayField,
  optionalStringField,
  parseInjectedContext,
  splitHistoricalSessionContent,
  stringArray,
} from "../../apps/sandbox-bridge/src/utils/prompt-parsing.js";

const TASK = "Fix the login button color.";
const companyMemoryBlock = `${COMPANY_MEMORY_CONTEXT_HEADER}\nThe following claims about this company are sourced from prior Slack threads, PRs, and sessions.\n[pr cm-1 | fact | Acme] Internal claim text.\n${COMPANY_MEMORY_CONTEXT_FOOTER}`;
const companyMemoryInjected = `${companyMemoryBlock}${SIMILAR_SESSION_TASK_SEPARATOR}${TASK}`;

describe("parseInjectedContext", () => {
  it("returns the whole content as task when there is no header", () => {
    expect(parseInjectedContext("Just a task")).toEqual({ historical: "", task: "Just a task" });
  });

  it("strips a leading company-memory block from the task text", () => {
    const { historical, task } = parseInjectedContext(companyMemoryInjected);
    expect(historical).toBe(companyMemoryBlock);
    expect(task).toBe(TASK);
  });

  it("falls back to task-only when the company-memory footer is missing", () => {
    const content = `${COMPANY_MEMORY_CONTEXT_HEADER}\nclaims without footer${SIMILAR_SESSION_TASK_SEPARATOR}${TASK}`;
    expect(parseInjectedContext(content)).toEqual({ historical: "", task: content });
  });
});

describe("splitHistoricalSessionContent", () => {
  it("attributes all tokens to the task when there is no historical prefix", () => {
    const result = splitHistoricalSessionContent("Just a task");
    expect(result.historicalSessionTokens).toBe(0);
    expect(result.taskTextTokens).toBeGreaterThan(0);
  });

  it("counts both the injected prefix and the task when markers are present", () => {
    const result = splitHistoricalSessionContent(companyMemoryInjected);
    expect(result.historicalSessionTokens).toBeGreaterThan(0);
    expect(result.taskTextTokens).toBeGreaterThan(0);
  });
});

describe("extractCurrentTaskText", () => {
  it("returns the trimmed content when there is no header", () => {
    expect(extractCurrentTaskText("  Just a task  ")).toBe("Just a task");
  });

  it("returns the task text when a company-memory block is prepended", () => {
    expect(extractCurrentTaskText(companyMemoryInjected)).toBe(TASK);
  });

  it("returns the full trimmed content when trimming mangles the trailing separator", () => {
    // Trailing whitespace after the separator is stripped by content.trim(), which also strips
    // the separator's own trailing newlines, so the marker no longer parses as a full separator.
    // parseInjectedContext then reports no historical prefix and extractCurrentTaskText returns
    // the whole trimmed string. (A truly empty task with a truthy historical prefix is structurally
    // impossible, so there is no empty-task fallback branch to exercise.)
    const content = `${companyMemoryBlock}${SIMILAR_SESSION_TASK_SEPARATOR}   `;
    expect(extractCurrentTaskText(content)).toBe(content.trim());
  });
});

describe("untrusted-input parsers", () => {
  it("stringArray keeps only non-empty strings", () => {
    expect(stringArray(["a", "", "  ", 3, null, "b"])).toEqual(["a", "b"]);
    expect(stringArray("not an array")).toEqual([]);
  });

  it("optionalStringField omits empty/non-string values", () => {
    expect(optionalStringField("x", "value")).toEqual({ x: "value" });
    expect(optionalStringField("x", "   ")).toEqual({});
    expect(optionalStringField("x", 42)).toEqual({});
  });

  it("optionalStringArrayField omits when no valid entries", () => {
    expect(optionalStringArrayField("x", ["a"])).toEqual({ x: ["a"] });
    expect(optionalStringArrayField("x", [])).toEqual({});
  });

  it("memoryRefArray keeps only entries with a non-empty id and trims optional fields", () => {
    expect(
      memoryRefArray([{ id: " m1 ", path: " p ", title: " t " }, { id: "" }, { path: "no id" }, "garbage"]),
    ).toEqual([{ id: "m1", path: "p", title: "t" }]);
  });
});
