export function unwrapSessionState(payload: Record<string, unknown>): Record<string, unknown> {
  return (payload.session && typeof payload.session === "object" ? payload.session : payload) as Record<
    string,
    unknown
  >;
}
