import { type ReactNode, useMemo, useState } from "react";
import { Link } from "react-router";

import { fetchRepoContext, type RepoContext, type RepoContextMcpServer } from "../api/repo-context";
import { mcpValidationTone, splitRepoFullName, transportLabel } from "../components/context/context-helpers";
import { ContextSection } from "../components/context/ContextSection";
import { useLayoutContext } from "../components/Layout";
import {
  ArtifactChip,
  Badge,
  buttonClasses,
  EmptyState,
  PageHeader,
  Row,
  Select,
  SkeletonRows,
  StatTile,
} from "../components/ui";
import {
  CONTEXT_RUNTIME_COPY,
  LAYER_SOURCE_STATUS_LABELS,
  MCP_VALIDATION_STATUS_LABELS,
} from "../constants/repo-context";
import { useSyncEffect } from "../hooks/useEffects";
import { formatTimestampMinutes } from "../utils/time";

type LoadState = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; data: RepoContext };
type ContextTabId = "instructions" | "mcp" | "skills" | "secrets" | "setup" | "review";

// Rows inside a section card are separated by `.rule` hairlines (border-t
// border-border) rather than each carrying its own frame.
const listDivided = "[&>*+*]:border-t [&>*+*]:border-border";

// Key/value readout grid per the kit KeyValue: a Geist eyebrow label in the
// muted column, a tabular reading value in the primary column.
function KeyValueGrid({ children }: { children: ReactNode }) {
  return <dl className="grid grid-cols-[max-content_minmax(0,1fr)] items-baseline gap-x-6 gap-y-2.5">{children}</dl>;
}

function KeyValueRow({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <>
      <dt className="eyebrow pt-px">{label}</dt>
      <dd className="min-w-0 font-mono-tabular text-sm text-text-primary">{children}</dd>
    </>
  );
}

export function ContextPage() {
  const { repos, reposLoaded, selectedRepo } = useLayoutContext();

  const [selectedFullName, setSelectedFullName] = useState("");
  const [load, setLoad] = useState<LoadState>({ status: "loading" });

  // Keep the selection valid as repos hydrate: prefer the globally selected
  // repo, otherwise the first available one.
  useSyncEffect(() => {
    if (repos.length === 0) {
      if (selectedFullName !== "") setSelectedFullName("");
      return;
    }
    const stillValid = repos.some((repo) => repo.fullName === selectedFullName);
    if (stillValid) return;
    const preferred = repos.find((repo) => repo.fullName === selectedRepo?.fullName) ?? repos[0];
    setSelectedFullName(preferred.fullName);
  }, [repos, selectedRepo, selectedFullName]);

  useSyncEffect(() => {
    if (!selectedFullName) return;
    const parts = splitRepoFullName(selectedFullName);
    if (!parts) {
      setLoad({ status: "error", message: "Could not parse the selected repository." });
      return;
    }
    let cancelled = false;
    setLoad({ status: "loading" });
    fetchRepoContext(parts.owner, parts.name)
      .then((data) => {
        if (!cancelled) setLoad({ status: "ready", data });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : "Failed to load repository context.";
        setLoad({ status: "error", message });
      });
    return () => {
      cancelled = true;
    };
  }, [selectedFullName]);

  const repoSelector = useMemo(() => {
    if (repos.length === 0) return null;
    return (
      <Select
        controlSize="sm"
        aria-label="Select a repository"
        value={selectedFullName}
        onChange={(event) => setSelectedFullName(event.target.value)}
        wrapperClassName="w-56"
      >
        {repos.map((repo) => (
          <option key={repo.fullName} value={repo.fullName}>
            {repo.fullName}
          </option>
        ))}
      </Select>
    );
  }, [repos, selectedFullName]);

  return (
    <div className="control-room-canvas control-room-page">
      <div className="control-room-content flex flex-col gap-5">
        {/* The repo selector lives in the header actions slot, so it rides the
            -1 beat; there is no standalone toolbar row on this page. */}
        <PageHeader
          eyebrow="Knowledge"
          title="Context"
          actions={repoSelector}
          className="editorial-rise editorial-rise-1"
        />
        <div className="editorial-rise editorial-rise-3">{renderBody({ repos, reposLoaded, load })}</div>
      </div>
    </div>
  );
}

