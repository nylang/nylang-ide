const fs = require("fs");
const vscode = require("vscode");
const {
  LanguageClient,
  TransportKind,
} = require("vscode-languageclient/node");
const { registerDebugSupport } = require("./debugSupport");
const { resolveAnalyzerPath: resolveAnalyzerBinary } = require("./analyzerPath");
const { resolveWindowSdkPath, hasSelectedSdk } = require("./windowToolchain");
const { registerSdkSupport } = require("./sdkSupport");
const { registerPackageCreation } = require("./packageCreation");

let client;
let startPromise;
let output;
let lastStartFailure = "";
let selectedAnalyzerPath = "";
let stateListener;
let observedSdkSetting = "";
let observedAnalyzerSetting = "";
let sdkSupport;
let toolchainRefresh = Promise.resolve();

function refreshToolchain(context, refreshSelection = false, forceRestart = false) {
  toolchainRefresh = toolchainRefresh.catch(() => {}).then(async () => {
    resolveWindowSdkPath(vscode, refreshSelection);
    const nextPath = resolveAnalyzerPath();
    if (nextPath !== selectedAnalyzerPath || !client || forceRestart) {
      await stopClient();
      await startClient(context);
    }
    if (sdkSupport) sdkSupport.updateStatus();
  });
  return toolchainRefresh;
}

function log(message) {
  if (output) output.appendLine(`[${new Date().toISOString()}] ${message}`);
}

function resolveSdkPath() {
  return resolveWindowSdkPath(vscode, false);
}

function resolveAnalyzerPath() {
  const cfg = vscode.workspace.getConfiguration("nyra");
  return resolveAnalyzerBinary({
    analyzerPath: cfg.get("analyzerPath") || "",
    sdkPath: resolveSdkPath(),
    platform: process.platform,
  });
}

function currentSetting(key) {
  return (vscode.workspace.getConfiguration("nyra").get(key) || "").trim();
}

async function startClient(context) {
  if (client || startPromise) return startPromise;
  const sdkPath = resolveSdkPath();
  const analyzerPath = resolveAnalyzerPath();
  selectedAnalyzerPath = analyzerPath;
  if (!analyzerPath) {
    const message = "Nyra SDK not found. Select an existing SDK or install the official SDK to enable analysis and debugging.";
    log(message);
    if (lastStartFailure !== message) void sdkSupport.offerSetup(message);
    lastStartFailure = message;
    return;
  }
  if (!fs.existsSync(analyzerPath)) {
    const message = `Nyra analyzer not found: ${analyzerPath}. Select or install an SDK, or correct nyra.analyzerPath for a custom build.`;
    log(message);
    if (lastStartFailure !== message) void sdkSupport.offerSetup(message);
    lastStartFailure = message;
    return;
  }
  lastStartFailure = "";
  log(`Starting analyzer; sdk=${sdkPath || "(unset)"}; executable=${analyzerPath}`);

  const configuredArguments = vscode.workspace.getConfiguration("nyra").get("analyzerArguments") || [];
  if (!Array.isArray(configuredArguments) || configuredArguments.some(value => typeof value !== "string")) {
    throw new Error("nyra.analyzerArguments must be an array of strings.");
  }
  const serverOptions = {
    command: analyzerPath,
    args: [...configuredArguments],
    transport: TransportKind.stdio,
  };

  const clientOptions = {
    documentSelector: [{ scheme: "file", language: "nyra" }],
    outputChannel: output,
  };

  const nextClient = new LanguageClient(
    "nyraAnalyzer",
    "Nyra Analyzer",
    serverOptions,
    clientOptions
  );
  client = nextClient;
  if (nextClient.onDidChangeState) {
    stateListener = nextClient.onDidChangeState((event) => {
      const stateName = (state) => {
        if (state === 1) return "stopped";
        if (state === 2) return "running";
        if (state === 3) return "starting";
        return String(state);
      };
      log(`Analyzer state: ${stateName(event.oldState)} -> ${stateName(event.newState)}.`);
    });
  }
  startPromise = nextClient.start().then(() => {
    log("Analyzer client started.");
  }).catch(async (error) => {
    const message = `Nyra analyzer failed to start (${analyzerPath}): ${error && error.message ? error.message : error}`;
    log(message);
    if (stateListener) stateListener.dispose();
    stateListener = undefined;
    if (client === nextClient) client = undefined;
    lastStartFailure = message;
    try { await nextClient.stop(); } catch (_stopError) { /* already stopped */ }
    vscode.window.showErrorMessage(`${message}. See the Nyra output channel for details.`);
  }).finally(() => {
    startPromise = undefined;
  });
  return startPromise;
}

async function stopClient() {
  // LanguageClient.start() is asynchronous. Wait for its single in-flight
  // attempt before stopping, otherwise a settings change can race startup.
  const pendingStart = startPromise;
  if (pendingStart) await pendingStart;
  if (!client) {
    return;
  }
  const c = client;
  client = undefined;
  if (stateListener) stateListener.dispose();
  stateListener = undefined;
  try {
    await c.stop();
    log("Analyzer client stopped.");
  } catch (error) {
    log(`Analyzer stop error: ${error && error.message ? error.message : error}`);
  }
}

async function activate(context) {
  output = vscode.window.createOutputChannel("Nyra");
  context.subscriptions.push(output);
  observedSdkSetting = currentSetting("sdkPath");
  observedAnalyzerSetting = currentSetting("analyzerPath");
  sdkSupport = registerSdkSupport(vscode, context, { log, refresh: () => refreshToolchain(context) });
  registerDebugSupport(context);
  registerPackageCreation(vscode, context, { log });

  context.subscriptions.push(
    vscode.commands.registerCommand("nyra.showOutput", () => output.show(true))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("nyra.restartAnalyzer", async () => {
      await stopClient();
      await startClient(context);
      if (client) vscode.window.showInformationMessage("Nyra analyzer restarted.");
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (ev) => {
      const sdkSetting = currentSetting("sdkPath");
      const analyzerSetting = currentSetting("analyzerPath");
      const sdkChanged = ev.affectsConfiguration("nyra.sdkPath") && sdkSetting !== observedSdkSetting;
      const analyzerChanged = ev.affectsConfiguration("nyra.analyzerPath") && analyzerSetting !== observedAnalyzerSetting;
      const argumentsChanged = ev.affectsConfiguration("nyra.analyzerArguments");
      if (sdkChanged || analyzerChanged || argumentsChanged) {
        observedSdkSetting = sdkSetting;
        observedAnalyzerSetting = analyzerSetting;
        await refreshToolchain(context, sdkChanged, argumentsChanged);
      }
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(async (event) => {
      const added = (event.added || []).map((folder) => folder.uri.fsPath);
      const removed = (event.removed || []).map((folder) => folder.uri.fsPath);
      log(`Workspace folders changed; added=[${added.join(", ")}], removed=[${removed.join(", ")}].`);
      if (!hasSelectedSdk()) resolveWindowSdkPath(vscode, true);
      const nextPath = resolveAnalyzerPath();
      if (!client && nextPath) {
        log(`Starting analyzer after workspace folders became available: ${nextPath}.`);
        await startClient(context);
      } else if (nextPath !== selectedAnalyzerPath) {
        log(`Workspace selection keeps the window toolchain stable: ${selectedAnalyzerPath || "(unresolved)"}.`);
      } else {
        log(`Window toolchain remains ${selectedAnalyzerPath || "(unresolved)"}; language client handles folder updates.`);
      }
    })
  );

  await startClient(context);
}

async function deactivate() {
  await stopClient();
}

module.exports = {
  activate,
  deactivate,
};
