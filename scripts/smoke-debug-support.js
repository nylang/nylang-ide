#!/usr/bin/env node
/** Contract smoke for V2/V3 debug support; no VS Code host required. */
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

const config = {};
let extensions = [];
let warningChoice;
const errors = [];
const infos = [];
const vscodeMock = {
  extensions: { getExtension: (id) => extensions.includes(id) ? { id } : undefined },
  ProgressLocation: { Notification: 1 },
  TaskRevealKind: { Silent: 1 },
  TaskPanelKind: { Shared: 1 },
  window: {
    activeTextEditor: undefined,
    showWarningMessage: async () => warningChoice,
    showErrorMessage: (message) => errors.push(String(message)),
    showInformationMessage: (message) => infos.push(String(message)),
  },
  workspace: {
    workspaceFolders: [],
    getWorkspaceFolder(uri) {
      return this.workspaceFolders.find((folder) => {
        const relative = path.relative(folder.uri.fsPath, uri.fsPath);
        return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
      });
    },
    getConfiguration: () => ({ get: (key) => config[key] || "" }),
  },
  tasks: {},
  commands: {},
  debug: {},
  Task: function () {},
  ShellExecution: function () {},
  ProcessExecution: function (command, args, options) { Object.assign(this, { command, args, options }); },
  CustomExecution: function (callback) { this.callback = callback; },
  EventEmitter: function () { this.event = () => {}; this.fire = () => {}; },
};

const originalRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === "vscode") return vscodeMock;
  return originalRequire.apply(this, arguments);
};

const support = require(path.join(__dirname, "..", "debugSupport.js"));
const t = support._test;
assert.ok(t, "debugSupport._test export required");

assert.strictEqual(t.isNyDebugEntry("/w/main.ny"), true);
assert.strictEqual(t.isNyDebugEntry("/w/face.ni"), false);
assert.strictEqual(t.isNyDebugEntry("/w/readme.md"), false);

const out = t.debugOutPath("/repo", "/repo/pkg/main.ny");
assert.ok(out.includes(`${path.sep}.nyra-debug${path.sep}`), out);
assert.ok(out.endsWith(path.join("pkg", "main.ny" + t.exeSuffix())), out);
assert.notStrictEqual(t.debugOutPath("/repo", "/repo/other/main.ny"), out);

const lldb = t.makeLaunchConfiguration("/repo/.nyra-debug/main", "/repo", { kind: "lldb" }, {
  name: "Nyra: debug current file",
});
assert.strictEqual(lldb.type, "lldb");
assert.strictEqual(lldb.program, "/repo/.nyra-debug/main");
assert.deepStrictEqual(lldb.sourceLanguages, ["c"]);
assert.strictEqual(lldb.stopOnEntry, false);

const cpp = t.makeLaunchConfiguration("/repo/.nyra-debug/main", "/repo", { kind: "cppdbg", miMode: "lldb" }, {});
assert.strictEqual(cpp.type, "cppdbg");
assert.strictEqual(cpp.MIMode, "lldb");
assert.strictEqual(cpp.stopAtEntry, false);

const debugArgs = t.buildArgs("/repo/a file; $(x).ny", "/repo/.nyra-debug/a file; $(x).ny.bin", "debug");
assert.deepStrictEqual(debugArgs.slice(0, 5), ["build", "/repo/a file; $(x).ny", "--link", "-o", "/repo/.nyra-debug/a file; $(x).ny.bin"]);
assert.ok(debugArgs.includes("-g"));
assert.ok(debugArgs.includes("-O0"));
const releaseArgs = t.buildArgs("/repo/a file.ny", "/repo/.nyra-debug/a file.ny.bin", "release");
assert.ok(releaseArgs.includes("--no-assert"));
assert.ok(releaseArgs.includes("-O2"));
assert.ok(releaseArgs.includes("-g0"));

