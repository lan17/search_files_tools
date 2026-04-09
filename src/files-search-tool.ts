import { Type } from "@sinclair/typebox";
import type { SearchFilesPluginConfig } from "./config.ts";
import { toPosixRelativePath, resolveValidatedRoot, createRealpathChecker, createGlobMatcher, readStringOrArray, sanitizeExcludePatterns } from "./path-utils.ts";
import {
  runRipgrepSearch,
  type MatchMode,
  type OutputMode,
  type RawSearchMatch,
} from "./search-backend.ts";
import type { AnyAgentTool, OpenClawPluginToolContext } from "./runtime-api.ts";

const DEFAULT_CONTEXT_LINES = 2;

const FilesSearchSchema = Type.Object(
  {
    root: Type.String({ description: "Absolute directory to search." }),
    patterns: Type.Union([Type.String(), Type.Array(Type.String(), { minItems: 1 })], {
      description: 'One or more search patterns (regex by default). Pass a string for a single pattern or an array for multiple.',
    }),
    matchMode: Type.Optional(
      Type.Union(
        [Type.Literal("regex"), Type.Literal("fixed"), Type.Literal("word"), Type.Literal("line")],
        { description: 'How patterns are interpreted. "regex" (default), "fixed" for literal strings, "word" for whole-word, "line" for whole-line.' },
      ),
    ),
    outputMode: Type.Optional(
      Type.Union(
        [Type.Literal("matches"), Type.Literal("files"), Type.Literal("counts")],
        { description: 'What to return. "matches" (default) returns matching lines with context, "files" returns just file paths, "counts" returns per-file match counts.' },
      ),
    ),
    include: Type.Optional(
      Type.Union([Type.String(), Type.Array(Type.String())], {
        description: 'Restrict which files are searched. A string or array of glob patterns (e.g., "*.ts" or ["*.ts", "src/**"]).',
      }),
    ),
    exclude: Type.Optional(
      Type.Union([Type.String(), Type.Array(Type.String())], {
        description: 'Exclude files from search. A string or array of glob patterns (e.g., "*.test.ts").',
      }),
    ),
    ignoreCase: Type.Optional(Type.Boolean({ description: "Match case-insensitively." })),
    beforeContext: Type.Optional(
      Type.Integer({ description: `Context lines before each match. Default: ${DEFAULT_CONTEXT_LINES}.`, minimum: 0 }),
    ),
    afterContext: Type.Optional(
      Type.Integer({ description: `Context lines after each match. Default: ${DEFAULT_CONTEXT_LINES}.`, minimum: 0 }),
    ),
    maxMatchesPerFile: Type.Optional(
      Type.Integer({ description: "Max matches to return per file.", minimum: 1 }),
    ),
    includeHidden: Type.Optional(
      Type.Boolean({ description: "Include dotfiles and dot-directories." }),
    ),
    followSymlinks: Type.Optional(Type.Boolean({ description: "Follow symbolic links." })),
  },
  { additionalProperties: false },
);

