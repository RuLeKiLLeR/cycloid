import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const migrations = await readD1Migrations("apps/control-plane-worker/migrations");
      return {
        wrangler: { configPath: "./tests/test_workerd/wrangler.toml" },
        miniflare: {
          serviceBindings: {
            MIGRATIONS: async () => Response.json(migrations),
          },
        },
      };
    }),
  ],
  test: {
    include: ["tests/test_workerd/**/*.{test,spec}.ts"],
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
});
