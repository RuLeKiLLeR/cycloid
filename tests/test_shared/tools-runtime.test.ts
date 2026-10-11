import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { EmbeddedTool } from "../../shared/tools-runtime/index.js";
import {
  buildToolCatalog,
  loadTools,
  MissingToolSecretError,
  parseToml,
  secret,
  ToolManifestSchema,
  validateToolInput,
} from "../../shared/tools-runtime/index.js";

const fixtureModule = {
  methods: {
    ping: {
      description: "Ping the fixture tool",
      inputSchema: z.object({ message: z.string() }),
      planMode: "readOnly" as const,
      execute: async (args: { message: string }) => ({ echoed: args.message }),
    },
  },
};

function fixtureTool(manifestText: string, manifestPath = "tools/fixture/manifest.toml"): EmbeddedTool {
  return {
    manifestText,
    manifestPath,
    module: fixtureModule,
  };
}

describe("tools runtime", () => {
  it("loads an embedded fixture tool and builds its catalog", () => {
    const loaded = loadTools([
      fixtureTool(`
name = "fixture"
description = "Fixture tool"
module = "./client.ts"
hosts = ["example.com"]
`),
    ]);

    const catalog = buildToolCatalog(loaded, {});

    expect(catalog).toHaveLength(1);
    expect(catalog[0]).toMatchObject({
      namespace: "fixture",
      name: "ping",
      description: "Ping the fixture tool",
      planMode: "readOnly",
    });
    expect(catalog[0]?.inputSchema).toMatchObject({
      type: "object",
      properties: {
        message: {
          type: "string",
        },
      },
      required: ["message"],
    });
  });

  it("adds source line and column to invalid TOML errors", () => {
    expect(() => parseToml("name = [", "tools/bad/manifest.toml")).toThrow(
      "tools/bad/manifest.toml:1:9: Invalid TOML document",
    );
  });

  it("rejects unsupported future secret types with explicit messages", () => {
    for (const type of ["oauth_token", "hmac_sign", "gcp_auth", "pg_dsn", "brokered_token"]) {
      expect(() =>
        ToolManifestSchema.parse({
          name: "fixture",
          description: "Fixture tool",
          module: "./client.ts",
          hosts: ["example.com"],
          secrets: [{ type }],
        }),
      ).toThrow(`secret type '${type}' is declared but not yet supported`);
    }
  });

  it("keeps the later duplicate tool and warns", () => {
    const logger = { warn: vi.fn() };
    const loaded = loadTools(
      [
        fixtureTool(`
name = "fixture"
description = "Old fixture"
module = "./client.ts"
hosts = ["old.example.com"]
`),
        fixtureTool(
          `
name = "fixture"
description = "New fixture"
module = "./client.ts"
hosts = ["new.example.com"]
`,
          "tools/new-fixture/manifest.toml",
        ),
      ],
      { logger },
    );

    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.manifest.description).toBe("New fixture");
    expect(logger.warn).toHaveBeenCalledWith("tool 'fixture' declared more than once; later entry wins", {
      manifestPath: "tools/new-fixture/manifest.toml",
    });
  });

  it("skips malformed tool manifests without dropping valid tools", () => {
    const logger = { warn: vi.fn() };
    const loaded = loadTools(
      [
        fixtureTool("name = [", "tools/bad/manifest.toml"),
        fixtureTool(`
name = "fixture"
description = "Fixture tool"
module = "./client.ts"
hosts = ["example.com"]
`),
      ],
      { logger },
    );

    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.manifest.name).toBe("fixture");
    expect(logger.warn).toHaveBeenCalledWith("tool manifest 'tools/bad/manifest.toml' could not be loaded", {
      error: expect.any(Error),
    });
  });

  it("catalogs zod input schemas instead of parsed output schemas", () => {
    const loaded = loadTools([
      {
        manifestText: `
name = "fixture"
description = "Fixture tool"
module = "./client.ts"
hosts = ["example.com"]
`,
        manifestPath: "tools/fixture/manifest.toml",
        module: {
          methods: {
            ping: {
              description: "Ping the fixture tool",
              inputSchema: z.object({ count: z.coerce.number().default(1) }),
              planMode: "readOnly",
              execute: async (args: { count: number }) => ({ count: args.count }),
            },
          },
        },
      },
    ]);

    const [entry] = buildToolCatalog(loaded, {});

    expect(entry?.inputSchema).toMatchObject({
      type: "object",
      properties: {
        count: {},
      },
    });
    expect(validateToolInput(entry!, {})).toEqual({ count: 1 });
    expect(validateToolInput(entry!, { count: "2" })).toEqual({ count: 2 });
  });

  it("does not catalog tools when declared secrets are missing", () => {
    const loaded = loadTools([
      fixtureTool(`
name = "fixture"
description = "Fixture tool"
module = "./client.ts"
hosts = ["example.com"]

[[secrets]]
type = "http"
name = "FIXTURE_TOKEN"
hosts = ["example.com"]
`),
    ]);

    expect(buildToolCatalog(loaded, {})).toEqual([]);
    expect(buildToolCatalog(loaded, { FIXTURE_TOKEN: "token" })).toHaveLength(1);
  });

  it("validates catalog input through the method zod schema", () => {
    const [entry] = buildToolCatalog(
      loadTools([
        fixtureTool(`
name = "fixture"
description = "Fixture tool"
module = "./client.ts"
hosts = ["example.com"]
`),
      ]),
      {},
    );

    expect(validateToolInput(entry!, { message: "hello" })).toEqual({ message: "hello" });
    expect(() => validateToolInput(entry!, { message: 1 })).toThrow();
  });

  it("fails closed when a required secret is unset without exposing secret values", () => {
    expect(secret("FIXTURE_TOKEN", { FIXTURE_TOKEN: "token" })).toBe("token");

    try {
      secret("FIXTURE_TOKEN", {});
      throw new Error("expected secret read to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(MissingToolSecretError);
      expect(String(error)).toContain("FIXTURE_TOKEN");
      expect(String(error)).not.toContain("token");
    }
  });
});
