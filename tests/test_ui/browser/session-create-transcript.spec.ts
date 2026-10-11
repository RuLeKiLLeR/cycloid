import { expect, test } from "@playwright/test";

import { installBrowserFixture } from "./helpers/network";

/**
 * Minimal end-to-end smoke: a seeded (stubbed-auth) user lands on home,
 * creates a session against the mocked control plane, and the session
 * transcript renders the sent prompt. Catches whole-app wiring breaks
 * (routing, bootstrap, session create flow, transcript render) that
 * component tests cannot.
 */
test("logged-in user creates a session and the transcript renders the prompt", async ({ page }) => {
  const fixture = await installBrowserFixture(page);
  // Two lines on purpose: the header title only shows the first line, so the
  // second line can only render from the transcript turn itself.
  const prompt = "Add a healthcheck endpoint to the API.\nReturn 200 from /health.";

  await page.goto("/");

  // Authenticated shell rendered from the seeded bootstrap.
  const promptInput = page.getByRole("textbox", { name: "Prompt" });
  await expect(promptInput).toBeVisible();
  await expect(page.getByLabel("Repository", { exact: true })).toContainText("repo");

  await promptInput.fill(prompt);
  await page.getByRole("button", { name: "Send" }).click();
  await fixture.createSessionGate.waitFor(1);
  await fixture.createSessionGate.release(1, "sess-e2e-1");

  // Session page reached and the prompt is sent to the (stubbed) sandbox.
  await expect(page).toHaveURL(/\/sessions\/sess-e2e-1$/);
  await fixture.waitForSendCount(1);
  expect(fixture.sendCalls[0]).toMatchObject({ sessionId: "sess-e2e-1", prompt });
  expect(fixture.createCalls[0]).toMatchObject({
    body: { context: { repoUrl: "https://github.com/org/repo", baseBranch: "main" }, model: "gpt-5.5" },
  });

  // Transcript renders the prompt turn: the second prompt line never appears
  // in the header title, so this cannot pass from the title alone.
  await expect(page.getByText("Return 200 from /health.").first()).toBeVisible();
  await expect(page.getByText("No prompts yet.")).toHaveCount(0);
});
