import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export async function createTempDir(prefix = "search-files-tools-"): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function writeFiles(
  root: string,
  files: Record<string, string>,
): Promise<Record<string, string>> {
  const written: Record<string, string> = {};
  for (const [relativePath, contents] of Object.entries(files)) {
    const absolutePath = path.join(root, relativePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, contents, "utf8");
    written[relativePath] = absolutePath;
  }
  return written;
}
