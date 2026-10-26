#!/usr/bin/env node
/**
 * Contract smoke for m_v0.13_p4: default LSP binary is Nyra nyra-analyzer.
 * No VS Code host required.
 */
"use strict";

const path = require("path");
const assert = require("assert");
const {
  defaultAnalyzerExeName,
  resolveSdkPath,
  resolveAnalyzerPath,
} = require(path.join(__dirname, "..", "analyzerPath"));

assert.strictEqual(defaultAnalyzerExeName("darwin"), "nyra-analyzer");
assert.strictEqual(defaultAnalyzerExeName("linux"), "nyra-analyzer");
assert.strictEqual(defaultAnalyzerExeName("win32"), "nyra-analyzer.exe");

const posix = resolveAnalyzerPath({
  sdkPath: "/repo",
  platform: "darwin",
});
assert.strictEqual(posix, path.join("/repo", "bin", "nyra-analyzer"));
assert.ok(!posix.includes("host-analyzer"), posix);

const win = resolveAnalyzerPath({
  sdkPath: "C:\\sdk",
  platform: "win32",
});
assert.ok(win.endsWith(path.join("bin", "nyra-analyzer.exe")), win);

assert.strictEqual(resolveAnalyzerPath({ sdkPath: "" }), "");
assert.strictEqual(resolveAnalyzerPath({ sdkPath: "   " }), "");

const roots = [
  { uri: { fsPath: "/workspace/first" } },
  { uri: { fsPath: "/workspace/second" } },
];
assert.strictEqual(resolveSdkPath({ sdkPath: " /custom/sdk ", workspaceFolders: roots }), "/custom/sdk");
assert.strictEqual(resolveSdkPath({ workspaceFolders: roots }), "/workspace/first");
assert.strictEqual(resolveSdkPath({ workspaceFolders: [] }), "");
// SDK selection is window-scoped and does not follow a changing active editor.
assert.strictEqual(resolveSdkPath({ workspaceFolders: roots }), "/workspace/first");

const override = "/opt/custom/nyra-analyzer";
assert.strictEqual(
  resolveAnalyzerPath({
    analyzerPath: override,
    sdkPath: "/repo",
    platform: "darwin",
  }),
  override
);

assert.strictEqual(
  resolveAnalyzerPath({
    analyzerPath: "  /custom/nyra-analyzer  ",
    sdkPath: "/ignored",
  }),
  "/custom/nyra-analyzer"
);

console.log("smoke-analyzer-path: ok (window SDK precedence; default bin/nyra-analyzer)");
