import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SEEDED_BUSINESS_IDS } from "../../apps/control-plane-worker/src/constants/businesses";
import { InitiationMode } from "../../apps/control-plane-worker/src/enums/initiation-mode";
import { SessionEntrypoint } from "../../apps/control-plane-worker/src/enums/session-entrypoint";
import { USER_SETTINGS_SELECT_BY_USER_ID_SQL } from "../../apps/control-plane-worker/src/settings/db";
import { ONBOARD_AGENT_NAME } from "../../shared/agent/constants";
import { ENVIRONMENT } from "../../shared/constants/environment";
import type { PlanModeSetting } from "../../shared/plan-mode";

const { mockAssessPlanNecessity, mockPostStructuredEventToDd } = vi.hoisted(() => ({
  mockAssessPlanNecessity: vi.fn(),
  mockPostStructuredEventToDd: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

vi.mock("@sentry/cloudflare", () => ({
  instrumentDurableObjectWithSentry: (_optionsCallback: unknown, DurableObjectClass: unknown) => DurableObjectClass,
  withSentry: (_optionsCallback: unknown, handler: unknown) => handler,
  setTag: () => {},
  setUser: () => {},
  captureException: () => {},
}));

vi.mock("../../apps/control-plane-worker/src/services/plan-necessity", () => ({
  assessPlanNecessity: (...args: unknown[]) => mockAssessPlanNecessity(...args),
}));

vi.mock("../../apps/control-plane-worker/src/observability/events-exporter", () => ({
  postStructuredEventToDd: (...args: unknown[]) => mockPostStructuredEventToDd(...args),
}));

type PlanModeOptions = {
  planMode?: PlanModeSetting;
  planApprovalRequired?: boolean;
  promptText?: string;
  autoVerify?: boolean;
  entrypoint?: (typeof SessionEntrypoint)[keyof typeof SessionEntrypoint];
  agentRole?: "implementation" | "verification";
  agentProfile?: string;
  targetPrUrl?: string | null;
  initiationMode?: (typeof InitiationMode)[keyof typeof InitiationMode];
};

type SettingsRow = {
  auto_verify_enabled: number;
  plan_mode_setting: PlanModeSetting;
  plan_approval_required?: number | null;
};

async function loadStateModule(activation: boolean) {
  vi.resetModules();
  vi.doMock("../../apps/control-plane-worker/src/constants/plan-approval", () => ({
    PLAN_APPROVAL_ACTIVATION: activation,
  }));
  return import("../../apps/control-plane-worker/src/session/state");
}

function createTestEnv(settings: SettingsRow | null, platformKey: string | null = "sk-test") {
  let initializeBody: Record<string, unknown> | null = null;
  const first = vi.fn(async (sql: string) => (sql === USER_SETTINGS_SELECT_BY_USER_ID_SQL ? settings : null));
  const prepare = vi.fn((sql: string) => ({
    bind: vi.fn(() => ({
      first: () => first(sql),
      run: vi.fn(async () => ({ success: true })),
      all: vi.fn(async () => ({ results: [] })),
    })),
  }));
  const fetch = vi.fn(async (_url: string, init: RequestInit) => {
    initializeBody = JSON.parse(String(init.body)) as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        session: {
          sessionId: initializeBody.sessionId,
          ownerUserId: initializeBody.ownerUserId,
          businessId: initializeBody.businessId,
          status: "active",
        },
        replay: { sessionId: initializeBody.sessionId, lastEventSequence: 0 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });

  return {
    env: {
      WORKER_ENV: ENVIRONMENT.Test,
      ARCANIST_OPENAI_API_KEY: platformKey ?? undefined,
      DB: { prepare },
      SESSION: {
        idFromName: (name: string) => name,
        get: () => ({ fetch }),
      },
    },
    prepare,
    getInitializeBody: () => initializeBody,
  };
}

async function resolveThroughSessionCreation(input: {
  activation: boolean;
  businessId: string;
  settings?: SettingsRow | null;
  options?: PlanModeOptions;
  platformKey?: string | null;
}) {
  const state = await loadStateModule(input.activation);
  const testEnv = createTestEnv(input.settings ?? null, input.platformKey);
  const sessionId = `session-${crypto.randomUUID()}`;
  await state.createSessionState(testEnv.env as never, sessionId, "123", {
    businessId: input.businessId,
    autoVerify: true,
    entrypoint: SessionEntrypoint.API,
    credentialGate: { mode: "skip", reason: "plan-mode resolver unit test" },
    ...input.options,
  });
  return { body: testEnv.getInitializeBody(), env: testEnv.env, prepare: testEnv.prepare, sessionId };
}

function autoDecisionEvent(): Record<string, unknown> | undefined {
  return mockPostStructuredEventToDd.mock.calls
    .map(([, event]) => event as Record<string, unknown>)
    .find((event) => event.event === "arcanist.plan_mode.auto_decision");
}

beforeEach(() => {
  mockAssessPlanNecessity.mockReset().mockResolvedValue({
    planNeeded: false,
    reason: "Single-step task.",
  });
  mockPostStructuredEventToDd.mockReset().mockResolvedValue(true);
});

afterEach(() => {
  vi.doUnmock("../../apps/control-plane-worker/src/constants/plan-approval");
});

describe("session plan-mode resolution", () => {
  const explicitCases = [
    { label: "unset", explicitPlanMode: undefined },
    { label: "explicit on", explicitPlanMode: "on" },
    { label: "explicit off", explicitPlanMode: "off" },
  ] as const;

  for (const activation of [false, true]) {
    for (const internal of [false, true]) {
      for (const testCase of explicitCases) {
        it(`resolves ${internal ? "internal" : "non-internal"} ${testCase.label} with activation ${activation ? "on" : "off"}`, async () => {
          const options: PlanModeOptions = {};
          if (testCase.explicitPlanMode !== undefined) options.planMode = testCase.explicitPlanMode;
          const { body } = await resolveThroughSessionCreation({
            activation,
            businessId: internal ? SEEDED_BUSINESS_IDS.cycloidQa : "customer-business",
            settings: null,
            options,
          });

          const expectedPlanMode = activation
            ? testCase.explicitPlanMode === "on"
            : testCase.explicitPlanMode !== "off";
          expect(body).toMatchObject({
            planMode: expectedPlanMode,
            planApprovalRequired: activation && expectedPlanMode,
          });
          expect(mockAssessPlanNecessity).not.toHaveBeenCalled();
        });
      }
    }
  }

  it("keeps legacy activation-off semantics for explicit auto without classifying", async () => {
    const { body } = await resolveThroughSessionCreation({
      activation: false,
      businessId: "customer-business",
      options: { planMode: "auto", promptText: "Implement several dependent changes." },
    });

    expect(body).toMatchObject({ planMode: true, planApprovalRequired: false });
    expect(mockAssessPlanNecessity).not.toHaveBeenCalled();
  });

  it("uses the saved plan-mode setting for an activated customer interactive session", async () => {
    const { body } = await resolveThroughSessionCreation({
      activation: true,
      businessId: "customer-business",
      settings: { auto_verify_enabled: 0, plan_mode_setting: "on" },
      options: { planMode: undefined },
    });

    expect(body).toMatchObject({ planMode: true, planApprovalRequired: true });
    expect(mockAssessPlanNecessity).not.toHaveBeenCalled();
  });

  it.each([SessionEntrypoint.API, SessionEntrypoint.SLACK])(
    "treats %s as interactive after activation",
    async (entrypoint) => {
      const { body } = await resolveThroughSessionCreation({
        activation: true,
        businessId: SEEDED_BUSINESS_IDS.cycloid,
        options: { entrypoint, planMode: "on" },
      });

      expect(body).toMatchObject({ planMode: true, planApprovalRequired: true });
      expect(mockAssessPlanNecessity).not.toHaveBeenCalled();
    },
  );

  it.each([
    SessionEntrypoint.CHILD_SESSION,
    SessionEntrypoint.SLACK_AUTOMATION,
    SessionEntrypoint.JIRA,
    SessionEntrypoint.LINEAR,
    SessionEntrypoint.PAGERDUTY,
    SessionEntrypoint.GITHUB,
    SessionEntrypoint.SCHEDULED,
    SessionEntrypoint.AUTO_QA,
    undefined,
  ])("forces unattended entrypoint %s off after activation", async (entrypoint) => {
    const { body } = await resolveThroughSessionCreation({
      activation: true,
      businessId: SEEDED_BUSINESS_IDS.cycloid,
      options: { entrypoint, planMode: "auto", promptText: "Implement several dependent changes." },
    });

    expect(body).toMatchObject({ planMode: false, planApprovalRequired: false });
    expect(mockAssessPlanNecessity).not.toHaveBeenCalled();
  });

  it.each([
    { label: "QA tester role", options: { agentRole: "verification" as const } },
    { label: "onboarding profile", options: { agentProfile: ONBOARD_AGENT_NAME } },
    { label: "target PR", options: { targetPrUrl: "https://github.com/acme/repo/pull/1" } },
    { label: "child initiation", options: { initiationMode: InitiationMode.CHILD } },
  ])("forces the $label carve-out off before all other resolution", async ({ options }) => {
    const { body } = await resolveThroughSessionCreation({
      activation: true,
      businessId: SEEDED_BUSINESS_IDS.cycloid,
      settings: { auto_verify_enabled: 1, plan_mode_setting: "on" },
      options: {
        entrypoint: SessionEntrypoint.API,
        planMode: "auto",
        promptText: "Implement several dependent changes.",
        ...options,
      },
    });

    expect(body).toMatchObject({ planMode: false, planApprovalRequired: false });
    expect(mockAssessPlanNecessity).not.toHaveBeenCalled();
  });

  it.each([
    {
      assessment: { planNeeded: true, reason: "Multiple dependent phases." },
      expected: true,
    },
    {
      assessment: { planNeeded: false, reason: "Single-step task." },
      expected: false,
    },
  ])("classifies a saved auto setting and resolves plan mode to $expected", async ({ assessment, expected }) => {
    mockAssessPlanNecessity.mockResolvedValueOnce(assessment);
    const promptText = "Update the resolver and then verify all callers.";
    const { body, env, sessionId } = await resolveThroughSessionCreation({
      activation: true,
      businessId: "customer-business",
      settings: { auto_verify_enabled: 0, plan_mode_setting: "auto" },
      options: { promptText },
    });

    expect(body).toMatchObject({
      planMode: expected,
      planApprovalRequired: expected,
    });
    if (expected) {
      expect(body).toMatchObject({ planAutoReason: assessment.reason });
    } else {
      expect(body).not.toHaveProperty("planAutoReason");
    }
    expect(mockAssessPlanNecessity).toHaveBeenCalledOnce();
    expect(mockAssessPlanNecessity).toHaveBeenCalledWith(env, promptText, {
      sessionId,
      phase: "session_create",
    });
    // Security contract (CWE-201): the classifier's prompt-derived free-form
    // reason must never reach third-party telemetry.
    expect(autoDecisionEvent()).not.toHaveProperty("reason");
    expect(autoDecisionEvent()).toMatchObject({
      event: "arcanist.plan_mode.auto_decision",
      sessionId,
      entrypoint: SessionEntrypoint.API,
      planNeeded: assessment.planNeeded,
      latencyMs: expect.any(Number),
      nullFallback: false,
    });
  });

  it("normalizes and clamps the Auto classifier reason before initializing the session", async () => {
    mockAssessPlanNecessity.mockResolvedValueOnce({
      planNeeded: true,
      reason: `  ${"a".repeat(260)}\nwith\tcontrols  `,
    });
    const { body } = await resolveThroughSessionCreation({
      activation: true,
      businessId: "customer-business",
      settings: { auto_verify_enabled: 0, plan_mode_setting: "auto" },
      options: { promptText: "Implement several dependent changes." },
    });

    expect(body?.planAutoReason).toHaveLength(240);
    expect(body?.planAutoReason).toMatch(/^a+…$/);
    expect(String(body?.planAutoReason)).not.toMatch(/[\u0000-\u001f\u007f]/);
  });

  it("keeps a non-null reason whenever plan mode is enabled", async () => {
    const on = await resolveThroughSessionCreation({
      activation: true,
      businessId: "customer-business",
      settings: { auto_verify_enabled: 0, plan_mode_setting: "on" },
      options: { promptText: "Implement several dependent changes." },
    });
    const off = await resolveThroughSessionCreation({
      activation: true,
      businessId: "customer-business",
      settings: { auto_verify_enabled: 0, plan_mode_setting: "off" },
      options: { promptText: "Implement several dependent changes." },
    });

    expect(on.body).toMatchObject({ planMode: true, planApprovalRequired: true });
    expect(on.body).toHaveProperty("planAutoReason");
    expect(off.body).toMatchObject({ planMode: false, planApprovalRequired: false });
    expect(off.body).not.toHaveProperty("planAutoReason");
  });

  it("decouples auto plan generation from approval", async () => {
    mockAssessPlanNecessity.mockResolvedValueOnce({ planNeeded: true, reason: "Multiple dependent phases." });
    const { body } = await resolveThroughSessionCreation({
      activation: true,
      businessId: "customer-business",
      settings: { auto_verify_enabled: 0, plan_mode_setting: "auto", plan_approval_required: 0 },
      options: { promptText: "Implement several dependent changes." },
    });

    expect(body).toMatchObject({ planMode: true, planApprovalRequired: false });
    expect(body?.planAutoReason).toBe("Multiple dependent phases.");
  });

  it("preserves derived approval when the saved gate is null", async () => {
    mockAssessPlanNecessity.mockResolvedValueOnce({ planNeeded: true, reason: "Multiple dependent phases." });
    const { body } = await resolveThroughSessionCreation({
      activation: true,
      businessId: "customer-business",
      settings: { auto_verify_enabled: 0, plan_mode_setting: "auto", plan_approval_required: null },
      options: { promptText: "Implement several dependent changes." },
    });

    expect(body).toMatchObject({ planMode: true, planApprovalRequired: true });
  });

  it("fails a saved auto setting toward no-plan when the platform key is missing", async () => {
    mockAssessPlanNecessity.mockImplementationOnce(async (env: { ARCANIST_OPENAI_API_KEY?: string }) =>
      env.ARCANIST_OPENAI_API_KEY ? { planNeeded: true, reason: "Needs a plan." } : null,
    );
    const { body, sessionId } = await resolveThroughSessionCreation({
      activation: true,
      businessId: "customer-business",
      settings: { auto_verify_enabled: 0, plan_mode_setting: "auto" },
      platformKey: null,
      options: { promptText: "Implement several dependent changes." },
    });

    expect(body).toMatchObject({ planMode: false, planApprovalRequired: false });
    expect(body).not.toHaveProperty("planAutoReason");
    expect(autoDecisionEvent()).toMatchObject({
      sessionId,
      planNeeded: null,
      nullFallback: true,
    });
  });

  it("guards an unexpected classifier throw and fails toward no-plan", async () => {
    mockAssessPlanNecessity.mockRejectedValueOnce(new Error("classifier escaped its guard"));
    const { body, sessionId } = await resolveThroughSessionCreation({
      activation: true,
      businessId: "customer-business",
      settings: { auto_verify_enabled: 0, plan_mode_setting: "auto" },
      options: { promptText: "Implement several dependent changes." },
    });

    expect(body).toMatchObject({ planMode: false, planApprovalRequired: false });
    expect(body).not.toHaveProperty("planAutoReason");
    expect(autoDecisionEvent()).toMatchObject({
      sessionId,
      planNeeded: null,
      nullFallback: true,
    });
  });

  it.each(["off", "on"] as const)("lets explicit auto override saved plan_mode_setting %s", async (planMode) => {
    mockAssessPlanNecessity.mockResolvedValueOnce({ planNeeded: true, reason: "Multiple phases." });
    const { body, prepare } = await resolveThroughSessionCreation({
      activation: true,
      businessId: "customer-business",
      settings: { auto_verify_enabled: 0, plan_mode_setting: planMode },
      options: { planMode: "auto", promptText: "Implement several dependent changes." },
    });

    expect(body).toMatchObject({ planMode: true, planApprovalRequired: true });
    expect(body).toMatchObject({ planAutoReason: "Multiple phases." });
    expect(mockAssessPlanNecessity).toHaveBeenCalledOnce();
    expect(prepare.mock.calls.filter(([sql]) => sql === USER_SETTINGS_SELECT_BY_USER_ID_SQL)).toHaveLength(0);
  });

  it.each([undefined, "", "   "])(
    "fails auto with prompt %j toward no-plan without classifying",
    async (promptText) => {
      const { body, sessionId } = await resolveThroughSessionCreation({
        activation: true,
        businessId: "customer-business",
        options: { planMode: "auto", promptText },
      });

      expect(body).toMatchObject({ planMode: false, planApprovalRequired: false });
      expect(mockAssessPlanNecessity).not.toHaveBeenCalled();
      expect(autoDecisionEvent()).toMatchObject({
        sessionId,
        planNeeded: null,
        nullFallback: true,
      });
    },
  );

  it("loads user settings once when auto-verify and activated plan mode both need defaults", async () => {
    const state = await loadStateModule(true);
    const testEnv = createTestEnv({ auto_verify_enabled: 1, plan_mode_setting: "on" });
    await state.createSessionState(testEnv.env as never, "session-one-settings-load", "123", {
      businessId: "customer-business",
      entrypoint: SessionEntrypoint.API,
      credentialGate: { mode: "skip", reason: "plan-mode resolver unit test" },
    });

    const settingsReads = testEnv.prepare.mock.calls.filter(([sql]) => sql === USER_SETTINGS_SELECT_BY_USER_ID_SQL);
    expect(settingsReads).toHaveLength(1);
    expect(testEnv.getInitializeBody()).toMatchObject({ planMode: true, planApprovalRequired: true });
  });
});
