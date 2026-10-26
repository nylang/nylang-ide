# Nyra VS Code extension

Provides Nyra syntax highlighting, themes, LSP features, and native debugging
for `.ny` and `.ni` files. Semantic features come from the Nyra-built
`nyra-analyzer`; debugging builds with `nyrac` and delegates to CodeLLDB or
Microsoft C/C++.

## Features

- One `nyra` language id and grammar for `.ny` and `.ni`.
- Nyra Slate Dark and Nyra Mist Light themes.
- Analyzer diagnostics, hover, definition, and completion over stdio.
- **Nyra: Restart Analyzer** and **Nyra: Show Output** commands.
- **Nyra: Debug Current File** saves the current `.ny`, builds with
  argument-vector options, creates a source-relative binary under
  `.nyra-debug/`, generates a dSYM on macOS, and starts the selected debugger.
- **Nyra: Initialize Debug Workspace** writes or merges build tasks and native
  launch configurations for the active workspace folder.

## Prerequisites

Install a Nyra SDK containing `nyrac` and `nyra-analyzer`. The compiler and
analyzer are separate products; this extension repository does not contain
their source code.

Set `nyra.sdkPath` to the SDK/repository root, or open a workspace whose first
folder is that root. The extension uses one selected SDK for the whole VS Code
window; changing the active editor does not switch toolchains. Defaults are
`<sdkPath>/bin/nyra-analyzer` and `<sdkPath>/bin/nyrac`.

For debugging, install either [CodeLLDB](https://marketplace.visualstudio.com/items?itemName=vadimcn.vscode-lldb)
or [Microsoft C/C++](https://marketplace.visualstudio.com/items?itemName=ms-vscode.cpptools).
No debugger extension is installed or managed by Nyra.

## Local checks

```bash
npm ci
npm test
```

The VS Code Development Host can be started by opening this repository and
pressing F5. Open a `.ny` or `.ni` file to activate the analyzer. To check
debugging, open a Nyra project, install a native adapter, and set a source breakpoint before choosing **Nyra: Debug
Current File**.

## Settings

| Setting | Default | Meaning |
|---------|---------|---------|
| `nyra.sdkPath` | First workspace folder | SDK root; explicit value takes precedence and is held for the window |
| `nyra.analyzerPath` | `<sdk>/bin/nyra-analyzer` | Analyzer executable override |
| `nyra.compilerPath` | `<sdk>/bin/nyrac` | Compiler executable override |
| `nyra.debugAdapter` | `auto` | `auto`, `lldb`, or `cppdbg` |

Generated debug binaries keep the entry's relative path, so equal basenames in
different packages do not collide. macOS uses `dsymutil` before LLDB starts.
Workspace initialization preserves unrelated task and launch entries. Cancel
leaves existing files unchanged; malformed JSON is reported without rewriting
either file, and a failed two-file update rolls back the prior contents.

## Scope

The extension does not provide a custom DAP, parser, or compiler frontend. Test
explorer/CodeLens features, `.nk` mode, marketplace publishing, and signing are
tracked separately.

## License

MIT; see [LICENSE](LICENSE). Dependency licenses remain their own.

This extension has an independent Git history. In the compiler workspace it is
mounted as the `ide/vscode` submodule. The current origin is a local repository
until a GitHub remote is assigned. Generated VSIX files and `node_modules/`
are excluded from Git.
