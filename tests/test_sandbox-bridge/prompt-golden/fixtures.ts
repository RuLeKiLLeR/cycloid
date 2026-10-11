import type { BuildSystemContextInput } from "../../../apps/sandbox-bridge/src/services/prompt-context-builder.js";
import { buildFileAttachmentsSection } from "../../../apps/sandbox-bridge/src/services/prompt-context-builder.js";

export type PromptGoldenFixture = {
  name: string;
  input: BuildSystemContextInput;
};

const NO_IDENTITY = { gitAuthorName: undefined, ownerUserId: undefined, promptActorUserId: null } as const;

const SKILL_SECTION = {
  name: "skill_directives",
  content:
    "<skill_directives>\nFollow the /deploy skill: run the deploy checklist before pushing.\n</skill_directives>",
  cadence: "conditional" as const,
};

const WORKSPACE_SECTION = {
  name: "workspace_setup_notice",
  content: "Workspace dependencies were installed with `npm install` before this prompt started.",
  cadence: "conditional" as const,
};

export const PROMPT_GOLDEN_FIXTURES: PromptGoldenFixture[] = [
  {
    name: "empty-initial",
    input: {
      hasSentPromptInCurrentSession: false,
      identity: NO_IDENTITY,
      perPromptSections: [],
      pendingDiagnostics: [],
    },
  },
  {
    name: "identity-author-only",
    input: {
      hasSentPromptInCurrentSession: false,
      identity: { gitAuthorName: "Ada Lovelace", ownerUserId: "42", promptActorUserId: null },
      perPromptSections: [],
      pendingDiagnostics: [],
    },
  },
  {
    name: "identity-distinct-prompt-actor",
    input: {
      hasSentPromptInCurrentSession: false,
      identity: { gitAuthorName: "Ada Lovelace", ownerUserId: "42", promptActorUserId: "77" },
      perPromptSections: [],
      pendingDiagnostics: [],
    },
  },
  {
    name: "identity-actor-without-owner",
    input: {
      hasSentPromptInCurrentSession: false,
      identity: { gitAuthorName: "Ada Lovelace", ownerUserId: undefined, promptActorUserId: "77" },
      perPromptSections: [],
      pendingDiagnostics: [],
    },
  },
  {
    name: "identity-invalid-prompt-actor",
    input: {
      hasSentPromptInCurrentSession: false,
      identity: { gitAuthorName: "Ada Lovelace", ownerUserId: "42", promptActorUserId: "not a user id!" },
      perPromptSections: [],
      pendingDiagnostics: [],
    },
  },
  {
    name: "skill-directive",
    input: {
      hasSentPromptInCurrentSession: false,
      identity: NO_IDENTITY,
      perPromptSections: [SKILL_SECTION],
      pendingDiagnostics: [],
    },
  },
  {
    name: "attached-files",
    input: {
      hasSentPromptInCurrentSession: false,
      identity: NO_IDENTITY,
      perPromptSections: [
        {
          name: "file_attachment_directives",
          content: buildFileAttachmentsSection(["src/index.ts", "docs/architecture.md"]),
          cadence: "conditional",
        },
      ],
      pendingDiagnostics: [],
    },
  },
  {
    name: "workspace-setup-notice",
    input: {
      hasSentPromptInCurrentSession: false,
      identity: NO_IDENTITY,
      perPromptSections: [WORKSPACE_SECTION],
      pendingDiagnostics: [],
    },
  },
  {
    name: "diagnostics-single-error",
    input: {
      hasSentPromptInCurrentSession: true,
      identity: NO_IDENTITY,
      perPromptSections: [],
      pendingDiagnostics: [
        {
          file: "src/server.ts",
          line: 12,
          column: 3,
          severity: "error",
          message: "Cannot find name 'foo'.",
          source: "typescript",
        },
      ],
    },
  },
  {
    name: "diagnostics-mixed",
    input: {
      hasSentPromptInCurrentSession: true,
      identity: NO_IDENTITY,
      perPromptSections: [],
      pendingDiagnostics: [
        {
          file: "src/server.ts",
          line: 12,
          column: 3,
          severity: "error",
          message: "Cannot find name 'foo'.",
          source: "typescript",
        },
        {
          file: "src/server.ts",
          line: 30,
          column: 1,
          severity: "warning",
          message: "'bar' is declared but never used.",
          source: "typescript",
        },
        {
          file: "src/client.ts",
          line: 5,
          column: 10,
          severity: "error",
          message: "Unexpected any.",
          source: "eslint",
        },
      ],
    },
  },
  {
    name: "followup-composite",
    input: {
      hasSentPromptInCurrentSession: true,
      identity: { gitAuthorName: "Ada Lovelace", ownerUserId: "42", promptActorUserId: "77" },
      perPromptSections: [SKILL_SECTION, WORKSPACE_SECTION],
      pendingDiagnostics: [
        {
          file: "src/server.ts",
          line: 12,
          column: 3,
          severity: "error",
          message: "Cannot find name 'foo'.",
          source: "typescript",
        },
      ],
    },
  },
  {
    name: "initial-composite",
    input: {
      hasSentPromptInCurrentSession: false,
      identity: { gitAuthorName: "Grace Hopper", ownerUserId: "7", promptActorUserId: null },
      perPromptSections: [
        SKILL_SECTION,
        {
          name: "file_attachment_directives",
          content: buildFileAttachmentsSection(["README.md"]),
          cadence: "conditional",
        },
      ],
      pendingDiagnostics: [],
    },
  },
];