function readNonNegativeInteger(value: unknown, label: string, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

function readOptionalPositiveInteger(value: unknown, label: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function readPatterns(value: unknown): string[] {
  if (typeof value === "string") {
    if (!value.trim()) {
      throw new Error("patterns must be a non-empty string or array");
    }
    return [value];
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("patterns is required");
  }
  for (const entry of value) {
    if (typeof entry !== "string" || !entry.trim()) {
      throw new Error("each search pattern must be a non-empty string");
    }
  }
  return value as string[];
}

function readMatchMode(value: unknown): MatchMode {
  if (value === undefined) {
    return "regex";
  }
  if (value === "regex" || value === "fixed" || value === "word" || value === "line") {
    return value;
  }
  throw new Error("matchMode must be one of: regex, fixed, word, line");
}

function readOutputMode(value: unknown): OutputMode {
  if (value === undefined) {
    return "matches";
  }
  if (value === "matches" || value === "files" || value === "counts") {
    return value;
  }
  throw new Error("outputMode must be one of: matches, files, counts");
}

async function filterMatchesBySymlink(
  matches: RawSearchMatch[],
  rootReal: string,
): Promise<RawSearchMatch[]> {
  const checker = createRealpathChecker(rootReal);
  const filtered: RawSearchMatch[] = [];
  for (const match of matches) {
    if (await checker(match.absolutePath)) {
      filtered.push(match);
    }
  }
  return filtered;
}

async function filterPathsBySymlink(
  paths: string[],
  rootReal: string,
): Promise<string[]> {
  const checker = createRealpathChecker(rootReal);
  const filtered: string[] = [];
  for (const p of paths) {
    if (await checker(p)) {
      filtered.push(p);
    }
  }
  return filtered;
}

export function createFilesSearchTool(params: {
  config: SearchFilesPluginConfig;
  context?: OpenClawPluginToolContext;
}): AnyAgentTool {
  return {
    name: "files_search",
    label: "Files Search",
    description:
      'Search for a function, variable, string, or pattern in file contents. Use this to find where something is defined, imported, or referenced. Patterns are regex by default — use matchMode "fixed" for literal strings. Returns matching lines with 2 lines of surrounding context by default. Respects .gitignore.',
    parameters: FilesSearchSchema,
    execute: async (_toolCallId, rawParams, signal) => {
      const root = await resolveValidatedRoot(rawParams.root, params.context);
      const patterns = readPatterns(rawParams.patterns);
      const matchMode = readMatchMode(rawParams.matchMode);
      const outputMode = readOutputMode(rawParams.outputMode);
      const include = readStringOrArray(rawParams.include, "include");
      const exclude = sanitizeExcludePatterns(readStringOrArray(rawParams.exclude, "exclude"));
      const beforeContext = readNonNegativeInteger(
        rawParams.beforeContext,
        "beforeContext",
        outputMode === "matches" ? DEFAULT_CONTEXT_LINES : 0,
      );
      const afterContext = readNonNegativeInteger(
        rawParams.afterContext,
        "afterContext",
        outputMode === "matches" ? DEFAULT_CONTEXT_LINES : 0,
      );
      const maxMatchesPerFile = readOptionalPositiveInteger(
        rawParams.maxMatchesPerFile,
        "maxMatchesPerFile",
      );
      const followSymlinks = rawParams.followSymlinks === true;

      // Build path filter: include globs applied at streaming level so limits are correct
      let pathFilter: ((absolutePath: string) => boolean) | undefined;
      if (include.length > 0) {
        const isIncluded = createGlobMatcher(include, {
          dot: rawParams.includeHidden === true,
        });
        pathFilter = (absolutePath: string) =>
          isIncluded(toPosixRelativePath(root.rootReal, absolutePath));
      }

      const result = await runRipgrepSearch({
        root: root.rootReal,
        patterns,
        matchMode,
        outputMode,
        excludeGlobs: exclude,
        ignoreCase: rawParams.ignoreCase === true,
        includeHidden: rawParams.includeHidden === true,
        followSymlinks,
        beforeContext,
        afterContext,
        maxMatchesPerFile,
        timeoutMs: params.config.timeoutMs,
        resultLimit: params.config.maxSearchResults,
        signal,
        pathFilter,
      });

      // Post-filter symlink escapes when following symlinks.
      // NOTE: this runs after result limits, so escaped paths can consume budget.
      // Moving this into the streaming pathFilter would require async realpath
      // inside a synchronous onLine callback, which isn't feasible. The tradeoff
      // is acceptable because followSymlinks + escaping symlinks is uncommon.
      if (followSymlinks) {
        if (outputMode === "matches") {
          result.matches = await filterMatchesBySymlink(result.matches, root.rootReal);
        } else if (outputMode === "files") {
          result.files = await filterPathsBySymlink(result.files, root.rootReal);
        } else {
          const allowedCounts: typeof result.counts = [];
          const checker = createRealpathChecker(root.rootReal);
          for (const entry of result.counts) {
            if (await checker(entry.absolutePath)) {
              allowedCounts.push(entry);
            }
          }
          result.counts = allowedCounts;
        }
      }

      // Convert to relative paths, sort, and build response
      if (outputMode === "matches") {
        const normalizedMatches = result.matches
          .map((match) => ({
            path: toPosixRelativePath(root.rootReal, match.absolutePath),
            line: match.line,
            text: match.text,
            ...(match.before ? { before: match.before } : {}),
            ...(match.after ? { after: match.after } : {}),
          }))
          .sort((a, b) => a.path.localeCompare(b.path, "en") || a.line - b.line);
        const payload = {
          root: root.rootReal,
          outputMode,
          truncated: result.truncated,
          summary: `${normalizedMatches.length} matches in ${new Set(normalizedMatches.map((m) => m.path)).size} files.${result.truncated ? " Results were truncated." : ""}`,
          matches: normalizedMatches,
        };
        return {
          content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
          details: payload,
        };
      }

      if (outputMode === "files") {
        const files = result.files
          .map((f) => toPosixRelativePath(root.rootReal, f))
          .sort((a, b) => a.localeCompare(b, "en"));
        const payload = {
          root: root.rootReal,
          outputMode,
          truncated: result.truncated,
          summary: `${files.length} files.${result.truncated ? " Results were truncated." : ""}`,
          files,
        };
        return {
          content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
          details: payload,
        };
      }

      // counts
      const counts = result.counts
        .map((entry) => ({
          path: toPosixRelativePath(root.rootReal, entry.absolutePath),
          count: entry.count,
        }))
        .sort((a, b) => a.path.localeCompare(b.path, "en"));
      const payload = {
        root: root.rootReal,
        outputMode,
        truncated: result.truncated,
        summary: `${counts.reduce((sum, e) => sum + e.count, 0)} matches in ${counts.length} files.${result.truncated ? " Results were truncated." : ""}`,
        counts,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        details: payload,
      };
    },
  };
}
