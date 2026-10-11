import type { EmbeddedTool } from "../../../../shared/tools-runtime/index.js";
import * as linearClient from "../../../../tools/linear/client.js";

const linearManifestText = `
name = "linear"
description = "Linear issue and comment tools."
module = "./client.ts"
hosts = ["api.linear.app"]

[[secrets]]
type = "http"
name = "LINEAR_ACCESS_TOKEN"
hosts = ["api.linear.app"]
`;

export const EMBEDDED_FIRST_PARTY_TOOLS: readonly EmbeddedTool[] = [
  {
    manifestText: linearManifestText,
    manifestPath: "tools/linear/manifest.toml",
    module: linearClient,
  },
];
