import { describe, expect, it } from "vitest";

import {
  adfBulletList,
  adfDoc,
  adfHeading,
  adfInlineCode,
  adfParagraph,
  adfText,
  flattenAdfToText,
  formatJiraIssueCommentAsAdf,
  wrapTextAsAdf,
} from "../../shared/utils/adf";

describe("ADF helpers", () => {
  it("builds explicit ADF node shapes", () => {
    expect(adfHeading(2, [adfText("Title")])).toEqual({
      type: "heading",
      attrs: { level: 2 },
      content: [{ type: "text", text: "Title" }],
    });
    expect(adfBulletList([[adfParagraph([adfText("First")])]])).toEqual({
      type: "bulletList",
      content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "First" }] }] }],
    });
    expect(adfInlineCode("repo=owner/name")).toEqual({
      type: "text",
      text: "repo=owner/name",
      marks: [{ type: "code" }],
    });
  });

  it("formats known Jira skip comments with heading, list, and inline code", () => {
    const adf = formatJiraIssueCommentAsAdf(
      "Cycloid couldn't start a session: no repository could be determined for this issue. Set a default repo in your Cycloid settings, or add `repo=owner/name` to the description, then re-add the label.",
    );

    expect(adf).toMatchObject({
      type: "doc",
      version: 1,
      content: [{ type: "heading", attrs: { level: 3 } }, { type: "paragraph" }, { type: "bulletList" }],
    });
    expect(JSON.stringify(adf)).toContain('"type":"code"');
    expect(JSON.stringify(adf)).toContain("repo=owner/name");
  });

  it("formats repo access verification skip comments with reconnect action", () => {
    const adf = formatJiraIssueCommentAsAdf(
      "Cycloid couldn't confirm access to `trycycloid/cycloid`. Reconnect GitHub in your Cycloid settings, then re-add the label.",
    );

    expect(adf).toMatchObject({
      type: "doc",
      version: 1,
      content: [{ type: "heading", attrs: { level: 3 } }, { type: "paragraph" }, { type: "bulletList" }],
    });
    expect(JSON.stringify(adf)).toContain("Reconnect GitHub in Cycloid settings");
    expect(JSON.stringify(adf)).toContain('"type":"code"');
    expect(JSON.stringify(adf)).toContain("trycycloid/cycloid");
  });

  it("falls back to plain paragraph ADF for arbitrary markdown and empty input", () => {
    expect(formatJiraIssueCommentAsAdf("## Heading\n\n- item")).toEqual(wrapTextAsAdf("## Heading\n\n- item"));
    expect(adfDoc([])).toEqual(wrapTextAsAdf(""));
  });

  it("preserves existing wrap and flatten behavior", () => {
    const wrapped = wrapTextAsAdf("Line one.\nLine two.\n\nSecond paragraph.");
    const flattened = flattenAdfToText(wrapped)
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    expect(flattened).toBe("Line one.\nLine two.\n\nSecond paragraph.");
  });
});
