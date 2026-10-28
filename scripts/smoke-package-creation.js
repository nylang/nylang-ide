#!/usr/bin/env node
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");
const { EventEmitter } = require("events");
const { spawnSync } = require("child_process");
const real = require("../packageCreation");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "nyra-creation-editor-"));
const executable = path.join(temporary, "manager with spaces");
fs.writeFileSync(executable, "fixture"); fs.chmodSync(executable, 0o755);
let state;
const calls = [];
function result(operation, target, status) {
  return { schema_version: 1, operation, status, package: { root: target, name: "sample", kind: "app", existing_source: false },
    files: [{ path: "package.yaml", action: status === "created" ? "created" : "create" }],
    workspace: { file: state.discovered || "", action: "none" }, errors: [] };
}
function fakeSpawn(file, args, options) {
  calls.push({ file, args, options });
  assert.strictEqual(options.shell, false);
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  const preview = args.includes("--dry-run");
  setTimeout(() => {
    if (state.oldTool) child.stdout.emit("data", Buffer.from("old manager help"));
    else {
      const value = result(args[0], args[1], preview ? "planned" : "created");
      if (state.schema) value.schema_version = state.schema;
      if (!preview && state.cancel) {
        assert.ok(fs.existsSync(options.env.NYRA_CREATE_CANCEL_FILE));
        state.cancelPath = options.env.NYRA_CREATE_CANCEL_FILE;
        value.status = "error"; value.errors.push({ code: "Cancelled", message: "rolled back", path: args[1] }); value.files[0].action = "rolled_back";
      }
      if (!preview && state.partial) {
        value.status = "error"; value.errors.push({ code: "IncompleteRollback", message: "changed file retained", path: args[1] }); value.files[0].action = "remaining";
      }
      child.stdout.emit("data", Buffer.from(JSON.stringify(value)));
    }
    child.emit("close", !preview && (state.cancel || state.partial) ? 1 : 0);
  }, !preview && state.cancel ? 10 : 0);
  return child;
}
const load = Module._load;
delete require.cache[require.resolve("../packageCreation")];
Module._load = function(request, parent, main) {
  if (request === "child_process") return { spawn: fakeSpawn };
  return load.call(this, request, parent, main);
};
const creation = require("../packageCreation");
Module._load = load;
function uri(file, scheme = "file") { return { fsPath: file, scheme, path: file, authority: "host" }; }
const handlers = new Map();
const settings = { packageManagerPath: executable, sdkPath: "" };
const vscode = {
  env: {}, Uri: { joinPath: (base, ...parts) => uri(path.join(base.fsPath, ...parts), base.scheme) },
  ProgressLocation: { Notification: 1 },
  workspace: {
    isTrusted: true, workspaceFolders: [], getConfiguration: () => ({ get: key => settings[key] }),
    updateWorkspaceFolders: (...args) => state.added.push(args),
  },
  commands: { registerCommand: (name, callback) => { handlers.set(name, callback); return { dispose() {} }; },
    executeCommand: async (...args) => { state.commands.push(args); } },
  window: {
    showInputBox: async () => state.inputs.shift(),
    showQuickPick: async (choices, options) => {
      if (options.title === "Package kind") return choices[state.library ? 1 : 0];
      if (options.title === "Nyra workspace registration") return choices[state.register ? 1 : 0];
      return state.folder === undefined ? undefined : choices[state.folder];
    },
    showOpenDialog: async () => state.dialogs.shift(),
    showInformationMessage: async (_message, ...options) => options[0] && options[0].modal ? state.approve : state.open,
    showErrorMessage: async (message) => { state.errors.push(message); return state.recover; },
    showTextDocument: async document => { state.opened.push(document); },
    withProgress: async (_options, callback) => {
      const token = { isCancellationRequested: false, onCancellationRequested(listener) {
        if (state.cancel) setTimeout(listener, 1);
        return { dispose() {} };
      } };
      return callback({}, token);
    },
  },
};
const context = { subscriptions: [] };
creation.registerPackageCreation(vscode, context, { log() {} });
function reset(overrides = {}) {
  calls.length = 0;
  state = { inputs: ["new directory; literal", "sample"], dialogs: [], approve: "Create Package", open: "Keep Current Window",
    errors: [], commands: [], added: [], opened: [], ...overrides };
  vscode.workspace.isTrusted = true;
  vscode.workspace.workspaceFolders = [];
  settings.packageManagerPath = executable;
}
async function run() {
  let passed = 0;
  reset(); await handlers.get("nyra.package.create")(uri(temporary));
  assert.strictEqual(calls.length, 3); assert.strictEqual(state.errors.length, 0);
  assert.ok(calls[2].args.includes(path.join(temporary, "new directory; literal")));
  assert.ok(calls[2].args.includes("--no-workspace")); assert.ok(!calls[2].args.includes("--dry-run"));
  assert.strictEqual(state.opened[0].fsPath, path.join(temporary, "new directory; literal/main.ny")); passed++;
  reset({ library: true, open: "Add to Workspace" }); await handlers.get("nyra.package.create")(uri(temporary));
  assert.ok(calls[2].args.includes("lib")); assert.strictEqual(state.added.length, 1); passed++;
  reset({ inputs: ["sample"] }); await handlers.get("nyra.package.initialize")(uri(temporary));
  assert.strictEqual(calls[2].args[0], "init"); passed++;
  reset(); vscode.workspace.isTrusted = false; await handlers.get("nyra.package.create")(uri(temporary));
  assert.strictEqual(calls.length, 0); assert.match(state.errors[0], /Trust/); passed++;
  reset({ inputs: [undefined] }); await handlers.get("nyra.package.create")(uri(temporary));
  assert.strictEqual(calls.length, 0); passed++;
  reset({ approve: undefined }); await handlers.get("nyra.package.create")(uri(temporary));
  assert.strictEqual(calls.length, 2); assert.ok(calls.every(call => call.args.includes("--dry-run"))); passed++;
  reset({ discovered: path.join(temporary, "workspace.yaml"), register: true }); await handlers.get("nyra.package.create")(uri(temporary));
  assert.ok(calls[2].args.includes("--workspace")); assert.ok(calls[2].args.includes(state.discovered)); passed++;
  reset({ oldTool: true, recover: "Select SDK" }); await handlers.get("nyra.package.create")(uri(temporary));
  assert.strictEqual(calls.length, 1); assert.strictEqual(state.commands[0][0], "nyra.selectSdk"); passed++;
  reset({ schema: 99 }); await handlers.get("nyra.package.create")(uri(temporary));
  assert.strictEqual(calls.length, 1); assert.match(state.errors[0], /unsupported/); passed++;
  reset(); settings.packageManagerPath = path.join(temporary, "missing override"); await handlers.get("nyra.package.create")(uri(temporary));
  assert.strictEqual(calls.length, 0); assert.match(state.errors[0], /missing override/); passed++;
  reset({ partial: true }); await handlers.get("nyra.package.create")(uri(temporary));
  assert.match(state.errors[0], /Files remain/); assert.strictEqual(state.opened.length, 0); passed++;
  reset({ cancel: true }); await handlers.get("nyra.package.create")(uri(temporary));
  assert.match(state.errors[0], /Cancelled/); assert.ok(!fs.existsSync(state.cancelPath)); passed++;
  reset(); await handlers.get("nyra.package.create")(uri(temporary, "memfs"));
  assert.strictEqual(calls.length, 0); assert.match(state.errors[0], /filesystem directory/); passed++;
  reset({ folder: 1 }); vscode.workspace.workspaceFolders = [{ name: "first", uri: uri(temporary) }, { name: "second", uri: uri(path.join(temporary, "second")) }];
  await handlers.get("nyra.package.create")();
  assert.ok(calls[0].args[1].includes(path.join("second", "new directory; literal"))); passed++;
  reset({ dialogs: [[uri(temporary)]] }); await handlers.get("nyra.package.create")();
  assert.strictEqual(calls.length, 3); passed++;
  assert.throws(() => real.validateResult("{}", 0, "new", true), /unsupported/); passed++;
  assert.throws(() => real.validateResult(JSON.stringify({ ...result("new", "x", "created"), schema_version: 1 }), 0, "new", true), /status/); passed++;
  // Real manager integration checks native CLI/editor output equivalence without
  // duplicating any templates in JavaScript. Optional for standalone editor CI.
  if (process.env.NYRA_TEST_MANAGER) {
    const manager = process.env.NYRA_TEST_MANAGER;
    const left = path.join(temporary, "native-left"), right = path.join(temporary, "native-right");
    const cli = spawnSync(manager, ["new", left, "--kind", "lib", "--name", "identical", "--no-workspace", "--json"], { encoding: "utf8" });
    assert.strictEqual(cli.status, 0, cli.stderr + cli.stdout);
    await real.runNative(manager, ["new", right, "--kind", "lib", "--name", "identical", "--no-workspace"], { preview: false });
    const compare = relative => {
      for (const item of fs.readdirSync(path.join(left, relative), { withFileTypes: true })) {
        const next = path.join(relative, item.name);
        if (item.isDirectory()) compare(next);
        else assert.deepStrictEqual(fs.readFileSync(path.join(left, next)), fs.readFileSync(path.join(right, next)));
      }
    };
    compare(""); passed++;
  }
  console.log(`package creation smoke: ${passed} passed${process.env.NYRA_TEST_MANAGER ? "; real native equivalence included" : "; standalone API fixtures"}`);
}
run().finally(() => { for (const disposable of context.subscriptions) disposable.dispose(); fs.rmSync(temporary, { recursive: true, force: true }); }).catch(error => { console.error(error); process.exitCode = 1; });
