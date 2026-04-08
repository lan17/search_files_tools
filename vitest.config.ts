import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "openclaw/plugin-sdk/plugin-entry": path.resolve(
        __dirname,
        "test/stubs/openclaw-plugin-sdk-plugin-entry.ts",
      ),
    },
  },
});
