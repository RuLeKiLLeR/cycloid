import { describe, expect, it } from "vitest";

import {
  normalizeSandboxLayerInstructions,
  parseSandboxLayerDockerfile,
  parseSandboxLayerManifest,
  parseSandboxLayerSource,
  SandboxLayerValidationError,
} from "../../apps/control-plane-worker/src/sandbox/layer-parser";

describe("sandbox layer parser", () => {
  it("accepts the v1 manifest and normalizes RUN/ENV instructions", () => {
    const manifest = parseSandboxLayerManifest(
      ".cycloid/sandbox.yaml",
      [
        "version: 1",
        "name: CI deps",
        "layer:",
        "  dockerfile: .cycloid/sandbox.layer.Dockerfile",
        "smoke:",
        "  commands:",
        '    - ["bash", "-lc", "command -v rg"]',
        "",
      ].join("\n"),
    );
    expect(manifest).toEqual({
      version: 1,
      name: "CI deps",
      layer: { dockerfile: ".cycloid/sandbox.layer.Dockerfile" },
      smoke: { commands: [["bash", "-lc", "command -v rg"]] },
    });

    const instructions = parseSandboxLayerDockerfile(
      ".cycloid/sandbox.layer.Dockerfile",
      ['ENV FOO=bar BAZ="qux quux"', "RUN apt-get update && apt-get install -y ripgrep", ""].join("\n"),
    );
    expect(normalizeSandboxLayerInstructions(instructions)).toBe(
      JSON.stringify([
        { kind: "env", values: { BAZ: "qux quux", FOO: "bar" } },
        { kind: "run", command: "apt-get update && apt-get install -y ripgrep" },
      ]),
    );
  });

  it("rejects unsupported dockerfile instructions", () => {
    expect(() => parseSandboxLayerDockerfile(".cycloid/sandbox.layer.Dockerfile", "COPY . /tmp\n")).toThrow(
      SandboxLayerValidationError,
    );
  });

  it("rejects shell writes into runtime-owned paths", () => {
    expect(() => parseSandboxLayerDockerfile(".cycloid/sandbox.layer.Dockerfile", "RUN rm -rf /app/scripts\n")).toThrow(
      /runtime path/,
    );
  });

  it("rejects secret-like manifest content before storage", () => {
    expect(() =>
      parseSandboxLayerManifest(
        ".cycloid/sandbox.yaml",
        [
          "version: 1",
          "layer:",
          "  dockerfile: .cycloid/sandbox.layer.Dockerfile",
          "smoke:",
          "  commands: []",
          "password: hunter2",
          "",
        ].join("\n"),
      ),
    ).toThrow(/secret-like/);
  });

  it("aggregates manifest schema issues with fields", () => {
    try {
      parseSandboxLayerManifest(
        ".cycloid/sandbox.yaml",
        [
          "name: x",
          "resources:",
          "  cpu: 8",
          "layer:",
          "  dockerfile: ../sandbox.layer.Dockerfile",
          "smoke:",
          "  commands:",
          "    - echo hi",
          "",
        ].join("\n"),
      );
      throw new Error("expected validation failure");
    } catch (err) {
      expect(err).toBeInstanceOf(SandboxLayerValidationError);
      const issues = (err as SandboxLayerValidationError).issues;
      expect(issues.map((issue) => issue.field)).toEqual(
        expect.arrayContaining(["version", "resources", "name", "layer.dockerfile", "smoke.commands.0"]),
      );
      expect(issues.find((issue) => issue.field === "resources")?.message).toContain("Cycloid policy");
    }
  });

  it("rejects invalid manifest paths and smoke args", () => {
    const cases = [
      "  dockerfile: /tmp/layer.Dockerfile",
      "  dockerfile: C:\\\\tmp\\\\layer.Dockerfile",
      "  dockerfile: docker/layer.Dockerfile",
      "  dockerfile: .cycloid//layer.Dockerfile",
    ];
    for (const line of cases) {
      expect(() =>
        parseSandboxLayerManifest(
          ".cycloid/sandbox.yaml",
          ["version: 1", "layer:", line, "smoke:", "  commands:", '    - ["bash", "ok"]', ""].join("\n"),
        ),
      ).toThrow(SandboxLayerValidationError);
    }

    expect(() =>
      parseSandboxLayerManifest(
        ".cycloid/sandbox.yaml",
        [
          "version: 1",
          "layer:",
          "  dockerfile: .cycloid/layer.Dockerfile",
          "smoke:",
          "  commands:",
          '    - ["bash\\n"]',
          "",
        ].join("\n"),
      ),
    ).toThrow(/no NUL or newline/);
  });

  it("accepts continued RUN and records physical line numbers", () => {
    const instructions = parseSandboxLayerDockerfile(
      ".cycloid/sandbox.layer.Dockerfile",
      ["# comment", "", "RUN apt-get update \\", "  && apt-get install -y jq", ""].join("\n"),
    );
    expect(instructions).toEqual([
      { kind: "run", command: "apt-get update && apt-get install -y jq", startLine: 3, endLine: 4 },
    ]);
  });

  it("accepts strict ENV values and rejects ambiguous ENV forms", () => {
    expect(
      parseSandboxLayerDockerfile(".cycloid/sandbox.layer.Dockerfile", 'ENV PATH="/opt/tool/bin:${PATH}" FOO=bar\n'),
    ).toEqual([{ kind: "env", values: { PATH: "/opt/tool/bin:${PATH}", FOO: "bar" }, startLine: 1, endLine: 1 }]);
    for (const body of ["ENV FOO\n", "ENV FOO bar\n", "ENV FOO=\n", "ENV foo=bar\n"]) {
      expect(() => parseSandboxLayerDockerfile(".cycloid/sandbox.layer.Dockerfile", body)).toThrow(
        SandboxLayerValidationError,
      );
    }
  });

  it("rejects layer syntax and guardrail violations with line numbers", () => {
    const cases = [
      "# syntax=docker/dockerfile:1",
      "RUN <<EOF",
      "RUN --mount=type=secret echo hi",
      "RUN ",
      "RUN echo token",
      "RUN chmod 777 /workspace",
      "RUN echo hi \\",
    ];
    for (const source of cases) {
      expect(() => parseSandboxLayerDockerfile(".cycloid/sandbox.layer.Dockerfile", `${source}\n`)).toThrow(
        SandboxLayerValidationError,
      );
    }
    try {
      parseSandboxLayerDockerfile(".cycloid/sandbox.layer.Dockerfile", '\n\nENTRYPOINT ["bash"]\n');
      throw new Error("expected validation failure");
    } catch (err) {
      expect(err).toBeInstanceOf(SandboxLayerValidationError);
      expect((err as SandboxLayerValidationError).line).toBe(3);
    }
  });

  it("computes normalized source hashes from build identity, not commit identity", async () => {
    const input = {
      manifestPath: ".cycloid/sandbox.yaml",
      manifestText: [
        "version: 1",
        "layer:",
        "  dockerfile: .cycloid/sandbox.layer.Dockerfile",
        "smoke:",
        "  commands:",
        '    - ["go", "version"]',
        "",
      ].join("\n"),
      layerPath: ".cycloid/sandbox.layer.Dockerfile",
      layerText: "RUN apt-get update\n",
    };
    const first = await parseSandboxLayerSource({
      ...input,
      buildIdentity: { baseTemplateRef: "base-a", baseVersion: "1", compilerVersion: "sandbox-layer-v1" },
    });
    const same = await parseSandboxLayerSource({
      ...input,
      buildIdentity: { baseTemplateRef: "base-a", baseVersion: "1", compilerVersion: "sandbox-layer-v1" },
    });
    const newBase = await parseSandboxLayerSource({
      ...input,
      buildIdentity: { baseTemplateRef: "base-b", baseVersion: "1", compilerVersion: "sandbox-layer-v1" },
    });
    const newCompiler = await parseSandboxLayerSource({
      ...input,
      buildIdentity: { baseTemplateRef: "base-a", baseVersion: "1", compilerVersion: "sandbox-layer-v2" },
    });

    expect(first.hashes.normalizedSourceHash).toBe(same.hashes.normalizedSourceHash);
    expect(first.hashes.normalizedSourceHash).not.toBe(newBase.hashes.normalizedSourceHash);
    expect(first.hashes.normalizedSourceHash).not.toBe(newCompiler.hashes.normalizedSourceHash);
  });
});