const payload = t.nyraDebugWorkspacePayload();
assert.ok(payload.tasks.some((x) => x.label === "nyra: build debug (current file)"));
assert.strictEqual(payload.configurations[0].preLaunchTask, "nyra: build debug (current file)");
assert.ok(payload.configurations.some((x) => x.name === "Nyra: debug (CodeLLDB)"));
assert.ok(payload.configurations.some((x) => x.name === "Nyra: debug (C/C++ extension)"));
assert.ok(payload.configurations[0].program.includes("${relativeFile}"));
if (process.platform === "darwin") {
  const execution = t.makeBuildTaskExecution("/repo/bin/nyrac", debugArgs, out, "/repo");
  assert.strictEqual(typeof execution.callback, "function");
}

const mergedLaunch = t.mergeLaunchConfigs(
  { version: "0.2.0", configurations: [{ name: "Other", type: "node", request: "launch" }] },
  payload.configurations
);
assert.strictEqual(mergedLaunch.configurations.length, 3);
assert.ok(mergedLaunch.configurations.some((c) => c.name === "Other"));
const mergedTasks = t.mergeTasks(
  { version: "2.0.0", tasks: [{ label: "keep-me", type: "shell" }] }, payload.tasks
);
assert.strictEqual(mergedTasks.tasks.length, payload.tasks.length + 1);

extensions = ["vadimcn.vscode-lldb"];
assert.strictEqual(t.pickNativeDebugBackend("auto").kind, "lldb");
assert.strictEqual(t.pickNativeDebugBackend("lldb").kind, "lldb");
extensions = ["ms-vscode.cpptools"];
assert.strictEqual(t.pickNativeDebugBackend("auto").kind, "cppdbg");
assert.strictEqual(t.pickNativeDebugBackend("cppdbg").kind, "cppdbg");
extensions = [];
assert.strictEqual(t.pickNativeDebugBackend("lldb").kind, "none");
assert.match(t.pickNativeDebugBackend("lldb").reason, /vadimcn\.vscode-lldb/);
assert.strictEqual(t.pickNativeDebugBackend("cppdbg").kind, "none");
assert.match(t.pickNativeDebugBackend("cppdbg").reason, /ms-vscode\.cpptools/);

