import { describe, expect, it } from "vitest";

import { PR_PERSONAS, type PrPersona, renderPersonaHeader } from "../../shared/agent/pr-personas";

describe("renderPersonaHeader", () => {
  it("renders the configured persona identity", () => {
    expect(renderPersonaHeader(PR_PERSONAS.zeus)).toBe("## ⚡ Zeus\n_Code review — correctness, security, reuse_");
    expect(renderPersonaHeader(PR_PERSONAS.cycloidQa)).toBe("## 🔎 Cycloid QA\n_End-to-end verification_");
  });

  it("renders an HTTPS avatar when configured", () => {
    expect(renderPersonaHeader({ ...PR_PERSONAS.zeus, avatarUrl: "https://example.com/zeus?size=20&theme=dark" })).toBe(
      '## <img src="https://example.com/zeus?size=20&amp;theme=dark" width="20" alt="Zeus" /> ⚡ Zeus\n_Code review — correctness, security, reuse_',
    );
  });

  it("escapes persona text and rejects non-HTTPS avatars", () => {
    const persona: PrPersona = {
      id: "test",
      name: '<Zeus_"',
      tagline: "review_* [now]",
      accentEmoji: "<⚡>",
      avatarUrl: 'javascript:alert("xss")',
    };

    expect(renderPersonaHeader(persona)).toBe('## &lt;⚡&gt; &lt;Zeus\\_"\n_review\\_\\* \\[now\\]_');
    expect(renderPersonaHeader({ ...persona, avatarUrl: 'https://example.com/\" onerror=alert(1)' })).toContain(
      "&quot; onerror=alert(1)",
    );
  });
});
