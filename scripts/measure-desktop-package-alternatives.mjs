#!/usr/bin/env node
import { spawnSync } from "node:child_process";

export const BASE_IMAGE = "python:3.12-slim-bookworm";

const COMMON_DESKTOP_PACKAGES = [
  "ffmpeg",
  "fonts-dejavu-core",
  "fonts-liberation",
  "fonts-noto-color-emoji",
  "novnc",
  "scrot",
  "websockify",
  "wmctrl",
  "x11-xserver-utils",
  "x11vnc",
  "xdotool",
  "xvfb",
];

const XFCE_CORE_PACKAGES = [
  "adwaita-icon-theme",
  "dbus-x11",
  "hicolor-icon-theme",
  "thunar",
  "xfce4-panel",
  "xfce4-session",
  "xfce4-settings",
  "xfce4-terminal",
  "xfconf",
  "xfdesktop4",
  "xfwm4",
];

export const DESKTOP_PACKAGE_VARIANTS = [
  {
    id: "minimal-openbox-current",
    label: "Current Openbox desktop stack",
    packages: [...COMMON_DESKTOP_PACKAGES, "openbox", "tint2"].sort(),
  },
  {
    id: "xfce-core",
    label: "XFCE-core candidate stack",
    packages: [...COMMON_DESKTOP_PACKAGES, ...XFCE_CORE_PACKAGES].sort(),
  },
  {
    id: "xfce4-metapackage",
    label: "Debian xfce4 metapackage stack",
    packages: [...COMMON_DESKTOP_PACKAGES, "xfce4"].sort(),
  },
  {
    id: "xfce4-goodies-upper-bound",
    label: "Debian xfce4 + xfce4-goodies rejected upper bound",
    packages: [...COMMON_DESKTOP_PACKAGES, "xfce4", "xfce4-goodies"].sort(),
  },
];

