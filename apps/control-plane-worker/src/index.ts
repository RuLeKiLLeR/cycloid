import { dispatchQueueBatch } from "./queue-dispatch";
import router from "./router";
import type { Env } from "./types";

export { OpenAIGatewayBudgetDO } from "./openai-gateway/budget-do";
export { causeForLifecycleEvent, SessionDO } from "./session/durable-object";
export { resolveReplayCursor, selectReplayWindow } from "./session/events";
export { SessionFeedDO } from "./session/feed-do";
export { SessionResumeRateLimiterDO } from "./session/resume-rate-limiter-do";

// Wrangler picks up the default export's handlers.
// Sentry.withSentry returns an ExportedHandler with fetch + scheduled.
// Queue consumers share the Worker deployment with HTTP and scheduled handlers.
export default {
  fetch: router.fetch!.bind(router),
  scheduled: router.scheduled?.bind(router),
  queue: dispatchQueueBatch,
} satisfies ExportedHandler<Env>;
