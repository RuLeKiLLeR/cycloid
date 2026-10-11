/**
 * Type guards and extended event types for runtime events that are not part of
 * the bridge's explicit event contract but are still handled by the event loop
 * while the remaining runtime naming is cleaned up.
 */

interface RuntimeEvent {
  type: string;
  // Legacy runtime event processing narrows nested payloads at use sites.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  properties: any;
}

interface QuestionAskedEvent {
  type: "question.asked";
  properties: {
    id: string;
    sessionID: string;
    questions: Array<{
      question: string;
      options?: Array<{ label: string; description: string }>;
    }>;
  };
}

/** Runtime event plus bridge-specific event types. */
export type ExtendedEvent = RuntimeEvent | QuestionAskedEvent;

export function isQuestionAskedEvent(event: ExtendedEvent): event is QuestionAskedEvent {
  return (event.type as string) === "question.asked";
}

/**
 * Safely extract properties from any event as a record.
 * Used for the raw_agent_runtime fallback where the event shape is unknown.
 */
export function getEventProperties(event: ExtendedEvent): Record<string, unknown> {
  const props = (event as { properties?: unknown }).properties;
  if (props && typeof props === "object" && !Array.isArray(props)) {
    return props as Record<string, unknown>;
  }
  return {};
}
