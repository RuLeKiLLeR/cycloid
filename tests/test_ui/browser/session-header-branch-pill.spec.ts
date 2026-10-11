import { expect, test } from "@playwright/test";

import { installBrowserFixture } from "./helpers/network";

test("default base branch renders as a branch pill on the session page", async ({ page }) => {
  const fixture = await installBrowserFixture(page);
  const prompt = "Document the release checklist for this branch.";
  const defaultBranch = "main";

  await page.goto("/");

  const promptInput = page.getByRole("textbox", { name: "Prompt" });
  await expect(promptInput).toBeVisible();
  await expect(page.locator("#home-repo-select")).toContainText("repo");
  await expect(page.locator("#home-model-select")).toContainText("GPT-5.5");

  await promptInput.fill(prompt);
  await page.getByRole("button", { name: "Send" }).click();
  await fixture.createSessionGate.waitFor(1);
  await fixture.createSessionGate.release(1, "sess-branch-pill");

  await expect(page).toHaveURL(/\/sessions\/sess-branch-pill$/);
  expect(fixture.createCalls[0]).toMatchObject({
    body: { context: { repoUrl: "https://github.com/org/repo", baseBranch: defaultBranch }, model: "gpt-5.5" },
  });
  await expect(page.getByLabel(`Branch: ${defaultBranch}`)).toBeVisible();
});
