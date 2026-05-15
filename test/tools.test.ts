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

