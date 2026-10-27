"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

function hostKey(platform = process.platform, arch = process.arch) {
  const system = { darwin: "darwin", linux: "linux", win32: "windows" }[platform];
  const cpu = { arm64: "arm64", x64: "x86_64" }[arch];
  return system && cpu ? `${system}-${cpu}` : "";
}

function sdkManifest(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8")); }
  catch (_) { return undefined; }
}

function toolPath(root, tool, platform = process.platform, arch = process.arch) {
  if (!root) return "";
  const manifest = sdkManifest(root);
  const exe = tool + (platform === "win32" ? ".exe" : "");
  if (manifest && ["nyra-sdk-v1", "nyra-sdk-v2"].includes(manifest.format)) {
    return path.join(root, "hosts", hostKey(platform, arch) || "unsupported", "bin", exe);
  }
  return path.join(root, "bin", exe);
}

function isFile(file) {
  try { return fs.statSync(file).isFile(); } catch (_) { return false; }
}

function inspectSdk(root, platform = process.platform, arch = process.arch) {
  if (!root) return undefined;
  root = path.resolve(root);
  const manifest = sdkManifest(root);
  if (isFile(path.join(root, "manifest.json")) && (!manifest || !["nyra-sdk-v1", "nyra-sdk-v2"].includes(manifest.format))) return undefined;
  if (manifest && ["nyra-sdk-v1", "nyra-sdk-v2"].includes(manifest.format) && manifest.host !== hostKey(platform, arch)) return undefined;
  const compiler = toolPath(root, "nyrac", platform, arch);
  const analyzer = toolPath(root, "nyra-analyzer", platform, arch);
  if (!isFile(compiler) || !isFile(analyzer)) return undefined;
  const manager = manifest && manifest.format === "nyra-sdk-v2" ? toolPath(root,"nyra",platform,arch) : "";
  if (manager && (!isFile(manager) || manifest.schema_version !== 2)) return undefined;
  return { root, compiler, analyzer, manager, version: manifest && manifest.version || "development", host: hostKey(platform, arch) };
}

function candidateRoots(opts = {}) {
  const env = opts.env || process.env;
  const home = opts.home || os.homedir();
  const roots = (opts.workspaceFolders || []).map(f => f.uri && f.uri.fsPath).filter(Boolean);
  if (env.NYRA_SDK) roots.push(env.NYRA_SDK);
  for (const bin of (env.PATH || "").split(path.delimiter).filter(Boolean)) {
    if (path.basename(path.resolve(bin, "../..")) === "hosts") roots.push(path.resolve(bin, "../../.."));
    else roots.push(path.dirname(bin));
    // Package managers often expose SDK tools as symlinks in a shared bin.
    const exe = (opts.platform || process.platform) === "win32" ? "nyrac.exe" : "nyrac";
    try {
      const realBin = path.dirname(fs.realpathSync(path.join(bin, exe)));
      roots.push(path.basename(path.resolve(realBin, "../..")) === "hosts"
        ? path.resolve(realBin, "../../..") : path.dirname(realBin));
    } catch (_) { /* No compiler in this PATH entry. */ }
  }
  const bases = [opts.managedRoot, path.join(home, ".nyra", "sdk"), path.join(home, ".nyra", "sdks"),
    path.join(home, "nyra-sdk"), path.join(home, ".local", "share", "nyra", "sdks")].filter(Boolean);
  for (const base of bases) {
    roots.push(base);
    try {
      roots.push(...fs.readdirSync(base, { withFileTypes: true }).filter(e => e.isDirectory())
        .map(e => e.name).sort((a, b) => b.localeCompare(a, "en", { numeric: true }))
        .slice(0, 200).map(name => path.join(base, name)));
    } catch (_) { /* Optional installation directory. */ }
  }
  return [...new Set(roots.map(root => path.resolve(root)))];
}

function discoverSdks(opts = {}) {
  const seen = new Set();
  return candidateRoots(opts).map(root => inspectSdk(root, opts.platform, opts.arch)).filter(sdk => {
    if (!sdk) return false;
    const real = fs.realpathSync(sdk.root);
    if (seen.has(real)) return false;
    seen.add(real);
    return true;
  });
}

module.exports = { hostKey, sdkManifest, toolPath, inspectSdk, candidateRoots, discoverSdks };
