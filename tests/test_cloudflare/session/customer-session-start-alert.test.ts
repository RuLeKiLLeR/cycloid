import { describe, expect, it } from "vitest";

import {
  buildCustomerSessionStartAlertText,
  type CustomerSessionStartAlertInput,
} from "../../../apps/control-plane-worker/src/session/customer-session-start-alert";

const baseEnv = { FRONTEND_URL: "https://app.trycycloid.com", WORKER_ENV: "production" } as const;

function input(overrides: Partial<CustomerSessionStartAlertInput> = {}): CustomerSessionStartAlertInput {
  return {
    sessionId: "sess-123",
    ownerUserId: "2",
    ownerUserLogin: "octocat",
    businessId: "biz-1",
    repoOwner: "trycycloid",
    repoName: "cycloid",
    sessionKind: null,
    initiationMode: "repo",
    agentRole: null,
    ...overrides,
  };
}

describe("buildCustomerSessionStartAlertText", () => {
  it("renders the GitHub login in the User field instead of the numeric id", () => {
    const text = buildCustomerSessionStartAlertText(baseEnv, input());
    expect(text).toContain("User:       octocat");
    expect(text).not.toContain("User:       2");
    expect(text).toContain(
      "<https://app.trycycloid.com/admin/support-view?sessionId=sess-123&targetUserId=2|sess-123>",
    );
  });

  it("falls back to the numeric id when the login is unresolved", () => {
    const text = buildCustomerSessionStartAlertText(baseEnv, input({ ownerUserLogin: null }));
    expect(text).toContain("User:       2");
  });
});
