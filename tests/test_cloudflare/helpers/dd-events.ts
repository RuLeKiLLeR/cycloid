import type { Mock } from "vitest";

/**
 * Returns the most recent `postStructuredEventToDd` payload whose `event` matches
 * `eventName`, or `undefined` if none was posted. Shared across the route test
 * suites that assert direct-posted Datadog audit/rejection events; pass the
 * suite's own `postStructuredEventToDd` mock.
 */
export function lastDdEvent(
  mock: Mock<(...args: unknown[]) => Promise<boolean>>,
  eventName: string,
): Record<string, unknown> | undefined {
  for (let i = mock.mock.calls.length - 1; i >= 0; i--) {
    const payload = mock.mock.calls[i][1] as Record<string, unknown> | undefined;
    if (payload?.event === eventName) return payload;
  }
  return undefined;
}
