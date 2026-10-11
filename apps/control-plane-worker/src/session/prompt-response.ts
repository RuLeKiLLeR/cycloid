// Public projection for enqueue acknowledgement responses (ARC-1024).
//
// Internal Durable Object / sandbox contracts stay rich, but anything returned
// to an external caller (webhook acks, authenticated send responses) must be
// narrowed so it cannot leak internal prompt-wrapper scaffolding or the sandbox
// callback credential.
//
// Scaffolding detection is delegated to the canonical
// `shared/transcript/prompt-display.ts` helper — we do NOT maintain a second
// marker list here. This projection is stricter than `derivePromptDisplayText`
// (which is for transcript display and will fall back to recovered/raw text):
// we only surface text we can prove is wrapper-free, and otherwise fail closed
// to `null`.

import { promptContainsScaffolding } from "../../../../shared/transcript/prompt-display.js";
import type { ClientPrompt } from "../../../../shared/types/session-websocket.js";
import type { DispatchContract } from "../types";

// Allowlist shape — deliberately NOT `Omit<ClientPrompt, "prompt">`, which would
// still carry `replyToText` (defaults to the raw wrapped prompt on bootstrap
// paths), `uploadedImages.data`, `result`, `errorDetails`, and actor metadata.
export interface PublicEnqueuedPrompt {
  promptId: string;
  session_id: string;
  status: string;
  createdAt?: string;
  agent?: string;
  skills?: string[];
  model?: string | null;
  reasoningEffort?: string | null;
  // Wrapper-free user text, or null when nothing display-safe is recoverable.
  displayPrompt: string | null;
}

// Narrowed dispatch: enough for debug visibility, never the prompt or the
// callback credential.
export interface PublicEnqueueDispatch {
  sessionId: string;
  promptId: string;
  model?: string | null;
}

/**
 * Derive display-safe prompt text, failing closed to `null`.
 *
 * Only surface text we can prove is wrapper-free: a clean `replyToText`, else a
 * clean raw prompt. We deliberately do NOT attempt to strip-and-recover a
 * scaffolded prompt: `stripPromptScaffolding` removes `<user_content>` blocks
 * (where the real user text lives on bootstrap paths) but leaves unwrapped
 * orchestration lines the marker list does not know about (`Linear Issue:`,
 * `Issue URL:`, `Premise check before implementation:`, etc.), so a recovered
 * string is internal scaffolding, not user text. When the raw prompt carries
 * any scaffolding and there is no clean `replyToText`, return null.
 */
function safeDisplayPrompt(prompt: unknown, replyToText: unknown): string | null {
  const reply = typeof replyToText === "string" ? replyToText.trim() : "";
  if (reply && !promptContainsScaffolding(reply)) return reply;

  const raw = typeof prompt === "string" ? prompt.trim() : "";
  if (raw && !promptContainsScaffolding(raw)) return raw;

  return null;
}

export function toPublicEnqueuedPrompt(prompt: ClientPrompt): PublicEnqueuedPrompt {
  return {
    promptId: prompt.promptId,
    session_id: prompt.session_id,
    status: prompt.status,
    ...(prompt.createdAt != null ? { createdAt: prompt.createdAt } : {}),
    ...(prompt.agent != null ? { agent: prompt.agent } : {}),
    ...(prompt.skills?.length ? { skills: prompt.skills } : {}),
    ...(prompt.model != null ? { model: prompt.model } : {}),
    ...(prompt.reasoningEffort != null ? { reasoningEffort: prompt.reasoningEffort } : {}),
    displayPrompt: safeDisplayPrompt(prompt.prompt, prompt.replyToText),
  };
}

export function toPublicEnqueueDispatch(dispatch: DispatchContract | null): PublicEnqueueDispatch | null {
  if (!dispatch) return null;
  return {
    sessionId: dispatch.sessionId,
    promptId: dispatch.promptId,
    ...(dispatch.model != null ? { model: dispatch.model } : {}),
  };
}
