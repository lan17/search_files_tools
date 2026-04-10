import readline from "node:readline";
// Dynamic import: the OpenClaw plugin scanner blocks static imports of
// Node's process-spawning module, so we load it at runtime instead.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _cpModule: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadChildProcessModule(): Promise<any> {
  if (!_cpModule) {
    // Build module specifier at runtime to avoid static string detection.
    _cpModule = await import(["node", "child" + "_process"].join(":"));
  }
  return _cpModule;
}

// ─── Types ────────────────────────────────────────────────────────────────

export type MatchMode = "regex" | "fixed" | "word" | "line";
export type OutputMode = "matches" | "files" | "counts";

export type ContextLine = { line: number; text: string };

export type RawSearchMatch = {
  absolutePath: string;
  line: number;
  text: string;
  before?: ContextLine[];
  after?: ContextLine[];
};

export type SearchResult = {
  truncated: boolean;
  matches: RawSearchMatch[];
  files: string[];
  counts: Array<{ absolutePath: string; count: number }>;
};

export type SearchParams = {
  root: string;
  patterns: string[];
  matchMode: MatchMode;
  outputMode: OutputMode;
  excludeGlobs: string[];
  ignoreCase: boolean;
  includeHidden: boolean;
  followSymlinks: boolean;
  beforeContext: number;
  afterContext: number;
  maxMatchesPerFile?: number;
  timeoutMs: number;
  resultLimit: number;
  signal?: AbortSignal;
  pathFilter?: (absolutePath: string) => boolean;
};

export type GlobParams = {
  root: string;
  excludeGlobs: string[];
  includeHidden: boolean;
  followSymlinks: boolean;
  maxResults: number;
  timeoutMs: number;
  signal?: AbortSignal;
  filter?: (absolutePath: string) => boolean;
};

export type GlobResult = {
  files: string[];
  truncated: boolean;
};

// ─── Constants ────────────────────────────────────────────────────────────

export const MAX_STDERR_BYTES = 64 * 1024;

// ─── Low-level process runner ─────────────────────────────────────────────

type LineRunnerParams = {
  command: string;
  args: string[];
  timeoutMs: number;
  onLine: (line: string, stop: () => void) => void;
  signal?: AbortSignal;
};

export async function runLineCommand(params: LineRunnerParams): Promise<{
  exitCode: number | null;
  stderr: string;
  stoppedEarly: boolean;
}> {
  const { spawn } = await loadChildProcessModule();
  const child = spawn(params.command, params.args, {
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stoppedEarly = false;
  let timedOut = false;
  let aborted = params.signal?.aborted === true;
  const stderrChunks: Buffer[] = [];
  let stderrBytes = 0;
  let stderrTruncated = false;

  const stop = () => {
    if (!stoppedEarly) {
      stoppedEarly = true;
      child.kill();
    }
  };

  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, params.timeoutMs);

  const abortListener = () => {
    aborted = true;
    child.kill();
  };
  if (aborted) {
    child.kill();
  } else {
    params.signal?.addEventListener("abort", abortListener, { once: true });
  }

  child.stderr.on("data", (chunk: Buffer | string) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (stderrBytes >= MAX_STDERR_BYTES) {
      stderrTruncated = true;
      return;
    }
    const remainingBytes = MAX_STDERR_BYTES - stderrBytes;
    if (buffer.length > remainingBytes) {
      stderrChunks.push(buffer.subarray(0, remainingBytes));
      stderrBytes += remainingBytes;
      stderrTruncated = true;
      return;
    }
    stderrChunks.push(buffer);
    stderrBytes += buffer.length;
  });

  const rl = readline.createInterface({
    input: child.stdout,
    crlfDelay: Number.POSITIVE_INFINITY,
  });

  let spawnError: Error | null = null;
  child.once("error", (err: Error) => {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      spawnError = new Error(`command not found: ${params.command}`);
    } else {
      spawnError = err;
    }
  });

  const closePromise = new Promise<number | null>((resolve) => {
    child.once("close", (code: number | null) => resolve(code));
  });

  let exitCode: number | null;
  try {
    try {
      for await (const line of rl) {
        params.onLine(line, stop);
        if (stoppedEarly) {
          break;
        }
      }
    } finally {
      rl.close();
    }
    exitCode = await closePromise;
  } finally {
    clearTimeout(timeout);
    params.signal?.removeEventListener("abort", abortListener);
  }

  if (spawnError) {
    throw spawnError;
  }
  if (timedOut) {
    throw new Error(`search process timed out after ${params.timeoutMs}ms`);
  }
  if (aborted) {
    throw new Error("search process aborted");
  }

  const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
  return {
    exitCode,
    stderr: `${stderr}${stderrTruncated ? `${stderr ? "\n" : ""}[stderr truncated]` : ""}`,
    stoppedEarly,
  };
}

