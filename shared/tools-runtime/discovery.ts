import type { ToolManifest } from "./manifest.js";
import { ToolManifestSchema } from "./manifest.js";
import type { ToolMethods, ToolModule } from "./methods.js";
import { parseToml } from "./toml.js";

export type EmbeddedTool = {
  manifestText: string;
  manifestPath: string;
  module: ToolModule;
};

export type LoadedTool = {
  manifest: ToolManifest;
  methods: ToolMethods;
};

export type ToolDiscoveryLogger = Pick<Console, "warn">;

export function loadTools(
  embeddedTools: readonly EmbeddedTool[],
  options: { logger?: ToolDiscoveryLogger } = {},
): LoadedTool[] {
  const logger = options.logger ?? console;
  const byName = new Map<string, LoadedTool>();

  for (const embeddedTool of embeddedTools) {
    const manifest = parseToolManifest(embeddedTool, logger);
    if (!manifest) continue;
    const loadedTool = { manifest, methods: embeddedTool.module.methods };
    if (byName.has(manifest.name)) {
      logger.warn(`tool '${manifest.name}' declared more than once; later entry wins`, {
        manifestPath: embeddedTool.manifestPath,
      });
    }
    byName.set(manifest.name, loadedTool);
  }

  return [...byName.values()];
}

function parseToolManifest(embeddedTool: EmbeddedTool, logger: ToolDiscoveryLogger): ToolManifest | undefined {
  try {
    const parsedToml = parseToml(embeddedTool.manifestText, embeddedTool.manifestPath);
    return ToolManifestSchema.parse(parsedToml);
  } catch (error) {
    logger.warn(`tool manifest '${embeddedTool.manifestPath}' could not be loaded`, { error });
    return undefined;
  }
}
