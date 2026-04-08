import fs from "node:fs/promises";
import { Type } from "@sinclair/typebox";
import { enumerateFiles } from "./file-enumerator.ts";
import type { SearchFilesPluginConfig } from "./config.ts";
import {
  normalizeGlobInput,
  normalizeRelativePathList,
  resolveValidatedRoot,
} from "./path-utils.ts";
import {
  resolveSearchBackend,
  runSearchWithBackend,
  type SearchBackend,
  type SearchBackendMatch,
} from "./search-backend.ts";
import type { AnyAgentTool, OpenClawPluginToolContext } from "./runtime-api.ts";

const FilesSearchSchema = Type.Object(
  {
    root: Type.String({ description: "Absolute directory under which the search is performed." }),
    pattern: Type.Optional(Type.String({ description: "Single search pattern." })),
    patterns: Type.Optional(
      Type.Array(Type.String(), {
        description: "Multiple search patterns. Use pattern or patterns, but not both.",
        minItems: 1,
      }),
    ),
    paths: Type.Optional(
      Type.Array(Type.String(), {
        description: "Optional relative subpaths under root used to narrow search candidates.",
      }),
    ),
    includeGlobs: Type.Optional(
      Type.Array(Type.String(), {
        description: "Optional include glob patterns relative to root.",
      }),
    ),
    excludeGlobs: Type.Optional(
      Type.Array(Type.String(), {
        description: "Optional exclude glob patterns relative to root.",
      }),
    ),
    fixedStrings: Type.Optional(Type.Boolean({ description: "Treat patterns as literal strings." })),
    ignoreCase: Type.Optional(Type.Boolean({ description: "Match case-insensitively." })),
    wordMatch: Type.Optional(Type.Boolean({ description: "Require whole-word matches." })),
    lineMatch: Type.Optional(Type.Boolean({ description: "Require whole-line matches." })),
    beforeContext: Type.Optional(
      Type.Integer({ description: "Number of context lines to include before each match.", minimum: 0 }),
    ),
    afterContext: Type.Optional(
      Type.Integer({ description: "Number of context lines to include after each match.", minimum: 0 }),
    ),
    maxMatchesPerFile: Type.Optional(
      Type.Integer({ description: "Maximum number of matching lines to return per file.", minimum: 1 }),
    ),
    filesWithMatches: Type.Optional(
      Type.Boolean({ description: "Return matching file paths instead of individual match lines." }),
    ),
    countOnly: Type.Optional(
      Type.Boolean({ description: "Return per-file match counts instead of individual match lines." }),
    ),
    includeHidden: Type.Optional(Type.Boolean({ description: "Include dotfiles and dot-directories." })),
    respectIgnoreFiles: Type.Optional(
      Type.Boolean({ description: "Respect .gitignore and related ignore files when enumerating." }),
    ),
    followSymlinks: Type.Optional(Type.Boolean({ description: "Follow symbolic links while enumerating." })),
  },
  { additionalProperties: false },
);

type SearchMode = "matches" | "files" | "counts";

