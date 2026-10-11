import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MarkdownContent } from "../../apps/ui/src/components/MarkdownContent";

function paragraphs(html: string): string[] {
  const matches = html.match(/<p[^>]*>([\s\S]*?)<\/p>/g) ?? [];
  return matches.map((m: string) => m.replace(/<[^>]+>/g, ""));
}

describe("MarkdownContent paragraph loosening", () => {
  it("splits a long unbroken multi-sentence block on sentence boundaries", () => {
    const longBlock =
      "The customer activity projector buckets every ActivityEvent into one of six customer-facing categories by classifying both tool calls and bash commands using a regex-driven heuristic. " +
      "The CustomerActivityEvent type itself is defined in shared/transcript/projector.ts alongside the broader ActivityEvent union and the helpers the projector consumes during a session replay. " +
      "The type is referenced across the projector pair, its unit test, and the Transcript UI consumer that renders the rolled-up cards.";
    const html = renderToStaticMarkup(createElement(MarkdownContent, { content: longBlock }));
    expect(paragraphs(html).length).toBe(3);
  });

  it("leaves short content as a single paragraph", () => {
    const html = renderToStaticMarkup(createElement(MarkdownContent, { content: "Done. Nothing else." }));
    expect(paragraphs(html).length).toBe(1);
  });

  it("does not break on decimals or path-like tokens", () => {
    const block =
      "Confidence is 0.95 and the budget is 1.5 hours. " +
      "We touched apps/ui/src/Layout.tsx and shared/transcript/projector.ts. " +
      "Total cost was $0.35 across the run and ctx is 5%.";
    // Pad to exceed threshold so loosening is considered.
    const padded = block + " " + "x".repeat(280);
    const html = renderToStaticMarkup(createElement(MarkdownContent, { content: padded }));
    // Should not split inside "0.95", "1.5", "Layout.tsx", "projector.ts", "$0.35".
    expect(html).not.toMatch(/<p[^>]*>0\.95/);
    expect(html).not.toMatch(/<p[^>]*>5 hours/);
    expect(html).not.toMatch(/<p[^>]*>tsx\b/);
  });

  it("leaves blocks alone when they already have paragraph breaks", () => {
    const content =
      "First paragraph stays intact even if it has many words and is long enough to look like a wall.\n\nSecond paragraph also stays intact and runs on for a while just to be safe.";
    const html = renderToStaticMarkup(createElement(MarkdownContent, { content }));
    expect(paragraphs(html).length).toBe(2);
  });

  it("does not split a long single-line markdown block (list, heading, blockquote)", () => {
    const longList =
      "- this is a single bullet with a lot of prose. It runs over the threshold so the loosener would normally split it. But splitting list items would change markdown semantics and turn one bullet into three.";
    const html = renderToStaticMarkup(createElement(MarkdownContent, { content: longList }));
    // One <li>, not three. The loosener must skip block-leading syntax.
    const items = (html.match(/<li>/g) ?? []).length;
    expect(items).toBe(1);

    const longHeading =
      "# A long heading that for some reason runs many words and therefore exceeds the loosener threshold. It would be wrong to split this into multiple paragraphs and lose the heading.";
    const headingHtml = renderToStaticMarkup(createElement(MarkdownContent, { content: longHeading }));
    expect(headingHtml).toMatch(/<h1[^>]*>/);
    // Heading body must not contain <p> children.
    expect(headingHtml).not.toMatch(/<h1[^>]*>[\s\S]*<p[^>]*>/);
  });

  it("leaves code fences alone", () => {
    const content =
      "Here is a long enough preamble that would normally be split apart. The code follows. The block is large enough to exceed the threshold.\n\n```\nconst x = 1; // comment. Another comment.\nconst y = 2;\n```";
    const html = renderToStaticMarkup(createElement(MarkdownContent, { content }));
    expect(html).toContain("const x = 1");
  });
});

