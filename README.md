# Search Files Tools

OpenClaw plugin for searching and globbing files from agents.

## Features

- `files_search`: search file contents under an absolute root directory.
- `files_glob`: list files matching glob patterns under an absolute root directory.
- Shared root validation and OpenClaw filesystem policy enforcement.
- `rg` preferred for search, with `grep` fallback.

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

The plugin exposes four operational caps under
`plugins.entries.search-files-tools.config`:

- `timeoutMs` default `20000`
- `maxCandidateFiles` default `20000`
- `maxSearchResults` default `2000`
- `maxGlobResults` default `5000`

## Tools

### `files_search`

Search files below an absolute `root` path. Search results return root-relative
POSIX paths and support structured options such as `patterns`,
`includeGlobs`, `excludeGlobs`, `ignoreCase`, `fixedStrings`, and
`beforeContext` / `afterContext`.

### `files_glob`

List files below an absolute `root` path that match one or more glob
`patterns`. Results return root-relative POSIX paths.

## Verification

```bash
npm run lint
npm run typecheck
npm test
```
