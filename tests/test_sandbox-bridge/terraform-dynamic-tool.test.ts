import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildAllDynamicToolSpecs,
  executeFirstPartyDynamicToolCall,
} from "../../apps/sandbox-bridge/src/services/first-party-dynamic-tools.js";
import {
  buildTerraformCliConfigText,
  buildTerraformCommandFailureMessage,
  buildTerraformPlanCommandArgs,
  buildTerraformPlanSubprocessEnv,
  runTerraformCommand,
  shouldUseTerraformRemoteRunOverride,
} from "../../apps/sandbox-bridge/src/services/terraform-dynamic-tool.js";

const TEST_HCP_RUN_URL = "https://app.terraform.io/app/cycloid/cycloid-infra/runs/run-abc123";
const itWithFakeTerraformBinary = process.platform === "win32" ? it.skip : it;

async function createFakeTerraformBinary(): Promise<{ binaryPath: string; cleanup: () => Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), "cycloid-terraform-test-"));
  const scriptPath = join(directory, "terraform-fake.cjs");
  const binaryPath = process.platform === "win32" ? join(directory, "terraform.cmd") : join(directory, "terraform");
  const scriptText = `
const args = process.argv.slice(2);
if (args.includes("init")) process.exit(0);
if (args.includes("plan")) {
  console.log("Running plan in HCP Terraform. Output will stream here.");
  console.log("To view this run in a browser, visit:");
  console.log("${TEST_HCP_RUN_URL}");
  console.log("");
  console.log("Plan: 0 to add, 11 to change, 0 to destroy.");
  if (process.env.TF_TEST_PLAN_MARKER) require("node:fs").writeFileSync(process.env.TF_TEST_PLAN_MARKER, "plan-started");
  if (process.env.TF_TEST_EXTRA_RUN_URL) console.log(process.env.TF_TEST_EXTRA_RUN_URL);
  if (process.env.TF_TEST_POLICY_SUMMARY) console.log(process.env.TF_TEST_POLICY_SUMMARY);
  if (process.env.TF_TEST_RUN_TASK_SUMMARY) console.error(process.env.TF_TEST_RUN_TASK_SUMMARY);
  if (process.env.TF_TEST_ERROR_SUMMARY) console.error(process.env.TF_TEST_ERROR_SUMMARY);
  if (process.env.TF_TEST_SELF_SIGNAL) {
    process.kill(process.pid, process.env.TF_TEST_SELF_SIGNAL);
    setInterval(() => {}, 1000);
    return;
  }
  if (process.env.TF_TEST_HANG) {
    setInterval(() => {}, 1000);
    return;
  }
  process.exit(Number(process.env.TF_TEST_PLAN_EXIT_CODE || "1"));
}
process.exit(2);
`;
  await writeFile(scriptPath, scriptText, "utf8");
  if (process.platform === "win32") {
    await writeFile(binaryPath, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`, "utf8");
  } else {
    await writeFile(binaryPath, `#!/usr/bin/env node\n${scriptText}`, "utf8");
    await chmod(binaryPath, 0o755);
  }
  return {
    binaryPath,
    cleanup: async () => rm(directory, { recursive: true, force: true }),
  };
}