function renderBody({
  repos,
  reposLoaded,
  load,
}: {
  repos: ReturnType<typeof useLayoutContext>["repos"];
  reposLoaded: boolean;
  load: LoadState;
}) {
  if (repos.length === 0) {
    if (!reposLoaded) {
      return <SkeletonRows rows={4} />;
    }
    return (
      <EmptyState
        title="No repositories connected"
        description="Connect a repository to see the context injected into its agent sessions."
      />
    );
  }

  if (load.status === "loading") {
    return <SkeletonRows rows={5} />;
  }

  if (load.status === "error") {
    return <EmptyState title="Could not load context" description={load.message} />;
  }

  // Skeleton → content swap: this wrapper mounts when the load flips to ready
  // (including repo switches), fading the whole body in as one unit.
  return (
    <div className="editorial-fade">
      <ContextBody context={load.data} />
    </div>
  );
}

/**
 * First bucket with real content, in nav order. Runtime-resolved buckets
 * (instructions/skills in Wave 0) are skipped so the page never opens on an
 * empty panel; review settings always carry concrete values, so it is the
 * final fallback.
 */
export function defaultContextTab(context: RepoContext): ContextTabId {
  if (context.instructionFiles.available && context.instructionFiles.files.length > 0) return "instructions";
  if (context.mcpServers.length > 0) return "mcp";
  if (context.skills.available && context.skills.items.length > 0) return "skills";
  if (context.secrets.testCredentials.length + context.secrets.repoRuntimeEnvVarNames.length > 0) return "secrets";
  if (context.setup.repoLayerSource || context.setup.businessDefaultLayerSource) return "setup";
  return "review";
}

function ContextBody({ context }: { context: RepoContext }) {
  const [selected, setSelected] = useState<ContextTabId>(() => defaultContextTab(context));
  const sections: Array<{
    id: ContextTabId;
    title: string;
    description: string;
    meta?: ReactNode;
    content: ReactNode;
  }> = [
    // Counts live in the badge only; descriptions stay qualitative so the same
    // number is never printed twice in one nav item. Runtime-resolved buckets
    // say it once, in the chip — the panel body carries the explanation.
    {
      id: "instructions",
      title: "Instruction files",
      description: context.instructionFiles.available
        ? "Files in precedence order"
        : "Agent instruction files from your repo",
      meta: context.instructionFiles.available ? (
        <Badge tone="default">{context.instructionFiles.files.length}</Badge>
      ) : (
        <RuntimeBadge />
      ),
      content: <InstructionFilesSection files={context.instructionFiles} />,
    },
    {
      id: "mcp",
      title: "MCP servers",
      description: "Tool servers available to sessions",
      meta: <Badge tone="default">{context.mcpServers.length}</Badge>,
      content: <McpServersSection servers={context.mcpServers} />,
    },
    {
      id: "skills",
      title: "Skills",
      description: "Reusable skills exposed to sessions",
      meta: context.skills.available ? <Badge tone="default">{context.skills.items.length}</Badge> : <RuntimeBadge />,
      content: <SkillsSection skills={context.skills} />,
    },
    {
      id: "secrets",
      title: "Secrets & env",
      description: "Credential and env var names — values stay redacted",
      meta: (
        <Badge tone="default">
          {context.secrets.testCredentials.length + context.secrets.repoRuntimeEnvVarNames.length}
        </Badge>
      ),
      content: <SecretsSection secrets={context.secrets} />,
    },
    {
      id: "setup",
      title: "Setup",
      description: "Sandbox environment for this repository",
      content: <SetupSection setup={context.setup} />,
    },
    {
      id: "review",
      title: "Review settings",
      description: "Review loop behavior after publish",
      content: <ReviewSettingsSection review={context.reviewSettings} />,
    },
  ];
  const selectedSection = sections.find((section) => section.id === selected) ?? sections[0];

  return (
    <div className="grid gap-6 lg:grid-cols-[17rem_minmax(0,1fr)]">
      <div className="lg:hidden">
        <Select
          aria-label="Select a context source"
          value={selectedSection.id}
          onChange={(event) => setSelected(event.target.value as ContextTabId)}
          wrapperClassName="w-full"
        >
          {sections.map((section) => (
            <option key={section.id} value={section.id}>
              {section.title}
            </option>
          ))}
        </Select>
      </div>
      <nav aria-label="Context sources" className="hidden flex-col gap-1 lg:sticky lg:top-6 lg:flex lg:self-start">
        {sections.map((section) => {
          const active = section.id === selectedSection.id;
          return (
            <button
              key={section.id}
              type="button"
              onClick={() => setSelected(section.id)}
              className={`flex min-w-0 items-start justify-between gap-3 border-l-2 px-3 py-2 text-left transition-colors ${
                active
                  ? "border-live bg-surface-2 text-text-primary"
                  : "border-transparent text-text-secondary hover:bg-surface-1 hover:text-text-primary"
              }`}
            >
              <span className="min-w-0">
                {/* Titles wrap instead of truncating — "Instruction files" must
                    never render as "Instructi…" in its own nav. */}
                <span className="block text-sm font-medium">{section.title}</span>
                <span className="mt-0.5 block line-clamp-2 text-xs text-text-muted">{section.description}</span>
              </span>
              {section.meta ? <span className="shrink-0 pt-0.5">{section.meta}</span> : null}
            </button>
          );
        })}
      </nav>
      <div className="min-w-0">{selectedSection.content}</div>
    </div>
  );
}

