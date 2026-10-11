import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  verificationEvidenceFromMetadata,
  VerificationEvidenceList,
} from "../../apps/ui/src/components/VerificationEvidenceList";

describe("VerificationEvidenceList", () => {
  it("renders typed artifact and direct evidence records", () => {
    const evidence = verificationEvidenceFromMetadata({
      evidence: [
        {
          type: "screenshot",
          label: "fixed-state.png",
          artifactId: "artifact-1",
          status: "uploaded",
          url: "https://app.trycycloid.com/api/sessions/sess-1/artifacts/artifact-1/fixed-state.png",
          summary: "Screenshot of the fixed state.",
        },
        {
          type: "log",
          label: "typecheck-pass.log",
          status: "partial",
          summary: "Focused typecheck output passed.",
        },
        {
          type: "screenshot",
          label: "unsafe.png",
          url: "javascript:alert(1)",
        },
        {
          type: "screenshot",
          label: "protocol-relative.png",
          url: "//evil.example/artifact.png",
        },
        {
          type: "unsupported",
          label: "ignored",
        },
      ],
    });

    expect(evidence).toHaveLength(4);
    expect(evidence[0]).toMatchObject({
      type: "screenshot",
      artifactId: "artifact-1",
      url: "https://app.trycycloid.com/api/sessions/sess-1/artifacts/artifact-1/fixed-state.png",
    });
    expect(evidence[2]).not.toHaveProperty("url");
    expect(evidence[3]).not.toHaveProperty("url");

    const html = renderToStaticMarkup(createElement(VerificationEvidenceList, { evidence }));

    expect(html).toContain("fixed-state.png");
    expect(html).toContain(
      'href="https://app.trycycloid.com/api/sessions/sess-1/artifacts/artifact-1/fixed-state.png"',
    );
    expect(html).toContain("Screenshot of the fixed state.");
    expect(html).toContain("typecheck-pass.log");
    expect(html).toContain("Focused typecheck output passed.");
    expect(html).not.toContain("javascript:alert");
    expect(html).not.toContain("//evil.example");
    expect(html).not.toContain("ignored");
  });
});
