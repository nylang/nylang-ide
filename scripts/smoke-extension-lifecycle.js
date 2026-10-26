#!/usr/bin/env node
/** Analyzer lifecycle smoke with VS Code and language-client API doubles. */
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "nyra-vscode-lifecycle-"));
const settings = { sdkPath: "", analyzerPath: "" };
const outputLines = [];
const warnings = [];
const infos = [];
const registeredCommands = new Map();
const configListeners = [];
const workspaceListeners = [];
const clients = [];

function makeFolder(root) {
  return { name: path.basename(root), uri: { fsPath: root } };
}
function makeSdk(name) {
  const root = path.join(temp, name);
  fs.mkdirSync(path.join(root, "bin"), { recursive: true });
  fs.writeFileSync(path.join(root, "bin", "nyra-analyzer"), "fake executable");
  return root;
}

const sdkA = makeSdk("sdk-a");
const sdkB = makeSdk("sdk-b");
const sdkC = makeSdk("sdk-c");
const missingAnalyzer = path.join(temp, "missing", "nyra-analyzer");
const vscodeMock = {
  StatusBarAlignment: { Left: 1 },
  workspace: {
    workspaceFolders: [makeFolder(sdkA), makeFolder(sdkB)],
    getConfiguration: () => ({ get: (key) => settings[key] || "" }),
    onDidChangeConfiguration(listener) {
      configListeners.push(listener);
      return { dispose() {} };
    },
    onDidChangeWorkspaceFolders(listener) {
      workspaceListeners.push(listener);
      return { dispose() {} };
    },
  },
  window: {
    createStatusBarItem: () => ({ show() {}, dispose() {} }),
    createOutputChannel: () => ({ appendLine: (line) => outputLines.push(line), show() {} }),
    showWarningMessage: (message) => warnings.push(String(message)),
    showErrorMessage: (message) => { throw new Error(`Unexpected error notification: ${message}`); },
    showInformationMessage: (message) => infos.push(String(message)),
  },
  commands: {
    registerCommand(name, handler) {
      registeredCommands.set(name, handler);
      return { dispose() { registeredCommands.delete(name); } };
    },
  },
};

class MockLanguageClient {
  constructor(id, name, serverOptions, clientOptions) {
    this.id = id;
    this.name = name;
    this.serverOptions = serverOptions;
    this.clientOptions = clientOptions;
    this.stateHandlers = [];
    this.stops = 0;
    clients.push(this);
  }
  onDidChangeState(handler) {
    this.stateHandlers.push(handler);
    return { dispose: () => { this.stateHandlers = this.stateHandlers.filter((h) => h !== handler); } };
  }
  fireState(oldState, newState) {
    for (const handler of this.stateHandlers) handler({ oldState, newState });
  }
  async start() {
    this.fireState(1, 3);
    this.fireState(3, 2);
  }
  async stop() {
    this.stops += 1;
    this.fireState(2, 1);
  }
}

const originalRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === "vscode") return vscodeMock;
  if (id === "vscode-languageclient/node") {
    return { LanguageClient: MockLanguageClient, TransportKind: { stdio: 1 } };
  }
  if (id === "./debugSupport") return { registerDebugSupport() {} };
  return originalRequire.apply(this, arguments);
};

const extension = require(path.join(__dirname, "..", "extension.js"));
const context = { subscriptions: [] };
const configChange = (key) => ({ affectsConfiguration: (candidate) => candidate === key });

async function run() {
  try {
    await extension.activate(context);
    assert.strictEqual(clients.length, 1);
    assert.strictEqual(clients[0].serverOptions.command, path.join(sdkA, "bin", "nyra-analyzer"));
    assert.strictEqual(clients[0].clientOptions.documentSelector[0].language, "nyra");
    assert.strictEqual(clients[0].clientOptions.workspaceFolder, undefined, "LanguageClient must track all workspace folders");
    assert.match(outputLines.join("\n"), /Analyzer state: starting -> running/);

    // Adding another root leaves the window's first-folder SDK stable. The
    // language client receives workspace-folder changes without a process restart.
    vscodeMock.workspace.workspaceFolders.push(makeFolder(sdkC));
    await workspaceListeners[0]({ added: [makeFolder(sdkC)], removed: [] });
    assert.strictEqual(clients.length, 1);

    // The window keeps its initial SDK choice when workspace roots are removed;
    // the language client itself handles didChangeWorkspaceFolders.
    vscodeMock.workspace.workspaceFolders.shift();
    await workspaceListeners[0]({ added: [], removed: [makeFolder(sdkA)] });
    assert.strictEqual(clients.length, 1);
    assert.strictEqual(outputLines.some((line) => line.includes("language client handles folder updates")), true);

    // An explicit SDK change restarts the client; an analyzer override keeps
    // its resolved path stable across later SDK edits.
    settings.sdkPath = sdkB;
    await configListeners[0](configChange("nyra.sdkPath"));
    assert.strictEqual(clients.length, 2);
    assert.strictEqual(clients[1].serverOptions.command, path.join(sdkB, "bin", "nyra-analyzer"));
    const customAnalyzer = path.join(sdkC, "bin", "nyra-analyzer");
    settings.analyzerPath = customAnalyzer;
    await configListeners[0](configChange("nyra.analyzerPath"));
    assert.strictEqual(clients.length, 3);
    assert.strictEqual(clients[2].serverOptions.command, customAnalyzer);
    settings.sdkPath = sdkA;
    await configListeners[0](configChange("nyra.sdkPath"));
    assert.strictEqual(clients.length, 3);

    await registeredCommands.get("nyra.restartAnalyzer")();
    assert.strictEqual(clients.length, 4);
    assert.strictEqual(clients[2].stops, 1);
    assert.ok(infos.some((message) => /restarted/i.test(message)));

    settings.analyzerPath = missingAnalyzer;
    await configListeners[0](configChange("nyra.analyzerPath"));
    await configListeners[0](configChange("nyra.analyzerPath"));
    assert.strictEqual(clients.length, 4, "missing binary must not spawn a client");
    assert.strictEqual(warnings.filter((message) => message.includes(missingAnalyzer)).length, 1);

    settings.analyzerPath = "";
    await configListeners[0](configChange("nyra.analyzerPath"));
    assert.strictEqual(clients.length, 5);
    assert.strictEqual(clients[4].serverOptions.command, path.join(sdkA, "bin", "nyra-analyzer"));

    await extension.deactivate();
    assert.strictEqual(clients[4].stops, 1, "deactivation must stop the final client");
    assert.match(outputLines.join("\n"), /Analyzer client stopped/);
    console.log("smoke-extension-lifecycle: ok (startup, workspace selection, settings, retry, restart, shutdown)");
  } finally {
    Module.prototype.require = originalRequire;
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
