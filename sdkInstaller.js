"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");
const crypto = require("crypto");
const { Transform } = require("stream");
const { pipeline } = require("stream/promises");
const tar = require("tar");
const yauzl = require("yauzl");
const { inspectSdk, hostKey } = require("./sdkDiscovery");

const RELEASE_BASE = "https://github.com/nylang/sdk/releases";
const HASH = /^[a-f0-9]{64}$/i;

function checkCancelled(signal) {
  if (signal && signal.aborted) throw new Error("SDK installation cancelled.");
}

function request(url, signal, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 8 || new URL(url).protocol !== "https:") return reject(new Error("Invalid SDK download redirect."));
    const req = https.get(url, { signal, headers: { "User-Agent": "Nyra-VSCode", Accept: "application/octet-stream" } }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        res.resume();
        if (!res.headers.location) return reject(new Error("SDK download redirect has no location."));
        resolve(request(new URL(res.headers.location, url).href, signal, redirects + 1));
      } else if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`SDK download failed: HTTP ${res.statusCode}.`));
      } else resolve(res);
    });
    req.setTimeout(60000, () => req.destroy(new Error("SDK download timed out.")));
    req.on("error", reject);
  });
}

async function fetchRelease(signal) {
  const response = await request(`${RELEASE_BASE}/latest/download/release.json`, signal);
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response) {
    bytes += chunk.length;
    if (bytes > 2 * 1024 * 1024) { response.destroy(); throw new Error("SDK release metadata is too large."); }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function selectRelease(metadata, host) {
  if (!/^\d+\.\d+\.\d+$/.test(metadata.version || "")) throw new Error("Invalid stable SDK version.");
  const row = (metadata.releases || metadata.hosts || []).find(r => r.host === host);
  if (!row) throw new Error(`No official SDK is available for ${host || "this platform"}.`);
  const archive = typeof row.archive === "string" ? row.archive : row.archive && row.archive.path;
  const sha256 = row.archive_sha256 || row.archive && row.archive.sha256;
  const bytes = row.archive_bytes || row.archive && row.archive.bytes;
  const expected = `nyra-sdk-${metadata.version}-${host}${host.startsWith("windows-") ? ".zip" : ".tar.gz"}`;
  if (archive !== expected || !HASH.test(sha256 || "") || !HASH.test(row.sdk_manifest_sha256 || "") ||
      !Number.isSafeInteger(bytes) || bytes <= 0 || bytes > 4 * 1024 ** 3) throw new Error("Invalid SDK archive metadata.");
  return { ...row, archive, sha256: sha256.toLowerCase(), bytes, version: metadata.version,
    url: `${RELEASE_BASE}/download/v${metadata.version}/${archive}` };
}

async function hashFile(file, signal) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file, { signal })) hash.update(chunk);
  return hash.digest("hex");
}

async function downloadArchive(release, file, signal, progress = () => {}) {
  const response = await request(release.url, signal);
  const hash = crypto.createHash("sha256");
  let bytes = 0;
  const meter = new Transform({ transform(chunk, _encoding, callback) {
    bytes += chunk.length;
    if (bytes > release.bytes) return callback(new Error("SDK download exceeds its declared size."));
    hash.update(chunk);
    progress(bytes, release.bytes);
    callback(null, chunk);
  } });
  await pipeline(response, meter, fs.createWriteStream(file, { flags: "wx" }), { signal });
  if (bytes !== release.bytes || hash.digest("hex") !== release.sha256) throw new Error("SDK archive SHA-256 verification failed.");
}

function safeEntry(name, root) {
  if (typeof name !== "string" || name.includes("\\") || name.includes(":" ) || name.includes("\0") ||
      name.startsWith("/") || name.split("/").includes("..")) throw new Error(`Unsafe SDK archive path: ${name}`);
  const normalized = path.posix.normalize(name).replace(/\/$/, "");
  if (normalized !== root && !normalized.startsWith(`${root}/`)) throw new Error(`Unexpected SDK archive root: ${name}`);
  return normalized;
}

async function extractArchive(file, destination, root, signal) {
  if (file.endsWith(".zip")) return extractZip(file, destination, root, signal);
  // Validate the whole inventory before writing. Symlinks may point only inside
  // the SDK; no archive member may subsequently write through such a link.
  const entries = [];
  let validationError;
  await tar.t({ file, strict: true, onReadEntry(entry) {
    try {
    checkCancelled(signal);
    const name = safeEntry(entry.path, root);
    if (!["File", "Directory", "SymbolicLink", "Link"].includes(entry.type)) throw new Error(`Unsupported SDK entry: ${entry.type}`);
    if (entry.type === "SymbolicLink") {
      if (entry.linkpath.startsWith("/") || /[\\:\0]/.test(entry.linkpath)) throw new Error("Unsafe SDK symlink.");
      safeEntry(path.posix.join(path.posix.dirname(name), entry.linkpath), root);
    }
    if (entry.type === "Link") safeEntry(entry.linkpath, root);
    entries.push({ name, type: entry.type });
    } catch (error) { validationError = validationError || error; }
  } });
  if (validationError) throw validationError;
  const links = new Set(entries.filter(e => e.type === "SymbolicLink" || e.type === "Link").map(e => e.name));
  const seen = new Set();
  for (const entry of entries) {
    if (seen.has(entry.name)) throw new Error("Duplicate SDK archive entry.");
    seen.add(entry.name);
    for (let parent = path.posix.dirname(entry.name); parent !== "."; parent = path.posix.dirname(parent)) {
      if (links.has(parent)) throw new Error("SDK archive writes through a link.");
    }
  }
  checkCancelled(signal);
  await tar.x({ file, cwd: destination, strict: true, preservePaths: false,
    filter() { return !(signal && signal.aborted); } });
  checkCancelled(signal);
}

