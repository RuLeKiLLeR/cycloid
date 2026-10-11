import { describe, expect, it } from "vitest";

import { extractVercelDeployPreviewFromCheckRuns } from "../../shared/integrations/vercel-deploy-preview.js";

describe("extractVercelDeployPreviewFromCheckRuns", () => {
  it("returns null when no Vercel check runs are present", () => {
    expect(
      extractVercelDeployPreviewFromCheckRuns([
        { name: "ci/test", app: { slug: "github-actions" }, status: "completed", conclusion: "success" },
      ]),
    ).toBeNull();
  });

  it("extracts preview URL and deploy status from a completed Vercel check run", () => {
    expect(
      extractVercelDeployPreviewFromCheckRuns([
        {
          name: "Vercel",
          app: { slug: "vercel" },
          status: "completed",
          conclusion: "success",
          details_url: "https://vercel.com/acme/widgets/abc123",
          output: {
            summary: "Visit Preview: https://widgets-git-feature-acme.vercel.app",
          },
        },
      ]),
    ).toEqual({
      provider: "vercel",
      status: "ready",
      previewUrl: "https://widgets-git-feature-acme.vercel.app",
      dashboardUrl: "https://vercel.com/acme/widgets/abc123",
      checkName: "Vercel",
      conclusion: "success",
    });
  });

  it("prefers a successful Vercel check run when multiple are present", () => {
    expect(
      extractVercelDeployPreviewFromCheckRuns([
        {
          name: "Vercel",
          app: { slug: "vercel" },
          status: "completed",
          conclusion: "failure",
          output: { summary: "Preview: https://failed.vercel.app" },
        },
        {
          name: "Vercel Preview Comments",
          app: { slug: "vercel" },
          status: "completed",
          conclusion: "success",
          output: { summary: "Ready: https://ready.vercel.app" },
        },
      ]),
    ).toMatchObject({
      status: "ready",
      previewUrl: "https://ready.vercel.app",
    });
  });

  it("prefers the latest Vercel check run when the same check was rerun", () => {
    expect(
      extractVercelDeployPreviewFromCheckRuns([
        {
          id: 1,
          name: "Vercel",
          app: { slug: "vercel" },
          status: "completed",
          conclusion: "success",
          started_at: "2026-06-23T15:41:09Z",
          output: { summary: "Visit Preview: https://stale-success.vercel.app" },
        },
        {
          id: 2,
          name: "Vercel",
          app: { slug: "vercel" },
          status: "completed",
          conclusion: "failure",
          started_at: "2026-06-23T16:33:57Z",
          output: { summary: "Deployment failed." },
        },
      ]),
    ).toMatchObject({
      status: "error",
      previewUrl: null,
      conclusion: "failure",
    });
  });
});
