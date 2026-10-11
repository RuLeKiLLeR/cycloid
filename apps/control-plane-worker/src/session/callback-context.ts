import type { CallbackContext } from "../types";

type SlackCallbackContext = Extract<CallbackContext, { source: "slack" }>;

export function mergeCallbackContextUpdate(
  existing: CallbackContext | null | undefined,
  next: CallbackContext,
): CallbackContext {
  if (!existing) {
    return next;
  }
  if (existing.source !== "slack" || next.source !== "slack") {
    return next;
  }

  const mergedTimestamps = mergeReactionTimestamps(existing.reactionMessageTimestamps, next.reactionMessageTimestamps);

  return {
    ...existing,
    ...next,
    reactionMessageTimestamps: mergedTimestamps,
    statusMessageTs: next.statusMessageTs ?? existing.statusMessageTs,
    // Thread-budget anchors: a partial update from one writer (e.g. a follow-up
    // reply refresh) must never wipe another writer's anchor.
    askMessageTs: next.askMessageTs ?? existing.askMessageTs,
    askRepostCount: next.askRepostCount ?? existing.askRepostCount,
    resultMessageTs: next.resultMessageTs ?? existing.resultMessageTs,
    resultPromptId: next.resultPromptId ?? existing.resultPromptId,
  };
}

function mergeReactionTimestamps(
  existing: SlackCallbackContext["reactionMessageTimestamps"],
  next: SlackCallbackContext["reactionMessageTimestamps"],
): string[] | undefined {
  if (!existing?.length && !next?.length) return undefined;
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const ts of [...(existing ?? []), ...(next ?? [])]) {
    if (seen.has(ts)) continue;
    seen.add(ts);
    merged.push(ts);
  }
  return merged.length ? merged : undefined;
}