function splitFileLines(contents: string): string[] {
  const lines = contents.replaceAll("\r\n", "\n").split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

function buildSearchPatterns(rawParams: Record<string, unknown>): string[] {
  const hasPattern = typeof rawParams.pattern === "string" && rawParams.pattern.length > 0;
  const hasPatterns = Array.isArray(rawParams.patterns);

  if (hasPattern === hasPatterns) {
    throw new Error("Provide exactly one of pattern or patterns");
  }

  if (hasPattern) {
    return [rawParams.pattern as string];
  }

  const patterns = normalizeRelativePathList(rawParams.patterns, "patterns", (value, label) => {
    if (!value.trim()) {
      throw new Error(`${label} cannot be empty`);
    }
    return value;
  });
  if (patterns.length === 0) {
    throw new Error("patterns is required");
  }
  return patterns;
}

function resolveSearchMode(rawParams: Record<string, unknown>): SearchMode {
  if (rawParams.filesWithMatches === true && rawParams.countOnly === true) {
    throw new Error("filesWithMatches and countOnly cannot both be true");
  }
  if (rawParams.filesWithMatches === true) {
    return "files";
  }
  if (rawParams.countOnly === true) {
    return "counts";
  }
  return "matches";
}

function buildIncludePatterns(pathFilters: string[], includeGlobs: string[]): string[] {
  if (includeGlobs.length > 0) {
    return includeGlobs;
  }
  if (pathFilters.length === 0) {
    return ["**/*"];
  }
  const patterns = new Set<string>();
  for (const filter of pathFilters) {
    if (filter === ".") {
      patterns.add("**/*");
      continue;
    }
    patterns.add(filter);
    patterns.add(`${filter}/**/*`);
  }
  return Array.from(patterns);
}

function readNonNegativeInteger(
  value: unknown,
  label: "beforeContext" | "afterContext",
): number {
  if (value === undefined) {
    return 0;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

function readOptionalPositiveInteger(value: unknown, label: "maxMatchesPerFile"): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

async function enrichMatchesWithContext(
  matches: SearchBackendMatch[],
  beforeContext: number,
  afterContext: number,
): Promise<
  Array<{
    path: string;
    line: number;
    text: string;
    before?: Array<{ line: number; text: string }>;
    after?: Array<{ line: number; text: string }>;
  }>
> {
  if (beforeContext <= 0 && afterContext <= 0) {
    return matches.map((match) => ({
      path: match.absolutePath,
      line: match.line,
      text: match.text,
    }));
  }

  const byFile = new Map<string, SearchBackendMatch[]>();
  for (const match of matches) {
    const existing = byFile.get(match.absolutePath);
    if (existing) {
      existing.push(match);
    } else {
      byFile.set(match.absolutePath, [match]);
    }
  }

  const enriched = new Map<
    string,
    Array<{
      path: string;
      line: number;
      text: string;
      before?: Array<{ line: number; text: string }>;
      after?: Array<{ line: number; text: string }>;
    }>
  >();

  for (const [absolutePath, fileMatches] of byFile.entries()) {
    const contents = await fs.readFile(absolutePath, "utf8");
    const lines = splitFileLines(contents);
    enriched.set(
      absolutePath,
      fileMatches.map((match) => {
        const before =
          beforeContext > 0
            ? lines
                .slice(Math.max(match.line - beforeContext - 1, 0), Math.max(match.line - 1, 0))
                .map((text, index) => ({
                  line: match.line - beforeContext + index > 0 ? match.line - beforeContext + index : index + 1,
                  text,
                }))
            : undefined;
        const after =
          afterContext > 0
            ? lines
                .slice(match.line, match.line + afterContext)
                .map((text, index) => ({
                  line: match.line + index + 1,
                  text,
                }))
            : undefined;
        return {
          path: absolutePath,
          line: match.line,
          text: match.text,
          ...(before && before.length > 0 ? { before } : {}),
          ...(after && after.length > 0 ? { after } : {}),
        };
      }),
    );
  }

  const nextMatchIndexByFile = new Map<string, number>();
  return matches.flatMap((match) => {
    const matchIndex = nextMatchIndexByFile.get(match.absolutePath) ?? 0;
    nextMatchIndexByFile.set(match.absolutePath, matchIndex + 1);
    const enrichedEntries = enriched.get(match.absolutePath);
    const entry = enrichedEntries?.[matchIndex];
    return entry ? [entry] : [];
  });
}

function summarizeSearch(params: {
  backend: SearchBackend;
  mode: SearchMode;
  truncated: boolean;
  candidateFileCount: number;
  matchCount: number;
  fileCount: number;
}): string {
  const modeSummary =
    params.mode === "matches"
      ? `${params.matchCount} matches`
      : params.mode === "files"
        ? `${params.fileCount} files`
        : `${params.fileCount} count entries`;
  const truncation = params.truncated ? " Results were truncated." : "";
  return `Searched ${params.candidateFileCount} candidate files with ${params.backend.name} and returned ${modeSummary}.${truncation}`;
}

function compareMatches(
  left: { path: string; line: number; text: string },
  right: { path: string; line: number; text: string },
): number {
  const pathOrder = left.path.localeCompare(right.path, "en");
  if (pathOrder !== 0) {
    return pathOrder;
  }
  if (left.line !== right.line) {
    return left.line - right.line;
  }
  return left.text.localeCompare(right.text, "en");
}

export function createFilesSearchTool(params: {
  config: SearchFilesPluginConfig;
  context?: OpenClawPluginToolContext;
  backendResolver?: () => Promise<SearchBackend>;
}): AnyAgentTool {
  return {
    name: "files_search",
    label: "Files Search",
    description: "Search file contents under an absolute root directory.",
    parameters: FilesSearchSchema,
    execute: async (_toolCallId, rawParams, signal) => {
      const root = await resolveValidatedRoot(rawParams.root, params.context);
      const patterns = buildSearchPatterns(rawParams);
      const mode = resolveSearchMode(rawParams);
      const pathFilters = normalizeRelativePathList(rawParams.paths, "paths");
      const includeGlobs = normalizeRelativePathList(
        rawParams.includeGlobs,
        "includeGlobs",
        normalizeGlobInput,
      );
      const excludeGlobs = normalizeRelativePathList(
        rawParams.excludeGlobs,
        "excludeGlobs",
        normalizeGlobInput,
      );
      const beforeContext = readNonNegativeInteger(rawParams.beforeContext, "beforeContext");
      const afterContext = readNonNegativeInteger(rawParams.afterContext, "afterContext");
      const maxMatchesPerFile = readOptionalPositiveInteger(
        rawParams.maxMatchesPerFile,
        "maxMatchesPerFile",
      );

      const enumerated = await enumerateFiles({
        rootReal: root.rootReal,
        patterns: buildIncludePatterns(pathFilters, includeGlobs),
        pathFilters: includeGlobs.length > 0 ? pathFilters : [],
        excludeGlobs,
        includeHidden: rawParams.includeHidden === true,
        respectIgnoreFiles: rawParams.respectIgnoreFiles === true,
        followSymlinks: rawParams.followSymlinks === true,
        maxResults: params.config.maxCandidateFiles,
        signal,
      });

      const backend = await (params.backendResolver ?? resolveSearchBackend)();
      const candidateFiles = enumerated.files;
      const candidateFileCount = candidateFiles.length;
      if (candidateFileCount === 0) {
        const emptyPayload = {
          backend: backend.name,
          root: root.rootReal,
          mode,
          truncated: enumerated.truncated,
          candidateFileCount,
          summary: "No candidate files matched the requested filters.",
          ...(mode === "matches"
            ? { matches: [] }
            : mode === "files"
              ? { files: [] }
              : { counts: [] }),
        };
        return {
          content: [{ type: "text", text: JSON.stringify(emptyPayload, null, 2) }],
          details: emptyPayload,
        };
      }

      const searchResult = await runSearchWithBackend({
        backend,
        files: candidateFiles.map((entry) => entry.absolutePath),
        patterns,
        fixedStrings: rawParams.fixedStrings === true,
        ignoreCase: rawParams.ignoreCase === true,
        wordMatch: rawParams.wordMatch === true,
        lineMatch: rawParams.lineMatch === true,
        maxMatchesPerFile,
        timeoutMs: params.config.timeoutMs,
        resultLimit: params.config.maxSearchResults,
        mode,
        signal,
      });

      const relativePathByAbsolute = new Map(
        candidateFiles.map((entry) => [entry.absolutePath, entry.relativePath] as const),
      );
      const truncated = enumerated.truncated || searchResult.truncated;

      if (mode === "matches") {
        const enriched = await enrichMatchesWithContext(searchResult.matches, beforeContext, afterContext);
        const normalizedMatches = enriched
          .map((match) => ({
            path: relativePathByAbsolute.get(match.path) ?? match.path,
            line: match.line,
            text: match.text,
            ...(match.before ? { before: match.before } : {}),
            ...(match.after ? { after: match.after } : {}),
          }))
          .sort(compareMatches);
        const payload = {
          backend: searchResult.backend,
          root: root.rootReal,
          mode,
          truncated,
          candidateFileCount,
          summary: summarizeSearch({
            backend,
            mode,
            truncated,
            candidateFileCount,
            matchCount: normalizedMatches.length,
            fileCount: new Set(normalizedMatches.map((entry) => entry.path)).size,
          }),
          matches: normalizedMatches,
        };
        return {
          content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
          details: payload,
        };
      }

      if (mode === "files") {
        const files = searchResult.files.map(
          (absolutePath) => relativePathByAbsolute.get(absolutePath) ?? absolutePath,
        );
        const payload = {
          backend: searchResult.backend,
          root: root.rootReal,
          mode,
          truncated,
          candidateFileCount,
          summary: summarizeSearch({
            backend,
            mode,
            truncated,
            candidateFileCount,
            matchCount: searchResult.matches.length,
            fileCount: files.length,
          }),
          files,
        };
        return {
          content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
          details: payload,
        };
      }

      const counts = searchResult.counts.map((entry) => ({
        path: relativePathByAbsolute.get(entry.absolutePath) ?? entry.absolutePath,
        count: entry.count,
      }));
      const payload = {
        backend: searchResult.backend,
        root: root.rootReal,
        mode,
        truncated,
        candidateFileCount,
        summary: summarizeSearch({
          backend,
          mode,
          truncated,
          candidateFileCount,
          matchCount: counts.reduce((sum, entry) => sum + entry.count, 0),
          fileCount: counts.length,
        }),
        counts,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        details: payload,
      };
    },
  };
}
