import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import jsxA11y from "eslint-plugin-jsx-a11y";
import unusedImports from "eslint-plugin-unused-imports";
import simpleImportSort from "eslint-plugin-simple-import-sort";

// Point-of-change bans (replace the former frontend-audit count metrics). Each
// selector is shared across the base rule and the per-file overrides so a wrapper
// file can be exempted from only its own rule, not every no-restricted-syntax ban
// (e.g. useEffects.ts still bans raw WebSocket/fetch).
const BAN_USE_EFFECT = {
  selector: "CallExpression[callee.name='useEffect']",
  message:
    "Direct useEffect is banned. Use useMountEffect (mount-only), useOnChange (skip-mount dep changes), or useSyncEffect (all dep changes).",
};
const BAN_RAW_WEBSOCKET = {
  selector: "NewExpression[callee.name='WebSocket']",
  message:
    "Raw `new WebSocket` is banned in UI code. Use the useSessionWebSocket hook (apps/ui/src/hooks/useSessionWebSocket.ts), the one sanctioned WebSocket owner.",
};
const BAN_RAW_FETCH = {
  selector: "CallExpression[callee.name='fetch']",
  message:
    "Raw `fetch(` is banned in UI app code. Add a typed function to apps/ui/src/api/ (use requestJson from api/client) and call that instead.",
};
const BAN_TOOLS_PROCESS_ENV = {
  selector:
    ":matches(MemberExpression[object.name='process'][property.name='env'], MemberExpression[object.name='process'][computed=true][property.value='env'])",
  message: "Tool clients must read secrets from the execution context via secret(name, ctx.env), not process.env.",
};
const BAN_REQUEST_JSON_CAST = {
  // Catch both `(await request.json()) as T` (TSAsExpression > AwaitExpression)
  // and the equivalent `await (request.json() as T)` (AwaitExpression > TSAsExpression);
  // the two forms compile identically but produce reversed ASTs.
  selector:
    ":matches(TSAsExpression > AwaitExpression, AwaitExpression > TSAsExpression) > CallExpression[callee.property.name='json'][callee.object.name='request']",
  message:
    "Ad-hoc `(await request.json()) as T` is banned. Read the body through parseJsonBody (apps/control-plane-worker/src/utils.ts), which already parses and guards it.",
};
const BAN_ROUTE_PREPARE = {
  selector: "CallExpression[callee.property.name='prepare']",
  message: "Routes must not call D1 prepare() directly. Move database access into a DAO/service layer.",
};
const ROUTE_DAO_IMPORT_BAN = {
  patterns: [
    {
      group: ["../**/db", "../**/*-db", "../../**/db", "../../**/*-db"],
      allowTypeImports: true,
      message: "Routes must not value-import DAO modules. Call a service, or add a narrow legacy exemption.",
    },
  ],
};

