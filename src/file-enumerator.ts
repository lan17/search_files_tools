import fg from "fast-glob";
import ignore, { type Ignore } from "ignore";
import fs from "node:fs/promises";
import path from "node:path";
import { isPathWithinFilters, toPosixRelativePath } from "./path-utils.ts";

export type EnumeratedFile = {
  absolutePath: string;
  relativePath: string;
};

export type EnumerateFilesParams = {
  rootReal: string;
  patterns: string[];
  pathFilters?: string[];
  excludeGlobs?: string[];
  includeHidden?: boolean;
  respectIgnoreFiles?: boolean;
  followSymlinks?: boolean;
  maxResults?: number;
};

const ROOT_IGNORE_FILENAMES = [".gitignore", ".ignore", ".fdignore", ".rgignore"];

async function createIgnoreMatcher(rootReal: string): Promise<Ignore | null> {
  const matcher = ignore();
  let loadedAny = false;

  for (const filename of ROOT_IGNORE_FILENAMES) {
    const absolutePath = path.join(rootReal, filename);
    try {
      const contents = await fs.readFile(absolutePath, "utf8");
      matcher.add(contents);
      loadedAny = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  return loadedAny ? matcher : null;
}

export async function enumerateFiles(params: EnumerateFilesParams): Promise<{
  files: EnumeratedFile[];
  truncated: boolean;
}> {
  const absolutePaths = await fg(params.patterns, {
    absolute: true,
    cwd: params.rootReal,
    dot: params.includeHidden === true,
    followSymbolicLinks: params.followSymlinks === true,
    ignore: params.excludeGlobs,
    onlyFiles: true,
    suppressErrors: true,
    unique: true,
  });

  const ignoreMatcher = params.respectIgnoreFiles === true
    ? await createIgnoreMatcher(params.rootReal)
    : null;

  const files = absolutePaths
    .map((absolutePath) => ({
      absolutePath: path.resolve(absolutePath),
      relativePath: toPosixRelativePath(params.rootReal, path.resolve(absolutePath)),
    }))
    .filter((entry) => !ignoreMatcher?.ignores(entry.relativePath))
    .filter((entry) => isPathWithinFilters(entry.relativePath, params.pathFilters ?? []))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath, "en"));

  const maxResults = params.maxResults;
  if (typeof maxResults === "number" && files.length > maxResults) {
    return {
      files: files.slice(0, maxResults),
      truncated: true,
    };
  }

  return { files, truncated: false };
}
