import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  sandboxAssignRepoCommand,
  sandboxBuildCommand,
  sandboxHistoryCommand,
  sandboxInitCommand,
  sandboxLogsCommand,
  sandboxRebuildStaleCommand,
  sandboxStatusCommand,
  sandboxUnassignDefaultCommand,
  sandboxUnassignRepoCommand,
  sandboxValidateCommand,
} from "../../apps/cli/src/commands/sandbox";
import { CliError } from "../../apps/cli/src/errors";

describe("CLI sandbox layer commands", () => {
  let originalCwd: string;
  let tempDir: string;
  let fetchMock: ReturnType<typeof vi.fn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalCwd = process.cwd();
    tempDir = mkdtempSync(join(tmpdir(), "cycloid-sandbox-cli-"));
    process.chdir(tempDir);
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.useRealTimers();
    stdoutSpy.mockRestore();
    vi.unstubAllGlobals();
    process.exitCode = undefined;
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("initializes and validates the default sandbox layer files", async () => {
    await sandboxInitCommand();
    await sandboxValidateCommand();

    await expect(readFile(".cycloid/sandbox.yaml", "utf8")).resolves.toContain(
      "dockerfile: .cycloid/sandbox.layer.Dockerfile",
    );
    await expect(readFile(".cycloid/sandbox.layer.Dockerfile", "utf8")).resolves.toContain("Only RUN and ENV");
  });

  it("validates with the shared sandbox layer parser and emits source details", async () => {
    await sandboxInitCommand();
    stdoutSpy.mockClear();

    await sandboxValidateCommand({ json: true });

    const output = stdoutSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("");
    expect(JSON.parse(output)).toMatchObject({
      ok: true,
      manifestPath: ".cycloid/sandbox.yaml",
      layerPath: ".cycloid/sandbox.layer.Dockerfile",
      instructionCount: 0,
      smokeCommandCount: 1,
      diagnostics: [],
    });
  });

  it("prints a validation success message with exact files and next command", async () => {
    await sandboxInitCommand();
    stdoutSpy.mockClear();

    await sandboxValidateCommand();

    const output = stdoutSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("");
    expect(output).toContain("Valid sandbox template.");
    expect(output).toContain("Manifest: .cycloid/sandbox.yaml");
    expect(output).toContain("Layer: .cycloid/sandbox.layer.Dockerfile");
    expect(output).toContain(
      "Next: configure a GitHub origin, then run cycloid sandbox build <owner/repo> --wait --follow",
    );
  });

  it("queues build requests through the business-scoped source repo route with target coverage", async () => {
    await sandboxInitCommand();
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          buildRequest: {
            id: "build-1",
            status: "validated",
            sourceRepo: "acme/source",
            targetRepo: "acme/heavy",
            commitSha: "abc123",
            resourceProfileKey: "large",
          },
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      ),
    );

    await sandboxBuildCommand("acme/source", {
      apiUrl: "https://api.example.test",
      token: "arc_test",
      business: "biz-1",
      ref: "main",
      targetRepo: "acme/heavy",
      json: true,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.test/api/businesses/biz-1/repos/acme/source/sandbox-layer/build-requests",
      expect.objectContaining({
        method: "POST",
        headers: expect.any(Headers),
        body: JSON.stringify({
          ref: "main",
          manifestPath: ".cycloid/sandbox.yaml",
          targetRepo: { owner: "acme", name: "heavy" },
        }),
      }),
    );
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Headers).get("Idempotency-Key")).toBeTruthy();
  });

  it("sends explicit idempotency keys for sandbox builds", async () => {
    await sandboxInitCommand();
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          buildRequest: { id: "build-1", status: "validated", sourceRepo: "acme/source", commitSha: "abc123" },
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      ),
    );

    await sandboxBuildCommand("acme/source", {
      apiUrl: "https://api.example.test",
      token: "arc_test",
      business: "biz-1",
      ref: "main",
      idempotencyKey: "retry-key",
      json: true,
    });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Headers).get("Idempotency-Key")).toBe("retry-key");
  });

  it("adds an actionable hint for duplicate sandbox build keys", async () => {
    await sandboxInitCommand();
    fetchMock.mockResolvedValueOnce(
      Response.json(
        { ok: false, error: "A request with this Idempotency-Key already exists", code: "duplicate_request" },
        { status: 409 },
      ),
    );

    await expect(
      sandboxBuildCommand("acme/source", {
        apiUrl: "https://api.example.test",
        token: "arc_test",
        business: "biz-1",
        ref: "main",
        idempotencyKey: "retry-key",
        json: true,
      }),
    ).rejects.toMatchObject({
      exitCode: 4,
      hint: "Use the same --idempotency-key only for retrying the original sandbox build request.",
      data: { serverCode: "duplicate_request" },
    });
  });

  it("infers business context from whoami for builds", async () => {
    await sandboxInitCommand();
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ businessId: "biz-1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            buildRequest: {
              id: "build-1",
              status: "validated",
              sourceRepo: "acme/source",
              commitSha: "abc123",
              resourceProfileKey: "default",
            },
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        ),
      );

    await sandboxBuildCommand("acme/source", {
      apiUrl: "https://api.example.test",
      token: "arc_test",
      ref: "main",
      json: true,
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://api.example.test/api/auth/whoami",
      expect.objectContaining({ headers: expect.any(Headers) }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://api.example.test/api/businesses/biz-1/repos/acme/source/sandbox-layer/build-requests",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          ref: "main",
          manifestPath: ".cycloid/sandbox.yaml",
        }),
      }),
    );
  });

  it("prints a successful wait summary with the active template", async () => {
    await sandboxInitCommand();
    stdoutSpy.mockClear();
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            buildRequest: { id: "build-1", status: "queued", sourceRepo: "acme/source" },
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            buildRequest: {
              id: "build-1",
              status: "completed",
              sourceRepo: "acme/source",
              commitSha: "abc123",
              providerArtifactRef: "tpl_new",
              activeTemplateRef: "tpl_new",
              createdBy: { userId: 7, login: "alice", name: "Alice Example" },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );

    await sandboxBuildCommand("acme/source", {
      apiUrl: "https://api.example.test",
      token: "arc_test",
      business: "biz-1",
      ref: "main",
      wait: true,
    });

    const output = stdoutSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("");
    expect(output).toContain("Sandbox build completed.");
    expect(output).toContain("Source: acme/source");
    expect(output).toContain("Built by: @alice");
    expect(output).toContain("Template: tpl_new");
    expect(output).toContain("Active template updated to tpl_new.");
    expect(process.exitCode).toBeUndefined();
  });

  it("does not claim inactive completed builds are active", async () => {
    await sandboxInitCommand();
    stdoutSpy.mockClear();
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            buildRequest: { id: "build-1", status: "queued", sourceRepo: "acme/source" },
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            buildRequest: {
              id: "build-1",
              status: "completed",
              sourceRepo: "acme/source",
              commitSha: "abc123",
              providerArtifactRef: "tpl_candidate",
              activeTemplateRef: null,
              createdBy: { userId: 7, login: "alice", name: "Alice Example" },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );

    await sandboxBuildCommand("acme/source", {
      apiUrl: "https://api.example.test",
      token: "arc_test",
      business: "biz-1",
      ref: "feature",
      wait: true,
    });

    const output = stdoutSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("");
    expect(output).toContain("Sandbox build completed.");
    expect(output).toContain("Template: tpl_candidate");
    expect(output).toContain(
      "Build completed but is not active; sessions will use the previous sandbox or Cycloid default.",
    );
    expect(output).not.toContain("Active: yes");
    expect(output).not.toContain("Active template updated to tpl_candidate.");
  });

  it("prints a failed smoke summary with command, exit code, and active rollback state", async () => {
    await sandboxInitCommand();
    stdoutSpy.mockClear();
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            buildRequest: { id: "build-1", status: "queued", sourceRepo: "acme/source" },
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            buildRequest: {
              id: "build-1",
              status: "failed",
              sourceRepo: "acme/source",
              commitSha: "abc123",
              activeTemplateRef: "tpl_previous",
              createdBy: { userId: 7, login: "alice", name: "Alice Example" },
              failureSummary: {
                phase: "smoke",
                reason: "go missing",
                command: "go version",
                exitCode: 1,
                stderrPreview: "go: command not found",
                activeTemplateUnchanged: true,
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );

    await sandboxBuildCommand("acme/source", {
      apiUrl: "https://api.example.test",
      token: "arc_test",
      business: "biz-1",
      ref: "main",
      wait: true,
    });

    const output = stdoutSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("");
    expect(output).toContain("Sandbox build failed during smoke.");
    expect(output).toContain("Built by: @alice");
    expect(output).toContain("Command: go version");
    expect(output).toContain("Exit code: 1");
    expect(output).toContain("Reason: go missing");
    expect(output).toContain("Active template unchanged; previous successful sandbox remains active.");
    expect(process.exitCode).toBe(1);
  });

  it("keeps failed wait output structured in JSON mode", async () => {
    await sandboxInitCommand();
    stdoutSpy.mockClear();
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            buildRequest: { id: "build-1", status: "queued", sourceRepo: "acme/source" },
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            buildRequest: {
              id: "build-1",
              status: "failed",
              createdBy: { userId: 7, login: "alice", name: "Alice Example" },
              failureSummary: { phase: "provider_build", reason: "apt exited 100", activeTemplateUnchanged: false },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );

    await sandboxBuildCommand("acme/source", {
      apiUrl: "https://api.example.test",
      token: "arc_test",
      business: "biz-1",
      ref: "main",
      wait: true,
      json: true,
    });

    const lines = stdoutSpy.mock.calls.map((call: unknown[]) => String(call[0]).trim()).filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]!)).toMatchObject({
      ok: true,
      buildRequest: {
        status: "failed",
        createdBy: { userId: 7, login: "alice", name: "Alice Example" },
        failureSummary: { phase: "provider_build", reason: "apt exited 100" },
      },
    });
    expect(lines.join("\n")).not.toContain("Sandbox build failed during provider build.");
    expect(process.exitCode).toBe(1);
  });

  it("emits build follow JSON as NDJSON logs and terminal build lines", async () => {
    await sandboxInitCommand();
    stdoutSpy.mockClear();
    fetchMock
      .mockResolvedValueOnce(
        Response.json({ ok: true, buildRequest: { id: "build-1", status: "queued", sourceRepo: "acme/source" } }),
      )
      .mockResolvedValueOnce(Response.json({ ok: true, logs: [{ sequence: 0, message: "installing packages" }] }))
      .mockResolvedValueOnce(
        Response.json({ ok: true, buildRequest: { id: "build-1", status: "completed", sourceRepo: "acme/source" } }),
      )
      .mockResolvedValueOnce(Response.json({ ok: true, logs: [] }));

    await sandboxBuildCommand("acme/source", {
      apiUrl: "https://api.example.test",
      token: "arc_test",
      business: "biz-1",
      ref: "main",
      follow: true,
      json: true,
    });

    const lines = stdoutSpy.mock.calls.map((call: unknown[]) => JSON.parse(String(call[0])));
    expect(lines).toEqual([
      { type: "logs", logs: [{ sequence: 0, message: "installing packages" }] },
      { type: "build", buildRequest: { id: "build-1", status: "completed", sourceRepo: "acme/source" } },
    ]);
  });

  it("drains final sandbox build logs after terminal status while following", async () => {
    await sandboxInitCommand();
    stdoutSpy.mockClear();
    fetchMock
      .mockResolvedValueOnce(
        Response.json({ ok: true, buildRequest: { id: "build-1", status: "queued", sourceRepo: "acme/source" } }),
      )
      .mockResolvedValueOnce(Response.json({ ok: true, logs: [] }))
      .mockResolvedValueOnce(
        Response.json({ ok: true, buildRequest: { id: "build-1", status: "completed", sourceRepo: "acme/source" } }),
      )
      .mockResolvedValueOnce(Response.json({ ok: true, logs: [{ sequence: 1, message: "finalizing image" }] }))
      .mockResolvedValueOnce(Response.json({ ok: true, logs: [{ sequence: 2, message: "promoted template" }] }))
      .mockResolvedValueOnce(Response.json({ ok: true, logs: [] }));

    await sandboxBuildCommand("acme/source", {
      apiUrl: "https://api.example.test",
      token: "arc_test",
      business: "biz-1",
      ref: "main",
      follow: true,
      json: true,
    });

    const lines = stdoutSpy.mock.calls.map((call: unknown[]) => JSON.parse(String(call[0])));
    expect(lines).toEqual([
      { type: "logs", logs: [{ sequence: 1, message: "finalizing image" }] },
      { type: "logs", logs: [{ sequence: 2, message: "promoted template" }] },
      { type: "build", buildRequest: { id: "build-1", status: "completed", sourceRepo: "acme/source" } },
    ]);
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      "https://api.example.test/api/businesses/biz-1/sandbox-layer/build-requests/build-1/logs?limit=500",
      expect.anything(),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      5,
      "https://api.example.test/api/businesses/biz-1/sandbox-layer/build-requests/build-1/logs?afterSequence=1&limit=500",
      expect.anything(),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      6,
      "https://api.example.test/api/businesses/biz-1/sandbox-layer/build-requests/build-1/logs?afterSequence=2&limit=500",
      expect.anything(),
    );
  });

  it("prints sandbox build history with build actor attribution", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          builds: [
            {
              id: "build-1",
              status: "completed",
              sourceRepo: "acme/source",
              commitSha: "abc123",
              resourceProfileKey: "default",
              templateId: "tpl_123",
              baseTemplateRef: "cycloid-sandbox-prod",
              baseVersion: "base-sha",
              baseSource: "registry",
              baseVersionQuality: "versioned",
              createdBy: { userId: 7, login: "alice", name: "Alice Example" },
              createdAt: 1_781_000_000_000,
              completedAt: 1_781_000_010_000,
              smokeStatus: "passed",
              failureSummary: null,
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    await sandboxHistoryCommand("acme/source", {
      apiUrl: "https://api.example.test",
      token: "arc_test",
      business: "biz-1",
      targetRepo: "acme/heavy",
      limit: "10",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.test/api/businesses/biz-1/sandbox-layer/build-requests?sourceRepo=acme%2Fsource&targetRepo=acme%2Fheavy&limit=10",
      expect.objectContaining({ headers: expect.any(Headers) }),
    );
    const output = stdoutSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("");
    expect(output).toContain("Build build-1 is completed.");
    expect(output).toContain("base=cycloid-sandbox-prod@base-sha");
    expect(output).toContain("builtBy=@alice");
  });

  it("infers business context from whoami for status", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ businessId: "biz-1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, repo: "acme/heavy", selected: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

    await sandboxStatusCommand("acme/heavy", {
      apiUrl: "https://api.example.test",
      token: "arc_test",
      json: true,
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://api.example.test/api/auth/whoami",
      expect.objectContaining({ headers: expect.any(Headers) }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://api.example.test/api/businesses/biz-1/repos/acme/heavy/sandbox-layer/resolution",
      expect.objectContaining({ headers: expect.any(Headers) }),
    );
  });

  it("prints sandbox status with build actor attribution", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          repo: "acme/heavy",
          resourceProfileKey: "default",
          selection: {
            tier: "business_default",
            sourceRepo: "acme/source",
            buildId: "build-1",
            templateId: "tpl_123",
            commitSha: "abc123",
            resourceProfileKey: "default",
            baseTemplateRef: "cycloid-sandbox-prod",
            baseVersion: "base-sha",
            currentBaseVersion: "base-sha",
            baseSource: "registry",
            baseVersionQuality: "versioned",
            baseStatus: "active",
            createdBy: { userId: 7, login: "alice", name: "Alice Example" },
          },
          latestRepoBuild: null,
          fallback: null,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    await sandboxStatusCommand("acme/heavy", {
      apiUrl: "https://api.example.test",
      token: "arc_test",
      business: "biz-1",
    });

    const output = stdoutSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("");
    expect(output).toContain("Using workspace default sandbox.");
    expect(output).toContain("Template: tpl_123");
    expect(output).toContain("Built from: cycloid-sandbox-prod @ base-sha");
    expect(output).toContain("Built by: @alice");
  });

  it("reads build logs from the business-scoped build request logs route", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, logs: [{ sequence: 7, message: "built" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await sandboxLogsCommand("build-1", {
      apiUrl: "https://api.example.test",
      token: "arc_test",
      business: "biz-1",
      afterSequence: "5",
      limit: "10",
      json: true,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.test/api/businesses/biz-1/sandbox-layer/build-requests/build-1/logs?afterSequence=5&limit=10",
      expect.objectContaining({ headers: expect.any(Headers) }),
    );
  });

  it("skips empty sandbox log follow batches in JSON mode", async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, logs: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockRejectedValueOnce(new Error("stop follow"));

    const promise = sandboxLogsCommand("build-1", {
      apiUrl: "https://api.example.test",
      token: "arc_test",
      business: "biz-1",
      follow: true,
      json: true,
      pollInterval: "250",
    }).catch((err: unknown) => err);

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(250);
    await expect(promise).resolves.toMatchObject({ message: expect.stringContaining("stop follow") });
    expect(stdoutSpy).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("starts a sandbox rebuild campaign with --yes", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          campaign: {
            id: "campaign-1",
            status: "queued",
            summary: {
              activeArtifactsScanned: 3,
              staleArtifactsFound: 2,
              currentArtifactsSkipped: 1,
              missingInstallationSkips: 0,
              sourceUnavailableSkips: 0,
              unversionedBaseSkips: 0,
              activeChangedSkips: 0,
              failedItems: 0,
              promotedItems: 0,
              buildsQueued: 2,
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    await sandboxRebuildStaleCommand({
      apiUrl: "https://api.example.test",
      token: "arc_test",
      business: "biz-1",
      yes: true,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.test/api/admin/sandbox-layer/rebuild-campaigns",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          scope: "business",
          businessId: "biz-1",
          reason: "base_update",
          dryRun: false,
        }),
      }),
    );
    const output = stdoutSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("");
    expect(output).toContain("Campaign: campaign-1");
    expect(output).toContain("Builds queued: 2");
  });

  it("infers business context from whoami for stale rebuild campaigns", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ businessId: "biz-1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            campaign: {
              id: "campaign-1",
              status: "completed",
              summary: {
                activeArtifactsScanned: 3,
                staleArtifactsFound: 2,
                currentArtifactsSkipped: 1,
                missingInstallationSkips: 0,
                sourceUnavailableSkips: 0,
                unversionedBaseSkips: 0,
                activeChangedSkips: 0,
                failedItems: 0,
                promotedItems: 0,
                buildsQueued: 0,
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );

    await sandboxRebuildStaleCommand({
      apiUrl: "https://api.example.test",
      token: "arc_test",
      dryRun: true,
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://api.example.test/api/auth/whoami",
      expect.objectContaining({ headers: expect.any(Headers) }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://api.example.test/api/admin/sandbox-layer/rebuild-campaigns",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          scope: "business",
          businessId: "biz-1",
          reason: "base_update",
          dryRun: true,
        }),
      }),
    );
  });

  it("prints a clear auth error when sandbox rebuild campaigns are forbidden", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, error: "Forbidden" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(
      sandboxRebuildStaleCommand({
        apiUrl: "https://api.example.test",
        token: "arc_test",
        business: "biz-1",
        dryRun: true,
      }),
    ).rejects.toThrow("Only Cycloid internal admins can rebuild stale sandbox layers.");
  });

  it("prints the sandbox rebuild admin error for 403 responses without forbidden text", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, error: "internal_admin_required" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(
      sandboxRebuildStaleCommand({
        apiUrl: "https://api.example.test",
        token: "arc_test",
        business: "biz-1",
        dryRun: true,
      }),
    ).rejects.toMatchObject({
      code: "auth",
      message: "Only Cycloid internal admins can rebuild stale sandbox layers.",
    });
  });

  it("does not rewrite non-403 sandbox rebuild errors containing forbidden text", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("Forbidden dependency failed", {
        status: 500,
        headers: { "content-type": "text/plain" },
      }),
    );

    await expect(
      sandboxRebuildStaleCommand({
        apiUrl: "https://api.example.test",
        token: "arc_test",
        business: "biz-1",
        dryRun: true,
      }),
    ).rejects.toMatchObject({
      code: "server",
      message: "API error 500: Forbidden dependency failed",
    } satisfies Partial<CliError>);
  });

  it("assigns and unassigns repo sandbox layer sources", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, assignment: { targetRepo: "acme/heavy" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, deleted: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

    await sandboxAssignRepoCommand("acme/heavy", "acme/source", {
      apiUrl: "https://api.example.test",
      token: "arc_test",
      business: "biz-1",
      manifest: ".cycloid/sandbox.yaml",
      json: true,
    });
    await sandboxUnassignRepoCommand("acme/heavy", {
      apiUrl: "https://api.example.test",
      token: "arc_test",
      business: "biz-1",
      yes: true,
      json: true,
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://api.example.test/api/businesses/biz-1/repos/acme/heavy/sandbox-layer/assignment",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          sourceRepoOwner: "acme",
          sourceRepoName: "source",
          manifestPath: ".cycloid/sandbox.yaml",
        }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://api.example.test/api/businesses/biz-1/repos/acme/heavy/sandbox-layer/assignment",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("requires --yes for JSON sandbox unassign commands", async () => {
    await expect(
      sandboxUnassignDefaultCommand({
        apiUrl: "https://api.example.test",
        token: "arc_test",
        business: "biz-1",
        json: true,
      }),
    ).rejects.toThrow("`sandbox unassign default --json` requires --yes");
    await expect(
      sandboxUnassignRepoCommand("acme/heavy", {
        apiUrl: "https://api.example.test",
        token: "arc_test",
        business: "biz-1",
        json: true,
      }),
    ).rejects.toThrow("`sandbox unassign repo --json` requires --yes");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
