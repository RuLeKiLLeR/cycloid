import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { defaultBuildLogger, Template } from "e2b";

import { PINNED_CLAUDE_AGENT_SDK_VERSION } from "../../shared/constants/claude-code-runtime.js";
import { PINNED_CODEX_CLI_VERSION } from "../../shared/constants/codex-runtime.js";
import { PINNED_CYCLOID_CLI_VERSION } from "../../shared/constants/cycloid-cli-runtime.js";
import { PINNED_OPENCODE_CLI_VERSION, PINNED_OPENCODE_SDK_VERSION } from "../../shared/constants/opencode-runtime.js";

const CODEX_CLI_VERSION = PINNED_CODEX_CLI_VERSION;
const CLAUDE_AGENT_SDK_VERSION = PINNED_CLAUDE_AGENT_SDK_VERSION;
const OPENCODE_CLI_VERSION = PINNED_OPENCODE_CLI_VERSION;
const OPENCODE_SDK_VERSION = PINNED_OPENCODE_SDK_VERSION;
const CYCLOID_CLI_VERSION = PINNED_CYCLOID_CLI_VERSION;
const JUST_VERSION = "1.51.0";
const PLAYWRIGHT_VERSION = "1.59.0";
// Pinned: the AGENT_BROWSER_EXECUTABLE_PATH=/usr/local/bin/chromium mechanism below was
// verified against this version. An unpinned upgrade could rename/remove that env
// var and silently re-introduce agent-browser's own ~684 MB Chrome download.
const AGENT_BROWSER_VERSION = "0.28.0";
const PRE_COMMIT_VERSION = "4.6.0";
const TYPESCRIPT_VERSION = "5.9.3";
const TERRAFORM_VERSION = "1.15.7";
const GOOGLE_FONTS_COMMIT = "e4572de925a4c3be12f1f9983ee0adbe1eb6e9fe";
const GEIST_FONT_COMMIT = "10dc7658f13c38a474cde201bb09a4617267545b";
const TEMPLATE_CPU_COUNT = 2;
const TEMPLATE_MEMORY_MB = 4096;
const TEMPLATE_READY_CMD = "/app/ready-check.sh";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

type CliOptions = {
  name: string;
  skipCache: boolean;
  cpuCount: number;
  memoryMB: number;
  printContentHash: boolean;
  apiKey?: string;
};

