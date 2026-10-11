import { type ReactNode, useRef, useState } from "react";
import { Link, useParams } from "react-router";

import type { IntegrationLifecycleEvent } from "../../../../../shared/types/integrations";
import { fetchIntegrationLifecycleEvents } from "../../api/integration-lifecycle";
import { useSyncEffect } from "../../hooks/useEffects";
import { Badge, type BadgeTone, Button, CopyButton, cx } from "../ui";
import { SettingsError, SettingsPageHeader, SettingsSection, SettingsSkeleton } from "./SettingsLayout";

function formatTimestamp(value: number): string {
  return new Date(value).toLocaleString();
}

function formatLabel(value: string): string {
  return value
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
}

function getStatusTone(status: IntegrationLifecycleEvent["status"]): BadgeTone {
  if (status === "failed") return "error";
  if (status === "passed") return "success";
  return "warning";
}

function getStatusDotClasses(status: IntegrationLifecycleEvent["status"]): string {
  if (status === "failed") return "bg-error";
  if (status === "passed") return "bg-success";
  return "bg-warning";
}

function formatDetails(detailsJson: string | null): string | null {
  if (!detailsJson) return null;
  try {
    return JSON.stringify(JSON.parse(detailsJson), null, 2);
  } catch {
    return detailsJson;
  }
}

function MetadataItem({
  label,
  value,
  children,
}: {
  label: string;
  value?: string | number | null;
  children?: ReactNode;
}) {
  if (value == null && children == null) return null;

  return (
    <div className="min-w-0">
      <dt className="eyebrow">{label}</dt>
      <dd className="mt-1 min-w-0 text-sm text-text-secondary">{children ?? value}</dd>
    </div>
  );
}

function IntegrationEventRow({ event }: { event: IntegrationLifecycleEvent }) {
  const details = formatDetails(event.details_json);

  return (
    <article className="session-stack-surface overflow-hidden p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={cx("inline-block h-1.5 w-1.5 rounded-full", getStatusDotClasses(event.status))}
              aria-hidden
            />
            <Badge tone={getStatusTone(event.status)}>{event.status}</Badge>
            <span className="font-mono-tabular text-xs text-text-muted">{formatLabel(event.stage)}</span>
          </div>
          {event.message ? (
            <p className="mt-2 text-md leading-relaxed text-text-primary">{event.message}</p>
          ) : (
            <p className="mt-2 text-md leading-relaxed text-text-primary">{formatLabel(event.stage)}</p>
          )}
        </div>
        <time
          dateTime={new Date(event.created_at).toISOString()}
          className="shrink-0 font-mono-tabular text-xs text-text-muted tabular-nums"
        >
          {formatTimestamp(event.created_at)}
        </time>
      </div>

      <dl className="mt-4 grid gap-3 border-t border-border pt-3 sm:grid-cols-2 lg:grid-cols-4">
        <MetadataItem label="Integration">
          <span className="font-mono-tabular text-text-primary">{event.integration_id}</span>
        </MetadataItem>
        <MetadataItem label="Stage">
          <span className="font-mono-tabular">{event.stage}</span>
        </MetadataItem>
        <MetadataItem label="Reason" value={event.reason_code ?? "—"} />
        <MetadataItem label="Latency" value={event.latency_ms > 0 ? `${event.latency_ms} ms` : "—"} />
      </dl>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <CopyButton value={event.id} label="Copy event ID" copiedChildren="Copied event ID">
          Copy event ID
        </CopyButton>
        <CopyButton value={event.integration_id} label="Copy integration ID" copiedChildren="Copied integration ID">
          Copy integration ID
        </CopyButton>
        {event.session_id ? (
          <>
            <CopyButton value={event.session_id} label="Copy session ID" copiedChildren="Copied session ID">
              Copy session ID
            </CopyButton>
            <Link
              to={`/sessions/${event.session_id}`}
              className="inline-flex control-sm items-center px-2 text-xs font-medium text-accent transition-colors hover:bg-surface-2 hover:text-text-primary"
            >
              session {event.session_id}
            </Link>
          </>
        ) : null}
      </div>

      {details ? (
        <details className="mt-3 border border-border bg-surface-0">
          <summary className="eyebrow cursor-pointer px-3 py-2">Details</summary>
          <pre className="max-h-64 overflow-auto border-t border-border px-3 py-2 text-xs leading-relaxed text-text-secondary">
            {details}
          </pre>
        </details>
      ) : null}
    </article>
  );
}

