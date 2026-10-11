import { describe, expect, it } from "vitest";

import {
  parseEgressAllowlistSourceFile,
  serializeEgressAllowlistSourceFile,
} from "../../shared/egress-allowlist/parser";

describe("egress allowlist source parser", () => {
  it("parses one exact domain per line with normalization", () => {
    expect(parseEgressAllowlistSourceFile("Registry.Acme.test\napi.acme.test\n\n")).toEqual([
      "api.acme.test",
      "registry.acme.test",
    ]);
  });

  it("rejects protocols, comments, wildcards, IPs, and comma-separated entries", () => {
    for (const content of [
      "https://api.acme.test\n",
      "# api.acme.test\n",
      "*.acme.test\n",
      "192.168.1.1\n",
      "api.acme.test,registry.acme.test\n",
    ]) {
      expect(() => parseEgressAllowlistSourceFile(content)).toThrow(
        ".cycloid/egress-allowlist.txt entries must be exact domain names",
      );
    }
  });

  it("serializes sorted unique domains with a trailing newline", () => {
    expect(serializeEgressAllowlistSourceFile(["Registry.Acme.test", "api.acme.test"])).toBe(
      "api.acme.test\nregistry.acme.test\n",
    );
  });
});
