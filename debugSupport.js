const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const vscode = require("vscode");
const { resolveWindowSdkPath } = require("./windowToolchain");
const { toolPath } = require("./sdkDiscovery");

const CODE_LLDB_ID = "vadimcn.vscode-lldb";
const CPP_TOOLS_ID = "ms-vscode.cpptools";

function resolveSdkPath() {
  return resolveWindowSdkPath(vscode, false);
}

function resolveCompilerPath() {
  const cfg = vscode.workspace.getConfiguration("nyra");
  const override = (cfg.get("compilerPath") || "").trim();
  if (override) {
    return override;
  }
  const sdkPath = resolveSdkPath();
  if (!sdkPath) {
    return "";
  }
  return toolPath(sdkPath, "nyrac");
}

function exeSuffix() {
  return process.platform === "win32" ? ".exe" : ".bin";
}

function defaultCppdbgMIMode() {
  if (process.platform === "darwin") {
    return "lldb";
  }
  return "gdb";
}

function isNyDebugEntry(filePath) {
  const ext = path.extname(filePath || "").toLowerCase();
  return ext === ".ny";
}

function debugOutPath(workspaceRoot, nyPath) {
  const dir = path.join(workspaceRoot, ".nyra-debug");
  const relative = path.relative(workspaceRoot, nyPath);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw new Error("Debug entry must be inside its workspace folder.");
  }
  // Keep the relative source path so same-named files in different packages
  // cannot collide. The final suffix must not be .ny, or package discovery may
  // mistake the linked binary for another Nyra source file.
  return path.join(dir, relative + exeSuffix());
}

function ensureDebugOutDir(outPath) {
  const dir = path.dirname(outPath);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function appendOutput(current, chunk) {
  const limit = 10 * 1024 * 1024;
  const text = current + String(chunk);
  return text.length > limit ? text.slice(text.length - limit) : text;
}

function runProcess(command, args, cwd) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let child;
    try {
      child = spawn(command, args, { cwd, windowsHide: true });
    } catch (error) {
      finish({ ok: false, message: String(error.message || error) });
      return;
    }
    child.stdout.on("data", (chunk) => { stdout = appendOutput(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = appendOutput(stderr, chunk); });
    child.on("error", (error) => finish({ ok: false, message: String(error.message || error) }));
    child.on("close", (code) => {
      if (code === 0) {
        finish({ ok: true, message: "", stdout, stderr });
        return;
      }
      const details = [stderr, stdout].filter(Boolean).join("\n").trim();
      finish({ ok: false, message: details || `exit code ${code}`, stdout, stderr });
    });
  });
}

async function runBuild(compilerPath, args, cwd) {
  return runProcess(compilerPath, args, cwd);
}

async function runDsymutil(programPath, cwd) {
  if (process.platform !== "darwin") return { ok: true, message: "" };
  const result = await runProcess("dsymutil", [programPath, "-o", `${programPath}.dSYM`], cwd);
  if (!result.ok) return { ok: false, message: `dsymutil failed: ${result.message}` };
  return result;
}

function makeBuildTaskExecution(compilerPath, args, programPath, cwd) {
  if (process.platform !== "darwin") {
    return new vscode.ProcessExecution(compilerPath, args, { cwd });
  }
  // macOS linkers leave DWARF in object files; dsymutil packages it beside the
  // executable. Run both argv-safe processes inside one task so F5 waits for
  // the dSYM step before starting LLDB.
  return new vscode.CustomExecution(async () => {
    const write = new vscode.EventEmitter();
    const close = new vscode.EventEmitter();
    let child;
    let finished = false;
    const finish = (code) => {
      if (finished) return;
      finished = true;
      close.fire(code);
    };
    const run = (command, commandArgs, next) => {
      child = spawn(command, commandArgs, { cwd, windowsHide: true });
      child.stdout.on("data", (chunk) => write.fire(String(chunk)));
      child.stderr.on("data", (chunk) => write.fire(String(chunk)));
      child.on("error", (error) => {
        write.fire(`${command}: ${error.message || error}\r\n`);
        finish(1);
      });
      child.on("close", (code) => {
        if (finished) return;
        if (code !== 0) {
          finish(code || 1);
          return;
        }
        if (next) next();
        else finish(0);
      });
    };
    return {
      onDidWrite: write.event,
      onDidClose: close.event,
      open: () => run(compilerPath, args, () =>
        run("dsymutil", [programPath, "-o", `${programPath}.dSYM`], null)
      ),
      close: () => {
        if (child && !finished) child.kill();
      },
    };
  });
}

