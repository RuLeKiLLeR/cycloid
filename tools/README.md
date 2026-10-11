# Tool Plugins

Tool plugins live under `tools/<name>/`.
Each plugin has a `manifest.toml` and a `client.ts`.

## Manifest

Required fields:

- `name`: tool namespace exposed to agents.
- `description`: human-readable tool summary.
- `module`: client module path, currently `./client.ts`.
- `hosts`: provider hosts the tool may contact.
- `[[secrets]]`: declared runtime secrets.

Day-one secret support is `type = "http"` with `name` and `hosts`.
Future secret types intentionally fail manifest validation until the proxy contract exists.

## Client

`client.ts` exports a `methods` table.
Each method defines:

- `description`
- `inputSchema`: zod schema used for both catalog JSON Schema and dispatch validation.
- `planMode`: `readOnly` or `sideEffecting`.
- `execute(args, ctx)`: stateless execution.
- `redactPersistedInput(args)`: optional persistence redaction.

Read secrets from the execution context with `secret(name, ctx.env)`.
Direct `process.env` reads are banned in `tools/**/*.ts` so session-scoped credentials stay explicit.
