import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_PLUGIN_CONFIG } from "../src/config.ts";
import { createFilesGlobTool } from "../src/files-glob-tool.ts";
import { createTempDir, writeFiles } from "./helpers.ts";

describe("files_glob", () => {
  it("returns root-relative POSIX paths and honors exclude", async () => {
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
        exclude: "*.test.ts",
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

  it("accepts a bare string for patterns", async () => {
    const root = await createTempDir();
    try {
      await writeFiles(root, {
        "a.ts": "a",
        "b.js": "b",
      });

      const tool = createFilesGlobTool({ config: DEFAULT_PLUGIN_CONFIG });
      const result = await tool.execute("call", {
        root,
        patterns: "*.ts",
      });
      const details = result.details as { files: string[] };
      expect(details.files).toEqual(["a.ts"]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("supports maxResults truncation capped at config limit", async () => {
    const root = await createTempDir();
    try {
      await writeFiles(root, {
        "a.ts": "a",
        "b.ts": "b",
        "c.ts": "c",
      });

      const tool = createFilesGlobTool({
        config: { ...DEFAULT_PLUGIN_CONFIG, maxGlobResults: 2 },
      });

      const result = await tool.execute("call", {
        root,
        patterns: "*.ts",
        maxResults: 10,
      });
      const details = result.details as { files: string[]; truncated: boolean; count: number };
      expect(details.truncated).toBe(true);
      expect(details.count).toBe(2);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects non-integer maxResults", async () => {
    const root = await createTempDir();
    try {
      const tool = createFilesGlobTool({ config: DEFAULT_PLUGIN_CONFIG });
      await expect(
        tool.execute("call", { root, patterns: "*.ts", maxResults: 1.5 }),
      ).rejects.toThrow("maxResults must be a positive integer");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("respects .gitignore by default", async () => {
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
        patterns: "*.ts",
      });
      const details = result.details as { files: string[] };
      expect(details.files).toEqual(["kept.ts"]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects non-absolute roots", async () => {
    const tool = createFilesGlobTool({ config: DEFAULT_PLUGIN_CONFIG });
    await expect(
      tool.execute("call", { root: "relative/path", patterns: "*.ts" }),
    ).rejects.toThrow("root must be an absolute path");
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
        tool.execute("call", { root: outsideRoot, patterns: "**/*" }),
      ).rejects.toThrow("root must stay within the active workspace");

      const insideDir = path.join(workspaceRoot, "nested");
      await fs.mkdir(insideDir, { recursive: true });
      await fs.writeFile(path.join(insideDir, "a.ts"), "a", "utf8");

      const result = await tool.execute("call", {
        root: insideDir,
        patterns: "*.ts",
      });
      const details = result.details as { files: string[] };
      expect(details.files).toEqual(["a.ts"]);
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
      await fs.rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it("blocks symlink escapes when followSymlinks is enabled", async () => {
    const workspaceRoot = await createTempDir("workspace-");
    const outsideRoot = await createTempDir("outside-");

    try {
      const projectRoot = path.join(workspaceRoot, "project");
      await fs.mkdir(projectRoot, { recursive: true });
      await writeFiles(projectRoot, { "allowed.txt": "safe" });
      await writeFiles(outsideRoot, { "secret.txt": "secret" });
      await fs.symlink(outsideRoot, path.join(projectRoot, "escape"));

      const tool = createFilesGlobTool({
        config: DEFAULT_PLUGIN_CONFIG,
        context: {
          fsPolicy: { workspaceOnly: true },
          workspaceDir: workspaceRoot,
          sandboxed: true,
        },
      });

      const result = await tool.execute("call", {
        root: projectRoot,
        patterns: "**/*.txt",
        followSymlinks: true,
      });
      const details = result.details as { files: string[] };
      expect(details.files).toEqual(["allowed.txt"]);
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
      await fs.rm(outsideRoot, { recursive: true, force: true });
    }
  });
});