describe("MarkdownContent links", () => {
  it("renders external markdown links as anchors", () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownContent, { content: "[GitHub](https://github.com/trycycloid/cycloid)" }),
    );

    expect(html).toContain('href="https://github.com/trycycloid/cycloid"');
    expect(html).toContain('target="_blank"');
  });

  it("renders image links as clickable previews", () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownContent, { content: "[image.png](https://artifacts.example.com/session/image.png)" }),
    );

    expect(html).toContain('href="https://artifacts.example.com/session/image.png"');
    expect(html).toContain('src="https://artifacts.example.com/session/image.png"');
    expect(html).toContain('alt="image.png"');
    expect(html).toContain("block w-full max-w-full overflow-hidden");
  });

  it("uses formatted image-link labels as preview text", () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownContent, { content: "[**terminal screenshot**](https://artifacts.example.com/image.png)" }),
    );

    expect(html).toContain('src="https://artifacts.example.com/image.png"');
    expect(html).toContain('alt="terminal screenshot"');
    expect(html).toContain(">terminal screenshot<");
  });

  it("renders explicit markdown images without file extensions", () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownContent, { content: "![Chart](https://artifacts.example.com/render?id=1)" }),
    );

    expect(html).toContain('src="https://artifacts.example.com/render?id=1"');
    expect(html).toContain('alt="Chart"');
    expect(html).not.toContain('href="https://artifacts.example.com/render?id=1"');
    expect(html).toContain("block w-full max-w-full overflow-hidden");
  });

  it("renders repo-relative markdown links as text", () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownContent, { content: "Read [docs/conventions.md](docs/conventions.md)." }),
    );

    expect(html).toContain("docs/conventions.md");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain('href="docs/conventions.md"');
  });

  it("renders sandbox-local markdown links as text", () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownContent, {
        content: "Read [docs/what-is-cycloid.md](/workspace/repo/docs/what-is-cycloid.md).",
      }),
    );

    expect(html).toContain("docs/what-is-cycloid.md");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("/workspace/repo/docs/what-is-cycloid.md");
  });

  it("renders mailto markdown links as anchors", () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownContent, { content: "[Email](mailto:support@trycycloid.com)" }),
    );

    expect(html).toContain('href="mailto:support@trycycloid.com"');
    expect(html).toContain('target="_blank"');
  });

  it("renders javascript markdown links as text", () => {
    const html = renderToStaticMarkup(createElement(MarkdownContent, { content: "[Bad](javascript:alert(1))" }));

    expect(html).toContain("Bad");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain('href="javascript:alert(1)"');
  });

  it("renders fragment-only markdown links as text", () => {
    const html = renderToStaticMarkup(createElement(MarkdownContent, { content: "[Section](#section)" }));

    expect(html).toContain("Section");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain('href="#section"');
  });
});

describe("MarkdownContent inline variant", () => {
  it("renders links and inline code without block wrappers", () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownContent, {
        content: "Opened [logs](https://example.com/logs) and checked `npm test`.",
        variant: "inline",
      }),
    );

    expect(html).toContain('href="https://example.com/logs"');
    expect(html).toContain("<code");
    expect(html).not.toContain("<p");
    expect(html).not.toContain("<div");
  });

  it("keeps unsafe links and image links inert in inline summaries", () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownContent, {
        content:
          "[bad](javascript:alert(1)) [pixel](https://example.com/track.png) ![remote](https://example.com/remote.png)",
        variant: "inline",
      }),
    );

    expect(html).toContain("bad");
    expect(html).toContain("pixel");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("javascript:alert");
    expect(html).not.toContain("track.png");
    expect(html).not.toContain("remote.png");
  });

  it("does not render code-block copy controls in inline summaries", () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownContent, {
        content: "```ts\nconst value = 1;\n```",
        variant: "inline",
      }),
    );

    expect(html).toContain("const value = 1;");
    expect(html).toContain("whitespace-pre-wrap");
    expect(html).not.toContain("Copy");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<pre");
  });
});
