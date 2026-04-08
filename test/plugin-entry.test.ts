import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import pluginEntry, {
  SEARCH_FILES_TOOLS_PLUGIN_DESCRIPTION,
  SEARCH_FILES_TOOLS_PLUGIN_ID,
  SEARCH_FILES_TOOLS_PLUGIN_NAME,
} from "../src/plugin-entry.ts";
import { registerSearchFilesToolsPlugin } from "../src/plugin.ts";

describe("plugin entry", () => {
  it("matches the manifest metadata", async () => {
    const manifestPath = path.resolve(process.cwd(), "openclaw.plugin.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as {
      id: string;
      name: string;
      description: string;
    };

    expect(SEARCH_FILES_TOOLS_PLUGIN_ID).toBe(manifest.id);
    expect(SEARCH_FILES_TOOLS_PLUGIN_NAME).toBe(manifest.name);
    expect(SEARCH_FILES_TOOLS_PLUGIN_DESCRIPTION).toBe(manifest.description);
    expect(pluginEntry).toMatchObject({
      id: manifest.id,
      name: manifest.name,
      description: manifest.description,
    });
  });

  it("registers both required tools with the expected names", () => {
    const registerTool = vi.fn();
    registerSearchFilesToolsPlugin({
      registerTool,
      pluginConfig: undefined,
    } as never);

    expect(registerTool).toHaveBeenCalledTimes(2);
    expect(registerTool.mock.calls.map((call) => call[1]?.name)).toEqual([
      "files_search",
      "files_glob",
    ]);
    expect(registerTool.mock.calls.map((call) => typeof call[0])).toEqual(["function", "function"]);
  });
});
