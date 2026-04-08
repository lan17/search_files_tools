export type SearchFilesPluginConfig = {
  timeoutMs: number;
  maxCandidateFiles: number;
  maxSearchResults: number;
  maxGlobResults: number;
};

export const DEFAULT_PLUGIN_CONFIG: SearchFilesPluginConfig = {
  timeoutMs: 20_000,
  maxCandidateFiles: 20_000,
  maxSearchResults: 2_000,
  maxGlobResults: 5_000,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readPositiveInteger(
  value: unknown,
  fallback: number,
  label: keyof SearchFilesPluginConfig,
): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

export function resolvePluginConfig(pluginConfig: unknown): SearchFilesPluginConfig {
  const raw = isRecord(pluginConfig) ? pluginConfig : {};
  return {
    timeoutMs: readPositiveInteger(raw.timeoutMs, DEFAULT_PLUGIN_CONFIG.timeoutMs, "timeoutMs"),
    maxCandidateFiles: readPositiveInteger(
      raw.maxCandidateFiles,
      DEFAULT_PLUGIN_CONFIG.maxCandidateFiles,
      "maxCandidateFiles",
    ),
    maxSearchResults: readPositiveInteger(
      raw.maxSearchResults,
      DEFAULT_PLUGIN_CONFIG.maxSearchResults,
      "maxSearchResults",
    ),
    maxGlobResults: readPositiveInteger(
      raw.maxGlobResults,
      DEFAULT_PLUGIN_CONFIG.maxGlobResults,
      "maxGlobResults",
    ),
  };
}
