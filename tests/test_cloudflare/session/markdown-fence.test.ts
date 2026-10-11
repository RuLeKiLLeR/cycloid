import { describe, expect, it } from "vitest";

import { markdownFenceForLine, nextMarkdownFence } from "../../../apps/control-plane-worker/src/session/markdown-fence";

describe("markdownFenceForLine", () => {
  it("recognizes backtick and tilde fences of length >= 3", () => {
    expect(markdownFenceForLine("```")).toEqual({ marker: "`", length: 3 });
    expect(markdownFenceForLine("```typescript")).toEqual({ marker: "`", length: 3 });
    expect(markdownFenceForLine("~~~~")).toEqual({ marker: "~", length: 4 });
  });

  it("tolerates leading indentation", () => {
    expect(markdownFenceForLine("   ```")).toEqual({ marker: "`", length: 3 });
  });

  it("returns null for non-fence lines and short runs", () => {
    expect(markdownFenceForLine("`` inline")).toBeNull();
    expect(markdownFenceForLine("plain text")).toBeNull();
    expect(markdownFenceForLine("")).toBeNull();
  });
});

describe("nextMarkdownFence", () => {
  it("opens a fence from the closed state", () => {
    expect(nextMarkdownFence(null, "```ts")).toEqual({ marker: "`", length: 3 });
  });

  it("closes only on the same marker with a run at least as long", () => {
    const open = { marker: "`", length: 3 } as const;
    expect(nextMarkdownFence(open, "```")).toBeNull();
    expect(nextMarkdownFence(open, "````")).toBeNull();
  });

  it("does NOT close on a different marker", () => {
    const open = { marker: "`", length: 3 } as const;
    expect(nextMarkdownFence(open, "~~~")).toEqual(open);
  });

  it("does NOT close on a shorter run than the opener", () => {
    const open = { marker: "`", length: 4 } as const;
    expect(nextMarkdownFence(open, "```")).toEqual(open);
  });

  it("does NOT close on an info-string line (CommonMark: closing fence carries no info string)", () => {
    const open = { marker: "`", length: 3 } as const;
    expect(nextMarkdownFence(open, "```typescript")).toEqual(open);
    expect(nextMarkdownFence(open, "```ts")).toEqual(open);
  });

  it("closes on a bare marker line with trailing whitespace", () => {
    const open = { marker: "`", length: 3 } as const;
    expect(nextMarkdownFence(open, "```   ")).toBeNull();
  });

  it("leaves state unchanged on non-fence lines", () => {
    const open = { marker: "~", length: 3 } as const;
    expect(nextMarkdownFence(open, "some code")).toEqual(open);
    expect(nextMarkdownFence(null, "some text")).toBeNull();
  });
});
