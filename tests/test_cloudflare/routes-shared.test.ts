import { describe, expect, it } from "vitest";
import { z } from "zod";

import { parseBody } from "../../apps/control-plane-worker/src/routes/shared";

describe("parseBody", () => {
  it("returns the parsed zod value", async () => {
    const result = await parseBody(
      new Request("https://worker.test/api/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ count: "3" }),
      }),
      z.object({ count: z.coerce.number().int().positive() }),
    );

    expect(result).toEqual({ ok: true, value: { count: 3 } });
  });

  it("returns a RouteParseResult error response with the first schema message", async () => {
    const result = await parseBody(
      new Request("https://worker.test/api/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ count: 0 }),
      }),
      z.object({ count: z.number().positive("count must be positive") }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(400);
    expect(await result.response.json()).toEqual({ ok: false, error: "count must be positive" });
  });

  it("lets schemas decide how to handle empty or malformed bodies", async () => {
    const result = await parseBody(
      new Request("https://worker.test/api/test", { method: "POST", body: "not-json" }),
      z.preprocess((value) => value ?? {}, z.object({ count: z.number().default(1) })),
    );

    expect(result).toEqual({ ok: true, value: { count: 1 } });
  });
});
