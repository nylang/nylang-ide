"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { resolveWindowSdkPath } = require("./windowToolchain");
const { toolPath } = require("./sdkDiscovery");

function resolveManager(vscode) {
  const override = (vscode.workspace.getConfiguration("nyra").get("packageManagerPath") || "").trim();
  const executable = override ? path.resolve(override) : toolPath(resolveWindowSdkPath(vscode, false), "nyra");
  try {
    if (!executable || !fs.statSync(executable).isFile()) throw new Error("missing executable");
    fs.accessSync(executable, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
  } catch (_) {
    const error = new Error(`Native package creation needs a compatible SDK with nyra new/init (1.0.4 or later). Manager unavailable: ${executable || "select an SDK"}`);
    error.toolchain = true;
    throw error;
  }
  return { executable, override: !!override };
}

function validateResult(stdout, code, operation, preview) {
  let result;
  try { result = JSON.parse(stdout); } catch (_) { /* Old tools may only print help. */ }
  if (!result || result.schema_version !== 1 || result.operation !== operation ||
      !["planned", "created", "error"].includes(result.status) || !result.package ||
      typeof result.package.root !== "string" || !Array.isArray(result.files) ||
      !result.workspace || !Array.isArray(result.errors)) {
    const error = new Error("Native manager returned an unsupported creation result. Select a compatible SDK; no editor template fallback is available. Inspect output and the destination if execution started.");
    error.toolchain = true;
    throw error;
  }
  if (code !== 0 || result.status === "error") {
    const detail = result.errors.map(error => `${error.code}: ${error.message} ${error.path || ""}`).join("\n");
    const retained = result.files.filter(file => file.action === "remaining" || file.action === "created");
    const error = new Error(detail || `Native creation failed (exit ${code}).`);
    error.result = result;
    if (retained.length) error.message += `\nFiles remain: ${retained.map(file => file.path).join(", ")}. Inspect before retrying.`;
    throw error;
  }
  if (result.status !== (preview ? "planned" : "created")) throw new Error("Native creation status does not match the requested operation.");
  return result;
}

function runNative(executable, args, { preview, log = () => {}, token, running } = {}) {
  return new Promise((resolve, reject) => {
    let cancellation;
    let directory;
    let timer;
    let subscription;
    let finished = false;
    let stdout = "";
    let stderr = "";
    let overflow = false;
    let timedOut = false;
    const cancel = () => {
      if (!finished && cancellation) {
        try { fs.writeFileSync(cancellation, "cancel\n", { flag: "wx" }); }
        catch (error) { if (error.code !== "EEXIST") log(`Cancellation request failed: ${error.message}`); }
      }
    };
    try {
      if (!preview) directory = fs.mkdtempSync(path.join(os.tmpdir(), "nyra-create-cancel-"));
      cancellation = directory && path.join(directory, "cancel");
      const environment = { ...process.env };
      delete environment.NYRA_CREATE_CANCEL_FILE;
      if (cancellation) environment.NYRA_CREATE_CANCEL_FILE = cancellation;
      const operation = args[0];
      const argv = [...args, ...(preview ? ["--dry-run"] : []), "--json"];
      log(`Package manager: ${executable}\nArguments: ${JSON.stringify(argv)}`);
      const child = spawn(executable, argv, { env: environment, shell: false, windowsHide: true });
      if (running) running.add(cancel);
      const cleanup = () => {
        finished = true;
        clearTimeout(timer);
        if (subscription) subscription.dispose();
        if (running) running.delete(cancel);
        if (directory) fs.rmSync(directory, { recursive: true, force: true });
      };
      if (child.stdout.setEncoding) child.stdout.setEncoding("utf8");
      if (child.stderr.setEncoding) child.stderr.setEncoding("utf8");
      child.stdout.on("data", data => { stdout += data.toString(); if (stdout.length > 2097152) { overflow = true; stdout = stdout.slice(0, 2097152); cancel(); } });
      child.stderr.on("data", data => { stderr = (stderr + data.toString()).slice(-2097152); });
      child.on("error", error => { cleanup(); reject(error); });
      child.on("close", code => {
        if (finished) return;
        cleanup();
        if (stderr.trim()) log(stderr.trim());
        try {
          if (timedOut) throw new Error("Native creation did not stop cooperatively; inspect destination and workspace for retained state before retrying.");
          if (overflow) throw new Error("Native creation output exceeded the limit; inspect destination state.");
          const result = validateResult(stdout, code, operation, preview);
          log(JSON.stringify(result));
          resolve(result);
        } catch (error) { log(stdout); reject(error); }
      });
      if (token) {
        subscription = token.onCancellationRequested(cancel);
        if (token.isCancellationRequested) cancel();
      }
      timer = setTimeout(() => {
        log("Creation is taking longer than expected; requesting cooperative cancellation.");
        if (preview) { timedOut = true; child.kill(); }
        else {
          cancel();
          timer = setTimeout(() => { timedOut = true; child.kill(); }, 10000);
        }
      }, 30000);
    } catch (error) {
      finished = true;
      if (directory) fs.rmSync(directory, { recursive: true, force: true });
      reject(error);
    }
  });
}

function localUri(vscode, uri) {
  if (!uri || !uri.fsPath || (uri.scheme !== "file" && !(uri.scheme === "vscode-remote" && vscode.env && vscode.env.remoteName))) {
    throw new Error("Choose a filesystem directory on the current extension host.");
  }
  return uri;
}

async function chooseDirectory(vscode, hint, operation) {
  if (hint) return localUri(vscode, hint);
  const folders = vscode.workspace.workspaceFolders || [];
  let selected;
  if (folders.length > 1) {
    const choice = await vscode.window.showQuickPick([
      ...folders.map(folder => ({ label: folder.name, description: folder.uri.fsPath, uri: folder.uri })),
      { label: "Browse for another directory" },
    ], { title: operation === "new" ? "Choose package parent" : "Choose directory to initialize" });
    if (!choice) return undefined;
    if (choice.uri) selected = choice.uri;
  }
  if (selected) return localUri(vscode, selected);
  const values = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
    defaultUri: folders.length === 1 ? folders[0].uri : undefined,
    title: operation === "new" ? "Choose package parent directory" : "Choose existing directory to initialize" });
  return values && values[0] ? localUri(vscode, values[0]) : undefined;
}

