# Linear Tool

Linear is the first folder-based dynamic tool plugin.
The manifest declares the Linear API host and the `LINEAR_ACCESS_TOKEN` secret required before the tool is advertised.

The client exports a `methods` table.
Each method owns its zod input schema, plan mode, executor, and optional persistence redaction hook.

Current constraint: this is a first-party bridge plugin, not a portable external plugin boundary.
The client may import sandbox-bridge result helpers and utilities until those contracts are promoted into `shared/tools-runtime`.
