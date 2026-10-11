/**
 * Shared GitHub webhook test fixtures.
 *
 * Provides HMAC signing, signed request construction, and the canonical
 * idempotency-key mock implementation so individual suites don't have to
 * reimplement them.
 */

/**
 * Compute a hex-encoded HMAC-SHA256 over `body` using `secret`.
 * Matches the algorithm used by the production `verifyGithubWebhookSignature`
 * helper so requests built with this helper pass real signature verification.
 */
export async function computeHmacSha256Hex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Options for {@link makeSignedGithubRequest}. */
export interface SignedGithubRequestOptions {
  /** Value of the `x-github-event` header (e.g. `"issue_comment"`). */
  eventType: string;
  /** Webhook secret used to compute the HMAC signature. */
  secret: string;
  /**
   * Value of the `x-github-delivery` header.
   * Defaults to a fresh `crypto.randomUUID()` when omitted.
   */
  deliveryId?: string;
}

type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];
type JsonObject = { [key: string]: JsonValue | undefined };

/**
 * Build a signed GitHub webhook `Request` object.
 *
 * The `x-hub-signature-256` header is computed from `body` and `options.secret`
 * using `computeHmacSha256Hex`, so the resulting request passes production
 * signature verification.
 */
export async function makeSignedGithubRequest(body: string, options: SignedGithubRequestOptions): Promise<Request> {
  const { eventType, secret, deliveryId = crypto.randomUUID() } = options;
  const hmac = await computeHmacSha256Hex(secret, body);
  return new Request("https://example.com/api/webhooks/github", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": `sha256=${hmac}`,
      "x-github-delivery": deliveryId,
      "x-github-event": eventType,
    },
    body,
  });
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Deep-merge JSON-like objects for webhook test payload builders.
 *
 * Override values replace base values unless both sides are objects, in which
 * case the merge recurses. Passing `undefined` explicitly keeps the key present
 * on the returned object with an `undefined` value, which lets tests remove
 * optional fields by relying on `JSON.stringify` to omit them.
 */
function mergeJsonObjects<T extends JsonObject>(base: T, overrides: JsonObject = {}): T {
  const merged: JsonObject = { ...base };

  for (const [key, overrideValue] of Object.entries(overrides)) {
    const baseValue = merged[key];
    merged[key] =
      isJsonObject(baseValue) && isJsonObject(overrideValue)
        ? mergeJsonObjects(baseValue, overrideValue)
        : overrideValue;
  }

  return merged as T;
}

function buildGithubRepositoryPayload(overrides: JsonObject = {}): JsonObject {
  return mergeJsonObjects(
    {
      name: "repo",
      html_url: "https://github.com/acme/repo",
      owner: { login: "acme" },
    },
    overrides,
  );
}

export function buildGithubIssueCommentPayload(overrides: JsonObject = {}): JsonObject {
  return mergeJsonObjects(
    {
      action: "created",
      installation: { id: 2222 },
      repository: buildGithubRepositoryPayload(),
      issue: {
        id: 9001,
        number: 73,
        title: "Fix failing smoke test",
        body: "The smoke test still flakes on retries.",
        html_url: "https://github.com/acme/repo/issues/73",
      },
      comment: {
        id: 77,
        body: "@cycloid-dev fix the flaky test",
      },
      sender: {
        id: 123,
        login: "alice",
        type: "User",
      },
    },
    overrides,
  );
}

export function buildGithubPullRequestReviewPayload(overrides: JsonObject = {}): JsonObject {
  return mergeJsonObjects(
    {
      action: "submitted",
      installation: { id: 2222 },
      repository: buildGithubRepositoryPayload(),
      pull_request: {
        number: 42,
        html_url: "https://github.com/acme/repo/pull/42",
      },
      review: {
        id: 7001,
        state: "changes_requested",
        body: "Please address the null handling and naming issues.",
        user: {
          id: 555,
          login: "reviewer",
          type: "User",
        },
      },
    },
    overrides,
  );
}

export function buildGithubCommitStatusPayload(overrides: JsonObject = {}): JsonObject {
  return mergeJsonObjects(
    {
      id: 9600,
      sha: "head-sha",
      state: "success",
      context: "CodeRabbit",
      description: "Review completed",
      target_url: "https://coderabbit.ai/gh/acme/repo/pulls/42",
      installation: { id: 2222 },
      repository: buildGithubRepositoryPayload(),
      sender: {
        id: 777,
        login: "coderabbitai",
        type: "Bot",
      },
    },
    overrides,
  );
}

export function buildGithubCheckRunPayload(overrides: JsonObject = {}): JsonObject {
  return mergeJsonObjects(
    {
      action: "completed",
      installation: { id: 2222 },
      repository: buildGithubRepositoryPayload(),
      sender: {
        id: 666,
        login: "cursor[bot]",
        type: "Bot",
      },
      check_run: {
        id: 9500,
        name: "cursor bugbot",
        status: "completed",
        conclusion: "success",
        head_sha: "head-sha",
        app: { slug: "cursor", name: "Cursor" },
        pull_requests: [
          {
            number: 42,
            head: { sha: "head-sha" },
          },
        ],
      },
    },
    overrides,
  );
}

export function buildGithubPullRequestPayload(overrides: JsonObject = {}): JsonObject {
  return mergeJsonObjects(
    {
      action: "opened",
      installation: { id: 99999 },
      pull_request: {
        html_url: "https://github.com/org/repo/pull/42",
        number: 42,
        head: { sha: "abc123" },
        base: { repo: { owner: { login: "org" }, name: "repo" } },
      },
    },
    overrides,
  );
}

export function buildGithubInstallationPayload(overrides: JsonObject = {}): JsonObject {
  return mergeJsonObjects(
    {
      action: "created",
      installation: {
        id: 12345,
        account: { login: "acme-corp", id: 100, type: "Organization" },
        repository_selection: "all",
      },
    },
    overrides,
  );
}

export function buildGithubInstallationRepositoriesPayload(overrides: JsonObject = {}): JsonObject {
  return mergeJsonObjects(
    {
      action: "added",
      installation: {
        id: 12345,
        account: { login: "acme-corp", id: 100, type: "Organization" },
      },
      repositories_added: [{ full_name: "acme-corp/repo-a" }],
    },
    overrides,
  );
}

/**
 * Pure implementation of the `buildWebhookIdempotencyKey` function from
 * `apps/control-plane-worker/src/webhooks/db`.
 *
 * Use this as the factory body when mocking that module so suites share the
 * same key-building logic without re-deriving it independently.
 *
 * @example
 * ```ts
 * vi.mock("../../apps/control-plane-worker/src/webhooks/db", () => ({
 *   buildWebhookIdempotencyKey: buildWebhookIdempotencyKeyImpl,
 *   // ...other mocks
 * }))
 * ```
 */
export function buildWebhookIdempotencyKeyImpl(source: string, explicitKey: unknown, payloadHash: string): string {
  return typeof explicitKey === "string" && explicitKey.trim().length > 0
    ? `${source}:${explicitKey.trim()}`
    : `${source}:sha256:${payloadHash}`;
}
