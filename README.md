# Search Files Tools

[![CI](https://github.com/lan17/search_files_tools/actions/workflows/lint.yml/badge.svg)](https://github.com/lan17/search_files_tools/actions/workflows/lint.yml)
[![npm](https://img.shields.io/npm/v/search-files-tools)](https://www.npmjs.com/package/search-files-tools)
[![License](https://img.shields.io/github/license/lan17/search_files_tools)](LICENSE)

OpenClaw plugin for searching and globbing files from agents. Requires
[ripgrep](https://github.com/BurntSushi/ripgrep) (`rg`).

Having separate tools for just searching and globbing files is useful to avoid having to use `exec` tool.  The surface area of these tools is also designed to be friendlier to LLMs.

## Features

- `files_search`: search file contents under an absolute root directory.
- `files_glob`: list files matching glob patterns under an absolute root directory.
- Shared root validation and OpenClaw filesystem policy enforcement.
- Respects `.gitignore` by default via `rg --no-require-git` (works even
  outside git repositories when a `.gitignore` is present).
- Long matching lines are automatically truncated to 1000 characters to
  keep responses token-efficient for LLM consumers.

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

Search for text patterns in file contents. Patterns are regex by default;
use `matchMode: "fixed"` for literal strings. Returns 2 lines of context
around each match by default.

| Parameter | Type | Description |
|-----------|------|-------------|
| `root` | `string` | **Required.** Absolute directory to search. |
| `patterns` | `string \| string[]` | **Required.** Search pattern(s). Regex by default. |
| `matchMode` | `"regex" \| "fixed" \| "word" \| "line"` | How patterns are interpreted. Default: `"regex"`. |
| `outputMode` | `"matches" \| "files" \| "counts"` | What to return. Default: `"matches"`. |
| `include` | `string \| string[]` | Restrict searched files by glob (e.g., `"*.ts"`). |
| `exclude` | `string \| string[]` | Exclude files by glob (e.g., `"*.test.ts"`). |
| `ignoreCase` | `boolean` | Case-insensitive matching. |
| `beforeContext` | `integer` | Context lines before each match. Default: `2`. |
| `afterContext` | `integer` | Context lines after each match. Default: `2`. |
| `maxMatchesPerFile` | `integer` | Cap matches returned per file. |
| `includeHidden` | `boolean` | Include dotfiles. |
| `followSymlinks` | `boolean` | Follow symbolic links. |

### `files_glob`

Find files by name or path pattern. Patterns like `*.ts` match at any depth.

| Parameter | Type | Description |
|-----------|------|-------------|
| `root` | `string` | **Required.** Absolute directory to list files in. |
| `patterns` | `string \| string[]` | **Required.** Glob pattern(s) (e.g., `"*.ts"`). |
| `exclude` | `string \| string[]` | Glob patterns to exclude. |
| `includeHidden` | `boolean` | Include dotfiles. |
| `followSymlinks` | `boolean` | Follow symbolic links. |
| `maxResults` | `integer` | Result cap (capped at config `maxGlobResults`). |

## Security model

The plugin enforces access control at the **root directory level**. When
the OpenClaw `workspaceOnly` filesystem policy is active, the `root`
parameter must resolve to a path within the workspace. Symlinks inside an
allowed root are followed without additional checking — operators who
enable `followSymlinks` are responsible for the symlink targets within
their workspace.

## Verification

```bash
npm run lint
npm run typecheck
npm test
npm run coverage
```