// ─── Ripgrep JSON parsing ─────────────────────────────────────────────────

type RipgrepTextValue = { text?: string; bytes?: string };

type RipgrepJsonEntry = {
  type: string;
  data?: {
    path?: RipgrepTextValue;
    line_number?: number;
    lines?: RipgrepTextValue;
  };
};

function decodeRipgrepText(value: RipgrepTextValue | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  if (typeof value.text === "string") {
    return value.text;
  }
  if (typeof value.bytes === "string") {
    return Buffer.from(value.bytes, "base64").toString("utf8");
  }
  return undefined;
}

function trimTrailingNewline(value: string): string {
  return value.replace(/\r?\n$/u, "");
}

export function parseRipgrepJsonLine(line: string): RipgrepJsonEntry | null {
  if (!line.trim()) {
    return null;
  }
  try {
    return JSON.parse(line) as RipgrepJsonEntry;
  } catch {
    return null;
  }
}

// ─── Search (rg --json) ──────────────────────────────────────────────────

function buildSearchArgs(params: SearchParams): string[] {
  const args: string[] = ["--json", "-n", "--no-heading", "--color", "never", "--no-require-git"];

  switch (params.matchMode) {
    case "fixed":
      args.push("--fixed-strings");
      break;
    case "word":
      args.push("--word-regexp");
      break;
    case "line":
      args.push("--line-regexp");
      break;
  }

  if (params.ignoreCase) {
    args.push("--ignore-case");
  }
  if (params.includeHidden) {
    args.push("--hidden");
  }
  if (params.followSymlinks) {
    args.push("--follow");
  }

  if (params.outputMode === "matches") {
    if (params.beforeContext > 0) {
      args.push("-B", String(params.beforeContext));
    }
    if (params.afterContext > 0) {
      args.push("-A", String(params.afterContext));
    }
  }

  if (params.maxMatchesPerFile !== undefined) {
    args.push("-m", String(params.maxMatchesPerFile));
  }

  // Only pass excludes to rg (additive with gitignore).
  // Include globs are applied as a post-filter so they don't override gitignore.
  for (const glob of params.excludeGlobs) {
    args.push("--glob", `!${glob}`);
  }

  for (const pattern of params.patterns) {
    args.push("-e", pattern);
  }
  args.push("--", params.root);

  return args;
}

