import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runScheduleCommand } from "../src/cli.js";
import { defaultConfig } from "../src/config.js";
import { parseDurationMs, parseScheduleTime, ScheduleStore } from "../src/scheduler.js";
import { buildDefaultRegistry } from "../src/tools.js";

function tempConfig() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "butterclaw-schedule-"));
  return defaultConfig({
    workspace: root,
    configDir: path.join(root, ".config"),
    agentsDir: path.join(root, ".config", "agents"),
    sessionsDir: path.join(root, ".config", "sessions"),
    skillsDir: path.join(root, ".config", "skills"),
    memoryPath: path.join(root, ".config", "memory.jsonl"),
    schedulePath: path.join(root, ".config", "schedule.json"),
    telegramStatePath: path.join(root, ".config", "telegram-state.json")
  });
}

test("scheduler parses relative and absolute times", () => {
  const now = new Date("2026-05-16T00:00:00.000Z");

  assert.equal(parseDurationMs("20m"), 1_200_000);
  assert.equal(parseScheduleTime("20m", now).toISOString(), "2026-05-16T00:20:00.000Z");
  assert.equal(parseScheduleTime("2026-05-16T01:00:00.000Z", now).toISOString(), "2026-05-16T01:00:00.000Z");
});

test("schedule store tracks due jobs, recurring next runs, and one-shot cleanup", () => {
  const config = tempConfig();
  const store = new ScheduleStore(config.schedulePath);
  const now = new Date("2026-05-16T00:00:00.000Z");

  const recurring = store.add({ name: "Morning Brief", every: "1h", message: "brief me", now });
  assert.equal(recurring.name, "morning-brief");
  assert.equal(store.due(new Date("2026-05-16T00:30:00.000Z")).length, 0);
  assert.deepEqual(
    store.due(new Date("2026-05-16T01:00:00.000Z")).map((job) => job.id),
    [recurring.id]
  );

  store.recordRun(recurring, "ok", "done", new Date("2026-05-16T01:00:00.000Z"), new Date("2026-05-16T01:00:05.000Z"));
  assert.equal(store.get(recurring.id)?.nextRunAt, "2026-05-16T02:00:05.000Z");

  const oneShot = store.add({ name: "Ping", at: "now", message: "ping me", now });
  store.recordRun(oneShot, "ok", "pong", now, now);
  assert.equal(store.get(oneShot.id), null);
  assert.equal(store.runs(oneShot.id).length, 1);
});

test("schedule CLI can add, list, run due jobs, and record history", async () => {
  const config = tempConfig();
  const lines: string[] = [];

  assert.equal(await runScheduleCommand(config, ["add", "--name", "Check Later", "--at", "now", "--message", "say hello"], (line) => lines.push(line)), 0);
  assert.match(lines.join("\n"), /Created check-later/);

  lines.length = 0;
  assert.equal(await runScheduleCommand(config, ["list"], (line) => lines.push(line)), 0);
  assert.match(lines.join("\n"), /check-later/);

  lines.length = 0;
  assert.equal(await runScheduleCommand(config, ["run", "--due"], (line) => lines.push(line)), 0);
  assert.match(lines.join("\n"), /Schedule check-later finished/);
  assert.match(lines.join("\n"), /Butterclaw mock provider is running/);

  const store = new ScheduleStore(config.schedulePath);
  assert.equal(store.list().length, 0);
  assert.equal(store.runs().length, 1);
  assert.equal(store.runs()[0].status, "ok");
});

test("schedule tools create, list, and remove jobs through the registry", async () => {
  const config = tempConfig();
  const registry = buildDefaultRegistry(config);

  const added = await registry.call("schedule_add", { name: "Ops Sweep", every: "2h", message: "check project state" });
  assert.equal(added.ok, true);
  assert.match(added.output, /Scheduled ops-sweep/);

  const listed = await registry.call("schedule_list", {});
  assert.equal(listed.ok, true);
  assert.match(listed.output, /ops-sweep/);

  const removed = await registry.call("schedule_remove", { id: "ops-sweep" });
  assert.equal(removed.ok, true);
  assert.match(removed.output, /Removed schedule/);
});
