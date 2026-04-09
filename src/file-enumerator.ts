import fg from "fast-glob";
import ignore, { type Ignore } from "ignore";
import fs from "node:fs/promises";
import path from "node:path";
import { isPathWithinFilters, isPathWithinRoot, toPosixRelativePath } from "./path-utils.ts";

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
  signal?: AbortSignal;
};

const ROOT_IGNORE_FILENAMES = [".gitignore", ".ignore", ".fdignore", ".rgignore"];

type IgnoreInspector = {
  ignores: (relativePath: string) => Promise<boolean>;
};

// fast-glob exposes stream() but not a more specific exported stream type in this version,
// so we narrow it to the parts we rely on for async iteration and cancellation.
type GlobStream = NodeJS.ReadableStream &
  AsyncIterable<string | Buffer> & {
    destroy: (error?: Error) => void;
  };

async function readIgnoreMatcher(directoryReal: string): Promise<Ignore | null> {
  const matcher = ignore();
  let loadedAny = false;

  for (const filename of ROOT_IGNORE_FILENAMES) {
    const absolutePath = path.join(directoryReal, filename);
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

function listIgnoreDirectories(relativePath: string): string[] {
  const parentDirectory = path.posix.dirname(relativePath);
  if (parentDirectory === ".") {
    return ["."];
  }

  const directories = ["."];
  const segments = parentDirectory.split("/");
  let current = "";
  for (const segment of segments) {
    current = current ? `${current}/${segment}` : segment;
    directories.push(current);
  }
  return directories;
}

async function createIgnoreInspector(rootReal: string): Promise<IgnoreInspector> {
  const matcherCache = new Map<string, Promise<Ignore | null>>();
  const ignoredDirectoryCache = new Map<string, Promise<boolean>>();

  const getMatcher = async (directoryRelativePath: string): Promise<Ignore | null> => {
    const cached = matcherCache.get(directoryRelativePath);
    if (cached) {
      return await cached;
    }

    const matcherPromise = readIgnoreMatcher(
      directoryRelativePath === "."
        ? rootReal
        : path.join(rootReal, directoryRelativePath.split("/").join(path.sep)),
    );
    matcherCache.set(directoryRelativePath, matcherPromise);
    return await matcherPromise;
  };

  const applyIgnoreRules = async (
    targetRelativePath: string,
    directoryRelativePaths: string[],
  ): Promise<boolean> => {
    let ignored = false;

    for (const directoryRelativePath of directoryRelativePaths) {
      const matcher = await getMatcher(directoryRelativePath);
      if (!matcher) {
        continue;
      }

      const relativeFromDirectory =
        directoryRelativePath === "."
          ? targetRelativePath
          : path.posix.relative(directoryRelativePath, targetRelativePath);
      const result = matcher.test(relativeFromDirectory);
      if (result.ignored) {
        ignored = true;
      }
      if (result.unignored) {
        ignored = false;
      }
    }

    return ignored;
  };

  const isDirectoryIgnored = async (directoryRelativePath: string): Promise<boolean> => {
    if (directoryRelativePath === ".") {
      return false;
    }

    const cached = ignoredDirectoryCache.get(directoryRelativePath);
    if (cached) {
      return await cached;
    }

    const ignoredPromise = applyIgnoreRules(
      `${directoryRelativePath}/`,
      listIgnoreDirectories(directoryRelativePath),
    );
    ignoredDirectoryCache.set(directoryRelativePath, ignoredPromise);
    return await ignoredPromise;
  };

  return {
    ignores: async (relativePath: string): Promise<boolean> => {
      for (const directoryRelativePath of listIgnoreDirectories(relativePath)) {
        if (directoryRelativePath !== "." && await isDirectoryIgnored(directoryRelativePath)) {
          return true;
        }
      }

      return await applyIgnoreRules(relativePath, listIgnoreDirectories(relativePath));
    },
  };
}

export async function enumerateFiles(params: EnumerateFilesParams): Promise<{
  files: EnumeratedFile[];
  truncated: boolean;
}> {
  const stream = fg.stream(params.patterns, {
    absolute: true,
    cwd: params.rootReal,
    dot: params.includeHidden === true,
    followSymbolicLinks: params.followSymlinks === true,
    ignore: params.excludeGlobs,
    onlyFiles: true,
    suppressErrors: true,
    unique: true,
  }) as GlobStream;

  const ignoreInspector =
    params.respectIgnoreFiles === true ? await createIgnoreInspector(params.rootReal) : null;
  const files: EnumeratedFile[] = [];
  let aborted = params.signal?.aborted === true;

  const abortEnumeration = () => {
    aborted = true;
    stream.destroy(new Error("file enumeration aborted"));
  };
  params.signal?.addEventListener("abort", abortEnumeration, { once: true });

  try {
    for await (const entry of stream) {
      if (aborted) {
        break;
      }

      const absolutePath = path.resolve(entry.toString());
      if (params.followSymlinks === true) {
        let realAbsolutePath: string;
        try {
          realAbsolutePath = await fs.realpath(absolutePath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            continue;
          }
          throw error;
        }

        if (!isPathWithinRoot(params.rootReal, realAbsolutePath)) {
          continue;
        }
      }

      const relativePath = toPosixRelativePath(params.rootReal, absolutePath);
      if (ignoreInspector && await ignoreInspector.ignores(relativePath)) {
        continue;
      }
      if (!isPathWithinFilters(relativePath, params.pathFilters ?? [])) {
        continue;
      }

      files.push({
        absolutePath,
        relativePath,
      });
    }
  } catch (error) {
    if (!(aborted && error instanceof Error && error.message === "file enumeration aborted")) {
      throw error;
    }
  } finally {
    params.signal?.removeEventListener("abort", abortEnumeration);
    stream.destroy();
  }

  if (aborted) {
    throw new Error("file enumeration aborted");
  }

  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath, "en"));

  const maxResults = params.maxResults;
  if (typeof maxResults === "number" && files.length > maxResults) {
    return {
      files: files.slice(0, maxResults),
      truncated: true,
    };
  }

  return { files, truncated: false };
}