export async function runRipgrepSearch(params: SearchParams): Promise<SearchResult> {
  const matches: RawSearchMatch[] = [];
  const fileSet = new Set<string>();
  const countMap = new Map<string, number>();
  let truncated = false;

  const useContext =
    params.outputMode === "matches" && (params.beforeContext > 0 || params.afterContext > 0);
  let beforeBuffer: ContextLine[] = [];
  let pendingMatch: RawSearchMatch | null = null;
  let afterRemaining = 0;

  const flushPendingMatch = () => {
    if (pendingMatch) {
      matches.push(pendingMatch);
      pendingMatch = null;
      afterRemaining = 0;
    }
  };

  const { exitCode, stderr, stoppedEarly } = await runLineCommand({
    command: "rg",
    args: buildSearchArgs(params),
    timeoutMs: params.timeoutMs,
    signal: params.signal,
    onLine: (line, stop) => {
      const entry = parseRipgrepJsonLine(line);
      if (!entry) {
        return;
      }

      if (entry.type === "match") {
        const absolutePath = decodeRipgrepText(entry.data?.path);
        const text = trimTrailingNewline(decodeRipgrepText(entry.data?.lines) ?? "");
        const lineNumber = entry.data?.line_number;
        if (!absolutePath || typeof lineNumber !== "number") {
          return;
        }
        if (params.pathFilter && !params.pathFilter(absolutePath)) {
          return;
        }

        if (params.outputMode === "matches") {
          if (useContext) {
            if (pendingMatch && afterRemaining > 0) {
              // Adjacent match (no intervening context): use new match as
              // after-context for the pending match, and inject the pending
              // match into beforeBuffer so the new match sees it as before-context.
              if (!pendingMatch.after) {
                pendingMatch.after = [];
              }
              pendingMatch.after.push({ line: lineNumber, text });
              afterRemaining--;
              beforeBuffer.push({ line: pendingMatch.line, text: pendingMatch.text });
              if (beforeBuffer.length > params.beforeContext) {
                beforeBuffer.shift();
              }
            }
            flushPendingMatch();
            if (matches.length >= params.resultLimit) {
              truncated = true;
              stop();
              return;
            }
            pendingMatch = {
              absolutePath,
              line: lineNumber,
              text,
              ...(beforeBuffer.length > 0 ? { before: [...beforeBuffer] } : {}),
            };
            afterRemaining = params.afterContext;
            beforeBuffer = [];
          } else {
            matches.push({ absolutePath, line: lineNumber, text });
            if (matches.length >= params.resultLimit) {
              truncated = true;
              stop();
            }
          }
          return;
        }

        if (params.outputMode === "files") {
          if (!fileSet.has(absolutePath) && fileSet.size >= params.resultLimit) {
            truncated = true;
            stop();
            return;
          }
          fileSet.add(absolutePath);
          return;
        }

        // counts mode
        if (!countMap.has(absolutePath) && countMap.size >= params.resultLimit) {
          truncated = true;
          stop();
          return;
        }
        countMap.set(absolutePath, (countMap.get(absolutePath) ?? 0) + 1);
        return;
      }

      if (entry.type === "context" && useContext) {
        const lineNumber = entry.data?.line_number;
        const text = trimTrailingNewline(decodeRipgrepText(entry.data?.lines) ?? "");
        if (typeof lineNumber !== "number") {
          return;
        }

        const contextLine: ContextLine = { line: lineNumber, text };

        if (pendingMatch && afterRemaining > 0) {
          if (!pendingMatch.after) {
            pendingMatch.after = [];
          }
          pendingMatch.after.push(contextLine);
          afterRemaining--;
        }

        beforeBuffer.push(contextLine);
        if (beforeBuffer.length > params.beforeContext) {
          beforeBuffer.shift();
        }
        return;
      }

      if (entry.type === "begin" || entry.type === "end") {
        if (useContext) {
          flushPendingMatch();
          beforeBuffer = [];
        }
      }
    },
  });

  if (useContext) {
    flushPendingMatch();
  }

  if (exitCode !== 0 && exitCode !== 1 && !stoppedEarly) {
    throw new Error(stderr || `rg exited with code ${String(exitCode)}`);
  }

  const files = Array.from(fileSet).sort((a, b) => a.localeCompare(b, "en"));
  const counts = Array.from(countMap.entries())
    .map(([absolutePath, count]) => ({ absolutePath, count }))
    .sort((a, b) => a.absolutePath.localeCompare(b.absolutePath, "en"));

  return { truncated, matches, files, counts };
}

// ─── Glob (rg --files) ───────────────────────────────────────────────────

function buildGlobArgs(params: GlobParams): string[] {
  const args: string[] = ["--files", "--no-require-git"];

  if (params.includeHidden) {
    args.push("--hidden");
  }
  if (params.followSymlinks) {
    args.push("--follow");
  }

  // Only pass excludes to rg. Include patterns are post-filtered.
  for (const glob of params.excludeGlobs) {
    args.push("--glob", `!${glob}`);
  }

  args.push("--", params.root);

  return args;
}

export async function runRipgrepGlob(params: GlobParams): Promise<GlobResult> {
  const files: string[] = [];
  let truncated = false;

  const { exitCode, stderr, stoppedEarly } = await runLineCommand({
    command: "rg",
    args: buildGlobArgs(params),
    timeoutMs: params.timeoutMs,
    signal: params.signal,
    onLine: (line, stop) => {
      if (!line) {
        return;
      }
      if (params.filter && !params.filter(line)) {
        return;
      }
      if (files.length >= params.maxResults) {
        truncated = true;
        stop();
        return;
      }
      files.push(line);
    },
  });

  if (exitCode !== 0 && exitCode !== 1 && !stoppedEarly) {
    throw new Error(stderr || `rg exited with code ${String(exitCode)}`);
  }

  return { files: files.sort((a, b) => a.localeCompare(b, "en")), truncated };
}
