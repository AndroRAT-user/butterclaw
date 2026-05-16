import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentStore } from "../src/agents.js";
import { defaultConfig } from "../src/config.js";
import { ButterclawGateway } from "../src/gateway.js";
import { ScheduleStore } from "../src/scheduler.js";

function tempConfig() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "butterclaw-gateway-"));
  return defaultConfig({
    workspace: root,
    configDir: path.join(root, ".config"),
    agentsDir: path.join(root, ".config", "agents"),
    sessionsDir: path.join(root, ".config", "sessions"),
    skillsDir: path.join(root, ".config", "skills"),
    memoryPath: path.join(root, ".config", "memory.jsonl"),
    schedulePath: path.join(root, ".config", "schedule.json"),
    gatewayTokenEnv: "BUTTERCLAW_TEST_GATEWAY_TOKEN",
    telegramStatePath: path.join(root, ".config", "telegram-state.json")
  });
}

async function withGateway<T>(fn: (baseUrl: string, config: ReturnType<typeof tempConfig>) => Promise<T>): Promise<T> {
  const config = tempConfig();
  process.env[config.gatewayTokenEnv] = "secret-token";
  const server = await new ButterclawGateway(config).startForTest();
  const address = server.address();
  assert.equal(typeof address, "object");
  const baseUrl = `http://127.0.0.1:${(address as import("node:net").AddressInfo).port}`;
  try {
    return await fn(baseUrl, config);
  } finally {
    delete process.env[config.gatewayTokenEnv];
    await closeServer(server);
  }
}

test("gateway exposes health and model listing", async () => {
  await withGateway(async (baseUrl, config) => {
    new AgentStore(config.agentsDir).create({
      name: "debugger",
      description: "Finds bugs",
      instructions: "Inspect first."
    });

    const health = await fetchJson(`${baseUrl}/health`);
    assert.equal(health.ok, true);
    assert.equal(health.name, "butterclaw-gateway");
    assert.equal((health.hooks as { auth: string }).auth, "configured");

    const models = await fetchJson(`${baseUrl}/v1/models`);
    assert.equal(models.object, "list");
    assert.equal((models.data as Array<{ id: string }>).some((model) => model.id === "butterclaw/debugger"), true);
  });
});

test("gateway hook agent requires bearer auth and runs the local agent", async () => {
  await withGateway(async (baseUrl, config) => {
    const unauthorized = await fetch(`${baseUrl}${config.gatewayHookPath}/agent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hello" })
    });
    assert.equal(unauthorized.status, 401);

    const response = await fetchJson(`${baseUrl}${config.gatewayHookPath}/agent`, {
      method: "POST",
      headers: {
        Authorization: "Bearer secret-token",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ message: "hello" })
    });
    assert.equal(response.status, "ok");
    assert.match(String(response.output), /Butterclaw mock provider is running/);
  });
});

test("gateway wake hook queues a due schedule job", async () => {
  await withGateway(async (baseUrl, config) => {
    const response = await fetchJson(`${baseUrl}${config.gatewayHookPath}/wake`, {
      method: "POST",
      headers: {
        "x-butterclaw-token": "secret-token",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ text: "check the build", session: "release-work" })
    });
    assert.equal(response.status, "accepted");

    const store = new ScheduleStore(config.schedulePath);
    const jobs = store.list();
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].session, "release-work");
    assert.equal(jobs[0].message, "check the build");
    assert.equal(store.due().length, 1);
  });
});

async function fetchJson(url: string, init?: RequestInit): Promise<any> {
  const response = await fetch(url, init);
  assert.equal(response.headers.get("content-type")?.includes("application/json"), true);
  return response.json();
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