function pickNativeDebugBackend(preference) {
  const hasLLDB = !!vscode.extensions.getExtension(CODE_LLDB_ID);
  const hasCpp = !!vscode.extensions.getExtension(CPP_TOOLS_ID);

  if (preference === "lldb") {
    if (hasLLDB) {
      return { kind: "lldb" };
    }
    return {
      kind: "none",
      reason: 'Selected CodeLLDB, but extension "CodeLLDB" (vadimcn.vscode-lldb) is not installed.',
    };
  }
  if (preference === "cppdbg") {
    if (hasCpp) {
      return { kind: "cppdbg", miMode: defaultCppdbgMIMode() };
    }
    return {
      kind: "none",
      reason: 'Selected cppdbg, but extension "C/C++" (ms-vscode.cpptools) is not installed.',
    };
  }

  if (hasLLDB) {
    return { kind: "lldb" };
  }
  if (hasCpp) {
    return { kind: "cppdbg", miMode: defaultCppdbgMIMode() };
  }
  return {
    kind: "none",
    reason:
      "No native debug extension found. Install CodeLLDB (vadimcn.vscode-lldb) or C/C++ (ms-vscode.cpptools).",
  };
}

function makeLaunchConfiguration(program, workspaceFolder, backend, extra) {
  const cwd = extra.cwd || workspaceFolder;
  const args = extra.args || [];
  const name = extra.name || "Nyra: debug";
  // DWARF uses DW_LANG_C99; host adapters treat C-family source mapping best with this hint.
  const sourceLanguages = ["c"];

  if (backend.kind === "lldb") {
    return {
      type: "lldb",
      request: "launch",
      name,
      program,
      args,
      cwd,
      sourceLanguages,
      stopOnEntry: false,
    };
  }

  if (backend.kind === "cppdbg") {
    return {
      type: "cppdbg",
      request: "launch",
      name,
      program,
      args,
      cwd,
      environment: [],
      externalConsole: false,
      MIMode: backend.miMode || "lldb",
      stopAtEntry: false,
      // Helps breakpoint binding when the TU path is absolute under the workspace.
      sourceFileMap: {},
    };
  }

  return null;
}

function buildArgs(nyPath, outPath, target) {
  const args = ["build", nyPath, "--link", "-o", outPath];
  if (target === "release") {
    args.push("--build-type", "release", "--no-assert", "-O2", "-g0");
  } else {
    args.push("-O0", "-g");
  }
  return args;
}