function parseArgs(argv: string[]): CliOptions {
  const fallbackName = process.env.E2B_SANDBOX_TEMPLATE ?? `cycloid-sandbox-dev-${process.env.USER ?? "local"}`;
  const options: CliOptions = {
    name: fallbackName,
    skipCache: false,
    cpuCount: TEMPLATE_CPU_COUNT,
    memoryMB: TEMPLATE_MEMORY_MB,
    printContentHash: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--name") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--name requires a template name");
      }
      options.name = value;
      index += 1;
      continue;
    }
    if (arg === "--api-key") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--api-key requires a value");
      }
      options.apiKey = value;
      index += 1;
      continue;
    }
    if (arg === "--cpu-count") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--cpu-count requires a value");
      }
      options.cpuCount = parsePositiveInteger(value, "--cpu-count");
      index += 1;
      continue;
    }
    if (arg === "--memory-mb") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--memory-mb requires a value");
      }
      options.memoryMB = parsePositiveInteger(value, "--memory-mb");
      index += 1;
      continue;
    }
    if (arg === "--skip-cache") {
      options.skipCache = true;
      continue;
    }
    if (arg === "--print-content-hash") {
      options.printContentHash = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function parsePositiveInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} requires a positive integer`);
  }
  return parsed;
}

function loadLocalDevVars(): void {
  if (process.env.E2B_API_KEY) {
    return;
  }

  const devVarsPath = path.join(repoRoot, "apps/control-plane-worker/.dev.vars");
  if (!existsSync(devVarsPath)) {
    return;
  }

  const text = readFileSync(devVarsPath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const separator = line.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    if (key !== "E2B_API_KEY") {
      continue;
    }
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (value) {
      process.env.E2B_API_KEY = value;
    }
    return;
  }
}

function requireFile(relativePath: string): string {
  const absolutePath = path.join(repoRoot, relativePath);
  if (!existsSync(absolutePath)) {
    throw new Error(`Required template input is missing: ${relativePath}`);
  }
  return relativePath;
}

type TemplateCopyInput = {
  src: string;
  dest: string;
  mode: number;
};

type TemplateRunCommandInput = {
  command: string;
  options?: { user: string };
};

function templateCopyInputs(): TemplateCopyInput[] {
  requireFile("apps/sandbox-e2b/scripts");
  const scripts = [
    "cycloid-app",
    "cycloid-desktop",
    "cycloid-desktop-supervisor",
    "cycloid-docker-preview",
    "repo-context.sh",
    "start-dockerd.sh",
  ].map((script) => `apps/sandbox-e2b/scripts/${script}`);
  return [
    { src: requireFile("apps/sandbox-bridge/dist/bundle.js"), dest: "/app/bridge/bundle.js", mode: 0o644 },
    // pytest-xdist worker cap: baked at /app (on PYTHONPATH) and auto-loaded via
    // ENV PYTEST_ADDOPTS below, so a repo's CI-sized `-n <N>` can't OOM the sandbox.
    {
      src: requireFile("apps/sandbox-e2b/pyplugins/cycloid_xdist_cap.py"),
      dest: "/app/cycloid_xdist_cap.py",
      mode: 0o644,
    },
    ...scripts.map((script) => ({
      src: requireFile(script),
      dest: `/app/scripts/${path.basename(script)}`,
      mode: 0o755,
    })),
    { src: requireFile("apps/sandbox-e2b/start-bridge.sh"), dest: "/app/start-bridge.sh", mode: 0o755 },
    { src: requireFile("apps/sandbox-e2b/ready-check.sh"), dest: "/app/ready-check.sh", mode: 0o755 },
    {
      src: requireFile("apps/sandbox-e2b/enforce-egress.sh"),
      dest: "/usr/local/sbin/cycloid-enforce-egress",
      mode: 0o755,
    },
    {
      src: requireFile("apps/sandbox-e2b/github-meta-cidrs.snapshot"),
      dest: "/app/github-meta-cidrs.snapshot",
      mode: 0o644,
    },
    { src: requireFile("apps/sandbox-e2b/curl-egress-wrapper.sh"), dest: "/usr/local/bin/curl", mode: 0o755 },
    { src: requireFile("apps/sandbox-e2b/git-command-wrapper.sh"), dest: "/usr/local/bin/git", mode: 0o755 },
    { src: requireFile("apps/sandbox-e2b/gh-command-wrapper.sh"), dest: "/usr/local/bin/gh", mode: 0o755 },
    {
      src: requireFile("apps/sandbox-e2b/cycloid-record-demo.mjs"),
      dest: "/usr/local/bin/cycloid-record-demo",
      mode: 0o755,
    },
    {
      src: requireFile("apps/sandbox-e2b/cycloid-recorder.mjs"),
      dest: "/usr/local/bin/cycloid-recorder",
      mode: 0o755,
    },
  ];
}

function templateRunCommands(): TemplateRunCommandInput[] {
  return [
    { command: "chmod +x /app/start-bridge.sh /app/ready-check.sh /app/scripts/*", options: { user: "root" } },
    {
      // Codex (the agent runtime) invokes every shell command as `bash -lc`, a
      // login shell. Debian's /etc/profile sets PATH from /etc/login.defs's
      // ENV_PATH defaults, which OVERRIDES the Dockerfile's ENV PATH directive
      // above. Without this profile.d snippet the agent's shell never sees
      // /app/scripts on PATH and `cycloid-app` (plus the other helpers we ship)
      // is silently undiscoverable — exactly the failure mode that surfaced on
      // the first prod E2E runtime sessions after #2657 merged. Writing a
      // profile.d file is the conventional Debian way to extend login-shell PATH.
      command: `printf '%s\\n' 'export PATH="/app/scripts:\${PATH}"' 'export NODE_PATH="/usr/local/lib/node_modules:/usr/lib/node_modules"' > /etc/profile.d/cycloid-path.sh && chmod 0644 /etc/profile.d/cycloid-path.sh`,
      options: { user: "root" },
    },
    {
      command: `cat > /etc/profile.d/cycloid-ngrok.sh <<'EOF'
