import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const scriptPath = path.resolve(import.meta.dirname, "../../.agents/skills/prepare-skeleton/scripts/make-skeleton.mjs");

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// Each makeRepo() case needs a *distinct* initial file set and some mutate git
// state, so a single shared repo would bleed across cases. But the costly part
// (git init + the two config spawns) is identical and immutable, so we pay it
// once into a template and clone it per case with a filesystem copy. The
// case-specific add+commit still run per case; only the 3 setup spawns are saved.
let templateRepo: string;
beforeAll(() => {
  templateRepo = mkdtempSync(path.join(tmpdir(), "skeleton-template-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: templateRepo });
  execFileSync("git", ["config", "user.email", "t@t.t"], { cwd: templateRepo });
  execFileSync("git", ["config", "user.name", "t"], { cwd: templateRepo });
});
afterAll(() => rmSync(templateRepo, { recursive: true, force: true }));

type RunResult = { status: number; stdout: string; stderr: string };

function makeRepo(files: Record<string, string>): string {
  const repo = mkdtempSync(path.join(tmpdir(), "skeleton-"));
  tempDirs.push(repo);
  cpSync(templateRepo, repo, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(repo, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repo });
  return repo;
}

function run(repo: string, args: string[] = []): RunResult {
  try {
    const stdout = execFileSync("node", [scriptPath, ...args], { cwd: repo, encoding: "utf-8", stdio: "pipe" });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

const skel = (repo: string, rel: string) => path.join(repo, "cycloid-skeleton", rel);
const read = (repo: string, rel: string) => readFileSync(skel(repo, rel), "utf-8");
function manifestTreatment(repo: string, file: string): string | undefined {
  const lines = read(repo, "MANIFEST.txt")
    .split("\n")
    .filter((l) => l && !l.startsWith("#"));
  return lines.find((l) => l.endsWith(`\t${file}`))?.split("\t")[0];
}

describe("make-skeleton: guards", () => {
  it("fails outside a git repo", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "nogit-"));
    tempDirs.push(dir);
    const r = run(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("not inside a git repository");
  });

  it("refuses a dirty worktree without --allow-dirty, but skips the modified file with it", () => {
    const repo = makeRepo({ "package.json": '{"name":"x"}', "src/a.ts": "export const a = () => 1;" });
    writeFileSync(path.join(repo, "src/a.ts"), "export const a = () => 999;");
    const dirty = run(repo);
    expect(dirty.status).toBe(1);
    expect(dirty.stderr).toContain("dirty");
    const r = run(repo, ["--allow-dirty"]);
    expect(r.status).toBe(0);
    expect(manifestTreatment(repo, "src/a.ts")).toBe("skipped-dirty");
  });

  it("refuses to overwrite existing output without --force", () => {
    const repo = makeRepo({ "package.json": "{}" });
    expect(run(repo).status).toBe(0);
    const second = run(repo);
    expect(second.status).toBe(1);
    expect(second.stderr).toContain("--force");
    expect(run(repo, ["--force"]).status).toBe(0);
  });

  it("rejects invalid --redact regex (fail closed)", () => {
    const repo = makeRepo({ "package.json": "{}" });
    const r = run(repo, ["--redact", "("]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("invalid --redact regex");
  });

  it("prints help and does nothing with --help", () => {
    const repo = makeRepo({ "package.json": "{}" });
    const r = run(repo, ["--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Usage: node make-skeleton.mjs");
    expect(existsSync(path.join(repo, "cycloid-skeleton"))).toBe(false);
  });
});

describe("make-skeleton: bucket classification", () => {
  it("copies allowlisted config verbatim and stubs recognized source", () => {
    const repo = makeRepo({
      "package.json": '{"name":"x","dependencies":{"a":"1"}}',
      "tsconfig.json": '{"compilerOptions":{}}',
      ".github/workflows/ci.yml": "name: ci\non: push",
      "src/app.ts": "export function f() { return 42; }",
    });
    expect(run(repo).status).toBe(0);
    expect(manifestTreatment(repo, "package.json")).toBe("verbatim");
    expect(manifestTreatment(repo, "tsconfig.json")).toBe("verbatim");
    expect(manifestTreatment(repo, ".github/workflows/ci.yml")).toBe("verbatim");
    expect(read(repo, "package.json")).toContain('"dependencies"');
    expect(manifestTreatment(repo, "src/app.ts")).toBe("stubbed");
  });

  it("skips unrecognized text by default and includes it with --include-text", () => {
    const repo = makeRepo({ "package.json": "{}", "db/schema.sql": "CREATE TABLE secret_pricing (x int);" });
    expect(run(repo).status).toBe(0);
    expect(manifestTreatment(repo, "db/schema.sql")).toContain("skipped-text");
    expect(existsSync(skel(repo, "db/schema.sql"))).toBe(false);

    const repo2 = makeRepo({ "package.json": "{}", "db/schema.sql": "CREATE TABLE secret_pricing (x int);" });
    expect(run(repo2, ["--include-text", "db/*.sql"]).status).toBe(0);
    expect(manifestTreatment(repo2, "db/schema.sql")).toBe("stubbed");
    expect(read(repo2, "db/schema.sql")).not.toContain("secret_pricing");
  });

  it("records binaries name+size only, never content", () => {
    const repo = makeRepo({ "package.json": "{}" });
    writeFileSync(path.join(repo, "logo.bin"), Buffer.from([0x89, 0x00, 0x01, 0x02, 0x00]));
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["commit", "-q", "-m", "bin"], { cwd: repo });
    expect(run(repo).status).toBe(0);
    expect(manifestTreatment(repo, "logo.bin")).toContain("skipped-binary");
    expect(existsSync(skel(repo, "logo.bin"))).toBe(false);
  });

  it("never copies denylisted secret files", () => {
    const repo = makeRepo({
      "package.json": "{}",
      "server.pem": "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
    });
    expect(run(repo).status).toBe(0);
    expect(manifestTreatment(repo, "server.pem")).toContain("skipped-denylist");
    expect(existsSync(skel(repo, "server.pem"))).toBe(false);
  });

  it("does not follow symlinks", () => {
    const repo = makeRepo({ "package.json": "{}", "real.ts": "export const x = () => 1;" });
    symlinkSync("/etc/passwd", path.join(repo, "link.ts"));
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["commit", "-q", "-m", "link"], { cwd: repo });
    expect(run(repo).status).toBe(0);
    expect(manifestTreatment(repo, "link.ts")).toBe("skipped-symlink");
    expect(existsSync(skel(repo, "link.ts"))).toBe(false);
  });

  it("excludes paths matching --exclude", () => {
    const repo = makeRepo({ "package.json": "{}", "src/internal.ts": "export const a = () => 1;" });
    expect(run(repo, ["--exclude", "src/**"]).status).toBe(0);
    expect(manifestTreatment(repo, "src/internal.ts")).toBe("skipped-excluded");
  });
});

describe("make-skeleton: source stubbing leaks nothing", () => {
  it("removes bodies, comments, docstrings, and string/number literals across languages", () => {
    const repo = makeRepo({
      "package.json": "{}",
      "src/a.ts": [
        "import { db } from './db';",
        "// PROPRIETARY: secret ranking comment",
        "export function rank(user: string) {",
        "  const MAGIC = 'SECRET_TOKEN_VALUE';",
        "  return db.query(MAGIC) * 1337;",
        "}",
      ].join("\n"),
      "svc/calc.py": [
        "import os",
        "def compute(x):",
        '    """SECRET docstring describing the algorithm"""',
        "    factor = 'PROPRIETARY_PY'",
        "    return x * 42 + len(factor)",
      ].join("\n"),
      "svc/h.go": [
        "package svc",
        'import "fmt"',
        "func Handle() string {",
        '    secret := "GO_SECRET_LITERAL"',
        "    return fmt.Sprintf(secret)",
        "}",
      ].join("\n"),
    });
    expect(run(repo).status).toBe(0);

    const ts = read(repo, "src/a.ts");
    expect(ts).toContain("import { db }");
    expect(ts).toContain("rank");
    for (const leak of ["SECRET_TOKEN_VALUE", "PROPRIETARY", "1337", "db.query"]) expect(ts).not.toContain(leak);

    const py = read(repo, "svc/calc.py");
    expect(py).toContain("import os");
    for (const leak of ["SECRET docstring", "PROPRIETARY_PY", "42", "x *"]) expect(py).not.toContain(leak);

    const go = read(repo, "svc/h.go");
    expect(go).toContain("package svc");
    for (const leak of ["GO_SECRET_LITERAL", "fmt.Sprintf"]) expect(go).not.toContain(leak);
  });

  // Regression: a declaration keyword (type, func, val, get...) appearing MID-LINE inside a body
  // statement must not cause that line to survive. Caught in E2E against gorilla/mux and ky.
  it("drops body statements even when they contain declaration keywords", () => {
    const repo = makeRepo({
      "package.json": "{}",
      "src/b.ts": [
        "export function pick(type: string) {",
        "  return response[type]();", // contains `type` — must be dropped
        "}",
      ].join("\n"),
      "svc/mw.go": [
        "package svc",
        "func Wrap(h Handler) Handler {",
        "  return http.HandlerFunc(func(w Writer, r *Request) {", // contains `func` — must drop
        "    secretRoutingLogic(w, r)",
        "  })",
        "}",
      ].join("\n"),
    });
    expect(run(repo).status).toBe(0);

    const ts = read(repo, "src/b.ts");
    expect(ts).toContain("pick"); // signature kept
    expect(ts).not.toContain("response["); // body dropped despite `type`

    const go = read(repo, "svc/mw.go");
    expect(go).toContain("func Wrap"); // signature kept
    for (const leak of ["HandlerFunc", "secretRoutingLogic"]) expect(go).not.toContain(leak);
  });

  // Regression: arrow-assigned function bodies must not leak (the signature collapsing to
  // `const handler` is acceptable; the body must be gone).
  it("drops arrow-function bodies", () => {
    const repo = makeRepo({
      "package.json": "{}",
      "src/c.ts": ["export const handler = (a: number) => {", "  return proprietaryCalc(a) * 7;", "};"].join("\n"),
    });
    expect(run(repo).status).toBe(0);
    const ts = read(repo, "src/c.ts");
    expect(ts).toContain("handler");
    for (const leak of ["proprietaryCalc", "* 7", "return "]) expect(ts).not.toContain(leak);
  });

  // Regression: import lines keep the module path but must strip embedded credentials.
  it("scrubs embedded credentials from kept import lines", () => {
    const repo = makeRepo({
      "package.json": "{}",
      "src/d.ts": "import x from 'https://user:s3cr3tTok@registry.internal/pkg';",
    });
    expect(run(repo).status).toBe(0);
    const ts = read(repo, "src/d.ts");
    expect(ts).toContain("import x from"); // path/import kept
    expect(ts).not.toContain("s3cr3tTok"); // embedded credential scrubbed
  });
});

describe("make-skeleton: secret redaction + gate", () => {
  it("redacts token assignments, PEM, JWT, and url creds in verbatim files", () => {
    const repo = makeRepo({
      "package.json": "{}",
      ".npmrc": "//registry.example.com/:_authToken=npm_REALSECRETvalue123",
      "docker-compose.yml": [
        "services:",
        "  db:",
        "    environment:",
        "      DATABASE_PASSWORD: hunter2supersecret",
        "      DATABASE_URL: postgres://user:p4ssw0rd@host/db",
      ].join("\n"),
    });
    expect(run(repo).status).toBe(0);
    const npmrc = read(repo, ".npmrc");
    expect(npmrc).toContain("__REDACTED__");
    expect(npmrc).not.toContain("npm_REALSECRETvalue123");
    const compose = read(repo, "docker-compose.yml");
    expect(compose).not.toContain("hunter2supersecret");
    expect(compose).not.toContain("p4ssw0rd");
    expect(compose).toContain("user:__REDACTED__@");
  });

  // Regression: npm `_auth` basic-auth key, Compose list-form env (`- KEY=val`), and Dockerfile
  // `ENV KEY=val` were not classified as secret-named, leaking verbatim.
  it("redacts npm _auth, Compose list-form env, and Dockerfile ENV secrets", () => {
    const repo = makeRepo({
      "package.json": "{}",
      ".npmrc": "_auth=dXNlcjpwYXNzd29yZA==\n//registry/:_password=c7Hk2",
      "docker-compose.yml": ["services:", "  db:", "    environment:", "      - DB_PASSWORD=listsecret"].join("\n"),
      Dockerfile: "FROM node:20\nENV API_SECRET=dockerenvsecret\n",
    });
    expect(run(repo).status).toBe(0);
    const npmrc = read(repo, ".npmrc");
    expect(npmrc).not.toContain("dXNlcjpwYXNzd29yZA==");
    expect(npmrc).not.toContain("c7Hk2");
    expect(read(repo, "docker-compose.yml")).not.toContain("listsecret");
    expect(read(repo, "Dockerfile")).not.toContain("dockerenvsecret");
  });

  it("blocks the zip on residual high-entropy content unless --accept-redactions", () => {
    const repo = makeRepo({
      "package.json": "{}",
      // High-entropy token under a non-secret-named key in a VERBATIM (allowlisted) file →
      // redaction misses it (key isn't secret-named), the residual-entropy gate catches it.
      Dockerfile: "FROM node:20\nENV BUILD_HASH=AbCdEf0123456789GhIjKlMnOpQrStUvWxYz0123456789ZZ\n",
    });
    const blocked = run(repo);
    expect(blocked.status).toBe(2);
    expect(blocked.stderr).toContain("residual secret-like content");
    expect(existsSync(path.join(repo, "cycloid-skeleton.zip"))).toBe(false);
    // Directory + manifest still produced for review.
    expect(existsSync(skel(repo, "MANIFEST.txt"))).toBe(true);

    const accepted = run(repo, ["--force", "--accept-redactions", "--no-zip"]);
    expect(accepted.status).toBe(0);
  });
});

describe("make-skeleton: env handling", () => {
  it("captures tracked env keys only, never values; ignores untracked unless --scan-local-env", () => {
    const repo = makeRepo({ "package.json": "{}", ".env.example": "API_KEY=placeholder\nDB_HOST=localhost" });
    // Untracked real env on disk:
    writeFileSync(path.join(repo, ".env"), "REAL_SECRET=do_not_read_me");
    expect(run(repo).status).toBe(0);
    const keys = read(repo, "env-keys.txt");
    expect(keys).toContain("API_KEY");
    expect(keys).toContain("DB_HOST");
    expect(keys).not.toContain("placeholder");
    expect(keys).not.toContain("REAL_SECRET");
    expect(manifestTreatment(repo, ".env.example")).toBe("keys-only");

    const r2 = run(repo, ["--force", "--scan-local-env"]);
    expect(r2.status).toBe(0);
    const keys2 = read(repo, "env-keys.txt");
    expect(keys2).toContain("REAL_SECRET");
    expect(keys2).not.toContain("do_not_read_me");
  });

  // Regression: --scan-local-env must not follow symlinked .env files (could read host files).
  it("does not follow symlinked untracked .env under --scan-local-env", () => {
    const repo = makeRepo({ "package.json": "{}" });
    symlinkSync("/etc/passwd", path.join(repo, ".env"));
    const r = run(repo, ["--scan-local-env"]);
    expect(r.status).toBe(0);
    expect(manifestTreatment(repo, ".env")).toBe("skipped-symlink-untracked");
    expect(read(repo, "env-keys.txt")).not.toContain("root:");
  });
});

describe("make-skeleton: dirty guard parses renames", () => {
  it("skips a renamed (uncommitted) tracked file under --allow-dirty", () => {
    const repo = makeRepo({ "package.json": "{}", "src/old-name.ts": "export const x = () => 1;" });
    execFileSync("git", ["mv", "src/old-name.ts", "src/new-name.ts"], { cwd: repo });
    // Without --allow-dirty the rename makes the worktree dirty → refuse.
    expect(run(repo).status).toBe(1);
    // With --allow-dirty the renamed (new) path is treated as dirty and skipped, not copied.
    const r = run(repo, ["--allow-dirty"]);
    expect(r.status).toBe(0);
    expect(manifestTreatment(repo, "src/new-name.ts")).toBe("skipped-dirty");
    expect(existsSync(skel(repo, "src/new-name.ts"))).toBe(false);
  });
});

describe("make-skeleton: stats + manifest", () => {
  it("emits repo-stats.json and a manifest noting path disclosure", () => {
    const repo = makeRepo({
      "package.json": '{"dependencies":{"a":"1","b":"2"}}',
      "src/a.ts": "export const a = () => 1;",
    });
    expect(run(repo).status).toBe(0);
    const stats = JSON.parse(read(repo, "repo-stats.json"));
    expect(stats.trackedFiles).toBeGreaterThan(0);
    expect(stats.totalBytes).toBeGreaterThan(0);
    expect(stats.lockfileDeps["package.json"]).toBe(2);
    expect(read(repo, "MANIFEST.txt")).toContain("path disclosure");
  });
});
