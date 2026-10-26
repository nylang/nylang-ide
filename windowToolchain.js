"use strict";

const { resolveSdkPath: resolveSdkRoot } = require("./analyzerPath");

let selectedSdkPath;

/**
 * Choose one SDK for this extension host. Explicit settings refresh the choice;
 * otherwise the first workspace folder is captured once for the window.
 */
function resolveWindowSdkPath(vscode, refresh) {
  const configured = (vscode.workspace.getConfiguration("nyra").get("sdkPath") || "").trim();
  if (configured) {
    selectedSdkPath = resolveSdkRoot({ sdkPath: configured });
    return selectedSdkPath;
  }
  if (selectedSdkPath === undefined || refresh) {
    selectedSdkPath = resolveSdkRoot({
      workspaceFolders: vscode.workspace.workspaceFolders || [],
    });
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
};
