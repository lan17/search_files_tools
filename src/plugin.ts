import type { OpenClawPluginApi } from "./runtime-api.ts";
import { resolvePluginConfig } from "./config.ts";
import { createFilesGlobTool } from "./files-glob-tool.ts";
import { createFilesSearchTool } from "./files-search-tool.ts";

export function registerSearchFilesToolsPlugin(api: OpenClawPluginApi): void {
  const config = resolvePluginConfig(api.pluginConfig);

  api.registerTool((context) => createFilesSearchTool({ config, context }), {
    name: "files_search",
  });
  api.registerTool((context) => createFilesGlobTool({ config, context }), {
    name: "files_glob",
  });
}