export default [
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        jsx: true,
      },
    },
    plugins: {
      "unused-imports": unusedImports,
      "@typescript-eslint": tsPlugin,
      "simple-import-sort": simpleImportSort,
    },
    rules: {
      "unused-imports/no-unused-imports": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "simple-import-sort/imports": "error",
      "simple-import-sort/exports": "error",
      "no-console": "warn",
      "eol-last": "error",
    },
  },
  {
    files: ["apps/ui/src/**/*.tsx"],
    plugins: {
      "jsx-a11y": jsxA11y,
    },
    rules: {
      ...jsxA11y.flatConfigs.recommended.rules,
    },
  },
  // Ban direct useEffect and freeze server-only shared imports in UI components
  {
    files: ["apps/ui/src/**/*.ts", "apps/ui/src/**/*.tsx"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "react",
              importNames: ["useEffect"],
              message: "Import useMountEffect, useOnChange, or useSyncEffect from '../hooks/useEffects' instead.",
            },
          ],
          patterns: [
            {
              group: ["**/shared/constants/models", "**/shared/constants/models.js"],
              message:
                "Frozen: shared/constants/models exposes server-only registry internals. Use server-provided DTOs instead (see frontend-knowledge-exposure-reduction-plan.md, Phase 2).",
            },
            {
              group: ["**/shared/constants/integration-helpers", "**/shared/constants/integration-helpers.js"],
              message:
                "Frozen: shared/constants/integration-helpers exposes server-only integration registry. Use server-provided DTOs instead (see frontend-knowledge-exposure-reduction-plan.md, Phase 1).",
            },
            {
              group: ["**/shared/constants/integrations", "**/shared/constants/integrations.js"],
              message:
                "Frozen: shared/constants/integrations is the server-only integration registry. Do not import directly from UI.",
            },
          ],
        },
      ],
      "no-restricted-syntax": ["error", BAN_USE_EFFECT, BAN_RAW_WEBSOCKET, BAN_RAW_FETCH],
    },
  },
  // useEffects.ts is the sanctioned useEffect wrapper: exempt only the useEffect
  // ban, keep the raw-WebSocket and raw-fetch bans in force.
  {
    files: ["apps/ui/src/hooks/useEffects.ts"],
    rules: {
      "no-restricted-imports": "off",
      "no-restricted-syntax": ["error", BAN_RAW_WEBSOCKET, BAN_RAW_FETCH],
    },
  },
  // The two sanctioned WebSocket owners: useSessionWebSocket.ts (per-session
  // channel) and useSessionFeed.ts (per-business sidebar feed, ARC-1322). Exempt
  // only the raw-WebSocket ban for these.
  {
    files: ["apps/ui/src/hooks/useSessionWebSocket.ts", "apps/ui/src/hooks/useSessionFeed.ts"],
    rules: {
      "no-restricted-syntax": ["error", BAN_USE_EFFECT, BAN_RAW_FETCH],
    },
  },
  // The API client layer and the Cloudflare Worker entry are the sanctioned homes
  // for fetch: exempt only the raw-fetch ban.
  {
    files: ["apps/ui/src/api/**/*.ts", "apps/ui/src/worker.ts"],
    rules: {
      "no-restricted-syntax": ["error", BAN_USE_EFFECT, BAN_RAW_WEBSOCKET],
    },
  },
  // Force control-plane structured-output calls through the platform wrapper so they
  // emit cost/usage telemetry. Banning the import (not just the call) also blocks the
  // `(deps.fn ?? queryOpenAIStructuredOutput)(...)` fallback form.
  {
    files: ["apps/control-plane-worker/src/**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
      },
    },
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/shared/llm/structured-output", "**/shared/llm/structured-output.js"],
              importNames: [
                "queryOpenAIStructuredOutput",
                "queryBasetenStructuredOutput",
                "queryAnthropicStructuredOutput",
              ],
              message:
                "Use queryPlatformStructuredOutput (services/platform-structured-output) so the call emits platform_llm.usage_event (cost, usage, session correlation). Direct provider structured-output calls are allowed only inside the wrapper.",
            },
          ],
        },
      ],
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "no-restricted-syntax": ["error", BAN_REQUEST_JSON_CAST],
    },
  },
  {
    files: ["apps/sandbox-bridge/src/**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
    },
  },
  {
    files: ["tools/**/*.ts"],
    rules: {
      "no-restricted-syntax": ["error", BAN_TOOLS_PROCESS_ENV],
    },
  },
  {
    files: ["apps/control-plane-worker/src/routes/**/*.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": ["error", ROUTE_DAO_IMPORT_BAN],
      "no-restricted-syntax": ["error", BAN_REQUEST_JSON_CAST, BAN_ROUTE_PREPARE],
    },
  },
  // These routes still have legacy DAO imports, but direct route-level
  // `db.prepare()` remains banned by the route override above.
  {
    files: [
      "apps/control-plane-worker/src/routes/admin-approvals.ts",
      "apps/control-plane-worker/src/routes/admin-fsm-parity-check.ts",
      "apps/control-plane-worker/src/routes/admin-impersonation.ts",
      "apps/control-plane-worker/src/routes/auth.ts",
      "apps/control-plane-worker/src/routes/bootstrap.ts",
      "apps/control-plane-worker/src/routes/businesses.ts",
      "apps/control-plane-worker/src/routes/integrations.ts",
      "apps/control-plane-worker/src/routes/observability.ts",
      "apps/control-plane-worker/src/routes/sessions.ts",
      "apps/control-plane-worker/src/routes/test-credentials.ts",
    ],
    rules: {
      "@typescript-eslint/no-restricted-imports": "off",
    },
  },
  // The wrapper is the one sanctioned caller of the raw primitive.
  {
    files: ["apps/control-plane-worker/src/services/platform-structured-output.ts"],
    rules: {
      "no-restricted-imports": "off",
    },
  },
  {
    ignores: [
      "node_modules/",
      "dist/",
      "**/dist/**",
      "**/.wrangler/**",
      ".claude/worktrees/**",
      ".worktrees/**",
      ".codex/worktrees/**",
      ".gstack/**",
    ],
  },
];