function usage() {
  return [
    "Usage: node scripts/measure-desktop-package-alternatives.mjs [options]",
    "",
    "Options:",
    "  --variant <id>      Measure only one variant. Repeatable.",
    "  --include-goodies   Include the rejected xfce4-goodies upper-bound variant.",
    "  --json              Print JSON instead of text.",
    "  --print-commands    Print reproducible docker run commands without running them.",
    "  --help              Show this help.",
    "",
    "Default variants: minimal-openbox-current, xfce-core, xfce4-metapackage.",
  ].join("\n");
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function buildContainerMeasurementScript(packages) {
  const packageArgs = packages.map(shellQuote).join(" ");

  return [
    "set -euo pipefail",
    "export DEBIAN_FRONTEND=noninteractive",
    "before_kib=$(du -sx -k / | awk '{print $1}')",
    "apt-get update >/dev/null",
    `apt-get install -y --no-install-recommends ${packageArgs} >/dev/null`,
    "rm -rf /var/lib/apt/lists/*",
    "after_kib=$(du -sx -k / | awk '{print $1}')",
    'printf "SIZE_DELTA_KIB=%s\\n" "$((after_kib - before_kib))"',
    'printf "ROOTFS_AFTER_KIB=%s\\n" "$after_kib"',
    `printf "REQUESTED_PACKAGE_COUNT=%s\\n" "${packages.length}"`,
    'printf "VERSIONS_BEGIN\\n"',
    "dpkg-query -W -f='${Package}=${Version}\\n' " + packageArgs + " | sort",
    'printf "VERSIONS_END\\n"',
  ].join("\n");
}

export function buildDockerRunArgs(packages) {
  return ["run", "--rm", "--pull=missing", BASE_IMAGE, "bash", "-lc", buildContainerMeasurementScript(packages)];
}

export function parseMeasurementOutput(output) {
  const values = new Map();
  const versions = [];
  let inVersions = false;

  for (const rawLine of output.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    if (line === "VERSIONS_BEGIN") {
      inVersions = true;
      continue;
    }
    if (line === "VERSIONS_END") {
      inVersions = false;
      continue;
    }
    if (inVersions) {
      versions.push(line);
      continue;
    }
    const match = line.match(/^([A-Z_]+)=([0-9]+)$/u);
    if (match) {
      values.set(match[1], Number(match[2]));
    }
  }

  const sizeDeltaKiB = values.get("SIZE_DELTA_KIB");
  const rootfsAfterKiB = values.get("ROOTFS_AFTER_KIB");
  const requestedPackageCount = values.get("REQUESTED_PACKAGE_COUNT");

  if (sizeDeltaKiB === undefined || rootfsAfterKiB === undefined || requestedPackageCount === undefined) {
    throw new Error(`measurement output missing required fields:\n${output}`);
  }

  return {
    sizeDeltaKiB,
    rootfsAfterKiB,
    requestedPackageCount,
    versions,
  };
}

function parseArgs(argv) {
  const options = {
    includeGoodies: false,
    json: false,
    printCommands: false,
    variantIds: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (arg === "--include-goodies") {
      options.includeGoodies = true;
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--print-commands") {
      options.printCommands = true;
      continue;
    }
    if (arg === "--variant") {
      const id = argv[index + 1];
      if (!id) {
        throw new Error("--variant requires an id");
      }
      options.variantIds.push(id);
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }

  return options;
}

export function selectVariants(options) {
  const byId = new Map(DESKTOP_PACKAGE_VARIANTS.map((variant) => [variant.id, variant]));
  const defaultIds = ["minimal-openbox-current", "xfce-core", "xfce4-metapackage"];
  const ids = options.variantIds.length > 0 ? options.variantIds : defaultIds;
  const selected = ids.map((id) => {
    const variant = byId.get(id);
    if (!variant) {
      throw new Error(
        `unknown variant '${id}'. Known variants: ${DESKTOP_PACKAGE_VARIANTS.map((v) => v.id).join(", ")}`,
      );
    }
    return variant;
  });

  if (options.includeGoodies && !selected.some((variant) => variant.id === "xfce4-goodies-upper-bound")) {
    selected.push(byId.get("xfce4-goodies-upper-bound"));
  }

  return selected;
}

function runMeasurement(variant) {
  const result = spawnSync("docker", buildDockerRunArgs(variant.packages), {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.status !== 0) {
    const error = result.stderr.trim() || result.stdout.trim() || "docker measurement failed";
    throw new Error(`${variant.id}: ${error}`);
  }

  return {
    id: variant.id,
    label: variant.label,
    packages: variant.packages,
    ...parseMeasurementOutput(result.stdout),
  };
}

function formatText(results) {
  const sections = [`BASE_IMAGE=${BASE_IMAGE}`];
  for (const result of results) {
    sections.push(
      [
        "",
        `## ${result.id}`,
        `LABEL=${result.label}`,
        `SIZE_DELTA_KIB=${result.sizeDeltaKiB}`,
        `ROOTFS_AFTER_KIB=${result.rootfsAfterKiB}`,
        `REQUESTED_PACKAGE_COUNT=${result.requestedPackageCount}`,
        "VERSIONS:",
        ...result.versions,
      ].join("\n"),
    );
  }
  return sections.join("\n");
}

function printCommands(variants) {
  for (const variant of variants) {
    const command = ["docker", ...buildDockerRunArgs(variant.packages).map(shellQuote)].join(" ");
    console.log(`# ${variant.id}: ${variant.label}`);
    console.log(command);
  }
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const variants = selectVariants(options);

    if (options.printCommands) {
      printCommands(variants);
      return;
    }

    const results = variants.map(runMeasurement);
    if (options.json) {
      console.log(JSON.stringify({ baseImage: BASE_IMAGE, results }, null, 2));
    } else {
      console.log(formatText(results));
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error("");
    console.error(usage());
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
