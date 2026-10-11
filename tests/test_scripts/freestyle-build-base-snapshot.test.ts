import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

type SnapshotScriptModule = {
  SNAPSHOT_METADATA_PATH: string;
  buildEnvShim(args: { chromiumInstalled: boolean; typescriptVersion: string }): string;
  buildSnapshotMetadata(args: { chromiumInstalled: boolean; chromiumStatus: string }): string;
  snapshotMetadataCheckCommand(args: { chromiumInstalled: boolean; chromiumStatus: string }): string;
};

const { buildEnvShim, buildSnapshotMetadata, snapshotMetadataCheckCommand, SNAPSHOT_METADATA_PATH } = (await import(
  new URL("../../scripts/freestyle-build-base-snapshot.mjs", import.meta.url).href
)) as SnapshotScriptModule;

describe("freestyle-build-base-snapshot browser contract", () => {
  it("installs the same product font fallback families as the E2B template", () => {
    const source = readFileSync(new URL("../../scripts/freestyle-build-base-snapshot.mjs", import.meta.url), "utf8");

    expect(source).toContain('readTemplateConst("GOOGLE_FONTS_COMMIT")');
    expect(source).toContain('readTemplateConst("GEIST_FONT_COMMIT")');
    expect(source).toContain("install product font fallbacks");
    expect(source).toContain("7e65201e9b79159e2300267cc885e16c8dcef2424cdfa09a29bfb0980a94a7ba");
    expect(source).toContain("87c2aff9723544a9adaea19d92e42a33705c9723624801b6e0224c2206a6af0d");
    expect(source).toContain("sha256sum -c -");
    expect(source).toContain('done < "$tmp_dir/fonts.manifest"');
    expect(source).toContain("Poppins-Regular.ttf");
    expect(source).toContain("DMSans%5Bopsz%2Cwght%5D.ttf");
    expect(source).toContain("SchibstedGrotesk%5Bwght%5D.ttf");
    expect(source).toContain("Lora%5Bwght%5D.ttf");
    expect(source).toContain("Geist-Variable.ttf");
    expect(source).toContain("GeistMono-Variable.ttf");
  });

  it("exports the Chromium path only when the snapshot has a browser", () => {
    const envShim = buildEnvShim({ chromiumInstalled: true, typescriptVersion: "5.9.3" });

    expect(envShim).toContain("export AGENT_BROWSER_EXECUTABLE_PATH=/usr/local/bin/chromium");
    expect(envShim).toContain("export ARCANIST_TYPESCRIPT_VERSION=5.9.3");
    expect(envShim).toContain("export PYTHONPATH=/app");
  });

  it("omits the Chromium path when the snapshot is browser-less", () => {
    const envShim = buildEnvShim({ chromiumInstalled: false, typescriptVersion: "5.9.3" });

    expect(envShim).not.toContain("AGENT_BROWSER_EXECUTABLE_PATH");
    expect(envShim).toContain("export HOME=/home/user");
    expect(envShim).toContain("export NODE_ENV=development");
  });

  it("writes a stable browser-capability marker with the current Chromium status", () => {
    expect(SNAPSHOT_METADATA_PATH).toBe("/app/cycloid-snapshot-metadata.json");

    const metadata = JSON.parse(
      buildSnapshotMetadata({
        chromiumInstalled: false,
        chromiumStatus: "SKIPPED (chromium-less build): slow egress",
      }),
    );

    expect(metadata).toEqual({
      hasBrowser: false,
      chromiumStatus: "SKIPPED (chromium-less build): slow egress",
    });
  });

  it("marks browser-capable snapshots explicitly", () => {
    const metadata = JSON.parse(
      buildSnapshotMetadata({
        chromiumInstalled: true,
        chromiumStatus: "installed (curl+unzip seed; playwright install no-op gate passed)",
      }),
    );

    expect(metadata.hasBrowser).toBe(true);
    expect(metadata.chromiumStatus).toContain("installed");
  });

  it("escapes quoted chromium statuses in the metadata check command", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "freestyle-snapshot-meta-"));
    try {
      const appDir = join(tempDir, "app");
      const binDir = join(tempDir, "bin");
      const metadataPath = join(appDir, "cycloid-snapshot-metadata.json");
      const nodeCapturePath = join(tempDir, "node-capture.txt");
      const nodeShimPath = join(binDir, "node");
      const quotedStatus = `SKIPPED (chromium-less build): curl said "no" and user isn't root`;

      mkdirSync(appDir, { recursive: true });
      mkdirSync(binDir, { recursive: true });
      writeFileSync(metadataPath, buildSnapshotMetadata({ chromiumInstalled: false, chromiumStatus: quotedStatus }));
      writeFileSync(
        nodeShimPath,
        [
          "#!/usr/bin/env bash",
          "{",
          "  printf 'has=%s\\n' \"$EXPECTED_HAS_BROWSER\"",
          "  printf 'status=%s\\n' \"$EXPECTED_CHROMIUM_STATUS\"",
          "  printf 'arg1=%s\\n' \"$1\"",
          "  printf 'script=%s\\n' \"$2\"",
          '} > "$NODE_CAPTURE_PATH"',
          "printf 'snapshot-metadata-ok\\n'",
          "",
        ].join("\n"),
      );
      chmodSync(nodeShimPath, 0o755);

      const command = snapshotMetadataCheckCommand({
        chromiumInstalled: false,
        chromiumStatus: quotedStatus,
      }).replace(SNAPSHOT_METADATA_PATH, metadataPath);

      const output = execFileSync("bash", ["-c", command], {
        encoding: "utf8",
        env: { ...process.env, NODE_CAPTURE_PATH: nodeCapturePath, PATH: `${binDir}:${process.env.PATH ?? ""}` },
      }).trim();
      expect(output).toBe("snapshot-metadata-ok");
      expect(readFileSync(nodeCapturePath, "utf8")).toContain(`status=${quotedStatus}\n`);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 15_000);
});