if [ -n "\${NGROK_AUTHTOKEN:-\${NGROK_AUTH_TOKEN:-}}" ] && command -v ngrok >/dev/null 2>&1; then
  export NGROK_AUTHTOKEN="\${NGROK_AUTHTOKEN:-\${NGROK_AUTH_TOKEN}}"
  if [ ! -s "\${HOME:-/home/user}/.config/ngrok/ngrok.yml" ]; then
    ngrok_auth_log="/var/log/cycloid-egress.log"
    if [ ! -w "$ngrok_auth_log" ]; then
      ngrok_auth_log="/tmp/cycloid-ngrok-auth.log"
    fi
    ngrok config add-authtoken "$NGROK_AUTHTOKEN" >>"$ngrok_auth_log" 2>&1 || true
  fi
fi
EOF
chmod 0644 /etc/profile.d/cycloid-ngrok.sh`,
      options: { user: "root" },
    },
    {
      command:
        "chown root:root /usr/local/sbin/cycloid-enforce-egress /usr/local/bin/curl /usr/local/bin/git /usr/local/bin/gh && chmod 0755 /usr/local/sbin/cycloid-enforce-egress /usr/local/bin/curl /usr/local/bin/git /usr/local/bin/gh",
      options: { user: "root" },
    },
    {
      command:
        "chown root:root /usr/local/bin/cycloid-record-demo && chmod 0755 /usr/local/bin/cycloid-record-demo && cycloid-record-demo --help",
      options: { user: "root" },
    },
    {
      command:
        "chown root:root /usr/local/bin/cycloid-recorder && chmod 0755 /usr/local/bin/cycloid-recorder && cycloid-recorder --help",
      options: { user: "root" },
    },
    {
      command: [
        "set -euxo pipefail",
        "bash /app/scripts/start-dockerd.sh",
        "docker run --rm hello-world",
        "mkdir -p /tmp/cycloid-compose-smoke",
        'printf \'services:\\n  hello:\\n    image: busybox:1.36\\n    command: ["sh", "-lc", "echo docker-compose-ok"]\\n\' > /tmp/cycloid-compose-smoke/compose.yaml',
        "cd /tmp/cycloid-compose-smoke",
        "docker compose up --abort-on-container-exit --remove-orphans",
        "docker compose down --remove-orphans -v",
      ].join("\n"),
      options: { user: "root" },
    },
    { command: "chown -R user:user /workspace /app /home/user", options: { user: "root" } },
  ];
}

export function computeTemplateContentHash(options: Pick<CliOptions, "cpuCount" | "memoryMB">): string {
  const hash = createHash("sha256");
  hash.update(
    JSON.stringify({
      version: 1,
      memoryMB: options.memoryMB,
      cpuCount: options.cpuCount,
      dockerfile: dockerfile(),
      runCommands: templateRunCommands(),
      readyCmd: TEMPLATE_READY_CMD,
    }),
  );
  hash.update("\0");
  for (const input of templateCopyInputs()) {
    hash.update(JSON.stringify({ src: input.src, dest: input.dest, mode: input.mode }));
    hash.update("\0");
    hash.update(readFileSync(path.join(repoRoot, input.src)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

// Before adding ANY package/toolchain below: this is the shared base image.
// Every byte is paid on every sandbox cold-pull for every repo, forever, and
// removal is expensive (must also update ready-check.sh + the
// template-dockerfile.test.ts guardrail + ENV/PATH coupling, and ready-check.sh
// re-runs on every repo-layer build). Only tooling EVERY session needs belongs
// here; repo-specific toolchains go in the per-repo .cycloid/sandbox.layer.Dockerfile.
// See docs/sandbox-architecture.md "Base-image weight is shared cost".
export function dockerfile(): string {
  return `
