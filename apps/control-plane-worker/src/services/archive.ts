/**
 * S3 archive service for rollout state and artifacts.
 *
 * Uses aws4fetch for Workers-compatible S3 uploads.
 * No-ops gracefully when S3 credentials are missing.
 */

import * as Sentry from "@sentry/cloudflare";
import { AwsClient } from "aws4fetch";

import type { Logger } from "../logger";
import { tracedFetch } from "../observability/wrappers";
import type { Env } from "../types";

const S3_DEFAULT_REGION = "us-east-1";
const S3_EVENTS_PREFIX = "sessions";

interface S3Config {
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
}

type ArtifactFetchResult = { body: ReadableStream; contentType: string } | null;
type HandledArtifactFetchError = Error & { handledArtifactFetchError?: true };
export type S3ObjectDeleteResult = { deletedKeys: string[]; failedKeys: string[] };

function getS3Config(env: Env): S3Config | null {
  if (!env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY || !env.S3_SESSION_BUCKET) return null;
  return {
    bucket: env.S3_SESSION_BUCKET,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    region: env.S3_REGION || S3_DEFAULT_REGION,
  };
}

function buildObjectUrl(config: S3Config, key: string): string {
  return `https://${config.bucket}.s3.${config.region}.amazonaws.com/${key}`;
}

function createHandledArtifactFetchError(message: string): HandledArtifactFetchError {
  const error = new Error(message) as HandledArtifactFetchError;
  error.handledArtifactFetchError = true;
  return error;
}

async function putObject(config: S3Config, key: string, body: Uint8Array, contentType: string): Promise<boolean> {
  try {
    const client = new AwsClient({
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      region: config.region,
      service: "s3",
    });

    const url = `https://${config.bucket}.s3.${config.region}.amazonaws.com/${key}`;
    const response = await client.fetch(url, {
      method: "PUT",
      headers: { "Content-Type": contentType },
      body: body as unknown as BodyInit,
    });

    return response.ok;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[archive] S3 putObject failed:", String(err));
    Sentry.captureException(err, { tags: { operation: "s3PutObject" } });
    return false;
  }
}

export async function writeOffboardingArchiveObject(
  env: Env,
  key: string,
  body: Uint8Array,
  contentType: string,
  log: Logger,
): Promise<boolean> {
  const config = getS3Config(env);
  if (!config) return false;
  const ok = await putObject(config, key, body, contentType);
  if (!ok) log.error({ key }, "S3 offboarding archive upload failed");
  return ok;
}

export async function listSessionArchiveKeys(env: Env, sessionId: string, log: Logger): Promise<string[]> {
  const config = getS3Config(env);
  if (!config) return [];
  const client = createS3Client(config);
  const keys: string[] = [];
  let continuationToken: string | null = null;
  const prefix = `${S3_EVENTS_PREFIX}/${sessionId}/`;

  do {
    const url = new URL(`https://${config.bucket}.s3.${config.region}.amazonaws.com/`);
    url.searchParams.set("list-type", "2");
    url.searchParams.set("prefix", prefix);
    if (continuationToken) url.searchParams.set("continuation-token", continuationToken);
    const response = await client.fetch(url.toString(), { method: "GET" });
    if (!response.ok) {
      log.error({ sessionId, status: response.status }, "S3 session archive inventory failed");
      throw new Error(`S3 session archive inventory failed with status ${response.status}`);
    }
    const xml = await response.text();
    keys.push(...parseS3ListKeys(xml));
    continuationToken = parseFirstXmlValue(xml, "NextContinuationToken");
  } while (continuationToken);

  return keys;
}