function RuntimeBadge() {
  return <ArtifactChip kind="text" label="Resolved at runtime" showIcon={false} />;
}

function ManageLink({ to }: { to: string }) {
  return (
    <Link to={to} className={buttonClasses({ variant: "ghost", size: "sm" })}>
      Manage
    </Link>
  );
}

function InstructionFilesSection({ files }: { files: RepoContext["instructionFiles"] }) {
  return (
    <ContextSection title="Instruction files">
      {files.available && files.files.length > 0 ? (
        <div className="flex flex-col gap-3">
          <p className="max-w-prose text-sm text-text-muted">{files.precedenceNote}</p>
          <div className={listDivided}>
            {files.files.map((file) => (
              <Row
                key={file.path}
                title={<span className="font-mono-tabular">{file.path}</span>}
                subtitle={file.role}
                trailing={file.precedenceNote}
              />
            ))}
          </div>
        </div>
      ) : (
        // UI-owned copy instead of the server note, which leaks storage
        // internals ("not persisted in D1").
        <EmptyState
          className="py-8"
          title={CONTEXT_RUNTIME_COPY.instructionsTitle}
          description={CONTEXT_RUNTIME_COPY.instructionsDescription}
        />
      )}
    </ContextSection>
  );
}

function secretNamesForServer(server: RepoContextMcpServer): string[] {
  const names = new Set<string>(server.secretRefs);
  for (const secretName of Object.values(server.headerSecretRefs)) {
    names.add(secretName);
  }
  return Array.from(names);
}

