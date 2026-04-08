import { definePluginEntry } from "./runtime-api.ts";
import { registerSearchFilesToolsPlugin } from "./plugin.ts";

export const SEARCH_FILES_TOOLS_PLUGIN_ID = "search-files-tools";
export const SEARCH_FILES_TOOLS_PLUGIN_NAME = "Search Files Tools";
export const SEARCH_FILES_TOOLS_PLUGIN_DESCRIPTION =
  "Adds tools for searching file contents and globbing files under absolute roots.";

export default definePluginEntry({
  id: SEARCH_FILES_TOOLS_PLUGIN_ID,
  name: SEARCH_FILES_TOOLS_PLUGIN_NAME,
  description: SEARCH_FILES_TOOLS_PLUGIN_DESCRIPTION,
  register: registerSearchFilesToolsPlugin,
});
