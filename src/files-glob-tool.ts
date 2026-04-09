import { Type } from "@sinclair/typebox";
import type { SearchFilesPluginConfig } from "./config.ts";
import { toPosixRelativePath, resolveValidatedRoot, createRealpathChecker, createGlobMatcher } from "./path-utils.ts";
import { runRipgrepGlob } from "./search-backend.ts";
import type { AnyAgentTool, OpenClawPluginToolContext } from "./runtime-api.ts";

const FilesGlobSchema = Type.Object(
  {
    root: Type.String({ description: "Absolute directory to list files in." }),
    patterns: Type.Array(Type.String(), {
      description: 'Glob patterns to match (e.g., ["*.ts", "src/**"]). Uses gitignore-style matching where "*.ts" matches at any depth.',
      minItems: 1,
    }),
    excludeGlobs: Type.Optional(
      Type.Array(Type.String(), {
        description: "Glob patterns to exclude.",
      }),
    ),
    includeHidden: Type.Optional(
      Type.Boolean({ description: "Include dotfiles and dot-directories." }),
    ),
    followSymlinks: Type.Optional(Type.Boolean({ description: "Follow symbolic links." })),
    maxResults: Type.Optional(
      Type.Integer({
        description: "Result cap. Defaults to the plugin maxGlobResults limit.",
        minimum: 1,
      }),
    ),
  },
  { additionalProperties: false },
);

function readGlobPatterns(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("patterns is required and must be a non-empty array");
  }
  for (const entry of value) {
    if (typeof entry !== "string" || !entry.trim()) {
      throw new Error("each glob pattern must be a non-empty string");
    }
  }
  return value as string[];
}

function readStringArray(value: unknown, label: string): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array of strings`);
  }
  for (const entry of value) {
    if (typeof entry !== "string") {
      throw new Error(`${label} entries must be strings`);
    }
  }
  return value as string[];
}

function resolveMaxResults(rawValue: unknown, configuredCap: number): number {
  if (rawValue === undefined) {
    return configuredCap;
  }
  if (typeof rawValue !== "number" || !Number.isInteger(rawValue) || rawValue <= 0) {
    throw new Error("maxResults must be a positive integer");
  }
  return Math.min(rawValue, configuredCap);
}

export function createFilesGlobTool(params: {
  config: SearchFilesPluginConfig;
  context?: OpenClawPluginToolContext;
}): AnyAgentTool {
  return {
    name: "files_glob",
    label: "Files Glob",
    description:
      "List files matching glob patterns. Returns file paths relative to root. Respects .gitignore by default.",
    parameters: FilesGlobSchema,
    execute: async (_toolCallId, rawParams, signal) => {
      const root = await resolveValidatedRoot(rawParams.root, params.context);
      const patterns = readGlobPatterns(rawParams.patterns);
      const excludeGlobs = readStringArray(rawParams.excludeGlobs, "excludeGlobs");
      const maxResults = resolveMaxResults(rawParams.maxResults, params.config.maxGlobResults);
      const followSymlinks = rawParams.followSymlinks === true;

      // Include patterns applied at streaming level so maxResults caps filtered results
      const isIncluded = createGlobMatcher(patterns, {
        dot: rawParams.includeHidden === true,
      });

      const result = await runRipgrepGlob({
        root: root.rootReal,
        excludeGlobs,
        includeHidden: rawParams.includeHidden === true,
        followSymlinks,
        maxResults,
        timeoutMs: params.config.timeoutMs,
        signal,
        filter: (absolutePath) => isIncluded(toPosixRelativePath(root.rootReal, absolutePath)),
      });

      let files = result.files;
      if (followSymlinks) {
        const checker = createRealpathChecker(root.rootReal);
        const allowed: string[] = [];
        for (const f of files) {
          if (await checker(f)) {
            allowed.push(f);
          }
        }
        files = allowed;
      }

      // Convert to relative paths
      const relativePaths = files.map((f) => toPosixRelativePath(root.rootReal, f));

      const payload = {
        root: root.rootReal,
        truncated: result.truncated,
        count: relativePaths.length,
        files: relativePaths,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        details: payload,
      };
    },
  };
}