function McpServersSection({ servers }: { servers: RepoContextMcpServer[] }) {
  return (
    <ContextSection title="MCP servers" aside={<ManageLink to="/settings/mcp-servers" />}>
      {servers.length === 0 ? (
        <EmptyState title="No MCP servers" description="No MCP servers are configured for this repository." />
      ) : (
        <div className={listDivided}>
          {servers.map((server) => {
            const secretNames = secretNamesForServer(server);
            return (
              <div key={server.id}>
                <Row
                  title={
                    <span className="flex items-center gap-2">
                      <span className="truncate">{server.name}</span>
                      {!server.enabled && <Badge tone="default">Disabled</Badge>}
                    </span>
                  }
                  subtitle={server.description ?? "No description"}
                  meta={transportLabel(server.transport)}
                  chips={
                    <>
                      <Badge tone={mcpValidationTone(server.validationStatus)}>
                        {MCP_VALIDATION_STATUS_LABELS[server.validationStatus] ?? server.validationStatus}
                      </Badge>
                      <span className="numeral text-xs text-text-muted">
                        {server.discoveredToolCount} {server.discoveredToolCount === 1 ? "tool" : "tools"}
                      </span>
                    </>
                  }
                />
                {secretNames.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5 border-t border-border px-4 py-3">
                    <span className="eyebrow">Secrets</span>
                    {secretNames.map((name) => (
                      <ArtifactChip key={name} kind="text" label={name} showIcon={false} />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </ContextSection>
  );
}

function SkillsSection({ skills }: { skills: RepoContext["skills"] }) {
  return (
    <ContextSection title="Skills">
      {skills.available && skills.items.length > 0 ? (
        <div className={listDivided}>
          {skills.items.map((skill) => (
            <Row
              key={skill.path}
              title={skill.name}
              subtitle={<span className="font-mono-tabular">{skill.path}</span>}
            />
          ))}
        </div>
      ) : (
        // UI-owned copy instead of the server note (storage internals).
        <EmptyState
          className="py-8"
          title={CONTEXT_RUNTIME_COPY.skillsTitle}
          description={CONTEXT_RUNTIME_COPY.skillsDescription}
        />
      )}
    </ContextSection>
  );
}

function SecretsSection({ secrets }: { secrets: RepoContext["secrets"] }) {
  const { testCredentials, repoRuntimeEnvVarNames } = secrets;
  return (
    <ContextSection
      title="Secrets & env"
      description="Names only — values are redacted and never shown here."
      aside={<ManageLink to="/settings/repositories" />}
    >
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <span className="eyebrow">Test credentials</span>
          {testCredentials.length === 0 ? (
            <p className="text-sm text-text-muted">No test credentials configured.</p>
          ) : (
            <div className={listDivided}>
              {testCredentials.map((credential) => (
                <Row
                  key={credential.name}
                  title={<span className="font-mono-tabular">{credential.name}</span>}
                  trailing={formatTimestampMinutes(credential.updatedAt) ?? "—"}
                />
              ))}
            </div>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <span className="eyebrow">Runtime env var names</span>
          {repoRuntimeEnvVarNames.length === 0 ? (
            <p className="text-sm text-text-muted">No runtime env vars configured.</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {repoRuntimeEnvVarNames.map((name) => (
                <ArtifactChip key={name} kind="text" label={name} showIcon={false} />
              ))}
            </div>
          )}
        </div>
      </div>
    </ContextSection>
  );
}

function SetupSection({ setup }: { setup: RepoContext["setup"] }) {
  const { repoLayerSource, businessDefaultLayerSource } = setup;
  return (
    // UI-owned description instead of the server note, which names D1 columns.
    <ContextSection
      title="Setup"
      description={CONTEXT_RUNTIME_COPY.setupDescription}
      aside={<ManageLink to="/settings/repositories" />}
    >
      <KeyValueGrid>
        <KeyValueRow label="Repository layer">
          {repoLayerSource ? (
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="truncate">{repoLayerSource.sourceId}</span>
              <span className="text-text-muted">
                Updated {formatTimestampMinutes(repoLayerSource.updatedAt) ?? "—"}
              </span>
            </span>
          ) : (
            <span className="text-text-muted">No repository-specific layer assigned.</span>
          )}
        </KeyValueRow>
        <KeyValueRow label="Business default layer">
          {businessDefaultLayerSource ? (
            <span className="flex min-w-0 flex-col gap-1">
              <span className="truncate">
                {businessDefaultLayerSource.repoOwner}/{businessDefaultLayerSource.repoName}
              </span>
              <span className="truncate text-text-muted">{businessDefaultLayerSource.manifestPath}</span>
              <span className="mt-0.5 flex flex-wrap items-center gap-1.5">
                <Badge tone="default">
                  {LAYER_SOURCE_STATUS_LABELS[businessDefaultLayerSource.status] ?? businessDefaultLayerSource.status}
                </Badge>
                <Badge tone="default">
                  {businessDefaultLayerSource.hasActiveArtifact ? "Active artifact" : "No artifact"}
                </Badge>
              </span>
            </span>
          ) : (
            <span className="text-text-muted">No business default layer assigned.</span>
          )}
        </KeyValueRow>
      </KeyValueGrid>
    </ContextSection>
  );
}

function ReviewSettingsSection({ review }: { review: RepoContext["reviewSettings"] }) {
  return (
    <ContextSection
      title="Review settings"
      description="How the review loop behaves after a PR is published."
      aside={<ManageLink to="/settings/repositories" />}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <StatTile label="Merge conflict resolution" value={review.mergeConflictResolutionEnabled ? "On" : "Off"} />
        <StatTile label="Expected review bots" value={review.expectedBots.length} />
      </div>
    </ContextSection>
  );
}
