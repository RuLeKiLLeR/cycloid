import type { SessionMetadata } from "../types";

export function orderSessionsForSidebar(sessions: SessionMetadata[]): SessionMetadata[] {
  const visibleById = new Map(sessions.map((session) => [session.sessionId, session] as const));
  const childrenByParent = new Map<string, SessionMetadata[]>();

  for (const session of sessions) {
    if (!session.parentSessionId || session.parentSessionId === session.sessionId) continue;
    if (!visibleById.has(session.parentSessionId)) continue;
    const siblings = childrenByParent.get(session.parentSessionId);
    if (siblings) siblings.push(session);
    else childrenByParent.set(session.parentSessionId, [session]);
  }

  const ordered: SessionMetadata[] = [];
  const seen = new Set<string>();

  const findAnchor = (session: SessionMetadata): SessionMetadata => {
    let current = session;
    const ancestorIds = new Set([session.sessionId]);

    while (current.parentSessionId && current.parentSessionId !== current.sessionId) {
      const parent = visibleById.get(current.parentSessionId);
      if (!parent) break;
      if (ancestorIds.has(parent.sessionId)) return session;
      ancestorIds.add(parent.sessionId);
      current = parent;
    }

    return current;
  };

  const visit = (session: SessionMetadata) => {
    if (seen.has(session.sessionId)) return;
    seen.add(session.sessionId);
    ordered.push(session);
    for (const child of childrenByParent.get(session.sessionId) ?? []) visit(child);
  };

  for (const session of sessions) visit(findAnchor(session));

  // Malformed cycles should not drop rows from the sidebar.
  for (const session of sessions) visit(session);

  return ordered;
}
