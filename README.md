# Search Files Tools

OpenClaw plugin for searching and globbing files from agents. Requires
[ripgrep](https://github.com/BurntSushi/ripgrep) (`rg`).

## Features

- `files_search`: search file contents under an absolute root directory.
- `files_glob`: list files matching glob patterns under an absolute root directory.
- Shared root validation and OpenClaw filesystem policy enforcement.
- Respects `.gitignore` by default (handled natively by `rg`).

## Install

```bash
openclaw plugins install search-files-tools
```

For local development:

```bash
npm install
openclaw plugins install -l /absolute/path/to/search_files_tools
```

## Configuration

The plugin exposes three operational caps under
`plugins.entries.search-files-tools.config`:

- `timeoutMs` default `20000`
- `maxSearchResults` default `2000`
- `maxGlobResults` default `5000`

## Tools

### `files_search`

Search files below an absolute `root` path.

| Parameter | Type | Description |
|-----------|------|-------------|
| `root` | `string` | **Required.** Absolute directory to search. |
| `patterns` | `string[]` | **Required.** Search patterns (regex by default). |
| `matchMode` | `"regex" \| "fixed" \| "word" \| "line"` | How patterns are interpreted. Default: `"regex"`. |
| `outputMode` | `"matches" \| "files" \| "counts"` | What to return. Default: `"matches"`. |
| `includeGlobs` | `string[]` | Restrict searched files (gitignore-style). |
| `excludeGlobs` | `string[]` | Exclude files from search. |
| `ignoreCase` | `boolean` | Case-insensitive matching. |
| `beforeContext` | `integer` | Context lines before each match. |
| `afterContext` | `integer` | Context lines after each match. |
| `maxMatchesPerFile` | `integer` | Cap matches returned per file. |
| `includeHidden` | `boolean` | Include dotfiles. |
| `followSymlinks` | `boolean` | Follow symbolic links. |

### `files_glob`

List files below an absolute `root` path that match one or more glob patterns.

| Parameter | Type | Description |
|-----------|------|-------------|
| `root` | `string` | **Required.** Absolute directory to list files in. |
| `patterns` | `string[]` | **Required.** Glob patterns (gitignore-style). |
| `excludeGlobs` | `string[]` | Glob patterns to exclude. |
| `includeHidden` | `boolean` | Include dotfiles. |
| `followSymlinks` | `boolean` | Follow symbolic links. |
| `maxResults` | `integer` | Result cap (capped at config `maxGlobResults`). |

## Verification

```bash
npm run lint
npm run typecheck
npm test
npm run coverage
```
