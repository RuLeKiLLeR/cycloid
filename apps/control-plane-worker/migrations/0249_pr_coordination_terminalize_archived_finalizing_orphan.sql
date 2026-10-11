-- One-off data fix: terminalize a single orphaned pr_coordination FSM row.
--
-- Session 2e205db1-27d3-4188-97c4-1d3df36f5680 (internal dogfood, "Find E2B sandbox ID") was
-- archived by the idle-runtime phase reaper ~3s after it entered FINALIZING, as its DO went
-- dormant. The reaper flipped session_index.status='archived' but never drove the FSM: no
-- `session.archived` event reached applyEvent, so the pr_coordination row was stranded in
-- FINALIZING. The FINALIZING deadline backstop (deadline_exceeded -> FAILED(execution_timeout))
-- fires ONLY from the per-session DO alarm (durable-object.ts), which never ticks again for a
-- dormant/archived session, and there is no cron backstop for the codegen states (only REVIEW /
-- VERIFYING have one). So the row's dwell climbed unbounded and runSessionStallSweep paged the
-- "[Sessions] FINALIZING stall" monitor (20985001) hourly for 30+ hours on a dead session.
--
-- This settles the row to the terminal it should already hold (session_index already says
-- archived), removing it from STALL_WATCH_STATES so the stall sweep stops emitting an
-- above-threshold dwell and the monitor recovers. Idempotent + CAS-safe: the state='FINALIZING'
-- guard makes it a no-op if anything already advanced the row. `state` has no CHECK constraint
-- and 'ARCHIVED' is a valid FsmState (fsm/types.ts), so no table rebuild is needed.
--
-- The EXISTS guard on session_index.status='archived' pins the migration to the precondition it
-- relies on: if the session is unarchived before this runs (`/session/unarchive` flips
-- session_index.status back to 'active' but does NOT drive the FSM, so the row can still be
-- FINALIZING), the UPDATE becomes a no-op instead of forcing a now-active session into the
-- terminal ARCHIVED state.
--
-- Durable follow-ups (separate PRs): (1) archival must drive `session.archived` through
-- applyEvent so archived sessions terminalize their FSM row; (2) a cross-DO cron backstop for
-- GENERATING/FINALIZING/PUBLISHING mirroring fireDwellDueReviewStuckDeadlines, so a dormant DO
-- can never strand a codegen-state row again.

UPDATE pr_coordination
SET state = 'ARCHIVED',
    version = version + 1,
    deadline_at = NULL
WHERE session_id = '2e205db1-27d3-4188-97c4-1d3df36f5680'
  AND state = 'FINALIZING'
  AND EXISTS (
    SELECT 1 FROM session_index si
    WHERE si.session_id = '2e205db1-27d3-4188-97c4-1d3df36f5680'
      AND si.status = 'archived'
  );