async function debugCurrentNyFile() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !editor.document) {
    vscode.window.showWarningMessage("Open a .ny source file first.");
    return;
  }
  const doc = editor.document;
  if (doc.languageId !== "nyra") {
    vscode.window.showWarningMessage("Current file is not Nyra; open a .ny file.");
    return;
  }
  if (doc.isUntitled) {
    vscode.window.showWarningMessage("Save the file before debugging.");
    return;
  }
  const nyPath = doc.uri.fsPath;
  // .ni shares language id `nyra` for highlight/LSP; debug entry remains .ny / package main.
  if (!isNyDebugEntry(nyPath)) {
    vscode.window.showWarningMessage(
      "Debug entry must be a .ny file (or package main); .ni faces are not debug targets."
    );
    return;
  }
  const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
  if (!folder) {
    vscode.window.showWarningMessage("Add the file to a workspace folder before debugging.");
    return;
  }

  if (doc.isDirty) {
    const saved = await doc.save();
    if (!saved) {
      vscode.window.showWarningMessage("Could not save the file before debugging.");
      return;
    }
  }

  const compilerPath = resolveCompilerPath();
  if (!compilerPath || !fs.existsSync(compilerPath)) {
    vscode.window.showErrorMessage(
      `Nyra compiler not found: ${compilerPath || "(empty)"}. Build bin/nyrac (python3 nyra.py build) or set nyra.compilerPath.`
    );
    return;
  }

  const outPath = debugOutPath(folder.uri.fsPath, nyPath);
  try {
    ensureDebugOutDir(outPath);
  } catch (e) {
    vscode.window.showErrorMessage(`Cannot create output directory: ${e.message || e}`);
    return;
  }

  const args = buildArgs(nyPath, outPath, "debug");
  const build = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Nyra: building debug binary…",
      cancellable: false,
    },
    async () => runBuild(compilerPath, args, folder.uri.fsPath)
  );
  if (!build.ok) {
    vscode.window.showErrorMessage(`Nyra build failed: ${build.message}`);
    return;
  }
  if (!fs.existsSync(outPath)) {
    vscode.window.showErrorMessage(
      `Nyra build reported success but binary is missing: ${outPath}`
    );
    return;
  }
  const symbols = await runDsymutil(outPath, folder.uri.fsPath);
  if (!symbols.ok) {
    vscode.window.showErrorMessage(`Nyra debug symbols failed: ${symbols.message}`);
    return;
  }

  const pref = vscode.workspace.getConfiguration("nyra").get("debugAdapter") || "auto";
  const backend = pickNativeDebugBackend(pref);
  if (backend.kind === "none") {
    vscode.window.showErrorMessage(backend.reason);
    return;
  }

  const launch = makeLaunchConfiguration(outPath, folder.uri.fsPath, backend, {
    name: "Nyra: debug current file",
  });
  if (!launch) {
    vscode.window.showErrorMessage("Internal error: could not build launch configuration.");
    return;
  }

  const ok = await vscode.debug.startDebugging(folder, launch);
  if (!ok) {
    vscode.window.showErrorMessage(
      "Could not start debugging (startDebugging returned false). Check CodeLLDB/cppdbg is enabled."
    );
  }
}

class NyraTaskProvider {
  provideTasks() {
    return [];
  }

  resolveTask(task) {
    if (!task || task.definition.type !== "nyra") {
      return undefined;
    }
    const def = task.definition;
    const target = def.target || "debug";
    if (target !== "debug" && target !== "release") {
      return undefined;
    }

    const scope = task.scope;
    if (!scope || typeof scope.uri?.fsPath !== "string") {
      return undefined;
    }
    const workspaceFolder = scope.uri.fsPath;
    const compilerPath = resolveCompilerPath();
    if (!compilerPath || !fs.existsSync(compilerPath)) {
      return task;
    }

    const configuredFile = typeof def.file === "string" ? def.file.trim() : "";
    const active = vscode.window.activeTextEditor;
    const nyPath = configuredFile && configuredFile !== "${file}"
      ? path.resolve(workspaceFolder, configuredFile)
      : active && active.document && !active.document.isUntitled
        ? active.document.uri.fsPath
        : "";
    if (!isNyDebugEntry(nyPath)) return undefined;
    let outPath;
    try {
      outPath = debugOutPath(workspaceFolder, nyPath);
      ensureDebugOutDir(outPath);
    } catch (_error) {
      return undefined;
    }
    const execution = makeBuildTaskExecution(
      compilerPath,
      buildArgs(nyPath, outPath, target),
      outPath,
      workspaceFolder
    );

    const label =
      typeof def.label === "string" && def.label.trim()
        ? def.label.trim()
        : `nyra: build (${target})`;

    const resolved = new vscode.Task(def, scope, label, "nyra", execution, []);
    resolved.presentationOptions = {
      reveal: vscode.TaskRevealKind.Silent,
      panel: vscode.TaskPanelKind.Shared,
      showReuseMessage: false,
      clear: false,
    };
    return resolved;
  }
}

function readJsonFile(filePath) {
  if (!fs.existsSync(filePath)) return { exists: false, ok: true, value: null };
  try {
    return { exists: true, ok: true, value: JSON.parse(fs.readFileSync(filePath, "utf8")) };
  } catch (error) {
    return { exists: true, ok: false, error };
  }
}

function validateJsonObject(filePath, key, parsed) {
  if (!parsed.ok) return `${path.basename(filePath)} is not valid JSON.`;
  if (!parsed.exists) return "";
  const value = parsed.value;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return `${path.basename(filePath)} must contain a JSON object.`;
  }
  if (Object.prototype.hasOwnProperty.call(value, key) && !Array.isArray(value[key])) {
    return `${path.basename(filePath)} must contain an array named \"${key}\".`;
  }
  return "";
}

