// Import the REAL SDK, unmocked: this suite exists to pin the runtime contract the
// prod code depends on, so it must not vi.mock("freestyle").
import { Freestyle } from "freestyle";
import { describe, expect, it } from "vitest";

// freestyle-client.ts probes VM liveness with `client.vms.ref({ vmId }).getInfo()`
// (GET /v1/vms/{vm_id}). `getInfo()` is implemented on the SDK's Vm class but is
// ABSENT from the package's .d.ts, so the prod call casts through
// `as unknown as FreestyleVmInfoReader`. That cast makes tsc blind to an SDK bump
// that drops or renames the method: the break would surface only in prod, where a
// TypeError classifies as retryable `network` and, after retries, terminates a live
// VM as `unknown` (ARC-1478). This test re-asserts the contract against the real SDK
// so such a bump fails at CI instead. `vms.ref` builds a local handle and makes no
// network call, so no request escapes (the injected fetch throws to prove it).
describe("Freestyle SDK contract (unmocked)", () => {
  const noNetworkFetch = (() => {
    throw new Error("Freestyle SDK contract test must not make network calls");
  }) as unknown as typeof fetch;

  it("exposes vms.ref(...).getInfo() — the per-VM liveness read the probe relies on", () => {
    const client = new Freestyle({ apiKey: "contract-test-noop", fetch: noNetworkFetch });

    expect(typeof client.vms.ref).toBe("function");
    const vm = client.vms.ref({ vmId: "vm-contract-test" }) as unknown as { getInfo?: unknown };
    expect(typeof vm.getInfo).toBe("function");
  });

  // pauseSandbox parks the VM with `client.vms.ref({ vmId }).suspend()` (POST
  // /v1/vms/{vm_id}/suspend), the memory-preserving suspend that replaced the no-op
  // (ARC-1481). Like getInfo(), suspend() is implemented on the runtime Vm class but
  // ABSENT from the package's .d.ts, so the prod call casts through
  // `as unknown as FreestyleVmSuspender`. An SDK bump that drops or renames it would
  // otherwise slip past tsc and leave pause a silent no-op — VMs would resume billing at
  // full CPU/mem until their idle timer fired. Pin the method against the real SDK so the
  // break fails at CI.
  it("exposes vms.ref(...).suspend() — the memory-preserving pause pauseSandbox relies on", () => {
    const client = new Freestyle({ apiKey: "contract-test-noop", fetch: noNetworkFetch });

    const vm = client.vms.ref({ vmId: "vm-contract-test" }) as unknown as { suspend?: unknown };
    expect(typeof vm.suspend).toBe("function");
  });

  // createSandbox sizes a Freestyle VM by passing memSizeGb/vcpuCount/rootfsSizeGb to
  // vms.create (FREESTYLE-BIGSPEC). Those knobs are ABSENT from the package's typed
  // create() options even though the runtime forwards them onto the wire nested under
  // `template`, so the prod call casts through `as FreestyleVmCreateOptions`. That cast
  // makes tsc blind to an SDK change that stops forwarding the fields — the break would
  // surface only in prod as a VM that silently ignored its requested size. Pin the wire
  // contract against the real SDK by capturing the outgoing POST body.
  it("forwards memSizeGb/vcpuCount/rootfsSizeGb from vms.create onto the create request body", async () => {
    let capturedBody: unknown = null;
    const captureFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = init?.body ? JSON.parse(String(init.body)) : null;
      return new Response(JSON.stringify({ id: "vm-contract", domains: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const client = new Freestyle({ apiKey: "contract-test-noop", fetch: captureFetch });

    await (
      client.vms.create as unknown as (options: {
        snapshotId: string;
        name: string;
        idleTimeoutSeconds: number;
        memSizeGb: number;
        vcpuCount: number;
        rootfsSizeGb: number;
      }) => Promise<unknown>
    )({
      snapshotId: "sh-contract",
      name: "cycloid-contract",
      idleTimeoutSeconds: 2400,
      memSizeGb: 32,
      vcpuCount: 4,
      rootfsSizeGb: 32,
    });

    // The runtime moves snapshotId under `template` and nests the sizing there once any
    // sizing knob is present. If a bump changes this shape, freestyle-client's create
    // stops sizing VMs and this assertion fails at CI instead of in prod.
    expect(capturedBody).toMatchObject({
      template: { snapshotId: "sh-contract", memSizeGb: 32, vcpuCount: 4, rootfsSizeGb: 32 },
    });
  });
});
