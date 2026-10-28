# Changelog

## 0.24.8

- Add native Create Package and Initialize Package commands and folder actions.
- Preview app/library creation and optional workspace registration through SDK 1.0.4 nyra.
- Add packageManagerPath, cooperative cancellation and actionable old/missing SDK errors.
- Open or add created packages using the existing window/analyzer lifecycle.

## 0.24.7

- Discover installed SDKs from workspace roots, NYRA_SDK, PATH and known user
  installation directories, including compiler symlinks on PATH.
- Add Nyra: Select SDK, Nyra: Install SDK and a selected-SDK status-bar entry.
- Offer selection and installation when the SDK or analyzer cannot be found.
- Download the official stable SDK with cancellable progress, SHA-256 checks,
  staged extraction and cleanup; preserve existing installation directories.
- Resolve compiler/analyzer tools from official host-specific SDK layouts and
  compiler checkouts while keeping one toolchain selected per VS Code window.
- Use the blue folded N extension artwork and bundle the Nyra (Seti) file-icon
  theme with dedicated NY, NI and NK glyphs, source provenance and licenses.

## 0.24.0

- Provide Nyra syntax, analyzer integration, themes and native debug support.
