import * as doDb from "../do-db";

interface BaseOpts {
  sql: SqlStorage;
  sessionId: string;
}

interface SetMarkerOpts extends BaseOpts {
  at: number | null;
}

/**
 * Single owner for the `sandbox_state.disconnect_started_at` and
 * `sandbox_state.auto_close_scheduled_at` transport markers.
 *
 * The bug class: two paths writing these fields independently can race so
 * `rescheduleSessionAlarm` reads a stale value and arms the wrong grace
 * deadline. These helpers are the only sites that write the columns; every
 * caller (lifecycle applier, finalizeSandboxStopped, startSpawnAttempt,
 * reaper, alarm handler, ws-manager reconnect fallback) goes through them.
 */
export function setDisconnectStartedAt(opts: SetMarkerOpts): void {
  doDb.updateSandboxState(opts.sql, opts.sessionId, { disconnectStartedAt: opts.at });
}

export function scheduleAutoCloseAt(opts: SetMarkerOpts): void {
  doDb.updateSandboxState(opts.sql, opts.sessionId, { autoCloseScheduledAt: opts.at });
}

export function clearTransportMarkers(opts: BaseOpts): void {
  doDb.updateSandboxState(opts.sql, opts.sessionId, {
    disconnectStartedAt: null,
    autoCloseScheduledAt: null,
  });
}
