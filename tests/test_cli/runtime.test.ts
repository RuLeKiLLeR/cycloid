import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  assertCycloidSessionMutationAllowed,
  emit,
  readHiddenPrompt,
  resolveBusinessContext,
} from "../../apps/cli/src/runtime.js";

describe("readHiddenPrompt", () => {
  let stdoutWrites: string[];

  beforeEach(() => {
    stdoutWrites = [];

    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true,
    });
    Object.defineProperty(process.stdout, "isTTY", {
      value: true,
      configurable: true,
    });
    Object.defineProperty(process.stdin, "setRawMode", {
      value: vi.fn(),
      configurable: true,
      writable: true,
    });

    vi.spyOn(process.stdin, "resume").mockImplementation(() => process.stdin);
    vi.spyOn(process.stdin, "pause").mockImplementation(() => process.stdin);
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      stdoutWrites.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
  });

  afterEach(() => {
    Reflect.deleteProperty(process.stdin, "isTTY");
    Reflect.deleteProperty(process.stdout, "isTTY");
    Reflect.deleteProperty(process.stdin, "setRawMode");
    vi.restoreAllMocks();
  });

  it("masks pasted token input instead of echoing plaintext", async () => {
    const prompt = readHiddenPrompt("Enter your CLI token: ");

    process.stdin.emit("data", Buffer.from("\u001b[200~arc_secret\u001b[201~"));
    process.stdin.emit("data", Buffer.from("\r"));

    await expect(prompt).resolves.toBe("arc_secret");
    expect(stdoutWrites.join("")).toBe("Enter your CLI token: **********\n");
    expect(stdoutWrites.join("")).not.toContain("arc_secret");
    expect(process.stdin.setRawMode).toHaveBeenNthCalledWith(1, true);
    expect(process.stdin.setRawMode).toHaveBeenNthCalledWith(2, false);
    expect(process.stdin.pause).toHaveBeenCalledOnce();
  });

  it("handles bracketed-paste escape sequences split across chunks", async () => {
    const prompt = readHiddenPrompt("Enter your CLI token: ");

    process.stdin.emit("data", Buffer.from("\u001b["));
    process.stdin.emit("data", Buffer.from("200~arc_secret\u001b["));
    process.stdin.emit("data", Buffer.from("201~\r"));

    await expect(prompt).resolves.toBe("arc_secret");
    expect(stdoutWrites.join("")).toBe("Enter your CLI token: **********\n");
    expect(stdoutWrites.join("")).not.toContain("[200~");
    expect(process.stdin.pause).toHaveBeenCalledOnce();
  });

  it("ignores split SGR mouse escape sequences without trapping later input", async () => {
    const prompt = readHiddenPrompt("Token: ");

    // The partial CSI sequence stays in carry until the next chunk arrives.
    // The leading "M" in "Marc_token" completes \u001b[<0;12;34M, so the
    // remaining "arc_token" is the only text captured as user input.
    process.stdin.emit("data", Buffer.from("\u001b[<0;12;34"));
    process.stdin.emit("data", Buffer.from("Marc_token"));
    process.stdin.emit("data", Buffer.from("\r"));

    await expect(prompt).resolves.toBe("arc_token");
    expect(stdoutWrites.join("")).toBe("Token: *********\n");
    expect(stdoutWrites.join("")).not.toContain("[<0;12;34");
    expect(process.stdin.pause).toHaveBeenCalledOnce();
  });

  it("updates the mask when backspacing", async () => {
    const prompt = readHiddenPrompt("Token: ");

    process.stdin.emit("data", Buffer.from("arc_tox"));
    process.stdin.emit("data", Buffer.from("\u007F"));
    process.stdin.emit("data", Buffer.from("ken"));
    process.stdin.emit("data", Buffer.from("\n"));

    await expect(prompt).resolves.toBe("arc_token");
    expect(stdoutWrites.join("")).toBe("Token: *******\b \b***\n");
  });

  it("restores terminal state when interrupted", async () => {
    const prompt = readHiddenPrompt("Token: ");

    process.stdin.emit("data", Buffer.from("\u0003"));

    await expect(prompt).rejects.toMatchObject({
      message: "Interrupted.",
      exitCode: 130,
    });
    expect(stdoutWrites.join("")).toBe("Token: \n");
    expect(process.stdin.setRawMode).toHaveBeenNthCalledWith(1, true);
    expect(process.stdin.setRawMode).toHaveBeenNthCalledWith(2, false);
    expect(process.stdin.pause).toHaveBeenCalledOnce();
  });

  it("fails closed outside an interactive terminal", async () => {
    Reflect.deleteProperty(process.stdin, "isTTY");
    Reflect.deleteProperty(process.stdout, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", {
      value: false,
      configurable: true,
    });

    await expect(readHiddenPrompt("Token: ")).rejects.toMatchObject({
      message: "No interactive terminal available. Re-run with --token-stdin or set ARCANIST_TOKEN.",
    });
  });
});

describe("CLI runtime output helpers", () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  const originalApiUrl = process.env.ARCANIST_API_URL;
  const originalToken = process.env.ARCANIST_TOKEN;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    if (originalApiUrl === undefined) delete process.env.ARCANIST_API_URL;
    else process.env.ARCANIST_API_URL = originalApiUrl;
    if (originalToken === undefined) delete process.env.ARCANIST_TOKEN;
    else process.env.ARCANIST_TOKEN = originalToken;
    vi.restoreAllMocks();
  });

  it("emits JSON without calling the human printer", () => {
    const printer = vi.fn();

    emit(undefined, { json: true }, { ok: true }, printer);

    expect(stdoutSpy).toHaveBeenCalledWith('{"ok":true}\n');
    expect(printer).not.toHaveBeenCalled();
  });

  it("calls the human printer outside JSON mode", () => {
    const printer = vi.fn();

    emit(undefined, {}, { ok: true }, printer);

    expect(printer).toHaveBeenCalledWith({ ok: true });
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it("resolves merged runtime options and required config together", () => {
    process.env.ARCANIST_API_URL = "https://api.example.test/";
    process.env.ARCANIST_TOKEN = "arc_test";

    const { runtime, config } = resolveBusinessContext(undefined, { noColor: true });

    expect(runtime.noColor).toBe(true);
    expect(config).toEqual({ apiUrl: "https://api.example.test", token: "arc_test" });
  });
});

describe("read-only agent mutation guard", () => {
  const originalRole = process.env.ARCANIST_AGENT_ROLE;

  afterEach(() => {
    if (originalRole === undefined) delete process.env.ARCANIST_AGENT_ROLE;
    else process.env.ARCANIST_AGENT_ROLE = originalRole;
  });

  it.each(["verification", "review"])("blocks nested session creation for the %s role", (role) => {
    process.env.ARCANIST_AGENT_ROLE = role;
    expect(() => assertCycloidSessionMutationAllowed("create")).toThrow(
      `cycloid sessions create\` is disabled inside ${role} sessions`,
    );
  });

  it("keeps implementation session mutations available", () => {
    process.env.ARCANIST_AGENT_ROLE = "implementation";
    expect(() => assertCycloidSessionMutationAllowed("create")).not.toThrow();
  });
});
