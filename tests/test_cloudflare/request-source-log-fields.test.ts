import { describe, expect, it } from "vitest";

import { requestSourceLogFields, sourceNetworkSpanFields } from "../../apps/control-plane-worker/src/router";

function makeRequest(headers: Record<string, string>, cf?: unknown): Request {
  const req = new Request("https://app.trycycloid.com/auth/github", { headers });
  if (cf !== undefined) {
    Object.defineProperty(req, "cf", { value: cf, configurable: true });
  }
  return req;
}

describe("requestSourceLogFields", () => {
  it("reads cf_ip from cf-connecting-ip and asn/colo/country from request.cf", () => {
    const req = makeRequest({ "cf-connecting-ip": "203.0.113.7" }, { colo: "EWR", country: "US", asn: 13335 });
    expect(requestSourceLogFields(req)).toEqual({
      cf: { colo: "EWR", country: "US" },
      cf_ip: "203.0.113.7",
      asn: 13335,
    });
  });

  it("trims whitespace and uses the cf-connecting-ip header verbatim (no forwarded-for fallback)", () => {
    const req = makeRequest(
      { "cf-connecting-ip": "  198.51.100.4  ", "x-forwarded-for": "10.0.0.1, 203.0.113.9" },
      { colo: "LHR", country: "GB", asn: 7922 },
    );
    expect(requestSourceLogFields(req).cf_ip).toBe("198.51.100.4");
  });

  it("fails closed to nulls when cf is absent (local/dev, non-Cloudflare path)", () => {
    const req = makeRequest({});
    expect(requestSourceLogFields(req)).toEqual({ cf: null, cf_ip: null, asn: null });
  });

  it("nulls asn when request.cf carries a non-numeric/absent asn", () => {
    const req = makeRequest({ "cf-connecting-ip": "203.0.113.7" }, { colo: "EWR", country: "US", asn: "13335" });
    expect(requestSourceLogFields(req).asn).toBeNull();
  });

  it("nulls cf_ip on an empty cf-connecting-ip header", () => {
    const req = makeRequest({ "cf-connecting-ip": "   " }, { colo: "EWR", country: "US", asn: 13335 });
    expect(requestSourceLogFields(req).cf_ip).toBeNull();
  });

  it("ignores a spoofed cf-connecting-ip header when cf is absent (non-Cloudflare path)", () => {
    const req = makeRequest({ "cf-connecting-ip": "203.0.113.7" });
    expect(requestSourceLogFields(req)).toEqual({ cf: null, cf_ip: null, asn: null });
  });
});

describe("sourceNetworkSpanFields", () => {
  it("flattens cf into primitive span attributes", () => {
    const req = makeRequest({ "cf-connecting-ip": "203.0.113.7" }, { colo: "EWR", country: "US", asn: 13335 });
    expect(sourceNetworkSpanFields(req)).toEqual({
      cf_ip: "203.0.113.7",
      asn: 13335,
      "cf.colo": "EWR",
      "cf.country": "US",
    });
  });

  it("returns an empty object when cf is absent so no null/nested attributes leak onto the span", () => {
    // startSpan/endSpan do not drop null/undefined and SpanAttributes must be
    // primitive, so the helper must omit absent fields rather than emit nulls.
    expect(sourceNetworkSpanFields(makeRequest({}))).toEqual({});
  });

  it("omits cf_ip when the cf-connecting-ip header is missing but keeps asn/colo/country", () => {
    const req = makeRequest({}, { colo: "LHR", country: "GB", asn: 7922 });
    expect(sourceNetworkSpanFields(req)).toEqual({ asn: 7922, "cf.colo": "LHR", "cf.country": "GB" });
  });

  it("omits a non-numeric asn", () => {
    const req = makeRequest({ "cf-connecting-ip": "203.0.113.7" }, { colo: "EWR", country: "US", asn: "13335" });
    expect(sourceNetworkSpanFields(req)).toEqual({ cf_ip: "203.0.113.7", "cf.colo": "EWR", "cf.country": "US" });
  });

  it("omits cf_ip from a spoofed header when cf is absent (non-Cloudflare path)", () => {
    expect(sourceNetworkSpanFields(makeRequest({ "cf-connecting-ip": "203.0.113.7" }))).toEqual({});
  });
});
