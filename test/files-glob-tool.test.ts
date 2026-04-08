import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_PLUGIN_CONFIG } from "../src/config.ts";
import { createFilesGlobTool } from "../src/files-glob-tool.ts";
import { createTempDir, writeFiles } from "./helpers.ts";

describe("files_glob", () => {
  it("returns root-relative POSIX paths and honors exclude globs", async () => {
    const root = await createTempDir();
    try {
      await writeFiles(root, {
        "src/index.ts": "export {};",
        "src/util.ts": "export const util = true;",
        "src/util.test.ts": "test",
        ".hidden.ts": "hidden",
      });

      const tool = createFilesGlobTool({ config: DEFAULT_PLUGIN_CONFIG });
      const result = await tool.execute("call", {
        root,
        patterns: ["src/**/*.ts"],
        excludeGlobs: ["**/*.test.ts"],
      });
      const details = result.details as { files: string[]; truncated: boolean; count: number };
      const realRoot = await fs.realpath(root);

      expect(details).toMatchObject({
        root: realRoot,
        truncated: false,
        count: 2,
        files: ["src/index.ts", "src/util.ts"],
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("supports path narrowing, hidden files, and maxResults truncation", async () => {
    const root = await createTempDir();
    try {
      await writeFiles(root, {
        "src/a.ts": "a",
        "src/b.ts": "b",
        "other/c.ts": "c",
        ".config/secret.ts": "secret",
      });

      const tool = createFilesGlobTool({ config: DEFAULT_PLUGIN_CONFIG });
      const result = await tool.execute("call", {
        root,
        patterns: ["**/*.ts"],
        paths: ["src"],
        includeHidden: true,
        maxResults: 1,
      });
      const details = result.details as { files: string[]; truncated: boolean; count: number };

      expect(details.truncated).toBe(true);
      expect(details.count).toBe(1);
      expect(details.files).toEqual(["src/a.ts"]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("respects root ignore files when requested", async () => {
    const root = await createTempDir();
    try {
      await writeFiles(root, {
        ".gitignore": "ignored.ts\n",
        "ignored.ts": "ignored",
        "kept.ts": "kept",
      });

      const tool = createFilesGlobTool({ config: DEFAULT_PLUGIN_CONFIG });
      const result = await tool.execute("call", {
        root,
        patterns: ["**/*.ts"],
        respectIgnoreFiles: true,
      });
      const details = result.details as { files: string[] };

      expect(details.files).toEqual(["kept.ts"]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects escaping relative paths and non-absolute roots", async () => {
    const tool = createFilesGlobTool({ config: DEFAULT_PLUGIN_CONFIG });

    await expect(
      tool.execute("call", {
        root: "relative/path",
        patterns: ["**/*.ts"],
      }),
    ).rejects.toThrow("root must be an absolute path");

    const root = await createTempDir();
    try {
      await expect(
        tool.execute("call", {
          root,
          patterns: ["**/*.ts"],
          paths: ["../escape"],
        }),
      ).rejects.toThrow("paths must not escape root");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("honors workspace-only filesystem policy", async () => {
    const workspaceRoot = await createTempDir("workspace-");
    const outsideRoot = await createTempDir("outside-");

    try {
      const tool = createFilesGlobTool({
        config: DEFAULT_PLUGIN_CONFIG,
        context: {
          fsPolicy: { workspaceOnly: true },
          workspaceDir: workspaceRoot,
          sandboxed: true,
        },
      });

      await expect(
        tool.execute("call", {
          root: outsideRoot,
          patterns: ["**/*"],
        }),
      ).rejects.toThrow("root must stay within the active workspace");

      const insideDir = path.join(workspaceRoot, "nested");
      await fs.mkdir(insideDir, { recursive: true });
      await fs.writeFile(path.join(insideDir, "a.ts"), "a", "utf8");

      const result = await tool.execute("call", {
        root: insideDir,
        patterns: ["**/*.ts"],
      });
      const details = result.details as { files: string[] };
      expect(details.files).toEqual(["a.ts"]);
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
      await fs.rm(outsideRoot, { recursive: true, force: true });
    }
  });
});