describe("terraform dynamic tool", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is available only when bridge-owned Terraform plan credentials are present", () => {
    expect(buildAllDynamicToolSpecs({}).map((tool) => `${tool.namespace}.${tool.name}`)).not.toContain(
      "terraform.plan",
    );
    expect(
      buildAllDynamicToolSpecs({ ARCANIST_TERRAFORM_PLAN_TOKEN: "tf-plan-token" }).map(
        (tool) => `${tool.namespace}.${tool.name}`,
      ),
    ).toContain("terraform.plan");
  });

  it("does not accept raw Terraform commands or flags", async () => {
    const result = await executeFirstPartyDynamicToolCall(
      "terraform",
      "plan",
      { command: "apply", args: ["-destroy"] },
      { env: { ARCANIST_TERRAFORM_PLAN_TOKEN: "tf-plan-token" } },
    );

    expect(result).toMatchObject({
      success: false,
      errorCode: "invalid_input",
    });
  });

  it("requires credentials in the bridge env", async () => {
    const result = await executeFirstPartyDynamicToolCall("terraform", "plan", {}, { env: {} });

    expect(result).toMatchObject({
      success: false,
      errorCode: "not_connected",
    });
  });

  it("keeps credentials private to the bridge-owned execution path", async () => {
    const result = await executeFirstPartyDynamicToolCall(
      "terraform",
      "plan",
      { directory: "infra" },
      {
        env: {
          ARCANIST_TERRAFORM_BINARY: "definitely-not-installed-terraform-for-test",
          ARCANIST_TERRAFORM_PLAN_TOKEN: "tf-plan-token",
        },
        cwd: process.cwd(),
      },
    );

    expect(result).toMatchObject({
      success: false,
      errorCode: "missing_binary",
    });
    expect(result.contentItems[0]?.text).not.toContain("tf-plan-token");
  });

  it("rejects plan directories outside the repository", async () => {
    const result = await executeFirstPartyDynamicToolCall(
      "terraform",
      "plan",
      { directory: "../outside-repo" },
      {
        env: { ARCANIST_TERRAFORM_PLAN_TOKEN: "tf-plan-token" },
        cwd: process.cwd(),
      },
    );

    expect(result).toMatchObject({
      success: false,
      errorCode: "invalid_input",
    });
    expect(result.contentItems[0]?.text).toContain("must stay inside the repository");
  });

  it("allows in-repo plan directories that normalize back to the repository root", async () => {
    const result = await executeFirstPartyDynamicToolCall(
      "terraform",
      "plan",
      { directory: "infra/.." },
      {
        env: {
          ARCANIST_TERRAFORM_BINARY: "definitely-not-installed-terraform-for-test",
          ARCANIST_TERRAFORM_PLAN_TOKEN: "tf-plan-token",
        },
        cwd: process.cwd(),
      },
    );

    expect(result).toMatchObject({
      success: false,
      errorCode: "missing_binary",
    });
  });

  itWithFakeTerraformBinary(
    "treats a terminally successful HCP run as plan success even when the local CLI exits non-zero",
    async () => {
      const fakeTerraform = await createFakeTerraformBinary();
      try {
        const fetchImpl = vi.fn(
          async () =>
            new Response(JSON.stringify({ data: { attributes: { status: "planned_and_finished" } } }), { status: 200 }),
        ) as typeof fetch;

        const result = await executeFirstPartyDynamicToolCall(
          "terraform",
          "plan",
          { directory: "." },
          {
            cwd: process.cwd(),
            env: {
              ARCANIST_TERRAFORM_BINARY: fakeTerraform.binaryPath,
              ARCANIST_TERRAFORM_PLAN_TOKEN: "tf-plan-token",
              PATH: process.env.PATH ?? "",
              TF_TEST_ERROR_SUMMARY:
                "Error: local CLI returned 1 while reading /workspace/repo/infra/.terraform/tmp/plan.json",
            },
            fetchImpl,
          },
        );

        expect(result).toMatchObject({ success: true });
        expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("https://app.terraform.io/api/v2/runs/run-abc123");
        expect(fetchImpl.mock.calls[0]?.[1]?.headers).toMatchObject({
          accept: "application/vnd.api+json",
          authorization: "Bearer tf-plan-token",
        });
        expect(result.contentItems[0]?.text).toContain("Terraform plan succeeded in HCP Terraform.");
        expect(result.contentItems[0]?.text).toContain(`HCP Terraform run URL: ${TEST_HCP_RUN_URL}`);
        expect(result.contentItems[0]?.text).toContain("Remote run status: planned_and_finished");
        expect(result.contentItems[0]?.text).toContain("Plan summary: Plan: 0 to add, 11 to change, 0 to destroy.");
        expect(result.contentItems[0]?.text).not.toContain("tf-plan-token");
        expect(result.contentItems[0]?.text).not.toContain("/workspace/repo/infra");
        expect(result.contentItems[0]?.text).not.toContain("local CLI returned 1");
      } finally {
        await fakeTerraform.cleanup();
      }
    },
  );

  itWithFakeTerraformBinary.each(["planned_and_saved", "policy_checked"])(
    "treats HCP status %s as remote plan success after local CLI exit 1",
    async (runStatus) => {
      const fakeTerraform = await createFakeTerraformBinary();
      try {
        const fetchImpl = vi.fn(
          async () => new Response(JSON.stringify({ data: { attributes: { status: runStatus } } }), { status: 200 }),
        ) as typeof fetch;

        const result = await executeFirstPartyDynamicToolCall(
          "terraform",
          "plan",
          { directory: "." },
          {
            cwd: process.cwd(),
            env: {
              ARCANIST_TERRAFORM_BINARY: fakeTerraform.binaryPath,
              ARCANIST_TERRAFORM_PLAN_TOKEN: "tf-plan-token",
              PATH: process.env.PATH ?? "",
              TF_TEST_ERROR_SUMMARY:
                "Error: local CLI returned 1 while reading /workspace/repo/infra/.terraform/tmp/plan.json",
            },
            fetchImpl,
          },
        );

        expect(result).toMatchObject({ success: true });
        expect(result.contentItems[0]?.text).toContain("Terraform plan succeeded in HCP Terraform.");
        expect(result.contentItems[0]?.text).toContain(`Remote run status: ${runStatus}`);
        expect(result.contentItems[0]?.text).toContain("Plan summary: Plan: 0 to add, 11 to change, 0 to destroy.");
        expect(result.contentItems[0]?.text).not.toContain("tf-plan-token");
        expect(result.contentItems[0]?.text).not.toContain("/workspace/repo/infra");
        expect(result.contentItems[0]?.text).not.toContain("local CLI returned 1");
      } finally {
        await fakeTerraform.cleanup();
      }
    },
  );

  itWithFakeTerraformBinary("keeps cost_estimated inconclusive because later policy checks can still run", async () => {
    const fakeTerraform = await createFakeTerraformBinary();
    try {
      const fetchImpl = vi.fn(
        async () =>
          new Response(JSON.stringify({ data: { attributes: { status: "cost_estimated" } } }), { status: 200 }),
      ) as typeof fetch;

      const result = await executeFirstPartyDynamicToolCall(
        "terraform",
        "plan",
        { directory: "." },
        {
          cwd: process.cwd(),
          env: {
            ARCANIST_TERRAFORM_BINARY: fakeTerraform.binaryPath,
            ARCANIST_TERRAFORM_PLAN_TOKEN: "tf-plan-token",
            PATH: process.env.PATH ?? "",
          },
          fetchImpl,
        },
      );

      expect(result).toMatchObject({ success: false, errorCode: "execution_failed" });
      expect(result.contentItems[0]?.text).toContain(
        "HCP Terraform run status was inconclusive for local exit override: cost_estimated",
      );
      expect(result.contentItems[0]?.text).toContain(
        "Raw Terraform diagnostics were redacted because plan output may contain sensitive provider values.",
      );
    } finally {
      await fakeTerraform.cleanup();
    }
  });

  itWithFakeTerraformBinary("returns a safe failure summary when HCP reports the remote run failed", async () => {
    const fakeTerraform = await createFakeTerraformBinary();
    try {
      const fetchImpl = vi.fn(
        async () =>
          new Response(JSON.stringify({ data: { attributes: { status: "policy_soft_failed" } } }), { status: 200 }),
      ) as typeof fetch;

      const result = await executeFirstPartyDynamicToolCall(
        "terraform",
        "plan",
        { directory: "." },
        {
          cwd: process.cwd(),
          env: {
            ARCANIST_TERRAFORM_BINARY: fakeTerraform.binaryPath,
            ARCANIST_TERRAFORM_PLAN_TOKEN: "tf-plan-token",
            PATH: process.env.PATH ?? "",
            TF_TEST_POLICY_SUMMARY: "Sentinel Result: false",
            TF_TEST_RUN_TASK_SUMMARY:
              'Error: Run task "security-scan" failed from /workspace/repo/infra/.terraform/tmp/plan.json',
            TF_TEST_ERROR_SUMMARY:
              "Error: Remote policy gate failed from /workspace/repo/infra/.terraform/tmp/plan.json",
          },
          fetchImpl,
        },
      );

      expect(result).toMatchObject({ success: false, errorCode: "execution_failed" });
      expect(result.contentItems[0]?.text).toContain("Terraform plan failed in HCP Terraform.");
      expect(result.contentItems[0]?.text).toContain(`HCP Terraform run URL: ${TEST_HCP_RUN_URL}`);
      expect(result.contentItems[0]?.text).toContain("Remote run status: policy_soft_failed");
      expect(result.contentItems[0]?.text).toContain(
        "Plan summary produced before failure: Plan: 0 to add, 11 to change, 0 to destroy.",
      );
      expect(result.contentItems[0]?.text).toContain(
        "Raw Terraform diagnostics were redacted because plan output may contain sensitive provider values.",
      );
      expect(result.contentItems[0]?.text).not.toContain("tf-plan-token");
      expect(result.contentItems[0]?.text).not.toContain("/workspace/repo/infra");
      expect(result.contentItems[0]?.text).not.toContain("security-scan");
      expect(result.contentItems[0]?.text).not.toContain("Remote policy gate failed");
    } finally {
      await fakeTerraform.cleanup();
    }
  });

  it("anchors the HCP run URL to the active Terraform CLI banner instead of later URLs in output", () => {
    const strayRunUrl = "https://app.terraform.io/app/other/workspace/runs/run-stray999";
    const message = buildTerraformCommandFailureMessage(
      "plan",
      {
        code: 1,
        signal: null,
        stdout: [
          "Running plan in HCP Terraform. Output will stream here.",
          "To view this run in a browser, visit:",
          TEST_HCP_RUN_URL,
          "",
          "Plan: 0 to add, 11 to change, 0 to destroy.",
          strayRunUrl,
        ].join("\n"),
        stderr: "",
        stdoutBytes: Buffer.byteLength(
          [
            "Running plan in HCP Terraform. Output will stream here.",
            "To view this run in a browser, visit:",
            TEST_HCP_RUN_URL,
            "",
            "Plan: 0 to add, 11 to change, 0 to destroy.",
            strayRunUrl,
          ].join("\n"),
          "utf8",
        ),
        stderrBytes: 0,
      },
      "/app/bridge-tools/terraform",
      ["-chdir=/workspace/repo/infra", "plan", "-no-color"],
    );

    expect(message).toContain(`HCP Terraform run URL: ${TEST_HCP_RUN_URL}`);
    expect(message).not.toContain(strayRunUrl);
  });

  itWithFakeTerraformBinary("preserves redaction and reports when the HCP run lookup is unavailable", async () => {
    const fakeTerraform = await createFakeTerraformBinary();
    try {
      const fetchImpl = vi.fn(async () => {
        throw new Error("network unavailable");
      }) as typeof fetch;

      const result = await executeFirstPartyDynamicToolCall(
        "terraform",
        "plan",
        { directory: "." },
        {
          cwd: process.cwd(),
          env: {
            ARCANIST_TERRAFORM_BINARY: fakeTerraform.binaryPath,
            ARCANIST_TERRAFORM_PLAN_TOKEN: "tf-plan-token",
            PATH: process.env.PATH ?? "",
            TF_TEST_ERROR_SUMMARY:
              "Error: token leak from /workspace/repo/infra/.terraform/tmp/plan.json should stay redacted",
          },
          fetchImpl,
        },
      );

      expect(result).toMatchObject({ success: false, errorCode: "execution_failed" });
      expect(result.contentItems[0]?.text).toContain("Terraform plan failed.");
      expect(result.contentItems[0]?.text).toContain(`HCP Terraform run URL: ${TEST_HCP_RUN_URL}`);
      expect(result.contentItems[0]?.text).toContain(
        "Plan summary produced before failure: Plan: 0 to add, 11 to change, 0 to destroy.",
      );
      expect(result.contentItems[0]?.text).toContain(
        "Raw Terraform diagnostics were redacted because plan output may contain sensitive provider values.",
      );
      expect(result.contentItems[0]?.text).toContain("HCP Terraform run status lookup unavailable: request_failed");
      expect(result.contentItems[0]?.text).not.toContain("tf-plan-token");
      expect(result.contentItems[0]?.text).not.toContain("/workspace/repo/infra");
      expect(result.contentItems[0]?.text).not.toContain("token leak");
    } finally {
      await fakeTerraform.cleanup();
    }
  });

  itWithFakeTerraformBinary("preserves redaction and reports non-2xx HCP lookup responses", async () => {
    const fakeTerraform = await createFakeTerraformBinary();
    try {
      const fetchImpl = vi.fn(async () => new Response("forbidden", { status: 403 })) as typeof fetch;

      const result = await executeFirstPartyDynamicToolCall(
        "terraform",
        "plan",
        { directory: "." },
        {
          cwd: process.cwd(),
          env: {
            ARCANIST_TERRAFORM_BINARY: fakeTerraform.binaryPath,
            ARCANIST_TERRAFORM_PLAN_TOKEN: "tf-plan-token",
            PATH: process.env.PATH ?? "",
            TF_TEST_ERROR_SUMMARY:
              "Error: token leak from /workspace/repo/infra/.terraform/tmp/plan.json should stay redacted",
          },
          fetchImpl,
        },
      );

      expect(result).toMatchObject({ success: false, errorCode: "invalid_credential" });
      expect(result.contentItems[0]?.text).toContain("HCP Terraform run status lookup unavailable: http_error");
      expect(result.contentItems[0]?.text).toContain(
        "Raw Terraform diagnostics were redacted because plan output may contain sensitive provider values.",
      );
      expect(result.contentItems[0]?.text).not.toContain("forbidden");
      expect(result.contentItems[0]?.text).not.toContain("tf-plan-token");
      expect(result.contentItems[0]?.text).not.toContain("/workspace/repo/infra");
      expect(result.contentItems[0]?.text).not.toContain("token leak");
    } finally {
      await fakeTerraform.cleanup();
    }
  });

  itWithFakeTerraformBinary("preserves redaction and reports unrecognized HCP run statuses", async () => {
    const fakeTerraform = await createFakeTerraformBinary();
    try {
      const fetchImpl = vi.fn(
        async () =>
          new Response(JSON.stringify({ data: { attributes: { status: "unexpected_future_status" } } }), {
            status: 200,
          }),
      ) as typeof fetch;

      const result = await executeFirstPartyDynamicToolCall(
        "terraform",
        "plan",
        { directory: "." },
        {
          cwd: process.cwd(),
          env: {
            ARCANIST_TERRAFORM_BINARY: fakeTerraform.binaryPath,
            ARCANIST_TERRAFORM_PLAN_TOKEN: "tf-plan-token",
            PATH: process.env.PATH ?? "",
            TF_TEST_ERROR_SUMMARY:
              "Error: token leak from /workspace/repo/infra/.terraform/tmp/plan.json should stay redacted",
          },
          fetchImpl,
        },
      );

      expect(result).toMatchObject({ success: false, errorCode: "execution_failed" });
      expect(result.contentItems[0]?.text).toContain(
        "HCP Terraform run status was inconclusive for local exit override: unexpected_future_status",
      );
      expect(result.contentItems[0]?.text).toContain(
        "Raw Terraform diagnostics were redacted because plan output may contain sensitive provider values.",
      );
      expect(result.contentItems[0]?.text).not.toContain("tf-plan-token");
      expect(result.contentItems[0]?.text).not.toContain("/workspace/repo/infra");
      expect(result.contentItems[0]?.text).not.toContain("token leak");
    } finally {
      await fakeTerraform.cleanup();
    }
  });

  it("only allows remote Terraform override for ordinary exit code 1 failures", () => {
    expect(shouldUseTerraformRemoteRunOverride({ code: 1, signal: null })).toBe(true);
    expect(shouldUseTerraformRemoteRunOverride({ code: 143, signal: null })).toBe(false);
    expect(shouldUseTerraformRemoteRunOverride({ code: 1, signal: "SIGTERM" })).toBe(false);
    expect(shouldUseTerraformRemoteRunOverride({ code: null, signal: "SIGTERM" })).toBe(false);
  });

  it("keeps Terraform Cloud credentials out of the subprocess env", () => {
    const env = buildTerraformPlanSubprocessEnv(
      {
        PATH: "/usr/bin",
        ARCANIST_TERRAFORM_PLAN_TOKEN: "tf-plan-token",
        DD_API_KEY: "datadog-api-key",
        DD_APP_KEY: "datadog-app-key",
        CF_API_TOKEN: "cloudflare-api-token",
        BRAINTRUST_INTEGRATION_API_KEY: "braintrust-api-key",
        SENTRY_ACCESS_TOKEN: "sentry-access-token",
        TF_IN_AUTOMATION: "1",
      },
      "/tmp/cycloid-terraform/terraformrc",
    );

    expect(env).toMatchObject({
      PATH: "/usr/bin",
      TF_IN_AUTOMATION: "1",
      TF_CLI_CONFIG_FILE: "/tmp/cycloid-terraform/terraformrc",
    });
    expect(env.ARCANIST_TERRAFORM_PLAN_TOKEN).toBeUndefined();
    expect(env.TF_TOKEN_app_terraform_io).toBeUndefined();
    expect(env.DD_API_KEY).toBeUndefined();
    expect(env.DD_APP_KEY).toBeUndefined();
    expect(env.CF_API_TOKEN).toBeUndefined();
    expect(env.BRAINTRUST_INTEGRATION_API_KEY).toBeUndefined();
    expect(env.SENTRY_ACCESS_TOKEN).toBeUndefined();
  });

  it("initializes Terraform Cloud before planning", () => {
    const [initArgs, planArgs] = buildTerraformPlanCommandArgs("/workspace/repo/infra");

    expect(initArgs).toEqual(["-chdir=/workspace/repo/infra", "init", "-no-color", "-input=false"]);
    expect(planArgs).toEqual(["-chdir=/workspace/repo/infra", "plan", "-no-color", "-input=false", "-refresh=false"]);
  });

  it("writes Terraform Cloud credentials as CLI config content", () => {
    expect(buildTerraformCliConfigText('token"with\\chars')).toBe(
      'credentials "app.terraform.io" {\n  token = "token\\"with\\\\chars"\n}\n',
    );
  });

  it("keeps the generic redaction fallback for unparseable Terraform output", () => {
    const message = buildTerraformCommandFailureMessage(
      "plan",
      {
        code: 1,
        signal: null,
        stdout: "planning stdout",
        stderr: "planning stderr",
        stdoutBytes: "planning stdout".length,
        stderrBytes: "planning stderr".length,
      },
      "/app/bridge-tools/terraform",
      ["-chdir=/workspace/repo/infra", "plan", "-no-color"],
    );

    expect(message).toContain("Terraform plan failed.");
    expect(message).toContain("Command: /app/bridge-tools/terraform -chdir=<directory> plan -no-color");
    expect(message).toContain("Exit code: 1");
    expect(message).toContain("Stdout bytes: 15");
    expect(message).toContain("Stderr bytes: 15");
    expect(message).toContain(
      "Raw Terraform diagnostics were redacted because plan output may contain sensitive provider values.",
    );
    expect(message).not.toContain("planning stdout");
    expect(message).not.toContain("planning stderr");
    expect(message).not.toContain("/workspace/repo/infra");
  });

  it("classifies Terraform Cloud unauthorized diagnostics without exposing raw output", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cycloid-terraform-auth-test-"));
    const scriptPath = join(directory, "unauthorized.cjs");
    await writeFile(
      scriptPath,
      'process.stderr.write("Error: app.terraform.io returned 401 Unauthorized for invalid token secret-value\\n"); process.exit(1);\n',
      "utf8",
    );
    let thrown: unknown;
    try {
      await runTerraformCommand("init", process.execPath, [scriptPath], {
        cwd: process.cwd(),
        env: { ...process.env },
        timeout: 10_000,
      });
    } catch (error) {
      thrown = error;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }

    expect(thrown).toMatchObject({
      name: "TerraformToolError",
      code: "invalid_credential",
    });
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    expect(message).toContain("Terraform init failed.");
    expect(message).toContain(
      "Raw Terraform diagnostics were redacted because plan output may contain sensitive provider values.",
    );
    expect(message).not.toContain("invalid token");
    expect(message).not.toContain("secret-value");
  });

  it("classifies explicit Terraform Cloud token expiry diagnostics", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cycloid-terraform-auth-test-"));
    const scriptPath = join(directory, "expired.cjs");
    await writeFile(
      scriptPath,
      'process.stderr.write("Error: Terraform Cloud authentication token expired for secret-value\\n"); process.exit(1);\n',
      "utf8",
    );
    let thrown: unknown;
    try {
      await runTerraformCommand("plan", process.execPath, [scriptPath], {
        cwd: process.cwd(),
        env: { ...process.env },
        timeout: 10_000,
      });
    } catch (error) {
      thrown = error;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }

    expect(thrown).toMatchObject({
      name: "TerraformToolError",
      code: "token_expired",
    });
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    expect(message).toContain("Terraform plan failed.");
    expect(message).not.toContain("token expired");
    expect(message).not.toContain("secret-value");
  });

  it("does not classify unrelated auth-looking diagnostics after Terraform Cloud output", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cycloid-terraform-auth-test-"));
    const scriptPath = join(directory, "provider-forbidden.cjs");
    await writeFile(
      scriptPath,
      [
        'process.stdout.write("Initializing Terraform Cloud remote backend\\n");',
        'process.stderr.write("Error: private registry provider returned 403 forbidden for provider-secret\\n");',
        "process.exit(1);",
      ].join("\n"),
      "utf8",
    );
    let thrown: unknown;
    try {
      await runTerraformCommand("init", process.execPath, [scriptPath], {
        cwd: process.cwd(),
        env: { ...process.env },
        timeout: 10_000,
      });
    } catch (error) {
      thrown = error;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }

    expect(thrown).toMatchObject({
      name: "TerraformToolError",
      code: "execution_failed",
    });
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    expect(message).not.toContain("provider-secret");
  });

  it("surfaces a sanitized error summary without exposing raw diagnostics", () => {
    const message = buildTerraformCommandFailureMessage(
      "plan",
      {
        code: 1,
        signal: null,
        stdout: "Preparing the remote plan...",
        stderr:
          "Error: Failed to upload archive to https://example.com/upload from /workspace/repo/infra/.terraform/tmp/plan.json",
        stdoutBytes: "Preparing the remote plan...".length,
        stderrBytes:
          "Error: Failed to upload archive to https://example.com/upload from /workspace/repo/infra/.terraform/tmp/plan.json"
            .length,
      },
      "/app/bridge-tools/terraform",
      ["-chdir=/workspace/repo/infra", "plan", "-no-color"],
    );

    expect(message).toContain("Error summary: Failed to upload archive to <url> from <path>");
    expect(message).toContain(
      "Raw Terraform diagnostics were redacted because plan output may contain sensitive provider values.",
    );
    expect(message).not.toContain("https://example.com/upload");
    expect(message).not.toContain("/workspace/repo/infra/.terraform/tmp/plan.json");
  });

  it("redacts lookalike terraform hosts in sanitized error summaries", () => {
    const message = buildTerraformCommandFailureMessage(
      "plan",
      {
        code: 1,
        signal: null,
        stdout: "",
        stderr:
          "Error: Visit https://app.terraform.io.evil.com/app/cycloid/cycloid-infra/runs/run-abc123 or https://app.terraform.io@evil.com/app/cycloid/cycloid-infra/runs/run-def456",
        stdoutBytes: 0,
        stderrBytes: Buffer.byteLength(
          "Error: Visit https://app.terraform.io.evil.com/app/cycloid/cycloid-infra/runs/run-abc123 or https://app.terraform.io@evil.com/app/cycloid/cycloid-infra/runs/run-def456",
          "utf8",
        ),
      },
      "/app/bridge-tools/terraform",
      ["-chdir=/workspace/repo/infra", "plan", "-no-color"],
    );

    expect(message).toContain("Error summary: Visit <url> or <url>");
    expect(message).not.toContain("app.terraform.io.evil.com");
    expect(message).not.toContain("app.terraform.io@evil.com");
  });

  it("surfaces safe post-plan policy failure details after a plan summary", () => {
    const stdout = [
      "Running plan in HCP Terraform. Output will stream here.",
      "To view this run in a browser, visit:",
      "https://app.terraform.io/app/cycloid/cycloid-infra/runs/run-abc123",
      "",
      "Plan: 0 to add, 7 to change, 0 to destroy.",
      "",
      "Organization policy check:",
      "Sentinel Result: false",
    ].join("\n");
    const stderr = 'Error: Run task "security-scan" failed';
    const message = buildTerraformCommandFailureMessage(
      "plan",
      {
        code: 1,
        signal: null,
        stdout,
        stderr,
        stdoutBytes: stdout.length,
        stderrBytes: stderr.length,
      },
      "/app/bridge-tools/terraform",
      ["-chdir=/workspace/repo/infra", "plan", "-no-color"],
    );

    expect(message).toContain(
      "HCP Terraform run URL: https://app.terraform.io/app/cycloid/cycloid-infra/runs/run-abc123",
    );
    expect(message).toContain("Plan summary produced before failure: Plan: 0 to add, 7 to change, 0 to destroy.");
    expect(message).toContain("Policy summary: Sentinel Result: false");
    expect(message).toContain('Error summary: Run task "security-scan" failed');
    expect(message).not.toContain("Organization policy check:");
  });

  it("preserves utf8 terraform summaries when diagnostics are fully buffered", () => {
    const stdout = [
      "Running plan in HCP Terraform. Output will stream here.",
      "To view this run in a browser, visit:",
      "https://app.terraform.io/app/cycloid/cycloid-infra/runs/run-utf8",
      "Plan: 0 to add, 7 to change, 0 to destroy.",
      "Sentinel Result: false",
    ].join("\n");
    const stderr = "│ Error: Remote policy gate failed";
    const message = buildTerraformCommandFailureMessage(
      "plan",
      {
        code: 1,
        signal: null,
        stdout,
        stderr,
        stdoutBytes: Buffer.byteLength(stdout, "utf8"),
        stderrBytes: Buffer.byteLength(stderr, "utf8"),
      },
      "/app/bridge-tools/terraform",
      ["-chdir=/workspace/repo/infra", "plan", "-no-color"],
    );

    expect(message).toContain(
      "HCP Terraform run URL: https://app.terraform.io/app/cycloid/cycloid-infra/runs/run-utf8",
    );
    expect(message).toContain("Plan summary produced before failure: Plan: 0 to add, 7 to change, 0 to destroy.");
    expect(message).toContain("Policy summary: Sentinel Result: false");
    expect(message).toContain("Error summary: Remote policy gate failed");
    expect(message).toContain(
      "Raw Terraform diagnostics were redacted because plan output may contain sensitive provider values.",
    );
  });

  it("includes the generic error when Terraform returns no output", () => {
    const message = buildTerraformCommandFailureMessage(
      "init",
      {
        code: 1,
        signal: null,
        stdout: "",
        stderr: "",
        stdoutBytes: 0,
        stderrBytes: 0,
        error: new Error("spawn failed"),
      },
      "/app/bridge-tools/terraform",
      ["-chdir=/workspace/repo/infra", "init", "-no-color"],
    );

    expect(message).toContain("Terraform init failed.");
    expect(message).toContain("Exit code: 1");
    expect(message).toContain("Error:\nspawn failed");
  });

  it("drains large Terraform output without exposing diagnostics on failure", async () => {
    const largeOutput = "x".repeat(256 * 1024);

    let thrown: unknown;
    try {
      await runTerraformCommand(
        "plan",
        process.execPath,
        [
          "-e",
          `const { writeSync } = require("node:fs"); const output = "x".repeat(${largeOutput.length}); writeSync(1, output); writeSync(2, output); process.exit(1);`,
        ],
        {
          cwd: process.cwd(),
          env: { ...process.env },
          timeout: 10_000,
        },
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      name: "TerraformToolError",
      code: "execution_failed",
    });
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    expect(message).toContain("Terraform plan failed.");
    expect(message).toContain("Stdout bytes:");
    expect(message).toContain("Stderr bytes:");
    expect(message).toContain(
      "Raw Terraform diagnostics were redacted because plan output may contain sensitive provider values.",
    );
    expect(message).not.toContain("xxxxxxxxxxxxxxxx");
  });

  it("returns bounded output for successful Terraform commands while draining the full stream", async () => {
    const largeOutput = "s".repeat(256 * 1024);

    const tmpDir = await mkdtemp(join(tmpdir(), "terraform-bytes-"));
    const bytesPath = join(tmpDir, "bytes.json");
    try {
      const result = await runTerraformCommand(
        "plan",
        process.execPath,
        [
          "-e",
          `const { writeFileSync, writeSync } = require("node:fs"); const output = "s".repeat(${largeOutput.length}); const w1 = writeSync(1, output); const w2 = writeSync(2, output); writeFileSync(process.env.TF_TEST_BYTES_FILE, JSON.stringify({ w1, w2 })); process.exit(0);`,
        ],
        {
          cwd: process.cwd(),
          env: { ...process.env, TF_TEST_BYTES_FILE: bytesPath },
          timeout: 10_000,
        },
      );

      const { w1, w2 } = JSON.parse(await readFile(bytesPath, "utf8")) as { w1: number; w2: number };
      expect(result.stdoutBytes).toBe(w1);
      expect(result.stderrBytes).toBe(w2);
      expect(result.stdout.length).toBeLessThanOrEqual(64 * 1024);
      expect(result.stderr.length).toBeLessThanOrEqual(64 * 1024);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("bounds multibyte Terraform output without introducing replacement characters", async () => {
    const outputLen = 80 * 1024;
    const tmpDir = await mkdtemp(join(tmpdir(), "terraform-bytes-"));
    const bytesPath = join(tmpDir, "bytes.json");
    try {
      const result = await runTerraformCommand(
        "plan",
        process.execPath,
        [
          "-e",
          `const { writeFileSync, writeSync } = require("node:fs"); const output = "─".repeat(${outputLen}); const w1 = writeSync(1, output); const w2 = writeSync(2, output); writeFileSync(process.env.TF_TEST_BYTES_FILE, JSON.stringify({ w1, w2 })); process.exit(0);`,
        ],
        {
          cwd: process.cwd(),
          env: { ...process.env, TF_TEST_BYTES_FILE: bytesPath },
          timeout: 10_000,
        },
      );

      const { w1, w2 } = JSON.parse(await readFile(bytesPath, "utf8")) as { w1: number; w2: number };
      expect(result.stdoutBytes).toBe(w1);
      expect(result.stderrBytes).toBe(w2);

      expect(result.stdoutBytes).toBeGreaterThan(result.stdout.length);
      expect(result.stderrBytes).toBeGreaterThan(result.stderr.length);
      expect(result.stdout.length).toBeLessThanOrEqual(64 * 1024);
      expect(result.stderr.length).toBeLessThanOrEqual(64 * 1024);
      expect(result.stdout).not.toContain("\uFFFD");
      expect(result.stderr).not.toContain("\uFFFD");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("escalates timed-out Terraform commands that ignore SIGTERM", async () => {
    if (process.platform === "win32") return;

    let thrown: unknown;
    try {
      await runTerraformCommand(
        "plan",
        process.execPath,
        ["-e", `process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);`],
        {
          cwd: process.cwd(),
          env: { ...process.env },
          timeout: 50,
          terminationGraceMs: 50,
        },
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      name: "TerraformToolError",
      code: "execution_failed",
    });
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    expect(message).toMatch(/Signal: SIG(?:TERM|KILL)/);
  });
});
