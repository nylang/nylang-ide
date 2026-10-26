"use strict";

const path = require("path");
const { toolPath } = require("./sdkDiscovery");

/**
 * Default language-server executable name for the extension host.
 * The default is always the Nyra product binary; explicit overrides are for
 * custom Nyra builds.
 */
function defaultAnalyzerExeName(platform) {
  const p = platform || process.platform;
  return p === "win32" ? "nyra-analyzer.exe" : "nyra-analyzer";
}

/**
 * Select one SDK for the VS Code window. Active-editor changes never affect it.
 * @param {{ sdkPath?: string, workspaceFolders?: Array<{uri?: {fsPath?: string}}> }} opts
 */
function resolveSdkPath(opts) {
  const configured = ((opts && opts.sdkPath) || "").trim();
  if (configured) return path.resolve(configured);
  const folders = (opts && opts.workspaceFolders) || [];
  const first = folders[0] && folders[0].uri && folders[0].uri.fsPath;
  return first ? path.resolve(first) : "";
}

/**
 * Resolve the LSP binary the extension will spawn over stdio.
 *
 * @param {{ analyzerPath?: string, sdkPath?: string, platform?: string }} opts
 * @returns {string} absolute or override path; empty if sdkPath is missing
 */
function resolveAnalyzerPath(opts) {
  const override = ((opts && opts.analyzerPath) || "").trim();
  if (override) {
    return path.resolve(override);
  }
  const sdkPath = ((opts && opts.sdkPath) || "").trim();
  if (!sdkPath) {
    return "";
  }
  return toolPath(sdkPath, "nyra-analyzer", opts && opts.platform, opts && opts.arch);
}

module.exports = {
  defaultAnalyzerExeName,
  resolveSdkPath,
  resolveAnalyzerPath,
};