function writeJsonFilesTransaction(entries) {
  const staged = [];
  const applied = [];
  try {
    for (const [destination, value] of entries) {
      const dir = path.dirname(destination);
      fs.mkdirSync(dir, { recursive: true });
      const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const temporary = path.join(dir, `.${path.basename(destination)}.${suffix}.tmp`);
      const backup = path.join(dir, `.${path.basename(destination)}.${suffix}.bak`);
      const item = { destination, temporary, backup, hadOriginal: fs.existsSync(destination) };
      staged.push(item);
      fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { encoding: "utf8", flag: "wx" });
    }

    for (const item of staged) {
      if (item.hadOriginal) fs.renameSync(item.destination, item.backup);
      try {
        fs.renameSync(item.temporary, item.destination);
        applied.push(item);
      } catch (error) {
        if (item.hadOriginal && fs.existsSync(item.backup)) {
          fs.renameSync(item.backup, item.destination);
        }
        throw error;
      }
    }
    for (const item of staged) {
      if (fs.existsSync(item.backup)) {
        try { fs.unlinkSync(item.backup); } catch (_error) { /* committed files are already installed */ }
      }
    }
  } catch (error) {
    for (const item of applied.reverse()) {
      if (fs.existsSync(item.destination)) fs.unlinkSync(item.destination);
      if (item.hadOriginal && fs.existsSync(item.backup)) {
        fs.renameSync(item.backup, item.destination);
      }
    }
    for (const item of staged) {
      if (fs.existsSync(item.temporary)) fs.unlinkSync(item.temporary);
      if (fs.existsSync(item.backup)) {
        if (item.hadOriginal && !fs.existsSync(item.destination)) {
          fs.renameSync(item.backup, item.destination);
        } else {
          fs.unlinkSync(item.backup);
        }
      }
    }
    throw error;
  }
}

function mergeLaunchConfigs(existing, additions) {
  const body = existing && typeof existing === "object" ? existing : { version: "0.2.0", configurations: [] };
  if (!Array.isArray(body.configurations)) {
    body.configurations = [];
  }
  const names = new Set(body.configurations.map((c) => c && c.name).filter(Boolean));
  for (const cfg of additions) {
    if (!cfg || !cfg.name) {
      continue;
    }
    if (names.has(cfg.name)) {
      const idx = body.configurations.findIndex((c) => c && c.name === cfg.name);
      if (idx >= 0) {
        body.configurations[idx] = cfg;
      }
    } else {
      body.configurations.push(cfg);
      names.add(cfg.name);
    }
  }
  if (!body.version) {
    body.version = "0.2.0";
  }
  return body;
}

function mergeTasks(existing, additions) {
  const body = existing && typeof existing === "object" ? existing : { version: "2.0.0", tasks: [] };
  if (!Array.isArray(body.tasks)) {
    body.tasks = [];
  }
  const labels = new Set(body.tasks.map((t) => t && t.label).filter(Boolean));
  for (const task of additions) {
    if (!task || !task.label) {
      continue;
    }
    if (labels.has(task.label)) {
      const idx = body.tasks.findIndex((t) => t && t.label === task.label);
      if (idx >= 0) {
        body.tasks[idx] = task;
      }
    } else {
      body.tasks.push(task);
      labels.add(task.label);
    }
  }
  if (!body.version) {
    body.version = "2.0.0";
  }
  return body;
}

function nyraDebugWorkspacePayload() {
  const exe = exeSuffix();
  const programPath = "${workspaceFolder}/.nyra-debug/${relativeFile}" + exe;
  const tasks = [
    {
      label: "nyra: build debug (current file)",
      type: "nyra",
      target: "debug",
      file: "${file}",
      group: {
        kind: "build",
        isDefault: true,
      },
      problemMatcher: [],
    },
  ];
  const preLaunchTask = "nyra: build debug (current file)";
  const configurations = [
    {
      type: "lldb",
      request: "launch",
      name: "Nyra: debug (CodeLLDB)",
      program: programPath,
      args: [],
      cwd: "${workspaceFolder}",
      sourceLanguages: ["c"],
      stopOnEntry: false,
      preLaunchTask,
    },
    {
      type: "cppdbg",
      request: "launch",
      name: "Nyra: debug (C/C++ extension)",
      program: programPath,
      args: [],
      cwd: "${workspaceFolder}",
      environment: [],
      externalConsole: false,
      MIMode: defaultCppdbgMIMode(),
      stopAtEntry: false,
      preLaunchTask,
    },
  ];
  return { tasks, configurations };
}

