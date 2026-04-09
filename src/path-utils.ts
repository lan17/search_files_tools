import path from "node:path";
import fs from "node:fs/promises";
import type { OpenClawPluginToolContext } from "./runtime-api.ts";

export type ResolvedRoot = {
  root: string;
  rootReal: string;
  workspaceDirReal?: string;
};

function normalizeUserPath(value: string): string {
  return value.trim().replaceAll("\\", "/");
}

function hasParentTraversal(value: string): boolean {
  return normalizeUserPath(value)
    .split("/")
    .some((segment) => segment === "..");
}

export function toPosixRelativePath(rootReal: string, absolutePath: string): string {
  return path.relative(rootReal, absolutePath).split(path.sep).join("/");
}

export function normalizeRelativePathInput(value: string, label: string): string {
  const normalized = normalizeUserPath(value);
  if (!normalized || normalized === ".") {
    return ".";
  }
  if (path.isAbsolute(normalized)) {
    throw new Error(`${label} must be relative to root`);
  }
  if (hasParentTraversal(normalized)) {
    throw new Error(`${label} must not escape root`);
  }
  return normalized.replace(/^\.\/+/u, "");
}

export function normalizeGlobInput(value: string, label: string): string {
  const normalized = normalizeUserPath(value);
  if (!normalized) {
    throw new Error(`${label} cannot be empty`);
  }
  if (path.isAbsolute(normalized)) {
    throw new Error(`${label} must be relative to root`);
  }
  if (hasParentTraversal(normalized)) {
    throw new Error(`${label} must not escape root`);
  }
  return normalized.replace(/^\.\/+/u, "");
}

export function normalizeRelativePathList(
  values: unknown,
  label: string,
  normalizer: (value: string, entryLabel: string) => string = normalizeRelativePathInput,
): string[] {
  if (values === undefined) {
    return [];
  }
  if (!Array.isArray(values)) {
    throw new Error(`${label} must be an array of strings`);
  }
  const result = new Set<string>();
  for (const entry of values) {
    if (typeof entry !== "string") {
      throw new Error(`${label} must be an array of strings`);
    }
    result.add(normalizer(entry, label));
  }
  return Array.from(result);
}

export function isPathWithinFilters(relativePath: string, filters: string[]): boolean {
  if (filters.length === 0) {
    return true;
  }
  return filters.some((filter) => {
    if (filter === ".") {
      return true;
    }
    return relativePath === filter || relativePath.startsWith(`${filter}/`);
  });
}

export function isPathWithinRoot(rootReal: string, targetReal: string): boolean {
  const relativeToRoot = path.relative(rootReal, targetReal);
  return !(
    relativeToRoot === ".." ||
    relativeToRoot.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeToRoot)
  );
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
