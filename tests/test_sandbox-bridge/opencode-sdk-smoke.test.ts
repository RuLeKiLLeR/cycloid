// @ts-nocheck — sandbox-bridge is excluded from root tsconfig
import { createOpencode, createOpencodeClient, createOpencodeServer } from "@opencode-ai/sdk";
import { describe, expect, it } from "vitest";

describe("opencode SDK contract", () => {
  it("exports the server helpers and client methods the bridge adapter uses", () => {
    expect(typeof createOpencode).toBe("function");
    expect(typeof createOpencodeServer).toBe("function");
    expect(typeof createOpencodeClient).toBe("function");

    // @ts-nocheck strips the type-level Pick assertions at runtime, so check the
    // real client surface instead: createOpencodeClient builds a fetch-backed
    // client without booting a server, exposing the same method namespaces the
    // adapter calls. A pinned-SDK upgrade that drops any of these fails here.
    const client = createOpencodeClient({ baseUrl: "http://127.0.0.1:1" });
    expect(typeof client.session.create).toBe("function");
    expect(typeof client.session.promptAsync).toBe("function");
    expect(typeof client.session.abort).toBe("function");
    expect(typeof client.event.subscribe).toBe("function");
  });
});