async function writeDebugWorkspaceFiles() {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    vscode.window.showWarningMessage("Open a workspace folder first.");
    return;
  }
  const active = vscode.window.activeTextEditor;
  const activeFolder = active && active.document
    ? vscode.workspace.getWorkspaceFolder(active.document.uri)
    : undefined;
  const folder = activeFolder || folders[0];
  const root = folder.uri.fsPath;
  const vscodeDir = path.join(root, ".vscode");
  const launchPath = path.join(vscodeDir, "launch.json");
  const tasksPath = path.join(vscodeDir, "tasks.json");

  const launchExists = fs.existsSync(launchPath);
  const tasksExists = fs.existsSync(tasksPath);
  let mode = "write";
  if (launchExists || tasksExists) {
    const pick = await vscode.window.showWarningMessage(
      "Existing .vscode/launch.json or tasks.json found.",
      { modal: true },
      "Merge Nyra entries",
      "Overwrite",
      "Cancel"
    );
    if (pick === "Cancel" || pick === undefined) {
      return;
    }
    if (pick !== "Merge Nyra entries" && pick !== "Overwrite") return;
    mode = pick === "Overwrite" ? "overwrite" : "merge";
  }

  const payload = nyraDebugWorkspacePayload();
  let tasksBody;
  let launchBody;
  if (mode === "merge") {
    const existingTasks = readJsonFile(tasksPath);
    const existingLaunch = readJsonFile(launchPath);
    const tasksError = validateJsonObject(tasksPath, "tasks", existingTasks);
    const launchError = validateJsonObject(launchPath, "configurations", existingLaunch);
    if (tasksError || launchError) {
      vscode.window.showErrorMessage(
        `Cannot merge Nyra debug settings: ${tasksError || launchError} Files were left unchanged.`
      );
      return;
    }
    tasksBody = mergeTasks(existingTasks.value, payload.tasks);
    launchBody = mergeLaunchConfigs(existingLaunch.value, payload.configurations);
  } else {
    tasksBody = { version: "2.0.0", tasks: payload.tasks };
    launchBody = { version: "0.2.0", configurations: payload.configurations };
  }

  try {
    writeJsonFilesTransaction([
      [tasksPath, tasksBody],
      [launchPath, launchBody],
    ]);
  } catch (e) {
    vscode.window.showErrorMessage(`Cannot write Nyra debug settings: ${e.message || e}. Existing files were restored.`);
    return;
  }

  vscode.window.showInformationMessage(
    mode === "merge"
      ? "Merged Nyra debug entries into .vscode/tasks.json and launch.json. Open a .ny file, then F5 or Nyra: Debug Current File."
      : "Wrote .vscode/tasks.json and launch.json. Install CodeLLDB or C/C++, open a .ny file, then debug."
  );
}

function registerDebugSupport(context) {
  const provider = new NyraTaskProvider();
  context.subscriptions.push(
    vscode.tasks.registerTaskProvider("nyra", provider),
    vscode.commands.registerCommand("nyra.debug.currentFile", debugCurrentNyFile),
    vscode.commands.registerCommand("nyra.debug.initWorkspace", writeDebugWorkspaceFiles)
  );
}

module.exports = {
  registerDebugSupport,
  // Pure helpers for contract smoke (no vscode.window required).
  _test: {
    isNyDebugEntry,
    debugOutPath,
    buildArgs,
    makeBuildTaskExecution,
    runDsymutil,
    makeLaunchConfiguration,
    pickNativeDebugBackend,
    mergeLaunchConfigs,
    mergeTasks,
    nyraDebugWorkspacePayload,
    defaultCppdbgMIMode,
    writeDebugWorkspaceFiles,
    writeJsonFilesTransaction,
    runBuild,
    exeSuffix,
  },
};
