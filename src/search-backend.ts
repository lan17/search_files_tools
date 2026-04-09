import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";

export type SearchBackendName = "rg" | "grep";

export type SearchBackend = {
  name: SearchBackendName;
  command: string;
};

export type SearchMode = "matches" | "files" | "counts";

export type SearchBackendMatch = {
  absolutePath: string;
  line: number;
  text: string;
};

export type SearchBackendRunParams = {
  backend: SearchBackend;
  files: string[];
  patterns: string[];
  fixedStrings?: boolean;
  ignoreCase?: boolean;
  wordMatch?: boolean;
  lineMatch?: boolean;
  maxMatchesPerFile?: number;
  timeoutMs: number;
  resultLimit: number;
  mode: SearchMode;
  signal?: AbortSignal;
};

export type SearchBackendResult = {
  backend: SearchBackendName;
  truncated: boolean;
  matches: SearchBackendMatch[];
  files: string[];
  counts: Array<{ absolutePath: string; count: number }>;
};

type LineRunnerParams = {
  command: string;
  args: string[];
  timeoutMs: number;
  onLine: (line: string, stop: () => void) => void;
  signal?: AbortSignal;
};

const MAX_BATCH_ARG_CHARS = 120_000;
export const MAX_STDERR_BYTES = 64 * 1024;
const executableCache = new Map<string, Promise<SearchBackend>>();