async function workspaceConfigSmoke() {
  const argvMarker = "space; $(not-a-shell-command)";
  const processResult = await t.runBuild(
    process.execPath,
    ["-e", "process.stdout.write(process.argv[1])", argvMarker],
    process.cwd()
  );
  assert.strictEqual(processResult.ok, true, processResult.message);
  assert.strictEqual(processResult.stdout, argvMarker);

  const processFailure = await t.runBuild(
    process.execPath,
    ["-e", "process.stderr.write('expected failure'); process.exit(7)"],
    process.cwd()
  );
  assert.strictEqual(processFailure.ok, false);
  assert.match(processFailure.message, /expected failure/);

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "nyra-vscode-config-"));
  const first = path.join(temp, "first root");
  const second = path.join(temp, "second root");
  fs.mkdirSync(first, { recursive: true });
  fs.mkdirSync(second, { recursive: true });
  const secondVscode = path.join(second, ".vscode");
  const tasksPath = path.join(secondVscode, "tasks.json");
  const launchPath = path.join(secondVscode, "launch.json");
  vscodeMock.workspace.workspaceFolders = [
    { uri: { fsPath: first }, name: "first" },
    { uri: { fsPath: second }, name: "second" },
  ];
  vscodeMock.window.activeTextEditor = { document: { uri: { fsPath: path.join(first, "src/main.ny") } } };
  warningChoice = undefined;
  await t.writeDebugWorkspaceFiles();
  assert.ok(fs.existsSync(path.join(first, ".vscode", "tasks.json")), "fresh workspace should initialize without a prompt");

  vscodeMock.window.activeTextEditor = { document: { uri: { fsPath: path.join(second, "src/main.ny") } } };
  fs.mkdirSync(secondVscode, { recursive: true });
  const cancelledTasks = JSON.stringify({ version: "2.0.0", tasks: [{ label: "untouched", type: "shell" }] });
  fs.writeFileSync(tasksPath, cancelledTasks);
  warningChoice = "Cancel";
  await t.writeDebugWorkspaceFiles();
  assert.strictEqual(fs.readFileSync(tasksPath, "utf8"), cancelledTasks, "cancel must leave existing files unchanged");
  assert.strictEqual(fs.existsSync(launchPath), false, "cancel must not create the missing companion file");

  fs.writeFileSync(tasksPath, JSON.stringify({ version: "2.0.0", tasks: [{ label: "keep-task", type: "shell" }] }));
  fs.writeFileSync(launchPath, JSON.stringify({ version: "0.2.0", configurations: [{ name: "Keep launch", type: "node", request: "launch" }] }));
  warningChoice = "Merge Nyra entries";
  await t.writeDebugWorkspaceFiles();
  const mergedTasksOnDisk = JSON.parse(fs.readFileSync(tasksPath, "utf8"));
  const mergedLaunchOnDisk = JSON.parse(fs.readFileSync(launchPath, "utf8"));
  assert.ok(mergedTasksOnDisk.tasks.some((task) => task.label === "keep-task"));
  assert.ok(mergedTasksOnDisk.tasks.some((task) => task.label === "nyra: build debug (current file)"));
  assert.ok(mergedLaunchOnDisk.configurations.some((entry) => entry.name === "Keep launch"));

  const tasksBeforeBadJson = fs.readFileSync(tasksPath, "utf8");
  fs.writeFileSync(launchPath, "{invalid json");
  const launchBeforeBadJson = fs.readFileSync(launchPath, "utf8");
  await t.writeDebugWorkspaceFiles();
  assert.strictEqual(fs.readFileSync(tasksPath, "utf8"), tasksBeforeBadJson);
  assert.strictEqual(fs.readFileSync(launchPath, "utf8"), launchBeforeBadJson);
  assert.match(errors[errors.length - 1], /not valid JSON/);

  fs.writeFileSync(launchPath, JSON.stringify({ version: "0.2.0", configurations: [] }));
  const tasksBeforeCancel = fs.readFileSync(tasksPath, "utf8");
  const launchBeforeCancel = fs.readFileSync(launchPath, "utf8");
  warningChoice = "Cancel";
  await t.writeDebugWorkspaceFiles();
  assert.strictEqual(fs.readFileSync(tasksPath, "utf8"), tasksBeforeCancel);
  assert.strictEqual(fs.readFileSync(launchPath, "utf8"), launchBeforeCancel);

  warningChoice = "Merge Nyra entries";
  const originalRename = fs.renameSync;
  let failedOnce = false;
  fs.renameSync = function (from, to) {
    if (!failedOnce && path.basename(from).startsWith(".launch.json.") && from.endsWith(".tmp")) {
      failedOnce = true;
      throw new Error("injected second-file rename failure");
    }
    return originalRename.apply(this, arguments);
  };
  try {
    await t.writeDebugWorkspaceFiles();
  } finally {
    fs.renameSync = originalRename;
  }
  assert.strictEqual(failedOnce, true);
  assert.strictEqual(fs.readFileSync(tasksPath, "utf8"), tasksBeforeCancel, "failed pair write must roll back tasks.json");
  assert.strictEqual(fs.readFileSync(launchPath, "utf8"), launchBeforeCancel, "failed pair write must preserve launch.json");
  assert.match(errors[errors.length - 1], /Existing files were restored/);

  fs.rmSync(temp, { recursive: true, force: true });
}

workspaceConfigSmoke().then(() => {
  Module.prototype.require = originalRequire;
  console.log("OK  .ny entry + argv-safe debug/release profiles");
  console.log("OK  adapter selection and actionable missing-adapter errors");
  console.log("OK  multi-root config targeting, cancel, merge preservation, malformed JSON");
  console.log("OK  two-file rollback after injected write failure");
}).catch((error) => {
  Module.prototype.require = originalRequire;
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