FROM python:3.12-slim-bookworm

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \\
  && apt-get install -y --no-install-recommends \\
    build-essential \\
    ca-certificates \\
    curl \\
    fd-find \\
    ffmpeg \\
    file \\
    fontconfig \\
    fonts-dejavu-core \\
    fonts-firacode \\
    fonts-inter \\
    fonts-jetbrains-mono \\
    fonts-liberation \\
    fonts-liberation2 \\
    fonts-noto-color-emoji \\
    fonts-noto-core \\
    adwaita-icon-theme \\
    dbus-x11 \\
    git \\
    gnupg \\
    hicolor-icon-theme \\
    iproute2 \\
    iptables \\
    jq \\
    libasound2 \\
    libatk-bridge2.0-0 \\
    libgbm1 \\
    libgtk-3-0 \\
    libicu-dev \\
    libnss3 \\
    libxshmfence1 \\
    libzstd-dev \\
    lsof \\
    netcat-openbsd \\
    novnc \\
    openssh-client \\
    pkg-config \\
    procps \\
    ripgrep \\
    scrot \\
    sqlite3 \\
    sudo \\
    thunar \\
    tree \\
    unzip \\
    websockify \\
    wmctrl \\
    x11-xserver-utils \\
    x11vnc \\
    xdotool \\
    xfce4-panel \\
    xfce4-session \\
    xfce4-settings \\
    xfce4-terminal \\
    xfconf \\
    xfdesktop4 \\
    xfwm4 \\
    xvfb \\
  && mkdir -p /usr/local/lib/cycloid/real-bin \\
  && mv /usr/bin/git /usr/local/lib/cycloid/real-bin/git \\
  && ln -sf /usr/bin/fdfind /usr/local/bin/fd \\
  && fc-cache -f \\
  && rm -rf /var/lib/apt/lists/*

# Product font fallbacks for high-fidelity browser evidence. Mia serves Poppins
# and DM Sans from repo assets; OpenEvidence uses Schibsted Grotesk/Lora via
# next/font and Geist in the bidding app. These local fonts are a safety net
# when repo/CDN-served web fonts are unavailable or still loading in Chromium.
RUN set -eux; \\
  font_dir="/usr/local/share/fonts/cycloid-product"; \\
  tmp_dir="$(mktemp -d)"; \\
  trap 'rm -rf "$tmp_dir"' EXIT; \\
  install -d -m 0755 "$font_dir"; \\
  { \\
    echo '7e65201e9b79159e2300267cc885e16c8dcef2424cdfa09a29bfb0980a94a7ba|https://raw.githubusercontent.com/google/fonts/${GOOGLE_FONTS_COMMIT}/ofl/poppins/Poppins-Regular.ttf|Poppins-Regular.ttf'; \\
    echo '4fa76ae75b40f926420514044722cb97f32186cafd3b38263cc34dad7174d46d|https://raw.githubusercontent.com/google/fonts/${GOOGLE_FONTS_COMMIT}/ofl/poppins/Poppins-Italic.ttf|Poppins-Italic.ttf'; \\
    echo '650ba57fa99d12ec40c31ccfb680be656be4497fbe14164617d67e32ffe9cd46|https://raw.githubusercontent.com/google/fonts/${GOOGLE_FONTS_COMMIT}/ofl/poppins/Poppins-Light.ttf|Poppins-Light.ttf'; \\
    echo 'b8f9c5be59723fadf8e5447fa1245c2c53b60a3464a24d6ece9ee3c283d8917b|https://raw.githubusercontent.com/google/fonts/${GOOGLE_FONTS_COMMIT}/ofl/poppins/Poppins-LightItalic.ttf|Poppins-LightItalic.ttf'; \\
    echo '90373e7d838d32468438fc3e152dca0bdb12edcab99ea639f158790b1ba1fd05|https://raw.githubusercontent.com/google/fonts/${GOOGLE_FONTS_COMMIT}/ofl/poppins/Poppins-Medium.ttf|Poppins-Medium.ttf'; \\
    echo '983676516167748b74de6f4771fb384c664fd913acb8b471122ecacf5da5ea6c|https://raw.githubusercontent.com/google/fonts/${GOOGLE_FONTS_COMMIT}/ofl/poppins/Poppins-Bold.ttf|Poppins-Bold.ttf'; \\
    echo '3572ac8116a0ac7317d342262b29937bcbaf94d8f03f90df6fe666fa7e2fb43a|https://raw.githubusercontent.com/google/fonts/${GOOGLE_FONTS_COMMIT}/ofl/poppins/Poppins-BoldItalic.ttf|Poppins-BoldItalic.ttf'; \\
    echo '8cd08d97e89c24d0aa92edd2f0f4c8ee6195eee9b7c9f154865a58b02f0c1c0d|https://raw.githubusercontent.com/google/fonts/${GOOGLE_FONTS_COMMIT}/ofl/dmsans/DMSans%5Bopsz%2Cwght%5D.ttf|DMSans-Variable.ttf'; \\
    echo '22259c0cc8237221b80f44c76ba8d36e6bce3cda72779f5b2773643d499720ae|https://raw.githubusercontent.com/google/fonts/${GOOGLE_FONTS_COMMIT}/ofl/dmsans/DMSans-Italic%5Bopsz%2Cwght%5D.ttf|DMSans-Italic-Variable.ttf'; \\
    echo '6ceeadf6be8e1fd7687011c7fa38ed0edd1abe967a0b73d97caec183552e823d|https://raw.githubusercontent.com/google/fonts/${GOOGLE_FONTS_COMMIT}/ofl/schibstedgrotesk/SchibstedGrotesk%5Bwght%5D.ttf|SchibstedGrotesk-Variable.ttf'; \\
    echo 'b49fedb6f3a2ff9b43e13351888641505dc8e5f300941e597eecbc3f52ba357b|https://raw.githubusercontent.com/google/fonts/${GOOGLE_FONTS_COMMIT}/ofl/schibstedgrotesk/SchibstedGrotesk-Italic%5Bwght%5D.ttf|SchibstedGrotesk-Italic-Variable.ttf'; \\
    echo '822a6621ccbe8d97d20ac88c1c41f5615c9c2c202eaa75f272cd452aac6475a7|https://raw.githubusercontent.com/google/fonts/${GOOGLE_FONTS_COMMIT}/ofl/lora/Lora%5Bwght%5D.ttf|Lora-Variable.ttf'; \\
    echo '22d8d8854b53807aa664ca34f2031a9ed57a1d0dea296b8b96cdd3aad937a2b3|https://raw.githubusercontent.com/google/fonts/${GOOGLE_FONTS_COMMIT}/ofl/lora/Lora-Italic%5Bwght%5D.ttf|Lora-Italic-Variable.ttf'; \\
    echo '73894e0448cae90a92b6c2f8732b7bb9acb7b94c418bff559dad4a18e1de9659|https://raw.githubusercontent.com/vercel/geist-font/${GEIST_FONT_COMMIT}/packages/next/dist/fonts/geist-sans/Geist-Variable.ttf|Geist-Variable.ttf'; \\
    echo '87c2aff9723544a9adaea19d92e42a33705c9723624801b6e0224c2206a6af0d|https://raw.githubusercontent.com/vercel/geist-font/${GEIST_FONT_COMMIT}/packages/next/dist/fonts/geist-mono/GeistMono-Variable.ttf|GeistMono-Variable.ttf'; \\
  } > "$tmp_dir/fonts.manifest"; \\
  while IFS='|' read -r expected_sha url filename; do \\
    curl -fsSL --retry 3 --retry-delay 2 "$url" -o "$tmp_dir/$filename"; \\
    echo "$expected_sha  $tmp_dir/$filename" | sha256sum -c -; \\
    install -m 0644 "$tmp_dir/$filename" "$font_dir/$filename"; \\
  done < "$tmp_dir/fonts.manifest"; \\
  fc-cache -f; \\
  fc-match "Poppins" | grep -qi "Poppins"; \\
  fc-match "DM Sans" | grep -qi "DM Sans"; \\
  fc-match "Schibsted Grotesk" | grep -qi "Schibsted Grotesk"; \\
  fc-match "Lora" | grep -qi "Lora"; \\
  fc-match "Geist" | grep -qi "Geist"; \\
  fc-match "Geist Mono" | grep -qi "Geist Mono"

RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \\
  && apt-get update \\
  && apt-get install -y --no-install-recommends nodejs \\
  && node --version \\
  && npm --version \\
  && rm -rf /var/lib/apt/lists/*

# agent-browser is NOT run with its "install" subcommand: that downloads its own
# Chrome-for-Testing build (~684 MB). Instead AGENT_BROWSER_EXECUTABLE_PATH (set
# below) points agent-browser at Playwright's pre-baked Chromium, so the base
# ships one Chromium for both agent-browser and e2e tests.
RUN PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install -g agent-browser@${AGENT_BROWSER_VERSION} playwright@${PLAYWRIGHT_VERSION} \\
  && NODE_PATH="$(npm root -g)" node -e "require('playwright')" \\
  && mkdir -p /opt/cycloid/ms-playwright \\
  && PLAYWRIGHT_BROWSERS_PATH=/opt/cycloid/ms-playwright playwright install --with-deps chromium \\
  && npm_root="$(npm root -g)" \\
  && chromium_path="$(PLAYWRIGHT_BROWSERS_PATH=/opt/cycloid/ms-playwright NODE_PATH="$npm_root" node -e 'process.stdout.write(require("playwright").chromium.executablePath())')" \\
  && test -x "$chromium_path" \\
  && chown -R root:root /opt/cycloid/ms-playwright \\
  && chmod -R a+rX,go-w /opt/cycloid/ms-playwright \\
  && ln -sf "$chromium_path" /usr/local/bin/chromium \\
  && test "$(readlink -f /usr/local/bin/chromium)" = "$chromium_path" \\
  && chromium --version \\
  && playwright --version \\
  && npm cache clean --force

RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \\
    | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \\
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \\
    | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \\
  && apt-get update \\
  && apt-get install -y --no-install-recommends gh \\
  && mkdir -p /usr/local/lib/cycloid/real-bin \\
  && mv /usr/bin/gh /usr/local/lib/cycloid/real-bin/gh \\
  && /usr/local/lib/cycloid/real-bin/gh --version \\
  && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://ngrok-agent.s3.amazonaws.com/ngrok.asc \\
    | tee /etc/apt/trusted.gpg.d/ngrok.asc > /dev/null \\
  && echo "deb https://ngrok-agent.s3.amazonaws.com bookworm main" \\
    | tee /etc/apt/sources.list.d/ngrok.list > /dev/null \\
  && apt-get update \\
  && apt-get install -y --no-install-recommends ngrok \\
  && ngrok version \\
  && rm -rf /var/lib/apt/lists/*

RUN set -eux; \\
  just_arch="$(uname -m)"; \\
  case "$just_arch" in \\
    x86_64) just_arch="x86_64-unknown-linux-musl" ;; \\
    aarch64|arm64) just_arch="aarch64-unknown-linux-musl" ;; \\
    *) echo "unsupported just architecture: $just_arch" >&2; exit 1 ;; \\
  esac; \\
  just_archive="just-${JUST_VERSION}-$just_arch.tar.gz"; \\
  curl -fsSL "https://github.com/casey/just/releases/download/${JUST_VERSION}/SHA256SUMS" \\
    -o /tmp/just_SHA256SUMS; \\
  curl -fsSL "https://github.com/casey/just/releases/download/${JUST_VERSION}/$just_archive" \\
    -o "/tmp/$just_archive"; \\
  grep " $just_archive$" /tmp/just_SHA256SUMS \\
    | sed "s# $just_archive# /tmp/$just_archive#" \\
    | sha256sum -c -; \\
  tar -xzf "/tmp/$just_archive" -C /usr/local/bin just; \\
  chmod 755 /usr/local/bin/just; \\
  just --version; \\
  rm -f "/tmp/$just_archive" /tmp/just_SHA256SUMS

RUN echo 'user ALL=(root) NOPASSWD:SETENV: /usr/local/sbin/cycloid-enforce-egress' > /etc/sudoers.d/cycloid-egress \\
  && chmod 0440 /etc/sudoers.d/cycloid-egress

RUN set -eux; \\
  apt-get update; \\
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends docker.io; \\
  (DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends docker-compose-plugin \\
    || DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends docker-compose-v2 \\
    || true); \\
  if ! docker compose version >/dev/null 2>&1; then \\
    compose_arch="$(uname -m)"; \\
    case "$compose_arch" in \\
      x86_64) compose_arch="x86_64" ;; \\
      aarch64|arm64) compose_arch="aarch64" ;; \\
      *) echo "unsupported Docker Compose architecture: $compose_arch" >&2; exit 1 ;; \\
    esac; \\
    mkdir -p /usr/local/lib/docker/cli-plugins; \\
    curl -fsSL "https://github.com/docker/compose/releases/download/v2.29.7/docker-compose-linux-$compose_arch" \\
      -o /usr/local/lib/docker/cli-plugins/docker-compose; \\
    curl -fsSL "https://github.com/docker/compose/releases/download/v2.29.7/docker-compose-linux-$compose_arch.sha256" \\
      -o /tmp/docker-compose.sha256; \\
    expected_sha="$(cut -d ' ' -f1 /tmp/docker-compose.sha256)"; \\
    echo "$expected_sha  /usr/local/lib/docker/cli-plugins/docker-compose" | sha256sum -c -; \\
    chmod 755 /usr/local/lib/docker/cli-plugins/docker-compose; \\
  fi; \\
  usermod -aG docker user; \\
  echo 'user ALL=(root) NOPASSWD:SETENV: /app/scripts/start-dockerd.sh' > /etc/sudoers.d/cycloid-dockerd; \\
  chmod 0440 /etc/sudoers.d/cycloid-dockerd; \\
  docker --version; \\
  docker compose version; \\
  rm -rf /var/lib/apt/lists/*

RUN npm install -g \\
    pnpm \\
    yarn \\
    typescript@${TYPESCRIPT_VERSION} \\
  && pnpm --version \\
  && yarn --version \\
  && tsc --version \\
  && NODE_PATH="$(npm root -g)" node -e "const ts=require('typescript'); if (ts.version !== '${TYPESCRIPT_VERSION}') throw new Error('unexpected TypeScript '+ts.version)" \\
  && npm cache clean --force

RUN curl -fsSL https://bun.sh/install | bash \\
  && cp /root/.bun/bin/bun /usr/local/bin/bun \\
  && chmod 755 /usr/local/bin/bun \\
  && bun --version \\
  && rm -rf /root/.bun

RUN pip install --no-cache-dir \\
    black \\
    httpx \\
    mypy \\
    "pydantic>=2.0" \\
    pytest \\
    pytest-asyncio \\
    pytest-cov \\
    pytest-mock \\
    pytest-timeout \\
    "pre-commit==${PRE_COMMIT_VERSION}" \\
    ruff \\
    uv \\
  && uv --version \\
  && pytest --version \\
  && pre-commit --version \\
  && python -c "import pytest; print('python-test-tooling-ok')"

RUN mkdir -p \\
    /workspace/repo \\
    /app/bridge \\
    /app/bridge-tools \\
    /app/scripts \\
    /tmp/codex-home

RUN set -eux; \\
  terraform_arch="$(uname -m)"; \\
  case "$terraform_arch" in \\
    x86_64) terraform_arch="amd64" ;; \\
    aarch64|arm64) terraform_arch="arm64" ;; \\
    *) echo "unsupported terraform architecture: $terraform_arch" >&2; exit 1 ;; \\
  esac; \\
  terraform_zip="terraform_${TERRAFORM_VERSION}_linux_\${terraform_arch}.zip"; \\
  curl -fsSL "https://releases.hashicorp.com/terraform/${TERRAFORM_VERSION}/terraform_${TERRAFORM_VERSION}_SHA256SUMS" \\
    -o /tmp/terraform_SHA256SUMS; \\
  curl -fsSL "https://releases.hashicorp.com/terraform/${TERRAFORM_VERSION}/$terraform_zip" \\
    -o "/tmp/$terraform_zip"; \\
  grep " $terraform_zip$" /tmp/terraform_SHA256SUMS \\
    | sed "s# $terraform_zip# /tmp/$terraform_zip#" \\
    | sha256sum -c -; \\
  unzip -q "/tmp/$terraform_zip" -d /app/bridge-tools; \\
  chmod 0755 /app/bridge-tools/terraform; \\
  /app/bridge-tools/terraform version; \\
  rm -f "/tmp/$terraform_zip" /tmp/terraform_SHA256SUMS

# Keep static toolchains and their heavy downloads above frequently-bumped CLI
# pins, so a CLI version change only rebuilds the small npm layers below.
RUN npm install -g @openai/codex@${CODEX_CLI_VERSION} \\
  && codex --version \\
  && npm cache clean --force

RUN npm install -g opencode-ai@${OPENCODE_CLI_VERSION} \\
  && opencode --version \\
  && npm cache clean --force

RUN npm install -g @trycycloid/cli@${CYCLOID_CLI_VERSION} \\
  && cycloid --version \\
  && npm cache clean --force

# The claude_code agent-runtime backend drives the Claude Agent SDK's own
# version-locked native binary (installed in /app/bridge/node_modules), not a
# global claude-code CLI, so no global @anthropic-ai/claude-code is installed.
# The backend is selected per session via ARCANIST_AGENT_RUNTIME_BACKEND.

# The bridge bundle externalizes sharp and @anthropic-ai/claude-agent-sdk, so both
# are installed here in /app/bridge where the bundle resolves them at runtime. The
# SDK pulls its platform-specific native CLI binary (an optional dependency); the
# claude_code backend drives that binary, not the global claude-code CLI. The
# startup smoke confirms ESM resolution finds the SDK + its native binary.
RUN cd /app/bridge \\
  && npm init -y \\
  && npm pkg set type=module \\
  && npm install sharp @anthropic-ai/claude-agent-sdk@${CLAUDE_AGENT_SDK_VERSION} @opencode-ai/sdk@${OPENCODE_SDK_VERSION} \\
  && node -e "import('@anthropic-ai/claude-agent-sdk').then((m) => { if (typeof m.query !== 'function') throw new Error('claude-agent-sdk query export missing'); console.log('bridge-claude-agent-sdk-ok'); })" \\
  && node -e "import('@opencode-ai/sdk').then((m) => { if (typeof m.createOpencode !== 'function' || typeof m.createOpencodeServer !== 'function') throw new Error('opencode sdk exports missing'); console.log('bridge-opencode-sdk-ok'); })" \\
  && npm cache clean --force \\
  && echo 'bridge-sharp-v1'

# Recreate /tmp/codex-home in this layer before chown: the E2B builder does not
# carry /tmp across RUN layers, so the earlier mkdir does not survive to here.
RUN mkdir -p /tmp/codex-home \\
  && chown -R user:user /workspace /app /home/user /tmp/codex-home

ENV HOME=/home/user
ENV DISPLAY=:99
# Point agent-browser at the Playwright-managed Chromium instead of letting it
# download its own ~684 MB Chrome-for-Testing build.
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/local/bin/chromium
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/cycloid/ms-playwright
ENV NODE_ENV=development
ENV NODE_PATH=/usr/local/lib/node_modules:/usr/lib/node_modules
ENV ARCANIST_TYPESCRIPT_VERSION=${TYPESCRIPT_VERSION}
ENV PYTHONPATH=/app
# Auto-load the pytest-xdist worker cap (baked at /app, on PYTHONPATH above) for
# every pytest run so a repo's CI-sized -n can't OOM the sandbox. Survives bash -lc
# like PYTHONPATH (login shells only reset PATH). No-op when pytest-xdist is absent.
ENV PYTEST_ADDOPTS=-p cycloid_xdist_cap
ENV PATH=/app/scripts:/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin
WORKDIR /workspace/repo
`.trim();
}

async function main(): Promise<void> {
  loadLocalDevVars();
  const options = parseArgs(process.argv.slice(2));
  if (options.apiKey) {
    process.env.E2B_API_KEY = options.apiKey;
  }
  if (options.printContentHash) {
    process.stdout.write(`E2B_TEMPLATE_CONTENT_HASH=${computeTemplateContentHash(options)}\n`);
    return;
  }
  if (!process.env.E2B_API_KEY) {
    throw new Error("E2B_API_KEY is required to build an E2B sandbox template");
  }

  const copyInputs = templateCopyInputs();
  let templateBuilder = Template({ fileContextPath: repoRoot }).fromDockerfile(dockerfile()).copyItems(copyInputs);
  for (const step of templateRunCommands()) {
    templateBuilder = templateBuilder.runCmd(step.command, step.options);
  }
  const template = templateBuilder.setReadyCmd(TEMPLATE_READY_CMD);

  const build = await Template.build(template, options.name, {
    cpuCount: options.cpuCount,
    memoryMB: options.memoryMB,
    skipCache: options.skipCache,
    onBuildLogs: defaultBuildLogger({ minLevel: "info" }),
  });

  process.stdout.write(`${JSON.stringify(build, null, 2)}\n`);
  process.stdout.write(`E2B_TEMPLATE_CPU_COUNT=${options.cpuCount}\n`);
  process.stdout.write(`E2B_TEMPLATE_MEMORY_MB=${options.memoryMB}\n`);
  process.stdout.write(`E2B_SANDBOX_TEMPLATE=${build.name}\n`);
}

// Only run the CLI when invoked directly (e.g. `tsx template.ts ...` from the build script).
// Guarding this lets tests import computeTemplateContentHash() in-process instead of spawning
// the CLI, which is far faster and avoids parseArgs() rejecting the test runner's argv.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
