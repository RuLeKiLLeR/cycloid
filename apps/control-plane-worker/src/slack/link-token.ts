import { SLACK_LINK_TOKEN_TTL_MS } from "../constants/slack";
import { createSignedToken, type SignedTokenCodec, verifySignedToken } from "../signed-token";
import { generateRandomHex } from "../utils";

/**
 * Slack magic-link identity-binding token. A short-lived, HMAC-signed token
 * (via the shared `signed-token` primitive — not a JWT) that proves a Slack
 * user/workspace was the one the bot DMed. The `jti` is consumed once at bind
 * time so the link cannot be replayed.
 *
 * Slack user/team IDs are `[A-Z0-9]` and `jti` is hex, so a `:` delimiter is
 * unambiguous.
 */
export interface SlackLinkTokenPayload {
  slackUserId: string;
  slackTeamId: string;
  /** Random nonce; the single-use anchor recorded in slack_link_token_consumptions. */
  jti: string;
  /** Absolute expiry, Unix ms. */
  expiresAt: number;
}

const slackLinkTokenCodec: SignedTokenCodec<SlackLinkTokenPayload> = {
  encode(payload) {
    return `${payload.slackUserId}:${payload.slackTeamId}:${payload.jti}:${payload.expiresAt}`;
  },
  decode(raw) {
    const parts = raw.split(":");
    if (parts.length !== 4) return null;
    const [slackUserId, slackTeamId, jti, rawExpiresAt] = parts;
    if (!slackUserId || !slackTeamId || !jti) return null;
    const expiresAt = Number(rawExpiresAt);
    if (!Number.isFinite(expiresAt)) return null;
    return { slackUserId, slackTeamId, jti, expiresAt };
  },
};

/**
 * Mint a magic-link token for a Slack user/workspace. The caller embeds the
 * returned string in the DM link's `token` query param.
 */
export async function createSlackLinkToken(
  args: { slackUserId: string; slackTeamId: string },
  secret: string,
  now = Date.now(),
): Promise<string> {
  const payload: SlackLinkTokenPayload = {
    slackUserId: args.slackUserId,
    slackTeamId: args.slackTeamId,
    jti: generateRandomHex(16),
    expiresAt: now + SLACK_LINK_TOKEN_TTL_MS,
  };
  return createSignedToken(payload, secret, slackLinkTokenCodec);
}

/**
 * Verify a magic-link token's signature and expiry. Returns the decoded
 * payload, or `null` on a bad signature, malformed payload, or expired token.
 * Single-use enforcement (the `jti`) is layered on separately at bind time.
 */
export async function verifySlackLinkToken(
  token: string,
  secret: string,
  now = Date.now(),
): Promise<SlackLinkTokenPayload | null> {
  const payload = await verifySignedToken(token, secret, slackLinkTokenCodec);
  if (!payload) return null;
  if (payload.expiresAt <= now) return null;
  return payload;
}
