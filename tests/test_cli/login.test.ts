import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// We test config.ts functions directly. Because they use hardcoded paths via
// homedir(), we mock `node:os` to redirect to a temp directory.
// ---------------------------------------------------------------------------

const testDir = join(tmpdir(), `cycloid-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => testDir };
});

type ConfigModule = {
  loadConfig: (overrides?: {
    apiUrl?: string;
    token?: string;
    json?: boolean;
  }) => { apiUrl: string; token: string } | null;
  loadProjectConfig: (cwd?: string) => { apiUrl: string; token: string } | null;
  saveConfig: (config: { apiUrl: string; token: string }) => void;
  validateApiUrl: (url: string) => string | null;
};

let mod: ConfigModule;
const originalCycloidApiUrl = process.env.ARCANIST_API_URL;
const originalCycloidToken = process.env.ARCANIST_TOKEN;
const originalCwd = process.cwd();

describe("config", () => {
  beforeEach(async () => {
    // Fresh temp dir for each test
    mkdirSync(testDir, { recursive: true });
    process.chdir(testDir);
    delete process.env.ARCANIST_API_URL;
    delete process.env.ARCANIST_TOKEN;
    const modulePath: string = "../../apps/cli/src/config";
    mod = (await import(modulePath)) as unknown as ConfigModule;
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(testDir, { recursive: true, force: true });

    if (originalCycloidApiUrl === undefined) {
      delete process.env.ARCANIST_API_URL;
    } else {
      process.env.ARCANIST_API_URL = originalCycloidApiUrl;
    }

    if (originalCycloidToken === undefined) {
      delete process.env.ARCANIST_TOKEN;
    } else {
      process.env.ARCANIST_TOKEN = originalCycloidToken;
    }
  });

  // -------------------------------------------------------------------------
  // loadConfig
  // -------------------------------------------------------------------------
  describe("loadConfig", () => {
    it("returns null when config file does not exist", () => {
      expect(mod.loadConfig()).toBeNull();
    });

    it("returns parsed config when file exists", () => {
      const configDir = join(testDir, ".cycloid");
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, "config.json"),
        JSON.stringify({ apiUrl: "https://app.trycycloid.com", token: "arc_test123" }),
      );
      const result = mod.loadConfig();
      expect(result).toEqual({ apiUrl: "https://app.trycycloid.com", token: "arc_test123" });
    });

    it("normalizes a stored API URL with trailing slashes", () => {
      const configDir = join(testDir, ".cycloid");
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, "config.json"),
        JSON.stringify({ apiUrl: "https://app.trycycloid.com///", token: "arc_test123" }),
      );

      expect(mod.loadConfig()).toEqual({ apiUrl: "https://app.trycycloid.com", token: "arc_test123" });
    });

    it("returns null for malformed JSON", () => {
      const configDir = join(testDir, ".cycloid");
      mkdirSync(configDir, { recursive: true });
      writeFileSync(join(configDir, "config.json"), "not-json{{{");
      expect(mod.loadConfig()).toBeNull();
    });

    it("uses nearest project config before global config inside a git worktree", () => {
      writeGlobalConfig({ apiUrl: "https://app.trycycloid.com", token: "arc_global" });
      const root = makeGitRepo("project-nearest");
      const nested = join(root, "packages", "cli");
      mkdirSync(nested, { recursive: true });
      writeProjectConfig(root, { apiUrl: "http://localhost:3000", token: "arc_root" });
      writeProjectConfig(join(root, "packages"), { apiUrl: "http://127.0.0.1:3001", token: "arc_nearest" });

      process.chdir(nested);

      expect(mod.loadConfig({ json: true })).toEqual({ apiUrl: "http://127.0.0.1:3001", token: "arc_nearest" });
    });

    it("discovers project config from a linked worktree gitdir file", () => {
      writeGlobalConfig({ apiUrl: "https://app.trycycloid.com", token: "arc_global" });
      const root = makeLinkedGitWorktree("linked-worktree");
      writeProjectConfig(root, { apiUrl: "http://localhost:3000", token: "arc_project" });

      process.chdir(root);

      expect(mod.loadProjectConfig()).toEqual({ apiUrl: "http://localhost:3000", token: "arc_project" });
      expect(mod.loadConfig({ json: true })).toEqual({ apiUrl: "http://localhost:3000", token: "arc_project" });
    });

    it("falls through to global config when project config is absent", () => {
      writeGlobalConfig({ apiUrl: "https://app.trycycloid.com", token: "arc_global" });
      const root = makeGitRepo("project-absent");
      const nested = join(root, "nested");
      mkdirSync(nested, { recursive: true });

      process.chdir(nested);

      expect(mod.loadConfig()).toEqual({ apiUrl: "https://app.trycycloid.com", token: "arc_global" });
    });

    it("does not discover project config above the git root", () => {
      writeGlobalConfig({ apiUrl: "https://app.trycycloid.com", token: "arc_global" });
      const parent = join(testDir, "parent-config");
      const root = join(parent, "repo");
      const nested = join(root, "nested");
      mkdirSync(nested, { recursive: true });
      mkdirSync(join(root, ".git"), { recursive: true });
      writeProjectConfig(parent, { apiUrl: "http://localhost:3000", token: "arc_parent" });

      process.chdir(nested);

      expect(mod.loadProjectConfig()).toBeNull();
      expect(mod.loadConfig()).toEqual({ apiUrl: "https://app.trycycloid.com", token: "arc_global" });
    });

    it("skips project discovery outside a git repo when an ancestor has an invalid .git marker", () => {
      writeGlobalConfig({ apiUrl: "https://app.trycycloid.com", token: "arc_global" });
      const invalidGitParent = join(testDir, "invalid-git-parent");
      mkdirSync(join(invalidGitParent, ".git"), { recursive: true });
      const dir = join(invalidGitParent, "not-a-repo");
      mkdirSync(dir, { recursive: true });
      writeProjectConfig(dir, { apiUrl: "http://localhost:3000", token: "arc_project" });

      process.chdir(dir);

      expect(mod.loadProjectConfig()).toBeNull();
      expect(mod.loadConfig()).toEqual({ apiUrl: "https://app.trycycloid.com", token: "arc_global" });
    });

    it("fails closed when project config is malformed", () => {
      writeGlobalConfig({ apiUrl: "https://app.trycycloid.com", token: "arc_global" });
      const root = makeGitRepo("malformed-project");
      writeFileSync(join(root, ".cycloid-cli.json"), "not-json{{{");

      process.chdir(root);

      expect(() => mod.loadConfig()).toThrow(".cycloid-cli.json is not valid JSON.");
    });

    it("fails closed when project config is missing token", () => {
      writeGlobalConfig({ apiUrl: "https://app.trycycloid.com", token: "arc_global" });
      const root = makeGitRepo("missing-token-project");
      writeFileSync(join(root, ".cycloid-cli.json"), JSON.stringify({ apiUrl: "http://localhost:3000" }));

      process.chdir(root);

      expect(() => mod.loadConfig()).toThrow(".cycloid-cli.json must contain both apiUrl and token.");
    });

    it("fails closed when project config points at a non-loopback host", () => {
      writeGlobalConfig({ apiUrl: "https://app.trycycloid.com", token: "arc_global" });
      const root = makeGitRepo("remote-project");
      writeProjectConfig(root, { apiUrl: "https://attacker.example", token: "arc_project" });

      process.chdir(root);

      expect(() => mod.loadConfig()).toThrow(".cycloid-cli.json apiUrl must be a loopback host.");
    });

    it("uses complete env overrides before parsing project config", () => {
      const root = makeGitRepo("malformed-project-with-env");
      writeFileSync(join(root, ".cycloid-cli.json"), "not-json{{{");
      process.chdir(root);

      process.env.ARCANIST_API_URL = "https://app.trycycloid.com";
      process.env.ARCANIST_TOKEN = "arc_env";

      expect(mod.loadConfig()).toEqual({ apiUrl: "https://app.trycycloid.com", token: "arc_env" });
    });

    it("allows env to override project config only when api URL and token are both set", () => {
      const root = makeGitRepo("project-env-unit");
      writeProjectConfig(root, { apiUrl: "http://localhost:3000", token: "arc_project" });
      process.chdir(root);

      process.env.ARCANIST_API_URL = "https://app.trycycloid.com";
      expect(() => mod.loadConfig()).toThrow(".cycloid-cli.json is active");

      process.env.ARCANIST_TOKEN = "arc_env";
      expect(mod.loadConfig()).toEqual({ apiUrl: "https://app.trycycloid.com", token: "arc_env" });
    });

    it("allows flag overrides to override project config only when api URL and token are both set", () => {
      const root = makeGitRepo("project-flag-unit");
      writeProjectConfig(root, { apiUrl: "http://localhost:3000", token: "arc_project" });
      process.chdir(root);

      expect(() => mod.loadConfig({ apiUrl: "https://app.trycycloid.com" })).toThrow(".cycloid-cli.json is active");
      expect(mod.loadConfig({ apiUrl: "https://app.trycycloid.com", token: "arc_flag" })).toEqual({
        apiUrl: "https://app.trycycloid.com",
        token: "arc_flag",
      });
    });

    it("keeps single-field env overrides working when no project config is present", () => {
      writeGlobalConfig({ apiUrl: "https://app.trycycloid.com", token: "arc_global" });
      const dir = join(testDir, "single-field-env-outside-repo");
      mkdirSync(dir, { recursive: true });
      process.chdir(dir);
      process.env.ARCANIST_API_URL = "https://api.example.com";

      expect(mod.loadConfig()).toEqual({ apiUrl: "https://api.example.com", token: "arc_global" });
    });

    it("prints a stderr notice when project config is active outside JSON mode", () => {
      const root = makeGitRepo("project-notice");
      writeProjectConfig(root, { apiUrl: "http://localhost:3000", token: "arc_project" });
      process.chdir(root);
      const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      expect(mod.loadConfig()).toEqual({ apiUrl: "http://localhost:3000", token: "arc_project" });

      expect(writeSpy).toHaveBeenCalledWith("using .cycloid-cli.json -> http://localhost:3000\n");
      writeSpy.mockRestore();
    });

    it("suppresses the project config stderr notice in JSON mode", () => {
      const root = makeGitRepo("project-json-notice");
      writeProjectConfig(root, { apiUrl: "http://localhost:3000", token: "arc_project" });
      process.chdir(root);
      const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      expect(mod.loadConfig({ json: true })).toEqual({ apiUrl: "http://localhost:3000", token: "arc_project" });

      expect(writeSpy).not.toHaveBeenCalled();
      writeSpy.mockRestore();
    });
  });

  // -------------------------------------------------------------------------
  // saveConfig
  // -------------------------------------------------------------------------
  describe("saveConfig", () => {
    it("creates config directory and file", () => {
      mod.saveConfig({ apiUrl: "https://app.trycycloid.com", token: "arc_abc" });
      const configFile = join(testDir, ".cycloid", "config.json");
      expect(existsSync(configFile)).toBe(true);
      const content = JSON.parse(readFileSync(configFile, "utf-8"));
      expect(content.apiUrl).toBe("https://app.trycycloid.com");
      expect(content.token).toBe("arc_abc");
    });

    it("normalizes API URL before saving", () => {
      mod.saveConfig({ apiUrl: "https://app.trycycloid.com///", token: "arc_abc" });
      const content = JSON.parse(readFileSync(join(testDir, ".cycloid", "config.json"), "utf-8"));
      expect(content.apiUrl).toBe("https://app.trycycloid.com");
    });

    it("sets 0o700 permissions on config directory", () => {
      mod.saveConfig({ apiUrl: "https://app.trycycloid.com", token: "arc_abc" });
      const configDir = join(testDir, ".cycloid");
      const dirStat = statSync(configDir);
      // mode includes file type bits; mask to just permission bits
      expect(dirStat.mode & 0o777).toBe(0o700);
    });

    it("sets 0o600 permissions on config file", () => {
      mod.saveConfig({ apiUrl: "https://app.trycycloid.com", token: "arc_abc" });
      const configFile = join(testDir, ".cycloid", "config.json");
      const fileStat = statSync(configFile);
      expect(fileStat.mode & 0o777).toBe(0o600);
    });

    it("overwrites existing config", () => {
      mod.saveConfig({ apiUrl: "https://old.com", token: "arc_old" });
      mod.saveConfig({ apiUrl: "https://new.com", token: "arc_new" });
      const content = JSON.parse(readFileSync(join(testDir, ".cycloid", "config.json"), "utf-8"));
      expect(content.apiUrl).toBe("https://new.com");
      expect(content.token).toBe("arc_new");
    });
  });

  // -------------------------------------------------------------------------
  // validateApiUrl
  // -------------------------------------------------------------------------
  describe("validateApiUrl", () => {
    it("accepts HTTPS URLs", () => {
      expect(mod.validateApiUrl("https://app.trycycloid.com")).toBeNull();
    });

    it("accepts HTTPS with port", () => {
      expect(mod.validateApiUrl("https://example.com:3000")).toBeNull();
    });

    it("rejects HTTP for non-local hosts", () => {
      const err = mod.validateApiUrl("http://app.trycycloid.com");
      expect(err).toBe("API URL must use HTTPS for non-local hosts");
    });

    it("rejects URLs with embedded credentials", () => {
      const err = mod.validateApiUrl("https://user:secret@app.trycycloid.com");
      expect(err).toBe("API URL must not include embedded credentials. Use --token or ARCANIST_TOKEN to authenticate.");
    });

    it("rejects URLs with embedded username only", () => {
      const err = mod.validateApiUrl("https://user@app.trycycloid.com");
      expect(err).toBe("API URL must not include embedded credentials. Use --token or ARCANIST_TOKEN to authenticate.");
    });

    it("rejects URLs with embedded password only", () => {
      const err = mod.validateApiUrl("https://:secret@app.trycycloid.com");
      expect(err).toBe("API URL must not include embedded credentials. Use --token or ARCANIST_TOKEN to authenticate.");
    });

    it("allows HTTP for localhost", () => {
      expect(mod.validateApiUrl("http://localhost:3000")).toBeNull();
    });

    it("allows HTTP for 127.0.0.1", () => {
      expect(mod.validateApiUrl("http://127.0.0.1:3000")).toBeNull();
    });

    it("allows HTTP for ::1", () => {
      expect(mod.validateApiUrl("http://[::1]:3000")).toBeNull();
    });

    it("rejects invalid URL format", () => {
      const err = mod.validateApiUrl("not-a-url");
      expect(err).toBe("Invalid URL format");
    });

    it("rejects empty string", () => {
      const err = mod.validateApiUrl("");
      expect(err).toBe("Invalid URL format");
    });
  });
});

function writeGlobalConfig(config: { apiUrl: string; token: string }): void {
  const configDir = join(testDir, ".cycloid");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "config.json"), JSON.stringify(config));
}

function makeGitRepo(name: string): string {
  const root = join(testDir, name);
  mkdirSync(join(root, ".git"), { recursive: true });
  writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(root, ".git", "config"), "[core]\nrepositoryformatversion = 0\n");
  return root;
}

function makeLinkedGitWorktree(name: string): string {
  const root = join(testDir, name);
  const gitDir = join(testDir, `${name}-gitdir`);
  mkdirSync(root, { recursive: true });
  mkdirSync(gitDir, { recursive: true });
  writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(root, ".git"), `gitdir: ${gitDir}\n`);
  return root;
}

function writeProjectConfig(dir: string, config: { apiUrl: string; token: string }): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".cycloid-cli.json"), JSON.stringify(config));
}
