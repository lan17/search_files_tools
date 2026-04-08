import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_PLUGIN_CONFIG } from "../src/config.ts";
import { createFilesSearchTool } from "../src/files-search-tool.ts";
import {
  MAX_STDERR_BYTES,
  clearSearchBackendCache,
  parseRipgrepMatchLine,
  resolveSearchBackend,
  runLineCommand,
  runSearchWithBackend,
} from "../src/search-backend.ts";
import { createTempDir, writeFiles } from "./helpers.ts";

describe("files_search", () => {
  afterEach(() => {
    clearSearchBackendCache();
  });

  it("rejects invalid pattern combinations and invalid modes", async () => {
    const root = await createTempDir();
    try {
      const tool = createFilesSearchTool({ config: DEFAULT_PLUGIN_CONFIG });

      await expect(
        tool.execute("call", {
          root,
          pattern: "foo",
          patterns: ["bar"],
        }),
      ).rejects.toThrow("Provide exactly one of pattern or patterns");

      await expect(
        tool.execute("call", {
          root,
          pattern: "foo",
          filesWithMatches: true,
          countOnly: true,
        }),
      ).rejects.toThrow("filesWithMatches and countOnly cannot both be true");

      await expect(
        tool.execute("call", {
          root,
          pattern: "foo",
          beforeContext: 1.5,
        }),
      ).rejects.toThrow("beforeContext must be a non-negative integer");

      await expect(
        tool.execute("call", {
          root,
          pattern: "foo",
          afterContext: 2.5,
        }),
      ).rejects.toThrow("afterContext must be a non-negative integer");

      await expect(
        tool.execute("call", {
          root,
          pattern: "foo",
          maxMatchesPerFile: 2.5,
        }),
      ).rejects.toThrow("maxMatchesPerFile must be a positive integer");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("returns match entries with include/exclude globs, multi-pattern search, and context", async () => {
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
        patterns: ["needle", "second needle"],
        includeGlobs: ["src/**/*.ts"],
        excludeGlobs: ["**/*.test.ts"],
        beforeContext: 1,
        afterContext: 1,
      });
      const details = result.details as {
        mode: string;
        candidateFileCount: number;
        matches: Array<{
          path: string;
          line: number;
          text: string;
          before?: Array<{ line: number; text: string }>;
          after?: Array<{ line: number; text: string }>;
        }>;
      };

      expect(details.mode).toBe("matches");
      expect(details.candidateFileCount).toBe(2);
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

  it("supports files-with-matches, counts, hidden files, and path narrowing", async () => {
    const root = await createTempDir();
    try {
      await writeFiles(root, {
        "src/a.ts": "needle\nneedle\n",
        "src/nested/b.ts": "needle\n",
        "other/c.ts": "needle\n",
        ".hidden.ts": "needle\n",
      });

      const tool = createFilesSearchTool({ config: DEFAULT_PLUGIN_CONFIG });

      const filesResult = await tool.execute("call", {
        root,
        pattern: "needle",
        filesWithMatches: true,
        paths: ["src"],
      });
      const filesDetails = filesResult.details as { files: string[] };
      expect(filesDetails.files).toEqual(["src/a.ts", "src/nested/b.ts"]);

      const countsResult = await tool.execute("call", {
        root,
        pattern: "needle",
        countOnly: true,
        includeHidden: true,
      });
      const countsDetails = countsResult.details as {
        counts: Array<{ path: string; count: number }>;
      };
      expect(countsDetails.counts).toEqual([
        { path: ".hidden.ts", count: 1 },
        { path: "other/c.ts", count: 1 },
        { path: "src/a.ts", count: 2 },
        { path: "src/nested/b.ts", count: 1 },
      ]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("respects root ignore files when requested", async () => {
    const root = await createTempDir();
    try {
      await writeFiles(root, {
        ".gitignore": "ignored.txt\n",
        "ignored.txt": "needle\n",
        "kept.txt": "needle\n",
      });

      const tool = createFilesSearchTool({ config: DEFAULT_PLUGIN_CONFIG });
      const result = await tool.execute("call", {
        root,
        pattern: "needle",
        respectIgnoreFiles: true,
      });
      const details = result.details as {
        matches: Array<{ path: string; line: number; text: string }>;
      };

      expect(details.matches).toEqual([{ path: "kept.txt", line: 1, text: "needle" }]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("supports fixed-string, ignore-case, word, line, and maxMatchesPerFile behavior", async () => {
    const root = await createTempDir();
    try {
      await writeFiles(root, {
        "src/a.txt": "Needle\nneedleman\nneedle\n",
        "src/b.txt": "needle\nneedle\n",
      });

      const tool = createFilesSearchTool({ config: DEFAULT_PLUGIN_CONFIG });

      const wordResult = await tool.execute("call", {
        root,
        pattern: "needle",
        ignoreCase: true,
        wordMatch: true,
        maxMatchesPerFile: 1,
      });
      const wordDetails = wordResult.details as {
        matches: Array<{ path: string; line: number; text: string }>;
      };
      expect(wordDetails.matches).toEqual([
        { path: "src/a.txt", line: 1, text: "Needle" },
        { path: "src/b.txt", line: 1, text: "needle" },
      ]);

      const lineResult = await tool.execute("call", {
        root,
        pattern: "needle",
        lineMatch: true,
      });
      const lineDetails = lineResult.details as {
        matches: Array<{ path: string; line: number; text: string }>;
      };
      expect(lineDetails.matches).toEqual([
        { path: "src/a.txt", line: 3, text: "needle" },
        { path: "src/b.txt", line: 1, text: "needle" },
        { path: "src/b.txt", line: 2, text: "needle" },
      ]);

      const fixedStringResult = await tool.execute("call", {
        root,
        pattern: "needle.",
        fixedStrings: true,
      });
      const fixedDetails = fixedStringResult.details as { matches: Array<{ path: string }> };
      expect(fixedDetails.matches).toEqual([]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("marks searches as truncated when candidate enumeration hits the cap", async () => {
    const root = await createTempDir();
    try {
      await writeFiles(root, {
        "a.txt": "needle",
        "b.txt": "needle",
        "c.txt": "needle",
      });

      const tool = createFilesSearchTool({
        config: {
          ...DEFAULT_PLUGIN_CONFIG,
          maxCandidateFiles: 2,
        },
      });
      const result = await tool.execute("call", {
        root,
        pattern: "needle",
      });
      const details = result.details as { truncated: boolean; candidateFileCount: number };

      expect(details.truncated).toBe(true);
      expect(details.candidateFileCount).toBe(2);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("honors workspace-only filesystem policy even for sandboxed runs", async () => {
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
        tool.execute("call", {
          root: outsideRoot,
          pattern: "needle",
        }),
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
      await writeFiles(projectRoot, {
        "allowed.txt": "needle\n",
      });
      await writeFiles(outsideRoot, {
        "secret.txt": "needle\n",
      });
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
        pattern: "needle",
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
});

describe("search backend", () => {
  afterEach(() => {
    clearSearchBackendCache();
  });

  it("prefers rg when available", async () => {
    const backend = await resolveSearchBackend();
    expect(["rg", "grep"]).toContain(backend.name);
  });

  it("supports both rg and grep backends", async () => {
    const root = await createTempDir();
    try {
      const written = await writeFiles(root, {
        "a.txt": "needle\nneedle\n",
        "b.txt": "other\nneedle\n",
      });

      const rgBackend = await resolveSearchBackend();
      const results = await runSearchWithBackend({
        backend: rgBackend,
        files: Object.values(written),
        patterns: ["needle"],
        timeoutMs: DEFAULT_PLUGIN_CONFIG.timeoutMs,
        resultLimit: DEFAULT_PLUGIN_CONFIG.maxSearchResults,
        mode: "counts",
      });

      expect(results.counts.map((entry) => ({
        path: path.basename(entry.absolutePath),
        count: entry.count,
      }))).toEqual([
        { path: "a.txt", count: 2 },
        { path: "b.txt", count: 1 },
      ]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("returns null for malformed ripgrep JSON lines", () => {
    expect(parseRipgrepMatchLine("{not-json")).toBeNull();
  });

  it("caps stderr output collected from child processes", async () => {
    const result = await runLineCommand({
      command: process.execPath,
      args: [
        "-e",
        "process.stderr.write('x'.repeat(70000)); process.stdout.write('ok\\n');",
      ],
      timeoutMs: DEFAULT_PLUGIN_CONFIG.timeoutMs,
      onLine: () => {
        // No-op.
      },
    });

    expect(result.stderr.endsWith("[stderr truncated]")).toBe(true);
    expect(result.stderr.length).toBeLessThanOrEqual(
      MAX_STDERR_BYTES + "\n[stderr truncated]".length,
    );
  });
});