function IntegrationEventsState({ title, description }: { title: string; description: string }) {
  return (
    <div className="editorial-fade session-stack-surface px-4 py-5">
      <h3 className="text-md text-text-primary">{title}</h3>
      <p className="mt-1 text-base leading-relaxed text-text-secondary">{description}</p>
    </div>
  );
}

export function IntegrationsDebugSettings() {
  const { integrationId } = useParams();
  const [events, setEvents] = useState<IntegrationLifecycleEvent[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestGenerationRef = useRef(0);

  useSyncEffect(() => {
    requestGenerationRef.current += 1;
    const generation = requestGenerationRef.current;
    let cancelled = false;
    setLoading(true);
    setLoadingMore(false);
    setError(null);
    setEvents([]);
    setNextCursor(null);

    fetchIntegrationLifecycleEvents({ integrationId, limit: 50 })
      .then((result) => {
        if (cancelled || requestGenerationRef.current !== generation) return;
        setEvents(result.events);
        setNextCursor(result.nextCursor);
      })
      .catch((loadError) => {
        if (cancelled || requestGenerationRef.current !== generation) return;
        setError(loadError instanceof Error ? loadError.message : "Failed to load integration events.");
      })
      .finally(() => {
        if (!cancelled && requestGenerationRef.current === generation) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [integrationId]);

  async function handleLoadMore() {
    if (nextCursor == null) return;
    const generation = requestGenerationRef.current;
    setLoadingMore(true);
    try {
      const result = await fetchIntegrationLifecycleEvents({
        integrationId,
        cursor: nextCursor,
        limit: 50,
      });
      if (requestGenerationRef.current !== generation) return;
      setEvents((prev) => [...prev, ...result.events]);
      setNextCursor(result.nextCursor);
    } catch (loadError) {
      if (requestGenerationRef.current !== generation) return;
      setError(loadError instanceof Error ? loadError.message : "Failed to load more events.");
    } finally {
      if (requestGenerationRef.current === generation) setLoadingMore(false);
    }
  }

  return (
    <div className="space-y-6">
      <SettingsPageHeader
        eyebrow="Diagnostics"
        title="Diagnostics"
        description={
          integrationId
            ? `Recent events for ${integrationId} — useful when this integration isn't behaving as expected.`
            : "Recent events from integrations — useful when GitHub or Linear isn't behaving as expected."
        }
      />

      <SettingsSection title="Integration events">
        <div className="mt-4 space-y-6">
          {loading ? (
            <div className="session-stack-surface p-4">
              <SettingsSkeleton rows={4} showHeader={false} control={false} />
            </div>
          ) : error ? (
            <SettingsError message={error} />
          ) : events.length === 0 ? (
            <IntegrationEventsState
              title="No lifecycle events found"
              description={
                integrationId
                  ? `No recent lifecycle events were recorded for ${integrationId}.`
                  : "No recent lifecycle events were recorded for this business."
              }
            />
          ) : (
            <div className="editorial-fade space-y-3">
              {events.map((event) => (
                <IntegrationEventRow key={event.id} event={event} />
              ))}
            </div>
          )}

          {nextCursor != null && !loading && (
            <Button type="button" onClick={handleLoadMore} disabled={loadingMore} variant="secondary" size="md">
              {loadingMore ? "Loading…" : "Load more"}
            </Button>
          )}
        </div>
      </SettingsSection>
    </div>
  );
}
