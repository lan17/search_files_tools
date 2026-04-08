import { Type } from "@sinclair/typebox";
import { enumerateFiles } from "./file-enumerator.ts";
import type { SearchFilesPluginConfig } from "./config.ts";
import {
  normalizeGlobInput,
  normalizeRelativePathList,
  resolveValidatedRoot,
} from "./path-utils.ts";
import type { AnyAgentTool, OpenClawPluginToolContext } from "./runtime-api.ts";

const FilesGlobSchema = Type.Object(
  {
    root: Type.String({ description: "Absolute directory under which globbing is performed." }),
    patterns: Type.Array(Type.String(), {
      description: "One or more glob patterns relative to root.",
      minItems: 1,
    }),
    paths: Type.Optional(
      Type.Array(Type.String(), {
        description: "Optional relative subpaths under root used to narrow returned files.",
      }),
    ),
    excludeGlobs: Type.Optional(
      Type.Array(Type.String(), {
        description: "Optional glob patterns to exclude, relative to root.",
      }),
    ),
    includeHidden: Type.Optional(Type.Boolean({ description: "Include dotfiles and dot-directories." })),
    respectIgnoreFiles: Type.Optional(
      Type.Boolean({ description: "Respect .gitignore and related ignore files when enumerating." }),
    ),
    followSymlinks: Type.Optional(Type.Boolean({ description: "Follow symbolic links while globbing." })),
    maxResults: Type.Optional(
      Type.Number({
        description: "Optional per-call result cap. Defaults to the plugin maxGlobResults limit.",
        minimum: 1,
      }),
    ),
  },
  { additionalProperties: false },
);

export function createFilesGlobTool(params: {
  config: SearchFilesPluginConfig;
  context?: OpenClawPluginToolContext;
}): AnyAgentTool {
  return {
    name: "files_glob",
    label: "Files Glob",
    description: "List files matching glob patterns under an absolute root directory.",
    parameters: FilesGlobSchema,
    execute: async (_toolCallId, rawParams) => {
      const root = await resolveValidatedRoot(rawParams.root, params.context);
      const patterns = normalizeRelativePathList(rawParams.patterns, "patterns", normalizeGlobInput);
      if (patterns.length === 0) {
        throw new Error("patterns is required");
      }
      const pathFilters = normalizeRelativePathList(rawParams.paths, "paths");
      const excludeGlobs = normalizeRelativePathList(
        rawParams.excludeGlobs,
        "excludeGlobs",
        normalizeGlobInput,
      );
      const maxResults =
        typeof rawParams.maxResults === "number" && Number.isInteger(rawParams.maxResults)
          ? rawParams.maxResults
          : params.config.maxGlobResults;
      if (maxResults <= 0) {
        throw new Error("maxResults must be a positive integer");
      }

      const enumerated = await enumerateFiles({
        rootReal: root.rootReal,
        patterns,
        pathFilters,
        excludeGlobs,
        includeHidden: rawParams.includeHidden === true,
        respectIgnoreFiles: rawParams.respectIgnoreFiles === true,
        followSymlinks: rawParams.followSymlinks === true,
        maxResults,
      });

      const payload = {
        root: root.rootReal,
        truncated: enumerated.truncated,
        count: enumerated.files.length,
        files: enumerated.files.map((entry) => entry.relativePath),
      };

      return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        details: payload,
      };
    },
  };
}
