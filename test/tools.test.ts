import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultConfig } from "../src/config.js";
import { buildDefaultRegistry } from "../src/tools.js";

test("workspace write and read stays inside root", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "butterclaw-tools-"));
  const registry = buildDefaultRegistry(defaultConfig({ workspace: root, configDir: path.join(root, ".config") }));
  const write = await registry.call("write_file", { path: "notes/todo.txt", content: "ship it" });
  assert.equal(write.ok, true);
  const read = await registry.call("read_file", { path: "notes/todo.txt" });
  assert.equal(read.ok, true);
  assert.equal(read.output, "ship it");
});

test("workspace blocks path escape", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "butterclaw-tools-"));
  const registry = buildDefaultRegistry(defaultConfig({ workspace: root, configDir: path.join(root, ".config") }));
  const result = await registry.call("read_file", { path: "../outside.txt" });
  assert.equal(result.ok, false);
  assert.match(result.output, /Path escapes workspace/);
});

test("workspace map summarizes project shape", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "butterclaw-tools-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "test"), { recursive: true });
  fs.writeFileSync(path.join(root, "README.md"), "# Demo\n", "utf8");
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ scripts: { build: "tsc", test: "node --test" } }),
    "utf8"
  );
  fs.writeFileSync(path.join(root, "src", "index.ts"), "export {};\n", "utf8");
  fs.writeFileSync(path.join(root, "test", "index.test.ts"), "import test from 'node:test';\n", "utf8");

  const registry = buildDefaultRegistry(defaultConfig({ workspace: root, configDir: path.join(root, ".config") }));
  const result = await registry.call("workspace_map", { maxDepth: 2 });

  assert.equal(result.ok, true);
  assert.match(result.output, /Workspace map for \./);
  assert.match(result.output, /Package scripts:/);
  assert.match(result.output, /package\.json: build, test/);
  assert.match(result.output, /README\.md/);
  assert.match(result.output, /\.ts: 2/);
});

