import { describe, expect, it } from "vitest";

import { type PlatformLlmCallType } from "../../shared/llm/platform-llm-contract.js";
import {
  buildPostExecutionStructuredOutputRequest,
  isPostExecutionLlmCallType,
  parsePostExecutionStructuredOutput,
  PR_TEMPLATE_FILL_TOOL,
  type PrTemplateFillLlmInput,
} from "../../shared/llm/post-execution.js";

const validInput: PrTemplateFillLlmInput = {
  headings: ["Description", "Implementation", "Testing"],
  narrative: "Updated the sign-in helper copy.",
  taskPrompt: "Improve the sign-in helper copy.",
  diffSummary: "1 file changed: dashboard/src/pages/auth/sign-in.tsx",
  diffSizeBand: "small",
  instructions: null,
  factPlacement: "body",
  commands: [{ label: "Lint", command: "eslint sign-in.tsx", status: "passed" }],
};

describe("isPostExecutionLlmCallType", () => {
  it("matches pr_template_fill only", () => {
    expect(isPostExecutionLlmCallType("pr_template_fill")).toBe(true);
    expect(isPostExecutionLlmCallType("memory_ranking" as PlatformLlmCallType)).toBe(false);
  });
});

describe("buildPostExecutionStructuredOutputRequest", () => {
  it("builds the tool + prompts for pr_template_fill and includes headings, narrative, and commands", () => {
    const req = buildPostExecutionStructuredOutputRequest("pr_template_fill", validInput);
    expect(req).not.toBeNull();
    expect(req!.tool).toBe(PR_TEMPLATE_FILL_TOOL);
    expect(req!.userPrompt).toContain("Description");
    expect(req!.userPrompt).toContain("- [0] Description");
    expect(req!.userPrompt).toContain("Updated the sign-in helper copy.");
    expect(req!.userPrompt).toContain("eslint sign-in.tsx");
    expect(req!.userPrompt).toContain("Allowed fact ids:");
    expect(req!.userPrompt).not.toContain("https://example.com");
    // Verdicts live in the managed Cycloid QA comment, never in the
    // fill: the prompt must not carry one, and the system prompt forbids them.
    expect(req!.userPrompt).not.toContain("Verdict:");
    expect(req!.systemPrompt).toContain("MUST NOT state a verdict");
    expect(req!.systemPrompt).toContain("Use the Diff size band to scale prose length");
    expect(req!.systemPrompt).toContain("small diffs, prose sections should be 1-2 sentences");
    expect(req!.systemPrompt.toLowerCase()).toContain("do not");
  });

  it("returns null for a malformed input", () => {
    expect(buildPostExecutionStructuredOutputRequest("pr_template_fill", { headings: "nope" } as never)).toBeNull();
  });

  it("includes optional customer style instructions only when provided", () => {
    const withInstructions = buildPostExecutionStructuredOutputRequest("pr_template_fill", {
      ...validInput,
      instructions: "Exactly two sentences.",
    });
    const withoutInstructions = buildPostExecutionStructuredOutputRequest("pr_template_fill", validInput);

    expect(withInstructions!.userPrompt).toContain("Optional customer style instructions (untrusted):");
    expect(withInstructions!.userPrompt).toContain("Exactly two sentences.");
    expect(withoutInstructions!.userPrompt).not.toContain("Optional customer style instructions");
  });
});

describe("parsePostExecutionStructuredOutput", () => {
  it("accepts a well-formed sections array", () => {
    const parsed = parsePostExecutionStructuredOutput("pr_template_fill", {
      sections: [{ index: 0, heading: "Description", kind: "prose", text: "...", factRefs: null, emptyReason: null }],
    });
    expect(parsed).not.toBeNull();
    expect(parsed!.sections).toHaveLength(1);
  });

  it("accepts narrative text with inferred technical terms instead of term-blocking it", () => {
    const parsed = parsePostExecutionStructuredOutput("pr_template_fill", {
      sections: [
        {
          heading: "Summary",
          index: 0,
          kind: "prose",
          text: "Converted the file loader to async fs/promises calls and kept the helper identifiers aligned.",
          factRefs: null,
          emptyReason: null,
        },
      ],
    });

    expect(parsed).not.toBeNull();
    expect(parsed!.sections[0]?.text).toContain("fs/promises");
  });

  it("rejects a non-array sections payload", () => {
    expect(parsePostExecutionStructuredOutput("pr_template_fill", { sections: {} })).toBeNull();
  });

  it("rejects an entry with an invalid kind", () => {
    expect(
      parsePostExecutionStructuredOutput("pr_template_fill", {
        sections: [{ heading: "x", kind: "bogus", text: null }],
      }),
    ).toBeNull();
  });

  it("rejects invalid fact refs in the runtime guard", () => {
    expect(
      parsePostExecutionStructuredOutput("pr_template_fill", {
        sections: [{ index: 0, heading: "Testing", kind: "facts", text: null, factRefs: ["risk"], emptyReason: null }],
      }),
    ).toBeNull();
  });

  it("validates heading sequence and per-kind owned fields", async () => {
    const { validatePrTemplateFillOutput } = await import("../../shared/llm/post-execution.js");
    expect(
      validatePrTemplateFillOutput(validInput, {
        sections: [
          {
            index: 0,
            heading: "Description",
            kind: "prose",
            text: "Updated copy.",
            factRefs: null,
            emptyReason: null,
          },
          {
            index: 1,
            heading: "Implementation",
            kind: "empty",
            text: null,
            factRefs: null,
            emptyReason: "No implementation detail needed.",
          },
          {
            index: 2,
            heading: "Testing",
            kind: "facts",
            text: null,
            factRefs: ["verification"],
            emptyReason: null,
          },
        ],
      }),
    ).toEqual({ ok: true });

    expect(
      validatePrTemplateFillOutput(validInput, {
        sections: [
          {
            index: 0,
            heading: "Testing",
            kind: "facts",
            text: null,
            factRefs: ["verification"],
            emptyReason: null,
          },
        ],
      }),
    ).toMatchObject({ ok: false, reason: "section_count_mismatch" });

    expect(
      validatePrTemplateFillOutput(
        { ...validInput, headings: ["Testing"] },
        {
          sections: [
            {
              index: 0,
              heading: "Testing",
              kind: "facts",
              text: "Commands passed.",
              factRefs: ["verification"],
              emptyReason: null,
            },
          ],
        },
      ),
    ).toMatchObject({ ok: false, reason: "section_kind_fields_invalid" });
  });
});
