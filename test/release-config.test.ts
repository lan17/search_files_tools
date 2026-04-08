import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("release config", () => {
  it("does not promote docs commits to minor releases", async () => {
    const configPath = path.join(process.cwd(), ".releaserc.json");
    const config = JSON.parse(await fs.readFile(configPath, "utf8")) as {
      plugins?: unknown[];
    };

    const docsRule = config.plugins
      ?.filter((plugin): plugin is [string, { releaseRules?: Array<{ type?: string; release?: string }> }] =>
        Array.isArray(plugin) && plugin[0] === "@semantic-release/commit-analyzer"
      )
      .flatMap(([, options]) => options.releaseRules ?? [])
      .find((rule) => rule.type === "docs");

    expect(docsRule).toBeUndefined();
  });
});
