// The cycloid CLI version installed into the E2B sandbox base template
// (apps/sandbox-e2b/template.ts). Must stay >= the version that introduced the
// `cycloid sandbox` subcommand: the onboarding agent runs `cycloid sandbox
// init`/`validate` in-sandbox (ARC-1286). 0.1.97 predated it, so those commands
// failed in-session with `unknown command 'sandbox'` (oe-skeleton-new E2E).
export const PINNED_CYCLOID_CLI_VERSION = "0.1.125";
