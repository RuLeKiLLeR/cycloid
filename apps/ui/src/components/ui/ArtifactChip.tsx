import { type ReactNode } from "react";

import { GithubIcon } from "../icons";
import { type BadgeTone } from "./Badge";
import { chipClasses } from "./chip";
import { cx } from "./utils";

type IconProps = { className?: string };

const STROKE = {
  fill: "none" as const,
  stroke: "currentColor",
  strokeWidth: 1.4,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

function CheckMini({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className={className} {...STROKE}>
      <path d="M3.5 8.5l3 3 6-7" />
    </svg>
  );
}

function CrossMini({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className={className} {...STROKE}>
      <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
    </svg>
  );
}

function VerifiedMini({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className={className} {...STROKE}>
      <path d="M8 1.8l5 2v4c0 3-2.2 5-5 6.4-2.8-1.4-5-3.4-5-6.4v-4z" />
      <path d="M5.7 8l1.6 1.6L10.6 6" />
    </svg>
  );
}

function ChatMini({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className={className} {...STROKE}>
      <path d="M2.8 4.2A1.5 1.5 0 0 1 4.3 2.7h7.4a1.5 1.5 0 0 1 1.5 1.5V9a1.5 1.5 0 0 1-1.5 1.5H6.2l-3 2.4V10.5H4.3A1.5 1.5 0 0 1 2.8 9z" />
    </svg>
  );
}

function SlackMini({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className={className} {...STROKE}>
      <path d="M6.2 2.5v11M9.8 2.5v11M2.5 6.2h11M2.5 9.8h11" />
    </svg>
  );
}

function JiraMini({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className={className} {...STROKE}>
      <path d="M8 2l5.5 5.5L8 13 2.5 7.5z" />
      <path d="M5.5 7.5L8 10l2.5-2.5" />
    </svg>
  );
}

function LinearMini({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className={className} {...STROKE}>
      <path d="M3 8.5l4.5 4.5M3 5.5l7.5 7.5M4.5 3.5l8 8M8 3l5 5" />
    </svg>
  );
}

function ModelMini({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className={className} {...STROKE}>
      <path d="M8 2.5v11M2.5 8h11M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6" />
    </svg>
  );
}

export type ArtifactKind =
  | "pr-open"
  | "checks-passing"
  | "checks-failing"
  | "verified"
  | "needs-input"
  | "slack"
  | "jira"
  | "linear"
  | "model"
  | "text";

type ArtifactMeta = { label: string; tone: BadgeTone; Icon?: (props: IconProps) => ReactNode };

const ARTIFACT_META: Record<ArtifactKind, ArtifactMeta> = {
  "pr-open": { label: "PR open", tone: "default", Icon: GithubIcon },
  "checks-passing": { label: "Checks passing", tone: "success", Icon: CheckMini },
  "checks-failing": { label: "Checks failing", tone: "error", Icon: CrossMini },
  verified: { label: "Verified", tone: "success", Icon: VerifiedMini },
  "needs-input": { label: "Needs input", tone: "warning", Icon: ChatMini },
  slack: { label: "Slack", tone: "default", Icon: SlackMini },
  jira: { label: "Jira", tone: "default", Icon: JiraMini },
  linear: { label: "Linear", tone: "default", Icon: LinearMini },
  model: { label: "Model", tone: "default", Icon: ModelMini },
  text: { label: "", tone: "default" },
};

export type ArtifactChipProps = {
  kind: ArtifactKind;
  /** Override the default label. Required for `model` / `text`. */
  label?: ReactNode;
  /** Force a specific tone (defaults to the kind's tone). */
  tone?: BadgeTone;
  showIcon?: boolean;
  className?: string;
  title?: string;
};

export function ArtifactChip({ kind, label, tone, showIcon = true, className, title }: ArtifactChipProps) {
  const meta = ARTIFACT_META[kind];
  const Icon = meta.Icon;
  return (
    <span
      title={title}
      className={cx(
        // Shared chip geometry + tones (chipClasses) — matches Badge/StatusChip
        // so side-by-side chips read as one family.
        chipClasses(tone ?? meta.tone),
        className,
      )}
    >
      {showIcon && Icon != null && <Icon className="size-3 shrink-0" />}
      <span>{label ?? meta.label}</span>
    </span>
  );
}