export async function deleteS3Objects(env: Env, keys: string[], log: Logger): Promise<S3ObjectDeleteResult> {
  const config = getS3Config(env);
  if (!config || keys.length === 0) return { deletedKeys: [], failedKeys: [] };
  const client = createS3Client(config);
  const deletedKeys: string[] = [];
  const failedKeys: string[] = [];
  const chunkSize = 1000;

  for (let index = 0; index < keys.length; index += chunkSize) {
    const chunk = keys.slice(index, index + chunkSize);
    const body = new TextEncoder().encode(
      `<Delete>${chunk.map((key) => `<Object><Key>${escapeXml(key)}</Key></Object>`).join("")}</Delete>`,
    );
    const response = await client.fetch(`https://${config.bucket}.s3.${config.region}.amazonaws.com/?delete`, {
      method: "POST",
      headers: { "Content-Type": "application/xml" },
      body: body as unknown as BodyInit,
    });
    if (!response.ok) {
      failedKeys.push(...chunk);
      log.error({ status: response.status, keyCount: chunk.length }, "S3 object delete batch failed");
      continue;
    }
    const xml = await response.text();
    const errors = new Set(parseS3DeleteErrorKeys(xml));
    for (const key of chunk) {
      if (errors.has(key)) failedKeys.push(key);
      else deletedKeys.push(key);
    }
  }

  return { deletedKeys, failedKeys };
}

/**
 * Write a session artifact to S3 and return its canonical URL.
 * Callers decide whether that URL is suitable for end-user presentation.
 */
export async function writeArtifact(
  env: Env,
  sessionId: string,
  artifactId: string,
  filename: string,
  body: Uint8Array,
  contentType: string,
  log: Logger,
): Promise<string | null> {
  const config = getS3Config(env);
  if (!config) return null;

  const key = `${S3_EVENTS_PREFIX}/${sessionId}/artifacts/${artifactId}/${filename}`;
  const ok = await putObject(config, key, body, contentType);

  if (!ok) {
    log.error({ sessionId, artifactId, filename }, "S3 artifact upload failed");
    return null;
  }

  return buildObjectUrl(config, key);
}

/**
 * Read an artifact from S3 and return its body + content type.
 * Returns null if the object does not exist or S3 is not configured.
 */
export async function getArtifact(
  env: Env,
  sessionId: string,
  artifactId: string,
  filename: string,
  log: Logger,
): Promise<ArtifactFetchResult> {
  const config = getS3Config(env);
  if (!config) return null;

  const key = `${S3_EVENTS_PREFIX}/${sessionId}/artifacts/${artifactId}/${filename}`;
  const client = new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    region: config.region,
    service: "s3",
  });

  const url = `https://${config.bucket}.s3.${config.region}.amazonaws.com/${key}`;
  try {
    const response = await client.fetch(url, { method: "GET" });
    if (response.status === 404) return null;
    if (!response.ok) {
      const error = createHandledArtifactFetchError(`S3 artifact fetch failed with status ${response.status}`);
      log.error({ sessionId, artifactId, filename, status: response.status }, "S3 artifact fetch failed");
      Sentry.captureException(error, { tags: { operation: "s3GetArtifact", sessionId } });
      throw error;
    }
    if (!response.body) {
      const error = createHandledArtifactFetchError("S3 artifact fetch returned no body");
      log.error({ sessionId, artifactId, filename, status: response.status }, "S3 artifact fetch returned no body");
      Sentry.captureException(error, { tags: { operation: "s3GetArtifact", sessionId } });
      throw error;
    }

    return {
      body: response.body,
      contentType: response.headers.get("content-type") || "application/octet-stream",
    };
  } catch (err) {
    if (err instanceof Error && (err as HandledArtifactFetchError).handledArtifactFetchError) {
      throw err;
    }
    log.error({ sessionId, artifactId, filename, error: String(err) }, "S3 artifact fetch threw");
    Sentry.captureException(err, { tags: { operation: "s3GetArtifact", sessionId } });
    throw err;
  }
}

const ROLLOUT_CONTENT_TYPE = "application/gzip";

