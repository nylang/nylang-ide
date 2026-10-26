#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const tar = require("tar");
const { hostKey, inspectSdk, discoverSdks, toolPath } = require("../sdkDiscovery");
const { installSdk, selectRelease, extractArchive, safeEntry } = require("../sdkInstaller");
const windowToolchain = require("../windowToolchain");
const { registerSdkSupport } = require("../sdkSupport");

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "nyra-sdk-setup-"));
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const write = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); };
function fixture(root, platform = process.platform, arch = process.arch) {
  const host = hostKey(platform, arch);
  const tools = {};
  for (const tool of ["nyrac", "nyra-analyzer"]) {
    const relative = `hosts/${host}/bin/${tool}${platform === "win32" ? ".exe" : ""}`;
    const bytes = `fixture ${tool}`;
    write(path.join(root, relative), bytes);
    tools[tool] = { path: relative, sha256: hash(bytes) };
  }
  const manifest = { format: "nyra-sdk-v1", schema_version: 1, host, version: "1.2.3", tools };
  write(path.join(root, "manifest.json"), JSON.stringify(manifest));
  return manifest;
}

// Stored ZIP fixture builder keeps the tests independent of system zip tools.
function zipFixture(files) {
  const local = [], central = [];
  let offset = 0;
  for (const [name, data] of files) {
    const n = Buffer.from(name), b = Buffer.from(data);
    let crc = 0xffffffff;
    for (const byte of b) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
    crc = (crc ^ 0xffffffff) >>> 0;
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50); h.writeUInt16LE(20, 4);
    h.writeUInt32LE(crc, 14); h.writeUInt32LE(b.length, 18); h.writeUInt32LE(b.length, 22); h.writeUInt16LE(n.length, 26);
    local.push(h, n, b);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(b.length, 20); c.writeUInt32LE(b.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(offset, 42);
    central.push(c, n); offset += h.length + n.length + b.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

async function run() {
  try {
    assert.strictEqual(hostKey("win32", "x64"), "windows-x86_64");
    assert.strictEqual(hostKey("darwin", "arm64"), "darwin-arm64");
    assert.strictEqual(hostKey("linux", "ia32"), "");
    const sdk = path.join(temp, "existing SDK with spaces");
    fixture(sdk);
    assert.ok(inspectSdk(sdk));
    assert.strictEqual(inspectSdk(sdk, "linux", "ia32"), undefined);
    assert.ok(toolPath(sdk, "nyrac").includes(path.join("hosts", hostKey(), "bin")));
    const windows = path.join(temp, "windows-sdk");
    fixture(windows, "win32", "x64");
    assert.ok(inspectSdk(windows, "win32", "x64").analyzer.endsWith("nyra-analyzer.exe"));
    const options = { env: { NYRA_SDK: sdk, PATH: "" }, home: path.join(temp, "empty-home") };
    assert.strictEqual(discoverSdks(options)[0].root, sdk);
    const fromPath = discoverSdks({ ...options, env: { PATH: path.dirname(toolPath(sdk, "nyrac")) } });
    assert.strictEqual(fromPath[0].root, sdk);
    assert.strictEqual(fromPath.length, 1, "packaged host bin directory must not masquerade as a second development SDK");
    if (process.platform !== "win32") {
      const sharedBin = path.join(temp, "shared-bin");
      fs.mkdirSync(sharedBin);
      fs.symlinkSync(toolPath(sdk, "nyrac"), path.join(sharedBin, "nyrac"));
      assert.strictEqual(fs.realpathSync(discoverSdks({ ...options, env: { PATH: sharedBin } })[0].root), fs.realpathSync(sdk));
    }
    const settings = { sdkPath: "" };
    const vscode = { workspace: { workspaceFolders: [], getConfiguration: () => ({ get: key => settings[key] || "" }) } };
    const managed = path.join(temp, "managed");
    fixture(path.join(managed, "nyra-sdk-1.2.3"));
    windowToolchain._reset();
    windowToolchain.configureSdkSearch(managed);
    const chosen = windowToolchain.resolveWindowSdkPath(vscode);
    assert.ok(chosen);
    vscode.workspace.workspaceFolders = [{ uri: { fsPath: sdk } }];
    assert.strictEqual(windowToolchain.resolveWindowSdkPath(vscode), chosen, "automatic SDK selection stays fixed across workspace changes");
    settings.sdkPath = path.join(temp, "invalid-explicit");
    assert.strictEqual(windowToolchain.resolveWindowSdkPath(vscode), settings.sdkPath, "invalid explicit settings must not silently fall back");

    const tarPlatform = process.platform === "win32" ? "linux" : process.platform;
    const tarOptions = { platform: tarPlatform, arch: process.arch };
    const name = `nyra-sdk-1.2.3-${hostKey(tarPlatform)}`;
    const source = path.join(temp, "source", name);
    fixture(source, tarPlatform);
    if (process.platform !== "win32") fs.symlinkSync("nyrac", path.join(source, "hosts", hostKey(), "bin", "compiler-link"));
    const archive = path.join(temp, name + ".tar.gz");
    await tar.c({ gzip: true, file: archive, cwd: path.dirname(source) }, [name]);
    const bytes = fs.readFileSync(archive);
    const release = { version: "1.2.3", host: hostKey(tarPlatform), archive: path.basename(archive),
      archive_bytes: bytes.length, archive_sha256: hash(bytes), sdk_manifest_sha256: hash(fs.readFileSync(path.join(source, "manifest.json"))) };
    const selected = selectRelease({ version: "1.2.3", releases: [release] }, hostKey(tarPlatform));
    assert.match(selected.url, /\/download\/v1\.2\.3\/nyra-sdk-/);
    assert.throws(() => selectRelease({ version: "1.2.3", releases: [release] }, "linux-ia32"), /No official SDK/);
    assert.throws(() => selectRelease({ version: "../bad", releases: [release] }, hostKey(tarPlatform)), /Invalid stable/);
    assert.throws(() => selectRelease({ version: "1.2.3", releases: [{ ...release, archive: "../../sdk.tar.gz" }] }, hostKey(tarPlatform)), /metadata/);
    const download = async (_release, target) => fs.promises.copyFile(archive, target);
    const destination = path.join(temp, "install path with spaces");
    const installed = await installSdk(selected, destination, { ...tarOptions, download });
    assert.ok(inspectSdk(installed, tarPlatform));
    assert.strictEqual(fs.readdirSync(destination).length, 1, "successful install removes staging and downloaded archive");
    await assert.rejects(installSdk(selected, destination, { ...tarOptions, download }), /already exists/);
    const failed = path.join(temp, "bad-checksum");
    await assert.rejects(installSdk({ ...selected, sha256: "0".repeat(64) }, failed, { ...tarOptions, download }), /SHA-256/);
    assert.deepStrictEqual(fs.readdirSync(failed), [], "failed install cleans partial files");
    const badManifest = path.join(temp, "bad-manifest");
    await assert.rejects(installSdk({ ...selected, sdk_manifest_sha256: "0".repeat(64) }, badManifest, { ...tarOptions, download }), /manifest SHA-256/);
    assert.deepStrictEqual(fs.readdirSync(badManifest), []);
    const cancel = new AbortController();
    const cancelled = path.join(temp, "cancelled");
    await assert.rejects(installSdk(selected, cancelled, { ...tarOptions, signal: cancel.signal, download: async (_r, file) => {
      await fs.promises.copyFile(archive, file); cancel.abort();
    } }), /abort|cancel/i);
    assert.deepStrictEqual(fs.readdirSync(cancelled), []);
    const zipRoot = "nyra-sdk-1.2.3-windows-x86_64";
    const manifestBytes = fs.readFileSync(path.join(windows, "manifest.json"));
    const windowsFiles = [[`${zipRoot}/manifest.json`, manifestBytes],
      ...["nyrac", "nyra-analyzer"].map(tool => [`${zipRoot}/hosts/windows-x86_64/bin/${tool}.exe`, `fixture ${tool}`])];
    const zip = zipFixture(windowsFiles);
    const winRelease = selectRelease({ version: "1.2.3", releases: [{ host: "windows-x86_64", archive: zipRoot + ".zip",
      archive_bytes: zip.length, archive_sha256: hash(zip), sdk_manifest_sha256: hash(manifestBytes) }] }, "windows-x86_64");
    const installedWin = await installSdk(winRelease, path.join(temp, "windows-install"), {
      platform: "win32", arch: "x64", download: async (_r, target) => fs.promises.writeFile(target, zip) });
    assert.ok(inspectSdk(installedWin, "win32", "x64"));
    const zipAttack = path.join(temp, "zip-attack.zip");
    fs.writeFileSync(zipAttack, zipFixture([["../escape", "bad"]]));
    await assert.rejects(extractArchive(zipAttack, path.join(temp, "zip-extract"), zipRoot), /invalid|Unsafe|Unexpected/);
    for (const name of ["../escape", "/absolute", "sdk/../escape", "C:/escape", "sdk\\escape", "other/file"])
      assert.throws(() => safeEntry(name, "sdk"), /Unsafe|Unexpected/);
    if (process.platform !== "win32") {
      const attackRoot = path.join(temp, "attack", "sdk");
      fs.mkdirSync(attackRoot, { recursive: true });
      fs.symlinkSync("../../outside", path.join(attackRoot, "escape"));
      const attack = path.join(temp, "attack.tar.gz");
      await tar.c({ gzip: true, cwd: path.dirname(attackRoot), file: attack }, ["sdk"]);
      await assert.rejects(extractArchive(attack, path.join(temp, "extract"), "sdk"), /Unsafe|Unexpected/);
    }

    // Exercise actual command/UI wiring with filesystem discovery and settings.
    const commands = new Map();
    const notifications = [];
    let refreshes = 0;
    let pick;
    let warningChoice;
    const uiSettings = { sdkPath: "" };
    const ui = {
      StatusBarAlignment: { Left: 1 }, ConfigurationTarget: { Global: 1, Workspace: 2 },
      workspace: { workspaceFolders: [{ uri: { fsPath: sdk } }], getConfiguration: () => ({
        get: key => uiSettings[key], inspect: () => ({}),
        update: async (key, value, target) => { assert.strictEqual(target, 1); uiSettings[key] = value; },
      }) },
      window: { createStatusBarItem: () => ({ show() {}, dispose() {} }),
        showQuickPick: async rows => pick ? rows.find(pick) : undefined,
        showOpenDialog: async () => [{ fsPath: sdk }],
        showWarningMessage: async () => warningChoice,
        showErrorMessage: text => notifications.push(text) },
      commands: { registerCommand: (id, fn) => { commands.set(id, fn); return { dispose() {} }; }, executeCommand: async () => {} },
    };
    windowToolchain._reset();
    const context = { subscriptions: [], globalStorageUri: { fsPath: path.join(temp, "storage") } };
    const support = registerSdkSupport(ui, context, { log() {}, refresh: async () => { refreshes++; } });
    await commands.get("nyra.selectSdk")();
    assert.strictEqual(refreshes, 0, "cancelled selection keeps the current SDK");
    pick = row => row.sdk && row.sdk.root === sdk;
    await commands.get("nyra.selectSdk")();
    assert.strictEqual(uiSettings.sdkPath, sdk);
    assert.strictEqual(refreshes, 1);
    pick = row => row.action === "browse";
    warningChoice = "Select SDK";
    await support.offerSetup("SDK missing");
    assert.strictEqual(refreshes, 2);
    assert.deepStrictEqual(notifications, []);
    for (const subscription of context.subscriptions) subscription.dispose();
    console.log("smoke-sdk-setup: ok (discovery, packaged layouts, fixed window selection, UI selection, verified install, cancellation, checksum failures, existing directories, archive path/link rejection)");
  } finally { fs.rmSync(temp, { recursive: true, force: true }); windowToolchain._reset(); }
}

run().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
