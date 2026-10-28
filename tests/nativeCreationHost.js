"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vscode = require("vscode");
const { runNative, resolveManager } = require("../packageCreation");
exports.run = async function () {
  const extension = vscode.extensions.getExtension("nyra.nyra-lang");
  assert.ok(extension, "development extension is registered");
  await extension.activate();
  const commands = await vscode.commands.getCommands(true);
  assert.ok(commands.includes("nyra.package.create"));
  assert.ok(commands.includes("nyra.package.initialize"));
  const manager = process.env.NYRA_TEST_MANAGER;
  assert.ok(manager, "provide the native candidate manager");
  await vscode.workspace.getConfiguration("nyra").update("packageManagerPath", manager, vscode.ConfigurationTarget.Workspace);
  assert.strictEqual(resolveManager(vscode).executable, manager);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nyra-extension-host-"));
  try {
    for (const kind of ["app", "lib"]) {
      const target = path.join(root, kind + " space 包");
      const args = ["new", target, "--name", "sample", "--kind", kind, "--no-workspace"];
      const plan = await runNative(manager, args, { preview: true });
      assert.strictEqual(plan.status, "planned");
      assert.ok(!fs.existsSync(target));
      const result = await runNative(manager, args, { preview: false });
      assert.strictEqual(result.status, "created");
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(target, kind === "app" ? "main.ny" : "sample.ny")));
      assert.strictEqual(document.languageId, "nyra");
      assert.ok(document.getText().includes("module "));
    }
    const cancel = new vscode.CancellationTokenSource();
    cancel.cancel();
    const target = path.join(root, "cancelled");
    await assert.rejects(runNative(manager, ["new", target, "--no-workspace"], { preview: false, token: cancel.token }), /Cancelled/);
    assert.ok(!fs.existsSync(target));
    cancel.dispose();
    console.log("Native package creation Extension Host: passed (activation, commands, explicit manager, app/lib preview/create, Nyra documents, cooperative cancellation)");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
};