function decodeRipgrepText(
  value: { text?: string; bytes?: string } | undefined,
): string | undefined {
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

async function findExecutable(name: string, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const pathEnv = env.PATH;
  if (!pathEnv) {
    return null;
  }
  const pathEntries = pathEnv.split(path.delimiter).filter(Boolean);
  const suffixes =
    process.platform === "win32"
      ? (env.PATHEXT?.split(path.delimiter).filter(Boolean) ?? [".EXE", ".CMD", ".BAT", ".COM"])
      : [""];

  for (const entry of pathEntries) {
    for (const suffix of suffixes) {
      const candidate = path.join(entry, process.platform === "win32" ? `${name}${suffix}` : name);
      try {
        await fs.access(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        // Keep scanning PATH.
      }
    }
  }

  return null;
}

export function clearSearchBackendCache(): void {
  executableCache.clear();
}

export async function resolveSearchBackend(): Promise<SearchBackend> {
  const cached = executableCache.get("default");
  if (cached) {
    return await cached;
  }
  const resolution = (async () => {
    const rg = await findExecutable("rg");
    if (rg) {
      return { name: "rg", command: rg } satisfies SearchBackend;
    }
    const grep = await findExecutable("grep");
    if (grep) {
      return { name: "grep", command: grep } satisfies SearchBackend;
    }
    throw new Error("files_search requires either rg or grep to be installed");
  })();
  executableCache.set("default", resolution);
  return await resolution;
}

function buildSearchArgs(params: SearchBackendRunParams): string[] {
  const args: string[] = [];
  if (params.backend.name === "rg") {
    args.push("--json", "-n", "-H", "--no-heading", "--color", "never");
  } else {
    args.push("-nH", "-Z", "--binary-files=without-match");
  }

  if (params.fixedStrings === true) {
    args.push("-F");
  }
  if (params.ignoreCase === true) {
    args.push("-i");
  }
  if (params.wordMatch === true) {
    args.push("-w");
  }
  if (params.lineMatch === true) {
    args.push("-x");
  }
  if (typeof params.maxMatchesPerFile === "number") {
    args.push("-m", String(params.maxMatchesPerFile));
  }
  for (const pattern of params.patterns) {
    args.push("-e", pattern);
  }
  args.push("--");
  return args;
}

function createFileBatches(files: string[]): string[][] {
  const batches: string[][] = [];
  let currentBatch: string[] = [];
  let currentChars = 0;

  for (const file of files) {
    const fileChars = file.length + 1;
    if (currentBatch.length > 0 && currentChars + fileChars > MAX_BATCH_ARG_CHARS) {
      batches.push(currentBatch);
      currentBatch = [];
      currentChars = 0;
    }
    currentBatch.push(file);
    currentChars += fileChars;
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  return batches;
}

export async function runLineCommand(params: LineRunnerParams): Promise<{
  exitCode: number | null;
  stderr: string;
  stoppedEarly: boolean;
}> {
  const child = spawn(params.command, params.args, {
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stoppedEarly = false;
  let timedOut = false;
  let aborted = false;
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
  params.signal?.addEventListener("abort", abortListener, { once: true });

  child.stderr.on("data", (chunk: Buffer | string) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (stderrBytes >= MAX_STDERR_BYTES) {
      stderrTruncated = true;
      return;
    }

    const remainingBytes = MAX_STDERR_BYTES - stderrBytes;
    if (buffer.length > remainingBytes) {
      // This truncates on a byte boundary, which can split a UTF-8 codepoint, but stderr
      // here is only diagnostic output and the hard memory cap matters more than perfect decoding.
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

  const closePromise = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code));
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

  if (timedOut) {
    throw new Error(`search process timed out after ${params.timeoutMs}ms`);
  }
  if (aborted) {
    throw new Error("search process aborted");
  }

  const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
  return {
    exitCode,
    stderr: `${stderr}${
      stderrTruncated ? `${stderr ? "\n" : ""}[stderr truncated]` : ""
    }`,
    stoppedEarly,
  };
}

function trimTrailingNewline(value: string): string {
  return value.replace(/\r?\n$/u, "");
}

export function parseRipgrepMatchLine(line: string): SearchBackendMatch | null {
  if (!line.trim()) {
    return null;
  }
  let payload: {
    type?: string;
    data?: {
      path?: { text?: string; bytes?: string };
      line_number?: number;
      lines?: { text?: string; bytes?: string };
    };
  };
  try {
    payload = JSON.parse(line) as {
      type?: string;
      data?: {
        path?: { text?: string; bytes?: string };
        line_number?: number;
        lines?: { text?: string; bytes?: string };
      };
    };
  } catch {
    return null;
  }
  if (payload.type !== "match") {
    return null;
  }
  const absolutePath = decodeRipgrepText(payload.data?.path);
  const text = trimTrailingNewline(decodeRipgrepText(payload.data?.lines) ?? "");
  const lineNumber = payload.data?.line_number;
  if (!absolutePath || typeof lineNumber !== "number") {
    return null;
  }
  return {
    absolutePath,
    line: lineNumber,
    text,
  };
}

function parseGrepMatchLine(line: string): SearchBackendMatch | null {
  if (!line.trim()) {
    return null;
  }
  const nulIndex = line.indexOf("\u0000");
  if (nulIndex === -1) {
    return null;
  }
  const absolutePath = line.slice(0, nulIndex);
  const rest = line.slice(nulIndex + 1);
  const match = /^([0-9]+):(.*)$/u.exec(rest);
  if (!match) {
    return null;
  }
  return {
    absolutePath,
    line: Number(match[1]),
    text: match[2],
  };
}

export async function runSearchWithBackend(
  params: SearchBackendRunParams,
): Promise<SearchBackendResult> {
  const matches: SearchBackendMatch[] = [];
  const fileSet = new Set<string>();
  const countMap = new Map<string, number>();
  let truncated = false;

  const parser = params.backend.name === "rg" ? parseRipgrepMatchLine : parseGrepMatchLine;
  const baseArgs = buildSearchArgs(params);
  const batches = createFileBatches(params.files);

  for (const batch of batches) {
    const { exitCode, stderr, stoppedEarly } = await runLineCommand({
      command: params.backend.command,
      args: [...baseArgs, ...batch],
      timeoutMs: params.timeoutMs,
      signal: params.signal,
      onLine: (line, stop) => {
        const parsed = parser(line);
        if (!parsed) {
          return;
        }

        if (params.mode === "matches") {
          matches.push(parsed);
          if (matches.length >= params.resultLimit) {
            truncated = true;
            stop();
          }
          return;
        }

        if (params.mode === "files") {
          if (!fileSet.has(parsed.absolutePath) && fileSet.size >= params.resultLimit) {
            truncated = true;
            stop();
            return;
          }
          fileSet.add(parsed.absolutePath);
          return;
        }

        if (!countMap.has(parsed.absolutePath) && countMap.size >= params.resultLimit) {
          truncated = true;
          stop();
          return;
        }
        countMap.set(parsed.absolutePath, (countMap.get(parsed.absolutePath) ?? 0) + 1);
      },
    });

    if (exitCode !== 0 && exitCode !== 1 && !stoppedEarly) {
      const backendLabel = params.backend.name;
      throw new Error(stderr || `${backendLabel} exited with code ${String(exitCode)}`);
    }

    if (stoppedEarly) {
      truncated = true;
      break;
    }
  }

  const files = Array.from(fileSet).sort((left, right) => left.localeCompare(right, "en"));
  const counts = Array.from(countMap.entries())
    .map(([absolutePath, count]) => ({ absolutePath, count }))
    .sort((left, right) => left.absolutePath.localeCompare(right.absolutePath, "en"));

  return {
    backend: params.backend.name,
    truncated,
    matches,
    files,
    counts,
  };
}
