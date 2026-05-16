import crypto from "node:crypto";
import http from "node:http";
import { AgentProfile, AgentStore, applyAgentProfile } from "./agents.js";
import { ButterclawAgent } from "./agent.js";
import { ButterclawConfig } from "./config.js";
import { ScheduleStore } from "./scheduler.js";
import { isRecord, truncate } from "./util.js";

export class GatewayError extends Error {}

export interface GatewayRun {
  id: string;
  status: "ok" | "error" | "accepted";
  output?: string;
  steps?: number;
  jobId?: string;
  error?: string;
}

export class ButterclawGateway {
  private readonly startedAt = Date.now();

  constructor(private readonly config: ButterclawConfig) {}

  async serve(): Promise<number> {
    const server = this.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.config.gatewayPort, this.config.gatewayHost, () => resolve());
    });
    console.log(`Butterclaw gateway listening on http://${this.config.gatewayHost}:${this.resolvePort(server)}`);
    return new Promise<number>((resolve) => {
      server.once("close", () => resolve(0));
    });
  }

  async startForTest(): Promise<http.Server> {
    const server = this.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    return server;
  }

  status(): string {
    return gatewayStatus(this.config);
  }

  createServer(): http.Server {
    return http.createServer((req, res) => {
      void this.handle(req, res);
    });
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? "/", `http://${this.config.gatewayHost}`);
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health" || url.pathname === "/status")) {
        sendJson(res, 200, this.health());
        return;
      }
      if (req.method === "GET" && url.pathname === "/v1/models") {
        sendJson(res, 200, this.models());
        return;
      }
      if (url.pathname === this.config.gatewayHookPath || url.pathname.startsWith(`${this.config.gatewayHookPath}/`)) {
        await this.handleHook(req, res, url);
        return;
      }
      sendJson(res, 404, { ok: false, error: "not_found" });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  private health(): Record<string, unknown> {
    const tokenSet = Boolean(process.env[this.config.gatewayTokenEnv]);
    return {
      ok: true,
      name: "butterclaw-gateway",
      uptimeMs: Date.now() - this.startedAt,
      provider: this.config.provider,
      model: this.config.model,
      workspace: this.config.workspace,
      hooks: {
        path: this.config.gatewayHookPath,
        auth: tokenSet ? "configured" : "missing-token"
      }
    };
  }

  private models(): Record<string, unknown> {
    const agents = new AgentStore(this.config.agentsDir).list();
    return {
      object: "list",
      data: [
        { id: "butterclaw", object: "model", owned_by: "butterclaw" },
        { id: "butterclaw/default", object: "model", owned_by: "butterclaw" },
        ...agents.map((agent) => ({ id: `butterclaw/${agent.name}`, object: "model", owned_by: "butterclaw" }))
      ]
    };
  }

  private async handleHook(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (url.searchParams.has("token")) {
      sendJson(res, 400, { ok: false, error: "hook token must be sent in an Authorization bearer header or x-butterclaw-token header" });
      return;
    }
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.setHeader("Allow", "POST");
      res.end("Method Not Allowed");
      return;
    }
    const token = hookToken(req);
    const expected = process.env[this.config.gatewayTokenEnv] ?? "";
    if (!expected || !safeEqual(token, expected)) {
      sendJson(res, 401, { ok: false, error: "unauthorized" });
      return;
    }
    const body = await readJsonBody(req, this.config.gatewayMaxBodyBytes);
    const subPath = url.pathname.slice(this.config.gatewayHookPath.length).replace(/^\/+/, "");
    if (subPath === "wake") {
      const result = this.enqueueWake(body);
      sendJson(res, 200, result);
      return;
    }
    if (subPath === "agent") {
      const result = await this.runAgentHook(body);
      sendJson(res, result.status === "ok" ? 200 : 400, result);
      return;
    }
    sendJson(res, 404, { ok: false, error: "unknown_hook" });
  }

  private enqueueWake(payload: unknown): GatewayRun {
    if (!isRecord(payload)) {
      return { id: newRunId(), status: "error", error: "JSON object required" };
    }
    const text = String(payload.text ?? payload.message ?? "").trim();
    if (!text) {
      return { id: newRunId(), status: "error", error: "text required" };
    }
    const mode = payload.mode === "next-heartbeat" ? "next-heartbeat" : "now";
    const session = String(payload.session ?? payload.sessionKey ?? "main").trim() || "main";
    const job = new ScheduleStore(this.config.schedulePath).add({
      name: String(payload.name ?? "hook-wake"),
      at: mode === "now" ? "now" : "1m",
      message: text,
      session
    });
    return { id: newRunId(), status: "accepted", jobId: job.id, output: `queued ${mode} wake for ${job.nextRunAt}` };
  }

  private async runAgentHook(payload: unknown): Promise<GatewayRun> {
    if (!isRecord(payload)) {
      return { id: newRunId(), status: "error", error: "JSON object required" };
    }
    const message = String(payload.message ?? payload.text ?? "").trim();
    if (!message) {
      return { id: newRunId(), status: "error", error: "message required" };
    }
    const sessionName = optionalSlug(payload.session ?? payload.sessionKey);
    try {
      const runConfig = { ...this.config };
      const profile = this.resolveAgentProfile(payload, runConfig);
      const result = await new ButterclawAgent(runConfig, {
        ...(profile ? { agentProfile: profile } : {}),
        ...(sessionName ? { sessionName } : {})
      }).run(message);
      return { id: newRunId(), status: "ok", output: result.answer, steps: result.steps };
    } catch (error) {
      return { id: newRunId(), status: "error", error: error instanceof Error ? error.message : String(error) };
    }
  }

  private resolveAgentProfile(payload: Record<string, unknown>, config: ButterclawConfig): AgentProfile | undefined {
    const requested = optionalSlug(payload.agent ?? payload.agentId ?? payload.name);
    if (!requested) {
      return undefined;
    }
    const profile = new AgentStore(config.agentsDir).get(requested);
    if (!profile) {
      throw new GatewayError(`Unknown agent: ${requested}`);
    }
    applyAgentProfile(config, profile);
    return profile;
  }

  private resolvePort(server: http.Server): number {
    const address = server.address();
    return typeof address === "object" && address ? address.port : this.config.gatewayPort;
  }
}

export function gatewayStatus(config: ButterclawConfig): string {
  const tokenSet = Boolean(process.env[config.gatewayTokenEnv]);
  return [
    `Gateway: http://${config.gatewayHost}:${config.gatewayPort}`,
    `Hooks: http://${config.gatewayHost}:${config.gatewayPort}${config.gatewayHookPath}`,
    `Token env ${config.gatewayTokenEnv}: ${tokenSet ? "set" : "not set"}`,
    `Max body: ${config.gatewayMaxBodyBytes} bytes`
  ].join("\n");
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: http.IncomingMessage, maxBytes: number): Promise<unknown> {
  const text = await readBody(req, maxBytes);
  if (!text.trim()) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new GatewayError("Invalid JSON body");
  }
}

function readBody(req: http.IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new GatewayError("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function hookToken(req: http.IncomingMessage): string {
  const auth = String(req.headers.authorization ?? "");
  if (auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  return String(req.headers["x-butterclaw-token"] ?? req.headers["x-openclaw-token"] ?? "").trim();
}

function safeEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function newRunId(): string {
  return `gw_${crypto.randomUUID().slice(0, 8)}`;
}

function optionalSlug(value: unknown): string | undefined {
  const text = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return text ? truncate(text, 64) : undefined;
}
