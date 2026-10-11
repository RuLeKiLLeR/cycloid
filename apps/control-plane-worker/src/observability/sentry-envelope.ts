/**
 * Sentry envelope handling for the sandbox telemetry broker. The sandbox SDK
 * carries a non-secret placeholder DSN (it refuses to send without one), and
 * with `tunnel` set it embeds that placeholder in the envelope's JSON header.
 * Before forwarding to the real ingest, the broker rewrites that header `dsn`
 * to the worker-held platform DSN so the forwarded request matches the
 * standard tunnel shape (envelope auth consistent with the X-Sentry-Auth
 * header) instead of presenting a key the ingest does not recognize.
 */

/** Replace the `dsn` in the envelope's first-line JSON header. Throws when the
 * header line is not parseable JSON; callers fall back to forwarding the
 * original body. */
export function rewriteSentryEnvelopeDsn(envelope: Uint8Array, dsn: string): Uint8Array<ArrayBuffer> {
  const newlineIndex = envelope.indexOf(0x0a);
  const headerBytes = newlineIndex === -1 ? envelope : envelope.subarray(0, newlineIndex);
  const header = JSON.parse(new TextDecoder().decode(headerBytes)) as Record<string, unknown>;
  header.dsn = dsn;
  const rewrittenHeader = new TextEncoder().encode(JSON.stringify(header));
  const rest = newlineIndex === -1 ? new Uint8Array(0) : envelope.subarray(newlineIndex);
  const out = new Uint8Array(rewrittenHeader.byteLength + rest.byteLength);
  out.set(rewrittenHeader, 0);
  out.set(rest, rewrittenHeader.byteLength);
  return out;
}

/** Gunzip with a decompressed-size cap (the SDK gzips envelopes over 32 KB;
 * the cap guards the broker against decompression bombs). */
export async function gunzipCapped(data: Uint8Array, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Response(data.slice().buffer as ArrayBuffer).body;
  if (!stream) throw new Error("Empty gzip body");
  const reader = stream.pipeThrough(new DecompressionStream("gzip")).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("Decompressed payload exceeds size cap");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
