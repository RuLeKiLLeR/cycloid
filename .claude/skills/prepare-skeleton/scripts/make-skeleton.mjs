#!/usr/bin/env node
// make-skeleton.mjs — emit an IP-safe skeleton + manifest of a git repo.
//
// Single file, Node built-ins only (Node 18+). Run at the root of a git repo:
//   node make-skeleton.mjs [flags]
//
// Produces ./cycloid-skeleton/ (and ./cycloid-skeleton.zip unless --no-zip or
// `zip` is unavailable). Classifies every tracked path into exactly one bucket;
// anything unrecognized is skipped, never copied. See SKILL.md for the runbook.

import { execFileSync, spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

const OUTPUT_DIR = "cycloid-skeleton";
const ZIP_NAME = "cycloid-skeleton.zip";
const PER_FILE_BYTE_CAP = 2 * 1024 * 1024; // 2 MiB; larger tracked files are recorded name+size only.
const REDACTED = "__REDACTED__";

// --- Bucket 1: verbatim config allowlist (matched against the basename) -----
const CONFIG_ALLOWLIST = [
  "package.json",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "npm-shrinkwrap.json",
  "tsconfig*.json",
  "jsconfig.json",
  ".nvmrc",
  ".node-version",
  "requirements*.txt",
  "Pipfile",
  "Pipfile.lock",
  "pyproject.toml",
  "poetry.lock",
  "setup.cfg",
  "setup.py",
  "go.mod",
  "go.sum",
  "Cargo.toml",
  "Cargo.lock",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
  "gradle.properties",
  "Gemfile",
  "Gemfile.lock",
  "*.csproj",
  "*.sln",
  "packages.config",
  "composer.json",
  "composer.lock",
  "Dockerfile*",
  "docker-compose*.yml",
  "docker-compose*.yaml",
  "Makefile",
  "*.mk",
  "turbo.json",
  "nx.json",
  "lerna.json",
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
];
// Allowlisted by full relative path prefix/glob (CI config lives in nested dirs).
const CONFIG_PATH_GLOBS = [
  ".github/workflows/*.yml",
  ".github/workflows/*.yaml",
  ".gitlab-ci.yml",
  ".circleci/config.yml",
];

// --- Bucket 2: recognized source extensions -> language ---------------------
const SOURCE_LANGS = {
  ".ts": "ts",
  ".tsx": "ts",
  ".js": "ts",
  ".jsx": "ts",
  ".mjs": "ts",
  ".cjs": "ts",
  ".py": "py",
  ".go": "go",
  ".java": "c",
  ".kt": "c",
  ".kts": "c",
  ".rb": "rb",
  ".rs": "c",
  ".cs": "c",
};

// --- Never-verbatim secret-file denylist (recorded name only) ---------------
const SECRET_FILE_GLOBS = [
  "*.pem",
  "*.key",
  "id_rsa*",
  "*.p12",
  "*.pfx",
  "*.keystore",
  "*.tfvars",
  "credentials.json",
  "*service-account*.json",
  "*serviceaccount*.json",
];

// --- Secret value detection -------------------------------------------------
const SECRET_KEY =
  /(_?auth_?token|_auth|passwd|password|secret|api[_-]?key|access[_-]?key|client[_-]?secret|aws_(?:access|secret)[_-]?key(?:_id)?|private[_-]?key|credential|bearer)/i;
// Two assignment shapes: `key = value` and `key: value`. The leading-token group tolerates a
// YAML list marker (`- KEY=val` in Compose `environment:` lists) and Dockerfile `ENV`/`ARG`
// prefixes so secret-named keys in those forms are still redacted. The key is captured
// separately so only secret-named keys get their value redacted; the key may contain :/@,
// e.g. `//registry/:_authToken=...`.
const ASSIGN_EQ = /^(\s*(?:-\s+)?(?:export\s+|set\s+|ENV\s+|ARG\s+)?(\S+?)\s*=\s*)(.+?)\s*$/;
const ASSIGN_COLON = /^(\s*(?:-\s+)?["']?([\w.\-]+)["']?\s*:\s*)(\S.*?)\s*$/;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g;
const URL_CREDS = /\b([a-z][a-z0-9+.\-]*:\/\/)([^/\s:@]+):([^/\s@]+)@/gi;
const PEM_BLOCK = /-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g;
// A long token built from >=3 character classes; used for the residual-entropy gate.
const HIGH_ENTROPY = /\b(?=[\w+/=.\-]{40,}\b)(?=.*[a-z])(?=.*[A-Z0-9])[\w+/=.\-]{40,}\b/g;
// Lockfiles are full of integrity hashes (high entropy, not secrets); skip the residual gate
// on them and still redact any real credentials they embed.
const LOCKFILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "Cargo.lock",
  "poetry.lock",
  "Pipfile.lock",
  "composer.lock",
  "Gemfile.lock",
  "go.sum",
]);

function log(msg) {
  process.stdout.write(`${msg}\n`);
}
function fail(msg) {
  process.stderr.write(`make-skeleton: ${msg}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const opts = {
    exclude: [],
    redact: [],
    includeText: [],
    scanLocalEnv: false,
    allowDirty: false,
    acceptRedactions: false,
    force: false,
    noZip: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const takeValue = () => {
      const v = argv[++i];
      if (v === undefined) fail(`flag ${a} requires a value`);
      return v;
    };
    switch (a) {
      case "--exclude":
        opts.exclude.push(takeValue());
        break;
      case "--redact":
        opts.redact.push(takeValue());
        break;
      case "--include-text":
        opts.includeText.push(takeValue());
        break;
      case "--scan-local-env":
        opts.scanLocalEnv = true;
        break;
      case "--allow-dirty":
        opts.allowDirty = true;
        break;
      case "--accept-redactions":
        opts.acceptRedactions = true;
        break;
      case "--force":
        opts.force = true;
        break;
      case "--no-zip":
        opts.noZip = true;
        break;
      case "-h":
      case "--help":
        opts.help = true;
        break;
      default:
        fail(`unknown flag: ${a} (try --help)`);
    }
  }
  // Validate user regexes early so we fail closed on bad input.
  opts.redactCompiled = opts.redact.map((p) => {
    try {
      return new RegExp(p);
    } catch {
      return fail(`invalid --redact regex: ${p}`);
    }
  });
  return opts;
}

const HELP = `make-skeleton.mjs — emit an IP-safe skeleton + manifest of a git repo.

Usage: node make-skeleton.mjs [flags]   (run at the repo root)

Flags:
  --exclude <glob>        Skip tracked paths matching <glob> (repeatable).
  --redact <regex>        Extra value-redaction pattern (repeatable).
  --include-text <glob>   Opt otherwise-skipped text files into stubbing (repeatable).
  --scan-local-env        Also read keys (never values) from untracked local .env* files.
  --allow-dirty           Allow running with a dirty worktree (modified tracked files are skipped).
  --accept-redactions     Produce the zip even if residual secret-like content was flagged.
  --force                 Overwrite an existing ${OUTPUT_DIR}/ or ${ZIP_NAME}.
  --no-zip                Emit the directory only; do not create a zip.
  -h, --help              Show this help.

Output: ${OUTPUT_DIR}/ with MANIFEST.txt, repo-stats.json, env-keys.txt, and the
skeleton tree. Review MANIFEST.txt + env-keys.txt before sending.`;

// --- glob helpers -----------------------------------------------------------
function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}
const matchesAny = (value, globs) => globs.some((g) => globToRegExp(g).test(value));

function git(repoRoot, args) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf-8", maxBuffer: 256 * 1024 * 1024 });
}

function isBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

// --- comment + literal scrubbing for kept stub lines ------------------------
function stripComments(text) {
  let out = text.replace(/\/\*[\s\S]*?\*\//g, ""); // block comments
  out = out.replace(/^[ \t]*('''|""")[\s\S]*?\1[ \t]*$/gm, ""); // python docstrings on their own lines
  return out
    .split("\n")
    .map((line) => line.replace(/(^|\s)(\/\/|#).*$/, "$1").replace(/[ \t]+$/, ""))
    .join("\n");
}
function scrubLiterals(line) {
  return line
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``")
    .replace(/\b\d[\d_.eE+-]*\b/g, "0");
}

// Import lines are kept whole (module paths are not IP). Matched on the FIRST token only.
const IMPORT_LINE =
  /^\s*(import\b|from\s+\S+\s+import\b|#include\b|using\s+\S|package\s+\S|require\s|require\(|extern\s+crate\b)/;
// A declaration keyword must be the FIRST token of the line — not appear anywhere in it.
// Anchoring here is load-bearing: body statements like `return foo(type)` contain keywords
// (`type`, `func`) mid-line; matching those would leak the body. First-token matching drops them.
const DECL_START =
  /^\s*(@|export\b|public\b|private\b|protected\b|internal\b|abstract\b|static\b|final\b|open\b|sealed\b|data\b|companion\b|override\b|func\b|function\b|fn\b|fun\b|def\b|class\b|interface\b|type\b|struct\b|enum\b|trait\b|impl\b|object\b|extension\b|module\b|namespace\b|val\b|var\b|let\b|const\b|async\b|get\b|set\b|constructor\b|sub\b|void\b|pub\b|mod\b|use\b)/;

// Import lines keep their module path (path disclosure, already documented) but must not carry
// embedded credentials. Strip url creds / JWTs / high-entropy tokens while leaving the path.
function scrubImportSecrets(line) {
  return line
    .replace(URL_CREDS, (_m, proto, user) => `${proto}${user}:${REDACTED}@`)
    .replace(JWT, REDACTED)
    .replace(HIGH_ENTROPY, REDACTED);
}

// Keep a declaration's header up to the first body opener, then scrub literals. `=` is treated
// as an assignment cut only when it precedes any `(`, so parameter defaults like `def f(a=5)`
// keep their signature (the literal is still scrubbed) instead of being chopped mid-parameter.
function stubLine(line) {
  let cut = line.length;
  const brace = line.indexOf("{");
  const arrow = line.indexOf("=>");
  const paren = line.indexOf("(");
  const eq = line.indexOf("=");
  if (brace !== -1) cut = Math.min(cut, brace);
  if (arrow !== -1) cut = Math.min(cut, arrow);
  // Cut at `=` only for plain assignments (no `=>` on the RHS) so arrow-function parameter
  // signatures like `const f = (a) => {...}` are preserved (the body after `=>` is still cut).
  // Literals in the kept portion are scrubbed below regardless.
  const rhsHasArrow = eq !== -1 && line.slice(eq + 1).includes("=>");
  if (eq !== -1 && !rhsHasArrow && (paren === -1 || eq < paren)) cut = Math.min(cut, eq);
  return scrubLiterals(line.slice(0, cut)).replace(/\s+$/, "");
}

// Fail-safe stub: the default action for every line is DROP. Only import lines and lines whose
// FIRST token is a declaration keyword survive; declarations are truncated to their header and
// have literals scrubbed. Bodies, nested closures, statements, comments, and docstrings are
// never emitted, so no logic leaks.
function stubSource(text) {
  const cleaned = stripComments(text);
  const kept = [];
  for (const raw of cleaned.split("\n")) {
    const line = raw.replace(/[ \t]+$/, "");
    if (line.trim() === "") continue;
    if (IMPORT_LINE.test(line)) kept.push(scrubImportSecrets(line));
    else if (DECL_START.test(line)) kept.push(stubLine(line));
  }
  return `// Stubbed by make-skeleton: imports + signatures only, bodies removed.\n${kept.join("\n")}\n`;
}

// --- secret redaction -------------------------------------------------------
function redact(text, extraPatterns, scanResidual) {
  let redactions = 0;
  const bump = (m) => {
    redactions++;
    return m;
  };
  let out = text.replace(PEM_BLOCK, () => bump(`-----BEGIN REDACTED-----\n${REDACTED}\n-----END REDACTED-----`));
  out = out.replace(JWT, () => bump(REDACTED));
  out = out.replace(URL_CREDS, (_m, proto, user) => bump(`${proto}${user}:${REDACTED}@`));
  out = out
    .split("\n")
    .map((line) => {
      const eq = line.match(ASSIGN_EQ);
      if (eq && SECRET_KEY.test(eq[2])) {
        redactions++;
        return `${eq[1]}${REDACTED}`;
      }
      const colon = line.match(ASSIGN_COLON);
      if (colon && SECRET_KEY.test(colon[2])) {
        redactions++;
        return `${colon[1]}${REDACTED}`;
      }
      let l = line;
      for (const re of extraPatterns) {
        l = l.replace(new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`), () => bump(REDACTED));
      }
      return l;
    })
    .join("\n");
  // Residual high-entropy tokens after redaction are flagged for human review. Integrity
  // hashes (pure hex, `sha256-`/`sha512-` prefixes) are not secrets and are excluded.
  let residualCount = 0;
  if (scanResidual) {
    residualCount = (out.match(HIGH_ENTROPY) || []).filter(
      (t) => t !== REDACTED && !/^[0-9a-f]{32,}$/i.test(t) && !/^sha\d+-/i.test(t),
    ).length;
  }
  return { out, redactions, residualCount };
}

function basename(p) {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}
function extname(p) {
  const b = basename(p);
  const i = b.lastIndexOf(".");
  return i <= 0 ? "" : b.slice(i);
}

function classify(relPath, opts) {
  const base = basename(relPath);
  if (matchesAny(base, SECRET_FILE_GLOBS)) return "skipped-denylist";
  if (/^\.env(\..+)?$/.test(base)) return "env";
  if (matchesAny(base, CONFIG_ALLOWLIST) || matchesAny(relPath, CONFIG_PATH_GLOBS)) return "verbatim";
  if (extname(relPath) in SOURCE_LANGS) return "stubbed";
  if (opts.includeText.length && matchesAny(relPath, opts.includeText)) return "stubbed";
  return "skipped-text";
}

function writeOut(outRoot, relPath, content) {
  const dest = join(outRoot, relPath);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, content);
}

function countDeps(base, text) {
  try {
    if (base === "package.json") {
      const j = JSON.parse(text);
      return Object.keys(j.dependencies || {}).length + Object.keys(j.devDependencies || {}).length;
    }
    if (base === "package-lock.json") return Object.keys(JSON.parse(text).packages || {}).length;
    // yarn.lock entries start at column 0; scoped packages begin with `"` (e.g. `"@scope/x@^1":`).
    if (base === "yarn.lock") return (text.match(/^[^\s#].*:$/gm) || []).length;
    // Pipfile.lock is JSON (default + develop maps); Cargo.lock/poetry.lock are TOML.
    if (base === "Pipfile.lock") {
      const j = JSON.parse(text);
      return Object.keys(j.default || {}).length + Object.keys(j.develop || {}).length;
    }
    if (base === "Cargo.lock" || base === "poetry.lock") return (text.match(/^\[\[package\]\]/gm) || []).length;
  } catch {
    /* best-effort */
  }
  return 0;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    log(HELP);
    return;
  }

  // Check git presence first: a missing `git` makes the rev-parse below return status null, which
  // would otherwise misreport as "not inside a git repository".
  if (spawnSync("git", ["--version"]).status !== 0) fail("`git` is required but was not found on PATH.");

  const repoRoot = (() => {
    const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf-8" });
    if (r.status !== 0) fail("not inside a git repository (run at the repo root).");
    return r.stdout.trim();
  })();

  // Dirty-worktree guard: the script reads the working tree, so uncommitted changes could leak.
  // Modified tracked files are skipped unless --allow-dirty. Untracked files (??), including the
  // skeleton output itself, are harmless because we only ever read tracked content. Rename/copy
  // entries (R/C) emit a second NUL-separated path (the source) with no status prefix, so consume
  // it explicitly and record both paths rather than misparsing it as a status line.
  const dirty = new Set();
  {
    const segs = git(repoRoot, ["status", "--porcelain", "-z"]).split("\0");
    for (let i = 0; i < segs.length; i++) {
      const e = segs[i];
      if (!e) continue;
      const status = e.slice(0, 2);
      if (status === "??") continue;
      if (status[0] === "R" || status[0] === "C") {
        const orig = segs[++i];
        if (orig) dirty.add(orig);
      }
      const p = e.slice(3);
      if (p) dirty.add(p);
    }
  }
  if (dirty.size && !opts.allowDirty) {
    fail(`worktree is dirty (${dirty.size} change(s)). Commit/stash, or pass --allow-dirty to skip modified files.`);
  }

  const outAbs = join(repoRoot, OUTPUT_DIR);
  const zipAbs = join(repoRoot, ZIP_NAME);
  for (const p of [outAbs, zipAbs]) {
    let exists = false;
    try {
      lstatSync(p);
      exists = true;
    } catch {
      /* absent */
    }
    if (exists && !opts.force) fail(`${relative(repoRoot, p)} already exists. Pass --force to overwrite.`);
  }

  const tracked = git(repoRoot, ["ls-files", "-z"]).split("\0").filter(Boolean);
  // Build to a temp dir, then atomically swap in, so a failure never leaves partial output.
  const tmpRoot = mkdtempSync(join(repoRoot, ".cycloid-skeleton-tmp-"));
  const skeletonRoot = join(tmpRoot, OUTPUT_DIR);
  mkdirSync(skeletonRoot, { recursive: true });

  const manifest = [];
  const envKeys = new Set();
  const stats = { files: 0, bytes: 0, locByLang: {}, dirBytes: {}, lockfileDeps: {} };
  const suspects = [];
  const counts = {};
  const tally = (t) => {
    counts[t] = (counts[t] || 0) + 1;
  };

  try {
    for (const relPath of tracked) {
      // Path safety: reject anything that escapes the repo root.
      const rel = relative(repoRoot, join(repoRoot, relPath));
      if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith("/")) {
        manifest.push([relPath, "skipped-unsafe-path"]);
        tally("skipped-unsafe-path");
        continue;
      }
      const abs = join(repoRoot, relPath);
      let st;
      try {
        st = lstatSync(abs);
      } catch {
        manifest.push([relPath, "skipped-missing"]);
        tally("skipped-missing");
        continue;
      }
      if (st.isSymbolicLink()) {
        manifest.push([relPath, "skipped-symlink"]);
        tally("skipped-symlink");
        continue;
      }
      if (!st.isFile()) {
        manifest.push([relPath, "skipped-non-file"]);
        tally("skipped-non-file");
        continue;
      } // gitlinks/submodules
      if (dirty.has(relPath)) {
        manifest.push([relPath, "skipped-dirty"]);
        tally("skipped-dirty");
        continue;
      }
      if (matchesAny(relPath, opts.exclude) || matchesAny(basename(relPath), opts.exclude)) {
        manifest.push([relPath, "skipped-excluded"]);
        tally("skipped-excluded");
        continue;
      }

      stats.files++;
      stats.bytes += st.size;
      const topDir = relPath.includes("/") ? relPath.slice(0, relPath.indexOf("/")) : ".";
      stats.dirBytes[topDir] = (stats.dirBytes[topDir] || 0) + st.size;

      if (st.size > PER_FILE_BYTE_CAP) {
        manifest.push([relPath, `skipped-oversize:${st.size}`]);
        tally("skipped-oversize");
        continue;
      }

      const kind = classify(relPath, opts);
      if (kind === "skipped-denylist") {
        manifest.push([relPath, `skipped-denylist:${st.size}`]);
        tally("skipped-denylist");
        continue;
      }

      const buf = readFileSync(abs);
      if (isBinary(buf)) {
        manifest.push([relPath, `skipped-binary:${st.size}`]);
        tally("skipped-binary");
        continue;
      }
      const text = buf.toString("utf-8");

      if (kind === "env") {
        for (const line of text.split("\n")) {
          const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
          if (m) envKeys.add(m[1]);
        }
        manifest.push([relPath, "keys-only"]);
        tally("keys-only");
        continue;
      }
      if (kind === "verbatim") {
        const { out, residualCount } = redact(text, opts.redactCompiled, !LOCKFILES.has(basename(relPath)));
        if (residualCount > 0) suspects.push(`${relPath} (${residualCount} residual high-entropy token(s))`);
        writeOut(skeletonRoot, relPath, out);
        const base = basename(relPath);
        const deps = countDeps(base, text);
        if (deps) stats.lockfileDeps[relPath] = deps;
        manifest.push([relPath, "verbatim"]);
        tally("verbatim");
        continue;
      }
      if (kind === "stubbed") {
        const lang = SOURCE_LANGS[extname(relPath)] || "text";
        stats.locByLang[lang] = (stats.locByLang[lang] || 0) + text.split("\n").length;
        writeOut(skeletonRoot, relPath, stubSource(text));
        manifest.push([relPath, "stubbed"]);
        tally("stubbed");
        continue;
      }
      manifest.push([relPath, `skipped-text:${st.size}`]);
      tally("skipped-text");
    }

    // Optional: untracked local .env* keys (never values).
    if (opts.scanLocalEnv) {
      const untracked = git(repoRoot, ["ls-files", "--others", "-z"])
        .split("\0")
        .filter(Boolean)
        .filter((p) => /^\.env(\..+)?$/.test(basename(p)));
      for (const p of untracked) {
        try {
          // Never follow symlinks, same invariant as the tracked loop: a symlinked .env could
          // point outside the repo and exfiltrate arbitrary host file contents. Also skip
          // non-regular files (dirs/fifos) defensively.
          const envAbs = join(repoRoot, p);
          const envStat = lstatSync(envAbs);
          if (envStat.isSymbolicLink()) {
            manifest.push([p, "skipped-symlink-untracked"]);
            tally("skipped-symlink-untracked");
            continue;
          }
          if (!envStat.isFile()) {
            manifest.push([p, "skipped-non-file-untracked"]);
            tally("skipped-non-file-untracked");
            continue;
          }
          for (const line of readFileSync(envAbs, "utf-8").split("\n")) {
            const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
            if (m) envKeys.add(m[1]);
          }
          manifest.push([p, "keys-only-untracked"]);
          tally("keys-only-untracked");
        } catch {
          /* ignore unreadable */
        }
      }
    }

    // Top 10 largest directories by bytes.
    const largestDirs = Object.entries(stats.dirBytes)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([name, bytes]) => ({ name, bytes }));

    const repoStats = {
      trackedFiles: stats.files,
      totalBytes: stats.bytes,
      locByLanguage: stats.locByLang,
      largestDirs,
      lockfileDeps: stats.lockfileDeps,
    };
    writeFileSync(join(skeletonRoot, "repo-stats.json"), `${JSON.stringify(repoStats, null, 2)}\n`);
    writeFileSync(
      join(skeletonRoot, "env-keys.txt"),
      `# Env var NAMES only (values never read). ${envKeys.size} key(s).\n${[...envKeys].sort().join("\n")}\n`,
    );

    manifest.sort((a, b) => a[0].localeCompare(b[0]));
    const manifestBody = [
      "# Cycloid skeleton manifest. Treatment per tracked path.",
      "# NOTE: the paths below are preserved as-is and may reveal naming/architecture — this",
      "#       is a path disclosure risk, separate from file-content disclosure. Review both",
      "#       before sending. Use --exclude to drop sensitive paths.",
      "#",
      "# treatment\tpath",
      ...manifest.map(([p, t]) => `${t}\t${p}`),
    ].join("\n");
    writeFileSync(join(skeletonRoot, "MANIFEST.txt"), `${manifestBody}\n`);

    // Atomic swap into place.
    if (opts.force) {
      rmSync(outAbs, { recursive: true, force: true });
      rmSync(zipAbs, { force: true });
    }
    renameSync(skeletonRoot, outAbs);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }

  // Categorized leak-review summary.
  log("");
  log(`Skeleton written to ./${OUTPUT_DIR}/`);
  log("Treatment summary:");
  for (const [t, n] of Object.entries(counts).sort()) log(`  ${t.padEnd(24)} ${n}`);
  log(`  env keys captured        ${envKeys.size}`);

  const gateBlocked = suspects.length > 0 && !opts.acceptRedactions;
  if (suspects.length) {
    log("");
    log(`WARNING: ${suspects.length} file(s) have residual secret-like content after redaction:`);
    for (const s of suspects) log(`  - ${s}`);
    log(
      "Review these in the skeleton, then re-run with --accept-redactions --force " +
        "(--force is needed because ./" +
        OUTPUT_DIR +
        "/ already exists) to produce the zip anyway.",
    );
  }

  // Zip (optional). Node stdlib has no zip writer, so shell out to `zip`.
  let zipped = false;
  if (!opts.noZip && !gateBlocked) {
    const hasZip = spawnSync("zip", ["-v"]).status === 0;
    if (!hasZip) {
      log("");
      log("`zip` not found — skipping archive. The directory IS the artifact; zip ./" + OUTPUT_DIR + "/ manually.");
    } else {
      const r = spawnSync("zip", ["-rq", ZIP_NAME, OUTPUT_DIR], { cwd: repoRoot });
      if (r.status === 0) {
        zipped = true;
        log(`\nArchive: ./${ZIP_NAME}`);
      } else log("\n`zip` failed — the directory ./" + OUTPUT_DIR + "/ is the artifact.");
    }
  }

  log("");
  log(`Review ./${OUTPUT_DIR}/MANIFEST.txt and ./${OUTPUT_DIR}/env-keys.txt before sending.`);
  if (gateBlocked) {
    process.stderr.write("make-skeleton: zip suppressed due to residual secret-like content (see warnings above).\n");
    process.exit(2);
  }
  if (!opts.noZip && !zipped) process.exitCode = 0;
}

try {
  main();
} catch (err) {
  fail(err && err.message ? err.message : String(err));
}
