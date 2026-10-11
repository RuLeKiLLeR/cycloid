import { describe, expect, it } from "vitest";

import { parseLeadingSkillCommands, parseSkillMarkdown } from "../../shared/skills/index.js";

describe("parseLeadingSkillCommands", () => {
  it("extracts leading slash skill commands and strips them from prompt text", () => {
    expect(parseLeadingSkillCommands("/review-spec check the plan")).toEqual({
      skills: ["review-spec"],
      prompt: "check the plan",
    });
  });

  it("extracts multiple leading slash commands", () => {
    expect(parseLeadingSkillCommands("/review-spec /ship-prod ship it")).toEqual({
      skills: ["review-spec", "ship-prod"],
      prompt: "ship it",
    });
  });

  it("deduplicates repeated leading slash commands while preserving order", () => {
    expect(parseLeadingSkillCommands("/review-spec /review-spec /ship-prod ship it")).toEqual({
      skills: ["review-spec", "ship-prod"],
      prompt: "ship it",
    });
  });

  it("parses leading slash commands after initial whitespace", () => {
    expect(parseLeadingSkillCommands("   /review-spec /ship-prod ship it")).toEqual({
      skills: ["review-spec", "ship-prod"],
      prompt: "ship it",
    });
  });

  it("ignores slash commands after normal prompt text starts", () => {
    expect(parseLeadingSkillCommands("please /review-spec check this")).toEqual({
      skills: [],
      prompt: "please /review-spec check this",
    });
  });
});

describe("parseSkillMarkdown", () => {
  it("parses frontmatter from CRLF skill files", () => {
    expect(
      parseSkillMarkdown("---\r\nname: review-spec\r\ndescription: Review a spec\r\n---\r\n\r\n# Review\r\n"),
    ).toEqual({
      name: "review-spec",
      description: "Review a spec",
      content: "# Review",
    });
  });

  it("parses folded argument frontmatter", () => {
    expect(
      parseSkillMarkdown(
        [
          "---",
          "name: inspect-sessions",
          "description: Review sessions",
          "argument: >-",
          "  optional -- accepts a session ID, a natural language query, or a site query.",
          "  Examples: `site last 6h`",
          "---",
          "",
          "# Review",
        ].join("\n"),
      ),
    ).toEqual({
      name: "inspect-sessions",
      description: "Review sessions",
      argument: "optional -- accepts a session ID, a natural language query, or a site query. Examples: `site last 6h`",
      content: "# Review",
    });
  });

  it("preserves blank separator lines inside literal block scalars", () => {
    expect(
      parseSkillMarkdown(
        [
          "---",
          "name: with-blank",
          "description: |-",
          "  first paragraph",
          "",
          "  second paragraph",
          "argument: optional",
          "---",
          "",
          "# Body",
        ].join("\n"),
      ),
    ).toEqual({
      name: "with-blank",
      description: "first paragraph\n\nsecond paragraph",
      argument: "optional",
      content: "# Body",
    });
  });
});
