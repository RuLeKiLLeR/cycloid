import { useParams } from "react-router";

import { useLayoutContext } from "../components/Layout";
import { SessionDetailView } from "../components/SessionDetail";
import { useAuthenticatedTitle } from "../hooks/useAuthenticatedTitle";
import { buildInitialSession } from "../utils/session-seed";

export function SessionPage() {
  const { id } = useParams();
  const { sessions } = useLayoutContext();

  // Seed SessionDetailView with metadata from the sidebar list so the view
  // renders immediately instead of flashing "Loading…" while the full
  // session fetch is in flight. key={id} is load-bearing: it forces a full
  // remount on navigation, which re-runs useState with the new initial value.
  const initialSession = buildInitialSession(sessions, id);

  const label = initialSession?.title ?? id ?? "Session";
  useAuthenticatedTitle(`${label} - Cycloid`);

  return <SessionDetailView key={id} sessionId={id!} initialSession={initialSession} />;
}
