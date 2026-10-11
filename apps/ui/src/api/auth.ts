import { fetchUser } from "./auth-probe";
import { apiCacheKeys, invalidate } from "./cache";
import { requestVoid } from "./client";

export { fetchUser };

export async function logoutUser(): Promise<void> {
  try {
    await requestVoid("/auth/logout", { method: "POST" });
  } catch {
    // Logout failures are non-critical
  }
}

export async function disconnectLinear(): Promise<void> {
  await requestVoid("/auth/linear/disconnect", { method: "POST" }, "Failed to disconnect Linear");
  invalidate(apiCacheKeys.integrations());
}

export async function disconnectJira(): Promise<void> {
  await requestVoid("/auth/jira/disconnect", { method: "POST" }, "Failed to disconnect Jira");
  invalidate(apiCacheKeys.integrations());
}

export async function disconnectNotion(): Promise<void> {
  await requestVoid("/auth/notion/disconnect", { method: "POST" }, "Failed to disconnect Notion");
  invalidate(apiCacheKeys.integrations());
}

export async function disconnectSlack(): Promise<void> {
  await requestVoid("/auth/slack/disconnect", { method: "POST" }, "Failed to disconnect Slack");
  invalidate(apiCacheKeys.integrations());
}
