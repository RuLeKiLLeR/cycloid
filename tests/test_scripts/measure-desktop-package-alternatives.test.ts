import { execFileSync } from "node:child_process";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

type MeasurementScriptModule = {
  BASE_IMAGE: string;
  DESKTOP_PACKAGE_VARIANTS: Array<{ id: string; label: string; packages: string[] }>;
  buildDockerRunArgs(packages: string[]): string[];
  parseMeasurementOutput(output: string): {
    sizeDeltaKiB: number;
    rootfsAfterKiB: number;
    requestedPackageCount: number;
    versions: string[];
  };
  selectVariants(options: {
    includeGoodies: boolean;
    json: boolean;
    printCommands: boolean;
    variantIds: string[];
  }): Array<{
    id: string;
    label: string;
    packages: string[];
  }>;
};

const SCRIPT_PATH = join(__dirname, "../../scripts/measure-desktop-package-alternatives.mjs");

const { BASE_IMAGE, DESKTOP_PACKAGE_VARIANTS, buildDockerRunArgs, parseMeasurementOutput, selectVariants } =
  (await import(
    new URL("../../scripts/measure-desktop-package-alternatives.mjs", import.meta.url).href
  )) as MeasurementScriptModule;

describe("desktop package alternative measurement helper", () => {
  it("keeps the current Openbox and XFCE package sets distinct", () => {
    const minimal = DESKTOP_PACKAGE_VARIANTS.find((variant) => variant.id === "minimal-openbox-current");
    const xfceCore = DESKTOP_PACKAGE_VARIANTS.find((variant) => variant.id === "xfce-core");
    const xfce4 = DESKTOP_PACKAGE_VARIANTS.find((variant) => variant.id === "xfce4-metapackage");
    const goodies = DESKTOP_PACKAGE_VARIANTS.find((variant) => variant.id === "xfce4-goodies-upper-bound");

    expect(minimal?.packages).toEqual(expect.arrayContaining(["openbox", "tint2", "xvfb", "x11vnc"]));
    expect(xfceCore?.packages).toEqual(expect.arrayContaining(["dbus-x11", "xfwm4", "xfce4-panel"]));
    expect(xfceCore?.packages).not.toEqual(expect.arrayContaining(["openbox", "tint2", "xfce4-goodies"]));
    expect(xfce4?.packages).toEqual(expect.arrayContaining(["xfce4", "xvfb", "x11vnc"]));
    expect(xfce4?.packages).not.toContain("xfce4-goodies");
    expect(goodies?.packages).toEqual(expect.arrayContaining(["xfce4", "xfce4-goodies"]));
  });

  it("selects only required variants by default and adds goodies explicitly", () => {
    const defaults = selectVariants({ includeGoodies: false, json: false, printCommands: false, variantIds: [] });
    expect(defaults.map((variant) => variant.id)).toEqual([
      "minimal-openbox-current",
      "xfce-core",
      "xfce4-metapackage",
    ]);

    const withGoodies = selectVariants({ includeGoodies: true, json: false, printCommands: false, variantIds: [] });
    expect(withGoodies.map((variant) => variant.id)).toEqual([
      "minimal-openbox-current",
      "xfce-core",
      "xfce4-metapackage",
      "xfce4-goodies-upper-bound",
    ]);
  });

  it("builds a docker run command pinned to the Bookworm Python base image", () => {
    const args = buildDockerRunArgs(["xvfb", "xfwm4"]);

    expect(args.slice(0, 5)).toEqual(["run", "--rm", "--pull=missing", BASE_IMAGE, "bash"]);
    expect(args[5]).toBe("-lc");
    expect(args[6]).toContain("apt-get install -y --no-install-recommends 'xvfb' 'xfwm4'");
    expect(args[6]).toContain("rm -rf /var/lib/apt/lists/*");
    expect(args[6]).toContain("SIZE_DELTA_KIB");
  });

  it("parses container measurement output", () => {
    expect(
      parseMeasurementOutput(
        [
          "SIZE_DELTA_KIB=12345",
          "ROOTFS_AFTER_KIB=45678",
          "REQUESTED_PACKAGE_COUNT=2",
          "VERSIONS_BEGIN",
          "xfce4-panel=4.18.4-1",
          "xfwm4=4.18.0-1",
          "VERSIONS_END",
          "",
        ].join("\n"),
      ),
    ).toEqual({
      sizeDeltaKiB: 12345,
      rootfsAfterKiB: 45678,
      requestedPackageCount: 2,
      versions: ["xfce4-panel=4.18.4-1", "xfwm4=4.18.0-1"],
    });
  });

  it("prints a single reproducible docker command for a selected variant", () => {
    const output = execFileSync("node", [SCRIPT_PATH, "--print-commands", "--variant", "xfce-core"], {
      encoding: "utf8",
    });

    expect(output).toContain("# xfce-core: XFCE-core candidate stack");
    expect(output).toContain("docker 'run' '--rm' '--pull=missing'");
    expect(output).toContain("'dbus-x11'");
    expect(output).toContain("'xfce4-panel'");
    expect(output).not.toContain("xfce4-goodies");
  });
});