/** Server-side ceiling on a stored rollout, below the Durable Object memory limit. */
export const ROLLOUT_MAX_BYTES = 100 * 1024 * 1024;

// Signs then sends via tracedFetch (so the S3 call is traced like other outbound
// fetches, and callers can still spy on the destination URL) with retries disabled —
// rollout upload is best-effort and must not block a prompt with ~50s of 5xx backoff.
// Other writers use putObject (retries on).
// NOTE: `init.body` must be a fully-buffered value (Uint8Array), never a ReadableStream —
// client.sign() reads the body to hash it, which would drain a stream before the fetch
// below re-sends it, silently PUTting an empty object.
async function signedFetch(config: S3Config, url: string, init: RequestInit): Promise<Response> {
  const client = createS3Client(config);
  const signed = await client.sign(url, init);
  return tracedFetch(signed.url, {
    method: signed.method,
    headers: signed.headers,
    body: (init as RequestInit & { body?: BodyInit }).body,
  });
}

function createS3Client(config: S3Config): AwsClient {
  return new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    region: config.region,
    service: "s3",
    retries: 0,
  });
}

/**
 * Write the Codex rollout tar.gz to S3 (single object, overwritten each prompt).
 * Body is pre-gzipped tar. Returns true on success.
 */
export async function writeRollout(env: Env, sessionId: string, body: Uint8Array, log: Logger): Promise<boolean> {
  const config = getS3Config(env);
  if (!config) return false;

  const key = `${S3_EVENTS_PREFIX}/${sessionId}/codex-rollout.tar.gz`;
  const url = buildObjectUrl(config, key);

  try {
    const response = await signedFetch(config, url, {
      method: "PUT",
      headers: { "Content-Type": ROLLOUT_CONTENT_TYPE },
      body: body as unknown as BodyInit,
    });

    if (!response.ok) {
      log.error({ sessionId }, "S3 rollout upload failed");
      return false;
    }
    return true;
  } catch (err) {
    log.error({ sessionId, error: String(err) }, "S3 rollout upload threw");
    Sentry.captureException(err, { tags: { operation: "s3WriteRollout", sessionId } });
    return false;
  }
}

/**
 * Read the Codex rollout tar.gz from S3. Best-effort: returns null when missing,
 * unconfigured, or on any error (restore is non-critical).
 */
export async function readRollout(
  env: Env,
  sessionId: string,
  log: Logger,
): Promise<ReadableStream<Uint8Array> | null> {
  const config = getS3Config(env);
  if (!config) return null;

  const key = `${S3_EVENTS_PREFIX}/${sessionId}/codex-rollout.tar.gz`;
  const url = buildObjectUrl(config, key);

  try {
    const response = await signedFetch(config, url, { method: "GET" });
    if (response.status === 404) return null;
    if (!response.ok) {
      log.error({ sessionId, status: response.status }, "S3 rollout fetch failed");
      return null;
    }
    if (!response.body) {
      log.error({ sessionId, status: response.status }, "S3 rollout fetch returned no body");
      return null;
    }
    return response.body;
  } catch (err) {
    log.error({ sessionId, error: String(err) }, "S3 rollout fetch threw");
    Sentry.captureException(err, { tags: { operation: "s3ReadRollout", sessionId } });
    return null;
  }
}

function parseS3ListKeys(xml: string): string[] {
  return [...xml.matchAll(/<Key>([\s\S]*?)<\/Key>/g)].map((match) => unescapeXml(match[1] ?? ""));
}

function parseS3DeleteErrorKeys(xml: string): string[] {
  return [...xml.matchAll(/<Error>[\s\S]*?<Key>([\s\S]*?)<\/Key>[\s\S]*?<\/Error>/g)].map((match) =>
    unescapeXml(match[1] ?? ""),
  );
}

function parseFirstXmlValue(xml: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
  return match ? unescapeXml(match[1] ?? "") : null;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function unescapeXml(value: string): string {
  return value
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}
