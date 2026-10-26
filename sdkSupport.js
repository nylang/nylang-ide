"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { discoverSdks, inspectSdk, hostKey } = require("./sdkDiscovery");
const { configureSdkSearch, resolveWindowSdkPath } = require("./windowToolchain");
const { fetchRelease, selectRelease, installSdk } = require("./sdkInstaller");

function registerSdkSupport(vscode, context, { log, refresh }) {
  const managedRoot = context.globalStorageUri ? path.join(context.globalStorageUri.fsPath, "sdks") : path.join(os.homedir(), ".nyra", "sdks");
  configureSdkSearch(managedRoot);
  let installing;
  let disposed = false;
  let installController;
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 20);
  status.command = "nyra.selectSdk";
  context.subscriptions.push(status, { dispose() { disposed = true; if (installController) installController.abort(); } });

  function updateStatus() {
    const root = resolveWindowSdkPath(vscode, false);
    const sdk = inspectSdk(root);
    status.text = sdk ? `Nyra ${sdk.version === "development" ? "SDK" : sdk.version}` : "$(warning) Nyra: Select SDK";
    status.tooltip = root ? `Nyra SDK: ${root}\nClick to select or install an SDK.` : "Nyra SDK not found. Click to locate or install one.";
    status.show();
  }

  async function useSdk(root) {
    const sdk = inspectSdk(root);
    if (!sdk) throw new Error("Select an SDK root containing both nyrac and nyra-analyzer for this platform.");
    const cfg = vscode.workspace.getConfiguration("nyra");
    const inspected = cfg.inspect("sdkPath");
    const target = inspected && inspected.workspaceValue !== undefined
      ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    await cfg.update("sdkPath", sdk.root, target);
    log(`Selected SDK ${sdk.version}: ${sdk.root}`);
    await refresh();
    updateStatus();
  }

  async function browseSdk() {
    const chosen = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true,
      canSelectMany: false, title: "Select Nyra SDK root", openLabel: "Use SDK" });
    if (chosen && chosen[0]) await useSdk(chosen[0].fsPath);
  }

  async function selectSdk() {
    const configured = resolveWindowSdkPath(vscode, false);
    const found = discoverSdks({ workspaceFolders: vscode.workspace.workspaceFolders || [], managedRoot });
    if (configured && inspectSdk(configured) && !found.some(s => s.root === configured)) found.unshift(inspectSdk(configured));
    const rows = found.map(sdk => ({ label: `Nyra ${sdk.version}`, description: sdk.root, sdk }));
    rows.push({ label: "Browse for SDK…", action: "browse" }, { label: "Install SDK…", action: "install" });
    const selected = await vscode.window.showQuickPick(rows, { title: "Select Nyra SDK", placeHolder: "Choose the SDK used by this VS Code window" });
    if (!selected) return;
    if (selected.sdk) await useSdk(selected.sdk.root);
    else if (selected.action === "browse") await browseSdk();
    else await install();
  }

  async function performInstall() {
    if (!hostKey()) throw new Error("No Nyra SDK is available for this extension-host platform.");
    installController = new AbortController();
    try {
      const root = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification,
        title: "Install Nyra SDK", cancellable: true }, async (progress, token) => {
        const cancellation = token.onCancellationRequested(() => installController.abort());
        try {
          progress.report({ message: "Finding the latest official SDK…" });
          const release = selectRelease(await fetchRelease(installController.signal), hostKey());
          if (process.platform === "darwin" && release.minimum_os_version) {
            const minimumKernel = Number(release.minimum_os_version.split(".")[0]) + 9;
            if (Number(os.release().split(".")[0]) < minimumKernel) throw new Error(`This SDK requires macOS ${release.minimum_os_version} or newer.`);
          }
          await fs.promises.mkdir(managedRoot, { recursive: true });
          const folders = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true,
            canSelectMany: false, defaultUri: vscode.Uri.file(managedRoot), openLabel: "Install Here",
            title: `Install Nyra ${release.version} (${Math.ceil(release.bytes / 1024 ** 2)} MB): choose a parent folder` });
          if (!folders || !folders[0] || token.isCancellationRequested) return undefined;
          let lastProgress = "";
          return installSdk(release, folders[0].fsPath, { signal: installController.signal, progress(message) {
            if (message !== lastProgress) { lastProgress = message; progress.report({ message }); }
          } });
        } finally { cancellation.dispose(); }
      });
      if (root && !disposed) {
        await useSdk(root);
        vscode.window.showInformationMessage("Nyra SDK installed and selected.");
      }
    } finally { installController = undefined; }
  }

  function install() {
    if (!installing) installing = performInstall().finally(() => { installing = undefined; });
    return installing;
  }

  async function reportError(action) {
    try { await action(); }
    catch (error) {
      if (disposed || error.name === "AbortError" || /cancelled/i.test(error.message)) return;
      log(`SDK setup failed: ${error.message || error}`);
      vscode.window.showErrorMessage(`Nyra SDK setup failed: ${error.message || error}`);
    }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("nyra.selectSdk", () => reportError(selectSdk)),
    vscode.commands.registerCommand("nyra.installSdk", () => reportError(install))
  );

  async function offerSetup(message) {
    const choice = await vscode.window.showWarningMessage(message, "Select SDK", "Install SDK", "Show Output");
    if (choice === "Select SDK") await reportError(selectSdk);
    else if (choice === "Install SDK") await reportError(install);
    else if (choice === "Show Output") await vscode.commands.executeCommand("nyra.showOutput");
  }

  updateStatus();
  return { offerSetup, updateStatus };
}

module.exports = { registerSdkSupport };
