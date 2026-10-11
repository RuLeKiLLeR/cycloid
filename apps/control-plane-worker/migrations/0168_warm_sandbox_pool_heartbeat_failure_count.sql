-- Deep-plan 6.4: transient-tolerant warm-pool heartbeat.
--
-- Before: refreshReadyEntryHeartbeat caught ALL exceptions and immediately
-- drained (reason='heartbeat_failed'), so one transient provider hiccup killed a
-- ready sandbox and triggered a create->die->recreate thrash loop (97/132
-- terminal rows in prod were heartbeat_failed).
--
-- After: transient heartbeat failures increment this counter; the entry only
-- drains once the count reaches a threshold. A successful heartbeat resets it.
ALTER TABLE warm_sandbox_pool_entries ADD COLUMN heartbeat_failure_count INTEGER NOT NULL DEFAULT 0;
