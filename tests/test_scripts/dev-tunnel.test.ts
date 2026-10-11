import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "../..");
const DEV_TUNNEL_SCRIPT = resolve(REPO_ROOT, "scripts/dev-tunnel.sh");

describe("dev-tunnel.sh", () => {
  const script = readFileSync(DEV_TUNNEL_SCRIPT, "utf8");

  it("loads NGROK_DOMAIN from .dev.vars when the shell env is unset", () => {
    expect(script).toContain("read_dev_var()");
    expect(script).toContain('NGROK_DOMAIN="${NGROK_DOMAIN:-$(read_dev_var NGROK_DOMAIN)}"');
    expect(script).toContain("add NGROK_DOMAIN=<your-domain> to $DEV_VARS");
  });

  it("guards against tunneling the Vite UI port for sandbox callbacks", () => {
    expect(script).toContain('"$PORT" =~ ^517[0-9]$');
    expect(script).toContain("dev tunnel must target the API port");
  });
});
