import { useState } from "react";

import type { DisconnectMask, LifecycleView } from "../../../../shared/session/transient-disconnect.js";
import {
  applyDisconnectMask,
  isDisconnectMaskActive,
  nextDisconnectMask,
  TRANSIENT_DISCONNECT_VISIBILITY_MS,
} from "../../../../shared/session/transient-disconnect.js";
import type { SessionDetail } from "../types";
import { useSyncEffect } from "./useEffects";

type MaskState = {
  mask: DisconnectMask | null;
  lastView: LifecycleView | null;
};

function toView(session: SessionDetail | null): LifecycleView | null {
  return session ? { phase: session.phase, sandboxSubstate: session.sandboxSubstate } : null;
}

function viewChanged(a: LifecycleView | null, b: LifecycleView | null): boolean {
  return a?.phase !== b?.phase || a?.sandboxSubstate !== b?.sandboxSubstate;
}

// Render-side mask for transient sandbox disconnects: while a live transition
// into `sandboxSubstate: "reconnecting"` is younger than
// TRANSIENT_DISCONNECT_VISIBILITY_MS, keep rendering the pre-disconnect
// phase/substate (placeholder text, stop availability, status pill). The
// session store itself stays truthful — only the returned view is held back.
// See shared/session/transient-disconnect.ts for the rationale and rules.
export function useTransientDisconnectMask(session: SessionDetail | null): SessionDetail | null {
  const view = toView(session);
  // setState-during-render is the React-sanctioned "derive state from props"
  // pattern: the in-progress render is discarded and rerun with the new state.
  const [state, setState] = useState<MaskState>({ mask: null, lastView: view });
  const [, setExpiryTick] = useState(0);

  if (viewChanged(state.lastView, view)) {
    setState({ mask: nextDisconnectMask(state.mask, state.lastView, view, Date.now()), lastView: view });
  }

  const mask = state.mask;
  useSyncEffect(() => {
    if (!isDisconnectMaskActive(mask, Date.now())) return;
    // Re-render when the mask expires so a disconnect that outlives the
    // threshold becomes visible without waiting for the next server frame.
    const timer = setTimeout(
      () => setExpiryTick((tick) => tick + 1),
      Math.max(0, mask!.since + TRANSIENT_DISCONNECT_VISIBILITY_MS - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [mask]);

  if (!session) return session;
  return applyDisconnectMask(session, mask, Date.now());
}
