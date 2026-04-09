import picomatch from "picomatch";
import path from "node:path";
import fs from "node:fs/promises";
import type { OpenClawPluginToolContext } from "./runtime-api.ts";

export type ResolvedRoot = {
  root: string;
  rootReal: string;
  workspaceDirReal?: string;
};

export function toPosixRelativePath(rootReal: string, absolutePath: string): string {
  return path.relative(rootReal, absolutePath).split(path.sep).join("/");
}

export function isPathWithinRoot(rootReal: string, targetReal: string): boolean {
  const relativeToRoot = path.relative(rootReal, targetReal);
  return !(
    relativeToRoot === ".." ||
    relativeToRoot.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeToRoot)
  );
}

export function createRealpathChecker(rootReal: string): (absolutePath: string) => Promise<boolean> {
  const cache = new Map<string, Promise<boolean>>();
  return (absolutePath: string) => {
    const existing = cache.get(absolutePath);
    if (existing) {
      return existing;
    }
    const check = fs
      .realpath(absolutePath)
      .then((realPath) => isPathWithinRoot(rootReal, realPath))
      .catch(() => false);
    cache.set(absolutePath, check);
    return check;
  };
}

/**
 * Create a glob matcher that handles both basename patterns (e.g. `*.ts`)
 * and path patterns (e.g. `src/**\/*.ts`).  picomatch's `matchBase` option
 * only applies correctly to patterns without a `/`, so we split them.
 */
export function createGlobMatcher(
  patterns: string[],
  options?: { dot?: boolean },
): (relativePath: string) => boolean {
  const baseNamePatterns = patterns.filter((p) => !p.includes("/"));
  const pathPatterns = patterns.filter((p) => p.includes("/"));
  const matchers: Array<(input: string) => boolean> = [];
  if (baseNamePatterns.length > 0) {
    matchers.push(picomatch(baseNamePatterns, { ...options, matchBase: true }));
  }
  if (pathPatterns.length > 0) {
    matchers.push(picomatch(pathPatterns, options));
  }
  return (input: string) => matchers.some((m) => m(input));
}

export async function resolveValidatedRoot(
  rootInput: unknown,
  context?: Pick<OpenClawPluginToolContext, "fsPolicy" | "workspaceDir">,
): Promise<ResolvedRoot> {
  if (typeof rootInput !== "string" || !rootInput.trim()) {
    throw new Error("root is required");
  }
  if (!path.isAbsolute(rootInput)) {
    throw new Error("root must be an absolute path");
  }
  const root = path.resolve(rootInput);
  let stat;
  try {
    stat = await fs.stat(root);
  } catch {
    throw new Error("root does not exist");
  }
  if (!stat.isDirectory()) {
    throw new Error("root must be a directory");
  }
  const rootReal = await fs.realpath(root);
  const workspaceDir = context?.workspaceDir;
  const workspaceDirReal =
    typeof workspaceDir === "string" && workspaceDir.trim()
      ? await fs.realpath(path.resolve(workspaceDir))
      : undefined;

  if (context?.fsPolicy?.workspaceOnly === true) {
    if (!workspaceDirReal) {
      throw new Error("workspace-only filesystem policy is active, but no workspace root is set");
    }
    if (!isPathWithinRoot(workspaceDirReal, rootReal)) {
      throw new Error("root must stay within the active workspace");
    }
  }

  return { root, rootReal, ...(workspaceDirReal ? { workspaceDirReal } : {}) };
}
