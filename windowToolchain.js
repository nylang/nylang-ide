"use strict";

const { resolveSdkPath: resolveSdkRoot } = require("./analyzerPath");
const { discoverSdks, toolPath } = require("./sdkDiscovery");
const fs = require("fs");

let selectedSdkPath;
let managedRoot;

function configureSdkSearch(root) { managedRoot = root; }

/**
 * Choose one SDK for this extension host. Explicit settings refresh the choice;
 * otherwise the first usable discovered SDK is captured once for the window.
 */
function resolveWindowSdkPath(vscode, refresh) {
  const configured = (vscode.workspace.getConfiguration("nyra").get("sdkPath") || "").trim();
  if (configured) {
    selectedSdkPath = resolveSdkRoot({ sdkPath: configured });
    return selectedSdkPath;
  }
  if (selectedSdkPath === undefined || refresh) {
    const folders = vscode.workspace.workspaceFolders || [];
    const first = resolveSdkRoot({ workspaceFolders: folders });
    // Preserve development checkouts and explicit tool overrides while adding
    // packaged SDK discovery for ordinary application workspaces.
    selectedSdkPath = first && fs.existsSync(toolPath(first, "nyra-analyzer")) ? first
      : (discoverSdks({ workspaceFolders: folders, managedRoot })[0] || {}).root || "";
  }
  return selectedSdkPath || "";
}

function hasSelectedSdk() {
  return !!selectedSdkPath;
}

function resetWindowSdkPath() {
  selectedSdkPath = undefined;
}

module.exports = {
  resolveWindowSdkPath,
  hasSelectedSdk,
  _reset: resetWindowSdkPath,
  configureSdkSearch,
};
