import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_PLUGIN_CONFIG } from "../src/config.ts";
import { createFilesSearchTool } from "../src/files-search-tool.ts";
import {
  MAX_STDERR_BYTES,
  parseRipgrepJsonLine,
  runLineCommand,
  runRipgrepSearch,
} from "../src/search-backend.ts";
import { createTempDir, writeFiles } from "./helpers.ts";

describe("files_search", () => {
  it("rejects invalid params", async () => {
    const root = await createTempDir();
    try {
      const tool = createFilesSearchTool({ config: DEFAULT_PLUGIN_CONFIG });

      await expect(
        tool.execute("call", { root, patterns: [] }),
      ).rejects.toThrow("patterns is required");

      await expect(
        tool.execute("call", { root, patterns: ["x"], matchMode: "bogus" }),
      ).rejects.toThrow("matchMode must be one of");

      await expect(
        tool.execute("call", { root, patterns: ["x"], outputMode: "bogus" }),
      ).rejects.toThrow("outputMode must be one of");

      await expect(
        tool.execute("call", { root, patterns: ["x"], beforeContext: 1.5 }),
      ).rejects.toThrow("beforeContext must be a non-negative integer");

      await expect(
        tool.execute("call", { root, patterns: ["x"], afterContext: -1 }),
      ).rejects.toThrow("afterContext must be a non-negative integer");

      await expect(
        tool.execute("call", { root, patterns: ["x"], maxMatchesPerFile: 0 }),
      ).rejects.toThrow("maxMatchesPerFile must be a positive integer");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("returns matches with include/exclude globs and context", async () => {
    const root = await createTempDir();
    try {
      await writeFiles(root, {
        "src/app.ts": "alpha\nneedle\nomega\n",
        "src/other.ts": "beta\nsecond needle\ntrailer\n",
        "src/ignore.test.ts": "needle should be ignored\n",
        ".hidden.ts": "needle hidden\n",
      });

      const tool = createFilesSearchTool({ config: DEFAULT_PLUGIN_CONFIG });
      const result = await tool.execute("call", {
        root,
        patterns: ["needle"],
        includeGlobs: ["src/**/*.ts"],
        excludeGlobs: ["*.test.ts"],
        beforeContext: 1,
        afterContext: 1,
      });
      const details = result.details as {
        outputMode: string;
        matches: Array<{
          path: string;
          line: number;
          text: string;
          before?: Array<{ line: number; text: string }>;
          after?: Array<{ line: number; text: string }>;
        }>;
      };

      expect(details.outputMode).toBe("matches");
      expect(details.matches).toEqual([
        {
          path: "src/app.ts",
          line: 2,
          text: "needle",
          before: [{ line: 1, text: "alpha" }],
          after: [{ line: 3, text: "omega" }],
        },
        {
          path: "src/other.ts",
          line: 2,
          text: "second needle",
          before: [{ line: 1, text: "beta" }],
          after: [{ line: 3, text: "trailer" }],
        },
      ]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("supports outputMode files and counts", async () => {
    const root = await createTempDir();
    try {
      await writeFiles(root, {
        "src/a.ts": "needle\nneedle\n",
        "src/nested/b.ts": "needle\n",
        "other/c.ts": "needle\n",
      });

      const tool = createFilesSearchTool({ config: DEFAULT_PLUGIN_CONFIG });

      const filesResult = await tool.execute("call", {
        root,
        patterns: ["needle"],
        outputMode: "files",
        includeGlobs: ["src/**"],
      });
      const filesDetails = filesResult.details as { files: string[] };
      expect(filesDetails.files).toEqual(["src/a.ts", "src/nested/b.ts"]);

      const countsResult = await tool.execute("call", {
        root,
        patterns: ["needle"],
        outputMode: "counts",
      });
      const countsDetails = countsResult.details as {
        counts: Array<{ path: string; count: number }>;
      };
      expect(countsDetails.counts).toEqual([
        { path: "other/c.ts", count: 1 },
        { path: "src/a.ts", count: 2 },
        { path: "src/nested/b.ts", count: 1 },
      ]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("supports matchMode fixed, word, and line", async () => {
    const root = await createTempDir();
    try {
      await writeFiles(root, {
        "a.txt": "Needle\nneedleman\nneedle\n",
        "b.txt": "needle\nneedle\n",
      });

      const tool = createFilesSearchTool({ config: DEFAULT_PLUGIN_CONFIG });

      const wordResult = await tool.execute("call", {
        root,
        patterns: ["needle"],
        matchMode: "word",
        ignoreCase: true,
        maxMatchesPerFile: 1,
      });
      const wordDetails = wordResult.details as {
        matches: Array<{ path: string; line: number; text: string }>;
      };
      expect(wordDetails.matches).toEqual([
        { path: "a.txt", line: 1, text: "Needle" },
        { path: "b.txt", line: 1, text: "needle" },
      ]);

      const lineResult = await tool.execute("call", {
        root,
        patterns: ["needle"],
        matchMode: "line",
      });
      const lineDetails = lineResult.details as {
        matches: Array<{ path: string; line: number; text: string }>;
      };
      expect(lineDetails.matches).toEqual([
        { path: "a.txt", line: 3, text: "needle" },
        { path: "b.txt", line: 1, text: "needle" },
        { path: "b.txt", line: 2, text: "needle" },
      ]);

      const fixedResult = await tool.execute("call", {
        root,
        patterns: ["needle."],
        matchMode: "fixed",
      });
      const fixedDetails = fixedResult.details as { matches: unknown[] };
      expect(fixedDetails.matches).toEqual([]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("respects .gitignore by default", async () => {
    const root = await createTempDir();
    try {
      await writeFiles(root, {
        ".gitignore": "ignored.txt\n",
        "ignored.txt": "needle\n",
        "kept.txt": "needle\n",
      });

      const { execSync } = await import("node:child_process");
      execSync("git init && git add -A", { cwd: root, stdio: "ignore" });

      const tool = createFilesSearchTool({ config: DEFAULT_PLUGIN_CONFIG });
      const result = await tool.execute("call", {
        root,
        patterns: ["needle"],
      });
      const details = result.details as { matches: Array<{ path: string }> };
      expect(details.matches.map((m) => m.path)).toEqual(["kept.txt"]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("honors workspace-only filesystem policy", async () => {
    const workspaceRoot = await createTempDir("workspace-");
    const outsideRoot = await createTempDir("outside-");

    try {
      const tool = createFilesSearchTool({
        config: DEFAULT_PLUGIN_CONFIG,
        context: {
          fsPolicy: { workspaceOnly: true },
          workspaceDir: workspaceRoot,
          sandboxed: true,
        },
      });

      await expect(
        tool.execute("call", { root: outsideRoot, patterns: ["needle"] }),
      ).rejects.toThrow("root must stay within the active workspace");
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
      await writeFiles(projectRoot, { "allowed.txt": "needle\n" });
      await writeFiles(outsideRoot, { "secret.txt": "needle\n" });
      await fs.symlink(outsideRoot, path.join(projectRoot, "escape"));

      const tool = createFilesSearchTool({
        config: DEFAULT_PLUGIN_CONFIG,
        context: {
          fsPolicy: { workspaceOnly: true },
          workspaceDir: workspaceRoot,
          sandboxed: true,
        },
      });

      const result = await tool.execute("call", {
        root: projectRoot,
        patterns: ["needle"],
        followSymlinks: true,
      });
      const details = result.details as {
        matches: Array<{ path: string; line: number; text: string }>;
      };
      expect(details.matches).toEqual([{ path: "allowed.txt", line: 1, text: "needle" }]);
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
      await fs.rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it("marks results as truncated when hitting the result limit", async () => {
    const root = await createTempDir();
    try {
      await writeFiles(root, { "a.txt": "needle\nneedle\nneedle\n" });

      const tool = createFilesSearchTool({
        config: { ...DEFAULT_PLUGIN_CONFIG, maxSearchResults: 2 },
      });
      const result = await tool.execute("call", { root, patterns: ["needle"] });
      const details = result.details as { truncated: boolean; matches: unknown[] };
      expect(details.truncated).toBe(true);
      expect(details.matches).toHaveLength(2);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("search backend", () => {
  it("returns null for malformed ripgrep JSON lines", () => {
    expect(parseRipgrepJsonLine("{not-json")).toBeNull();
    expect(parseRipgrepJsonLine("")).toBeNull();
  });

  it("caps stderr output collected from child processes", async () => {
    const result = await runLineCommand({
      command: process.execPath,
      args: ["-e", "process.stderr.write('x'.repeat(70000)); process.stdout.write('ok\\n');"],
      timeoutMs: DEFAULT_PLUGIN_CONFIG.timeoutMs,
      onLine: () => {},
    });
    expect(result.stderr.endsWith("[stderr truncated]")).toBe(true);
    expect(result.stderr.length).toBeLessThanOrEqual(
      MAX_STDERR_BYTES + "\n[stderr truncated]".length,
    );
  });

  it("provides a clear error when command is not found", async () => {
    await expect(
      runLineCommand({
        command: "nonexistent-command-xyz",
        args: [],
        timeoutMs: 5000,
        onLine: () => {},
      }),
    ).rejects.toThrow("command not found: nonexistent-command-xyz");
  });

  it("runs rg search with counts mode", async () => {
    const root = await createTempDir();
    try {
      await writeFiles(root, {
        "a.txt": "needle\nneedle\n",
        "b.txt": "other\nneedle\n",
      });

      const result = await runRipgrepSearch({
        root: await fs.realpath(root),
        patterns: ["needle"],
        matchMode: "regex",
        outputMode: "counts",
        excludeGlobs: [],
        ignoreCase: false,
        includeHidden: false,
        followSymlinks: false,
        beforeContext: 0,
        afterContext: 0,
        timeoutMs: DEFAULT_PLUGIN_CONFIG.timeoutMs,
        resultLimit: DEFAULT_PLUGIN_CONFIG.maxSearchResults,
      });

      expect(
        result.counts.map((entry) => ({
          path: path.basename(entry.absolutePath),
          count: entry.count,
        })),
      ).toEqual([
        { path: "a.txt", count: 2 },
        { path: "b.txt", count: 1 },
      ]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
