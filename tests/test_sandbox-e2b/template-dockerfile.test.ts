import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { dockerfile } from "../../apps/sandbox-e2b/template";

const REPO_ROOT = resolve(__dirname, "../..");
const TEMPLATE_TS = resolve(REPO_ROOT, "apps/sandbox-e2b/template.ts");
const READY_CHECK = resolve(REPO_ROOT, "apps/sandbox-e2b/ready-check.sh");

describe("e2b template dockerfile", () => {
  const source = readFileSync(TEMPLATE_TS, "utf8");
  const renderedDockerfile = dockerfile();
  const readyCheck = readFileSync(READY_CHECK, "utf8");

  it("installs and smoke-tests Codex CLI support", () => {
    expect(source).toContain('import { PINNED_CODEX_CLI_VERSION } from "../../shared/constants/codex-runtime.js"');
    expect(source).toContain("const CODEX_CLI_VERSION = PINNED_CODEX_CLI_VERSION");
    expect(source).toContain("npm install -g @openai/codex@${CODEX_CLI_VERSION}");
    expect(source).toContain("codex --version");
    expect(source).toContain("/tmp/codex-home");
  });

  it("installs and ready-checks Cycloid CLI support", () => {
    expect(source).toContain(
      'import { PINNED_CYCLOID_CLI_VERSION } from "../../shared/constants/cycloid-cli-runtime.js"',
    );
    expect(source).toContain("const CYCLOID_CLI_VERSION = PINNED_CYCLOID_CLI_VERSION");
    expect(source).toContain("npm install -g @trycycloid/cli@${CYCLOID_CLI_VERSION}");
    expect(source).toContain("cycloid --version");
  });

  it("does not install a global @anthropic-ai/claude-code CLI (the Agent SDK native binary is the runtime)", () => {
    expect(source).toContain("PINNED_CLAUDE_AGENT_SDK_VERSION");
    expect(source).toContain('from "../../shared/constants/claude-code-runtime.js"');
    // The global CLI was removed: the claude_code backend drives the Agent SDK's
    // own version-locked native binary, not a global @anthropic-ai/claude-code.
    expect(source).not.toContain("PINNED_CLAUDE_CODE_CLI_VERSION");
    expect(source).not.toContain("CLAUDE_CODE_CLI_VERSION");
    expect(source).not.toContain("@anthropic-ai/claude-code@");
  });

  it("installs the Agent SDK (+ its native binary) in /app/bridge with an ESM resolution smoke", () => {
    expect(source).toContain("const CLAUDE_AGENT_SDK_VERSION = PINNED_CLAUDE_AGENT_SDK_VERSION");
    expect(source).toContain("npm install sharp @anthropic-ai/claude-agent-sdk@${CLAUDE_AGENT_SDK_VERSION}");
    expect(source).toContain("import('@anthropic-ai/claude-agent-sdk')");
    expect(source).toContain("bridge-claude-agent-sdk-ok");
    // The external PreToolUse hook artifact is gone (gate is in-process now).
    expect(source).not.toContain("claude-tool-safety-hook.js");
  });

  it("readiness-checks the codex CLI and no longer the removed global claude CLI", () => {
    expect(readyCheck).not.toContain("claude --version");
  });

  it("readiness-checks authenticated gh reads through a login shell", () => {
    expect(readyCheck).toContain('if [ -n "${REPO_OWNER:-}" ] && [ -n "${REPO_NAME:-}" ]; then');
    expect(readyCheck).toContain("bash -lc 'gh api \"repos/${REPO_OWNER}/${REPO_NAME}\" --silent'");
  });

  it("builds 4 GiB / 2 CPU templates by default with CLI resource overrides", () => {
    expect(source).toContain("const TEMPLATE_CPU_COUNT = 2");
    expect(source).toContain("const TEMPLATE_MEMORY_MB = 4096");
    expect(source).toContain('"--memory-mb"');
    expect(source).toContain('"--cpu-count"');
  });

  it("does not install deprecated local Notion MCP support", () => {
    expect(source).not.toContain("NOTION_MCP_VERSION");
    expect(source).not.toContain("@notionhq/notion-mcp-server");
    expect(source).not.toContain("notion-mcp-server --version");
  });

  it("installs and smoke-tests Docker Compose support", () => {
    expect(source).toContain("docker.io");
    expect(source).toContain("usermod -aG docker user");
    expect(source).toContain("NOPASSWD:SETENV: /app/scripts/start-dockerd.sh");
    expect(source).toContain("docker compose version");
    expect(source).toContain("docker/compose/releases/download/v2.29.7");
    expect(source).toContain("docker-compose-linux-$compose_arch.sha256");
    expect(source).toContain("sha256sum -c -");
    expect(source).toContain("docker run --rm hello-world");
    expect(source).toContain("docker compose up --abort-on-container-exit --remove-orphans");
    expect(source).toContain("docker compose down --remove-orphans -v");
  });

  it("installs ngrok and configures its auth token from sandbox env", () => {
    expect(source).toContain("https://ngrok-agent.s3.amazonaws.com/ngrok.asc");
    expect(source).toContain("https://ngrok-agent.s3.amazonaws.com bookworm main");
    expect(source).toContain("apt-get install -y --no-install-recommends ngrok");
    expect(source).toContain("ngrok version");
    expect(source).toContain("/etc/profile.d/cycloid-ngrok.sh");
    expect(source).toContain('NGROK_AUTHTOKEN="\\${NGROK_AUTHTOKEN:-\\${NGROK_AUTH_TOKEN}}"');
    expect(source).toContain('ngrok_auth_log="/var/log/cycloid-egress.log"');
    expect(source).toContain('ngrok_auth_log="/tmp/cycloid-ngrok-auth.log"');
    expect(source).toContain('ngrok config add-authtoken "$NGROK_AUTHTOKEN" >>"$ngrok_auth_log" 2>&1 || true');
  });

  it("installs Terraform as a bridge-only binary outside the agent PATH", () => {
    expect(source).toContain('const TERRAFORM_VERSION = "1.15.7"');
    expect(source).toContain("https://releases.hashicorp.com/terraform/${TERRAFORM_VERSION}");
    expect(source).toContain("terraform_${TERRAFORM_VERSION}_SHA256SUMS");
    expect(source).toContain("sha256sum -c -");
    expect(source).toContain("unzip -q");
    expect(source).toContain("/app/bridge-tools/terraform version");
    expect(readyCheck).toContain("/app/bridge-tools/terraform version");
  });

  it("does not expose Terraform as a general sandbox CLI", () => {
    expect(source).not.toContain("unzip -q /tmp/terraform.zip -d /usr/local/bin");
    expect(source).not.toContain('"terraform"');
    expect(readyCheck).not.toContain("\nterraform version");
    expect(source).not.toContain("TERRAGRUNT_VERSION");
    expect(source).not.toContain("gruntwork-io/terragrunt");
    expect(readyCheck).not.toContain("terragrunt --version");
  });

  it("installs and ready-checks uv and just for Python repo workflows", () => {
    expect(source).toContain('const JUST_VERSION = "1.51.0"');
    expect(source).toContain("https://github.com/casey/just/releases/download/${JUST_VERSION}/SHA256SUMS");
    expect(source).toContain("just-${JUST_VERSION}-$just_arch.tar.gz");
    expect(source).toContain("tar -xzf");
    expect(source).toContain("just --version");
    expect(source).toContain("uv \\");
    expect(source).toContain("uv --version");
  });

  it("pins global TypeScript to the Mia-supported 5.9 toolchain", () => {
    expect(source).toContain('const TYPESCRIPT_VERSION = "5.9.3"');
    expect(source).toContain("typescript@${TYPESCRIPT_VERSION}");
    expect(source).toContain("tsc --version");
    expect(source).toContain(
      `NODE_PATH="$(npm root -g)" node -e "const ts=require('typescript'); if (ts.version !== '\${TYPESCRIPT_VERSION}') throw new Error('unexpected TypeScript '+ts.version)"`,
    );
    expect(source).toContain("ENV ARCANIST_TYPESCRIPT_VERSION=${TYPESCRIPT_VERSION}");
    expect(readyCheck).toContain('node -e "const expected=process.env.ARCANIST_TYPESCRIPT_VERSION');
    expect(readyCheck).not.toContain("ts.version !== '5.9.3'");
    // LSP servers removed: zero platform/script/agent consumers.
    expect(source).not.toContain("typescript-language-server");
    expect(source).not.toContain("vscode-langservers-extracted");
    expect(readyCheck).not.toContain("typescript-language-server");
  });

  it("installs shared native tooling from stable apt sources", () => {
    // direnv was removed: it had zero runtime consumers in the image.
    expect(source).not.toContain("direnv \\");
    expect(source).toContain("ffmpeg \\");
    expect(source).toContain("file \\");
    expect(source).toContain("iproute2 \\");
    expect(source).toContain("libicu-dev \\");
    expect(source).toContain("libzstd-dev \\");
    expect(source).toContain("lsof \\");
    expect(source).toContain("netcat-openbsd \\");
    expect(source).toContain("pkg-config \\");
    expect(source).toContain("procps \\");
  });

  it("installs and ready-checks the essential sandbox font set", () => {
    expect(source).toContain('const GOOGLE_FONTS_COMMIT = "e4572de925a4c3be12f1f9983ee0adbe1eb6e9fe"');
    expect(source).toContain('const GEIST_FONT_COMMIT = "10dc7658f13c38a474cde201bb09a4617267545b"');
    expect(source).toContain("fontconfig \\");
    expect(source).toContain("fonts-firacode \\");
    expect(source).toContain("fonts-inter \\");
    expect(source).toContain("fonts-jetbrains-mono \\");
    expect(source).toContain("fonts-liberation2 \\");
    expect(source).toContain("fonts-noto-color-emoji \\");
    expect(source).toContain("fonts-noto-core \\");
    expect(source).toContain("fc-cache -f");
    expect(source).toContain("7e65201e9b79159e2300267cc885e16c8dcef2424cdfa09a29bfb0980a94a7ba");
    expect(source).toContain("87c2aff9723544a9adaea19d92e42a33705c9723624801b6e0224c2206a6af0d");
    expect(source).toContain("sha256sum -c -");
    expect(source).toContain("Poppins-Regular.ttf");
    expect(source).toContain("DMSans%5Bopsz%2Cwght%5D.ttf");
    expect(source).toContain("SchibstedGrotesk%5Bwght%5D.ttf");
    expect(source).toContain("Lora%5Bwght%5D.ttf");
    expect(source).toContain("Geist-Variable.ttf");
    expect(source).toContain("GeistMono-Variable.ttf");
    expect(readyCheck).toContain('require_font "Inter" "Inter"');
    expect(readyCheck).toContain('require_font "JetBrains Mono" "JetBrains Mono"');
  });

  it("renders the product font manifest without printf newline escapes", () => {
    const blockStart = renderedDockerfile.indexOf("# Product font fallbacks");
    const blockEnd = renderedDockerfile.indexOf("RUN curl -fsSL https://deb.nodesource.com/setup_22.x");
    expect(blockStart).toBeGreaterThanOrEqual(0);
    expect(blockEnd).toBeGreaterThan(blockStart);

    const fontBlock = renderedDockerfile.slice(blockStart, blockEnd);
    expect(fontBlock).toContain(
      "echo '7e65201e9b79159e2300267cc885e16c8dcef2424cdfa09a29bfb0980a94a7ba|https://raw.githubusercontent.com/google/fonts/",
    );
    expect(fontBlock).toContain('} > "$tmp_dir/fonts.manifest"; \\');
    expect(fontBlock).toContain('echo "$expected_sha  $tmp_dir/$filename" | sha256sum -c -; \\');
    expect(fontBlock).toContain('done < "$tmp_dir/fonts.manifest"; \\');
    expect(fontBlock).not.toContain("printf '%s\\n'");
    expect(fontBlock).not.toContain("printf '%s  %s\\n'");
  });

  it("ready-checks ffmpeg for recorder video encoding", () => {
    expect(readyCheck).not.toContain("ffmpeg -hide_banner");
    expect(readyCheck).not.toContain("imlib2/loaders/webp.so");
    expect(readyCheck).not.toContain("scrot_webp_probe");
    expect(readyCheck).not.toContain('DISPLAY="${webp_probe_display}"');
  });

  it("installs and ready-checks XFCE-core desktop packages for VNC/CUA support", () => {
    expect(source).toContain("xvfb \\");
    expect(source).toContain("dbus-x11 \\");
    expect(source).toContain("xfwm4 \\");
    expect(source).toContain("xfce4-panel \\");
    expect(source).toContain("xfdesktop4 \\");
    expect(source).toContain("xfce4-session \\");
    expect(source).toContain("xfce4-settings \\");
    expect(source).toContain("xfconf \\");
    expect(source).toContain("thunar \\");
    expect(source).toContain("xfce4-terminal \\");
    expect(source).toContain("adwaita-icon-theme \\");
    expect(source).toContain("hicolor-icon-theme \\");
    expect(source).not.toContain("openbox \\");
    expect(source).not.toContain("tint2 \\");
    expect(source).not.toContain("xfce4-goodies");
    expect(source).toContain("x11vnc \\");
    expect(source).toContain("x11-xserver-utils \\");
    expect(source).toContain("websockify \\");
    expect(source).toContain("novnc \\");
    expect(source).toContain("xdotool \\");
    expect(source).toContain("wmctrl \\");
    expect(source).toContain("scrot \\");
    expect(source).toContain("fonts-dejavu-core \\");
    expect(source).toContain("fonts-liberation \\");
    expect(source).toContain("fonts-noto-color-emoji \\");

    expect(readyCheck).not.toContain("dpkg-query");
    expect(readyCheck).not.toContain("xfwm4 --version");
    expect(readyCheck).not.toContain("xfdesktop --version");
    expect(readyCheck).not.toContain("xfce4-panel --version");
    expect(readyCheck).not.toContain("xfce4-terminal --version");
    expect(readyCheck).not.toContain("thunar --version");
    expect(readyCheck).not.toContain("xfconf-query --version");
    expect(readyCheck).not.toContain("openbox --version");
    expect(readyCheck).not.toContain("command -v tint2");
    expect(readyCheck).not.toContain("scrot_webp_probe");
    expect(readyCheck).not.toContain("fc-match sans");
  });

  it("keeps new desktop readiness checks presence-only", () => {
    expect(readyCheck).toContain("command -v Xvfb");
    expect(readyCheck).toContain("command -v x11vnc");
    expect(readyCheck).toContain("command -v scrot");
    expect(readyCheck).not.toContain("x11vnc -version");
    expect(readyCheck).not.toContain("scrot_webp_probe");
    expect(readyCheck).not.toContain('DISPLAY="${webp_probe_display}"');
    expect(readyCheck).not.toContain("ffmpeg -hide_banner");
    expect(readyCheck).not.toContain("dpkg-query");
  });

  it("copies the desktop supervisor and exports the default sandbox display", () => {
    expect(source).toContain('"cycloid-desktop"');
    expect(source).toContain('"cycloid-desktop-supervisor"');
    expect(source).toContain("dest: `/app/scripts/${path.basename(script)}`");
    expect(source).toContain("ENV DISPLAY=:99");
  });

  it("does not bundle PostgreSQL in the shared base image", () => {
    // PostgreSQL was a single-customer (Mia) toolchain that belongs in that
    // repo's per-repo .cycloid/sandbox.layer.Dockerfile, not the shared base
    // that every cold-pull pays for. See docs/sandbox-architecture.md.
    expect(source).not.toContain("libpq-dev");
    expect(source).not.toContain("postgresql");
    expect(source).not.toContain("POSTGRESQL_MAJOR_VERSION");
    expect(source).not.toContain("POSTGRESQL_BIN_DIR");
    expect(source).not.toContain("ARCANIST_POSTGRESQL_MAJOR_VERSION");
    expect(source).not.toContain("pg_ctl");
    expect(source).not.toContain("initdb");
    expect(source).not.toContain("pytest-postgresql");
    expect(readyCheck).not.toContain("postgresql");
    expect(readyCheck).not.toContain("pg_ctl");
    expect(readyCheck).not.toContain("pytest_postgresql");
  });

  it("installs and ready-checks common runtime diagnostic utilities", () => {
    expect(readyCheck).not.toContain("nc -h");
  });

  it("installs the sandbox egress firewall helper as root-owned sudo target", () => {
    expect(source).toContain("iptables");
    expect(source).toContain("NOPASSWD:SETENV: /usr/local/sbin/cycloid-enforce-egress");
    expect(source).toContain('"/usr/local/sbin/cycloid-enforce-egress"');
    expect(source).toContain('src: requireFile("apps/sandbox-e2b/github-meta-cidrs.snapshot")');
    expect(source).toContain('dest: "/app/github-meta-cidrs.snapshot"');
    expect(source).toContain('"/usr/local/bin/curl"');
    expect(source).toContain("chown root:root /usr/local/sbin/cycloid-enforce-egress /usr/local/bin/curl");
  });

  it("installs root-owned git and gh publish-command wrappers before user-writable paths", () => {
    expect(source).toContain('src: requireFile("apps/sandbox-e2b/git-command-wrapper.sh")');
    expect(source).toContain('dest: "/usr/local/bin/git"');
    expect(source).toContain('src: requireFile("apps/sandbox-e2b/gh-command-wrapper.sh")');
    expect(source).toContain('dest: "/usr/local/bin/gh"');
    expect(source).toContain("mkdir -p /usr/local/lib/cycloid/real-bin");
    expect(source).toContain("mv /usr/bin/git /usr/local/lib/cycloid/real-bin/git");
    expect(source).toContain("mv /usr/bin/gh /usr/local/lib/cycloid/real-bin/gh");
    expect(source).toContain(
      "chown root:root /usr/local/sbin/cycloid-enforce-egress /usr/local/bin/curl /usr/local/bin/git /usr/local/bin/gh",
    );
    expect(source).toContain(
      "chmod 0755 /usr/local/sbin/cycloid-enforce-egress /usr/local/bin/curl /usr/local/bin/git /usr/local/bin/gh",
    );
    expect(source).not.toContain('dest: "/app/scripts/git"');
    expect(source).not.toContain('dest: "/app/scripts/gh"');
  });

  it("installs the demo recorder helper on the agent PATH", () => {
    expect(source).toContain("npm install -g agent-browser@${AGENT_BROWSER_VERSION} playwright@");
    expect(source).toContain('"/usr/local/bin/cycloid-record-demo"');
    expect(source).toContain("cycloid-record-demo --help");
    expect(source).toContain("chown root:root /usr/local/bin/cycloid-record-demo");
  });

  it("installs and ready-checks the recorder command skeleton on the agent PATH", () => {
    expect(source).toContain('src: requireFile("apps/sandbox-e2b/cycloid-recorder.mjs")');
    expect(source).toContain('dest: "/usr/local/bin/cycloid-recorder"');
    expect(source).toContain("cycloid-recorder --help");
    expect(source).toContain("chown root:root /usr/local/bin/cycloid-recorder");
  });

  it("pre-bakes Playwright-managed Chromium for customer e2e test commands", () => {
    expect(source).toContain('const PLAYWRIGHT_VERSION = "1.59.0"');
    expect(source).toContain(
      "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install -g agent-browser@${AGENT_BROWSER_VERSION} playwright@",
    );
    expect(source).toContain("playwright@${PLAYWRIGHT_VERSION}");
    expect(source).toContain('NODE_PATH="$(npm root -g)" node -e "require(\'playwright\')"');
    expect(source).toContain(
      "PLAYWRIGHT_BROWSERS_PATH=/opt/cycloid/ms-playwright playwright install --with-deps chromium",
    );
    expect(source).toContain('process.stdout.write(require("playwright").chromium.executablePath())');
    expect(source).toContain('test -x "$chromium_path"');
    expect(source).toContain("chown -R root:root /opt/cycloid/ms-playwright");
    expect(source).toContain("chmod -R a+rX,go-w /opt/cycloid/ms-playwright");
    expect(source).toContain('ln -sf "$chromium_path" /usr/local/bin/chromium');
    expect(source).not.toContain("chrome-linux64/chrome");
    expect(source).not.toContain(`"playwright==\${PLAYWRIGHT_VERSION}"`);
    expect(source).not.toContain("HOME=/home/user python -m playwright install chromium");
    expect(source).toMatch(/chown -R user:user[^\n]*\/home\/user/);
  });

  it("points agent-browser at the Playwright-managed Chromium instead of downloading its own", () => {
    // agent-browser's `install` pulls a ~684 MB Chrome-for-Testing build. Pin it
    // to the shared Playwright-managed Chromium via env instead.
    expect(source).not.toContain("agent-browser install");
    expect(source).not.toContain("\n    chromium \\");
    // Pinned so a future agent-browser release can't silently drop the env-var contract.
    expect(source).toContain('const AGENT_BROWSER_VERSION = "0.28.0"');
    expect(source).toContain("agent-browser@${AGENT_BROWSER_VERSION}");
    expect(source).toContain("ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/local/bin/chromium");
    expect(source).toContain("ENV PLAYWRIGHT_BROWSERS_PATH=/opt/cycloid/ms-playwright");
  });

  it("cleans package-manager bootstrap caches from the image", () => {
    expect(source).toContain("npm cache clean --force");
    expect(source).not.toContain("rm -rf /root/.npm");
    expect(source).toContain("rm -rf /root/.bun");
  });

  it("installs common Python test tooling globally for ad hoc repo commands", () => {
    expect(source).toContain("pytest \\");
    expect(source).toContain("pytest-asyncio \\");
    expect(source).toContain("pytest-cov \\");
    expect(source).toContain("pytest-mock \\");
    expect(source).toContain("pytest-timeout \\");
    expect(source).toContain("ruff \\");
    expect(source).toContain("mypy \\");
    expect(source).toContain("black \\");
    // tox removed: zero consumers in platform/scripts/agent flow.
    expect(source).not.toContain("tox \\");
    expect(source).toContain("pytest --version");
    expect(source).toContain("python -c \"import pytest; print('python-test-tooling-ok')\"");
    expect(readyCheck).toContain('python -c "import pytest"');
  });

  it("does not install or ready-check the Rust toolchain (no active Rust repo)", () => {
    // Removed: ~1.2 GB of dead weight with no active Rust repo. A future Rust
    // repo adds cargo via its own per-repo layer per the base-image weight doc.
    expect(source).not.toContain("https://sh.rustup.rs");
    expect(source).not.toContain(".cargo/bin");
    expect(readyCheck).not.toContain("cargo --version");
    expect(readyCheck).not.toContain("rustfmt --version");
    expect(readyCheck).not.toContain("clippy-driver --version");
  });

  it("ready-check verifies the pre-baked Playwright Chromium cache", () => {
    expect(readyCheck).toContain("node -e \"require('playwright')\"");
    expect(readyCheck).not.toContain("python -m playwright --version");
    expect(readyCheck).toContain('"${PLAYWRIGHT_BROWSERS_PATH}"/chromium-*');
    expect(readyCheck).toContain("/opt/cycloid/ms-playwright/*)");
    expect(readyCheck).toContain(`test "$(stat -c '%U' "\${resolved_chromium_path}")" = root`);
    expect(readyCheck).toContain("8#022");
    expect(readyCheck).toContain('test "$PLAYWRIGHT_CHROMIUM_FOUND" -eq 1');
    expect(readyCheck).not.toContain("playwright install --dry-run chromium");
  });

  it("adds sandbox tools to login-shell PATH via /etc/profile.d so `bash -lc` can find them", () => {
    // ARC-849: Codex always invokes commands as `bash -lc`, a login shell
    // that sources /etc/profile and resets PATH from /etc/login.defs,
    // overriding the Dockerfile's `ENV PATH=/app/scripts:...`. Without an
    // explicit /etc/profile.d snippet, the agent never sees sandbox-provided
    // tools like cycloid-app on PATH.
    expect(source).toContain("/etc/profile.d/cycloid-path.sh");
    // The TS template literal escapes the dollar sign as `\${PATH}` so the
    // shell script written into the image stays as `${PATH}` (and isn't
    // interpolated at template-build time). The on-disk source bytes contain
    // a backslash before the dollar sign — we match those bytes here.
    expect(source).toMatch(/export PATH="\/app\/scripts:\\\$\{PATH\}"/);
    expect(source).toContain('export NODE_PATH="/usr/local/lib/node_modules:/usr/lib/node_modules"');
    expect(source).toContain("ENV NODE_PATH=/usr/local/lib/node_modules:/usr/lib/node_modules");
    expect(source).toContain("ENV PATH=/app/scripts:/usr/local/bin:");
    expect(source).toContain("chmod 0644 /etc/profile.d/cycloid-path.sh");
  });
});