function extractZip(file, destination, root, signal) {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (error, zip) => {
      if (error) return reject(error);
      let settled = false;
      const fail = err => { if (!settled) { settled = true; zip.close(); reject(err); } };
      const seen = new Set();
      zip.on("error", fail);
      zip.on("end", () => { if (!settled) { settled = true; resolve(); } });
      zip.on("entry", async entry => {
        try {
          checkCancelled(signal);
          const name = safeEntry(entry.fileName, root);
          if (seen.has(name.toLowerCase())) throw new Error("Duplicate SDK ZIP entry.");
          seen.add(name.toLowerCase());
          if (((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000) throw new Error("SDK ZIP symlinks are unsupported.");
          const target = path.join(destination, ...name.split("/"));
          if (entry.fileName.endsWith("/")) {
            await fs.promises.mkdir(target, { recursive: true });
            zip.readEntry();
          } else {
            await fs.promises.mkdir(path.dirname(target), { recursive: true });
            zip.openReadStream(entry, async (err, stream) => {
              if (err) return fail(err);
              try {
                await pipeline(stream, fs.createWriteStream(target, { flags: "wx" }), { signal });
                zip.readEntry();
              } catch (e) { fail(e); }
            });
          }
        } catch (e) { fail(e); }
      });
      zip.readEntry();
    });
  });
}

async function installSdk(release, parent, { signal, progress = () => {}, download = downloadArchive,
  platform = process.platform, arch = process.arch } = {}) {
  const host = hostKey(platform, arch);
  if (release.host !== host) throw new Error("SDK release does not match the extension host.");
  const rootName = release.archive.replace(/\.tar\.gz$|\.zip$/, "");
  if (!/^nyra-sdk-[a-zA-Z0-9._-]+$/.test(rootName)) throw new Error("Invalid SDK directory name.");
  await fs.promises.mkdir(parent, { recursive: true });
  const finalRoot = path.join(parent, rootName);
  if (fs.existsSync(finalRoot)) throw new Error(`Installation directory already exists: ${finalRoot}. Select it with Nyra: Select SDK or choose another folder.`);
  const stage = await fs.promises.mkdtemp(path.join(parent, ".nyra-install-"));
  try {
    checkCancelled(signal);
    const archive = path.join(stage, release.archive);
    await download(release, archive, signal, (done, total) => progress(`Downloading SDK: ${Math.floor(done * 100 / total)}%`));
    // Verify here too so alternative download transports cannot bypass checks.
    if ((await fs.promises.stat(archive)).size !== release.bytes || await hashFile(archive, signal) !== release.sha256) throw new Error("SDK archive SHA-256 verification failed.");
    progress("Verifying and extracting SDK…");
    await extractArchive(archive, stage, rootName, signal);
    const root = path.join(stage, rootName);
    if (await hashFile(path.join(root, "manifest.json"), signal) !== release.sdk_manifest_sha256) throw new Error("SDK manifest SHA-256 verification failed.");
    const sdk = inspectSdk(root, platform, arch);
    if (!sdk) throw new Error("The extracted SDK is missing its compiler/analyzer or has the wrong host.");
    const manifest = JSON.parse(await fs.promises.readFile(path.join(root, "manifest.json"), "utf8"));
    if (manifest.version !== release.version) throw new Error("SDK manifest version mismatch.");
    for (const [tool, file] of [["nyrac", sdk.compiler], ["nyra-analyzer", sdk.analyzer], ...(sdk.manager ? [["nyra",sdk.manager]] : [])]) {
      const expected = manifest.tools && manifest.tools[tool] && manifest.tools[tool].sha256;
      if (!HASH.test(expected || "") || await hashFile(file, signal) !== expected) throw new Error(`SDK ${tool} SHA-256 verification failed.`);
      if (platform !== "win32") await fs.promises.chmod(file, 0o755);
    }
    checkCancelled(signal);
    await fs.promises.rename(root, finalRoot);
    return finalRoot;
  } finally { await fs.promises.rm(stage, { recursive: true, force: true }); }
}

module.exports = { RELEASE_BASE, fetchRelease, selectRelease, downloadArchive, installSdk, safeEntry, extractArchive, hashFile };