function registerPackageCreation(vscode, context, { log }) {
  const running = new Set();
  context.subscriptions.push({ dispose() { for (const cancel of running) cancel(); } });
  async function create(operation, hint) {
    try {
      if (!vscode.workspace.isTrusted) throw new Error("Trust this workspace before running the native package manager.");
      const manager = resolveManager(vscode);
      if (manager.override) log(`Using explicit nyra.packageManagerPath override: ${manager.executable}`);
      let uri = await chooseDirectory(vscode, hint, operation);
      if (!uri) return;
      if (operation === "new") {
        const directory = await vscode.window.showInputBox({ title: "New package directory", prompt: "Directory name inside the selected parent",
          validateInput: value => !value || value === "." || value === ".." || /[\\/\0]/.test(value) ? "Enter one directory name." : undefined });
        if (directory === undefined) return;
        uri = vscode.Uri.joinPath(uri, directory);
      }
      const kind = await vscode.window.showQuickPick([{ label: "Application", kind: "app" }, { label: "Library", kind: "lib" }], { title: "Package kind" });
      if (!kind) return;
      const suggestion = path.basename(uri.fsPath).toLowerCase().replace(/[^a-z0-9_]/g, "_");
      const name = await vscode.window.showInputBox({ title: "Package name", value: suggestion, prompt: "Native nyra validates the package identity" });
      if (name === undefined) return;
      const args = [operation, uri.fsPath, "--kind", kind.kind, "--name", name];
      let plan = await runNative(manager.executable, args, { preview: true, log });
      const choices = [{ label: "Standalone package", action: "standalone" }];
      if (plan.workspace.file) choices.push({ label: "Register in discovered Nyra workspace", description: plan.workspace.file, file: plan.workspace.file });
      choices.push({ label: "Browse for an existing workspace.yaml", action: "browse" });
      const workspace = await vscode.window.showQuickPick(choices, { title: "Nyra workspace registration" });
      if (!workspace) return;
      let workspaceFile = workspace.file;
      if (workspace.action === "browse") {
        const selected = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: false, canSelectMany: false, title: "Select existing Nyra workspace.yaml", filters: { YAML: ["yaml"] } });
        if (!selected || !selected[0]) return;
        workspaceFile = localUri(vscode, selected[0]).fsPath;
      }
      args.push(...(workspaceFile ? ["--workspace", workspaceFile] : ["--no-workspace"]));
      plan = await runNative(manager.executable, args, { preview: true, log });
      const preview = plan.files.map(file => `${file.action}: ${file.path}`).join("\n") + `\nWorkspace: ${plan.workspace.action} ${plan.workspace.file || ""}`;
      const accepted = await vscode.window.showInformationMessage(`Create ${plan.package.name}?`, { modal: true, detail: preview }, "Create Package");
      if (accepted !== "Create Package") return;
      const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Creating Nyra package", cancellable: true },
        (_progress, token) => runNative(manager.executable, args, { preview: false, log, token, running }));
      const action = await vscode.window.showInformationMessage(`Created ${result.package.name}.`, "Open Folder", "Add to Workspace", "Keep Current Window");
      if (action === "Open Folder") await vscode.commands.executeCommand("vscode.openFolder", uri);
      else if (action === "Add to Workspace") vscode.workspace.updateWorkspaceFolders((vscode.workspace.workspaceFolders || []).length, 0, { uri });
      if (action !== "Open Folder") {
        const entry = result.package.existing_source ? "package.yaml" : result.package.kind === "app" ? "main.ny" : `${result.package.name}.ny`;
        await vscode.window.showTextDocument(vscode.Uri.joinPath(uri, entry));
      }
    } catch (error) {
      log(`Package creation: ${error.message}`);
      const choices = error.toolchain ? ["Select SDK", "Install SDK", "Show Output"] : ["Show Output"];
      const action = await vscode.window.showErrorMessage(error.message, ...choices);
      const commands = { "Select SDK": "nyra.selectSdk", "Install SDK": "nyra.installSdk", "Show Output": "nyra.showOutput" };
      if (commands[action]) await vscode.commands.executeCommand(commands[action]);
    }
  }
  context.subscriptions.push(vscode.commands.registerCommand("nyra.package.create", uri => create("new", uri)));
  context.subscriptions.push(vscode.commands.registerCommand("nyra.package.initialize", uri => create("init", uri)));
}

module.exports = { registerPackageCreation, resolveManager, runNative, validateResult, localUri };
