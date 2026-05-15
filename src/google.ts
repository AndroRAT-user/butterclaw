import { ButterclawConfig } from "./config.js";
import type { ToolResult } from "./tools.js";
import { isRecord, splitCsv, truncate } from "./util.js";

type ToolHandler = (args: Record<string, unknown>) => ToolResult | Promise<ToolResult>;

interface RegistryLike {
  register(spec: {
    name: string;
    description: string;
    args: Record<string, string>;
    handler: ToolHandler;
  }): void;
}

interface GoogleRequestOptions {
  method?: string;
  query?: Record<string, string | number | boolean | undefined>;
  queryList?: Array<[string, string]>;
  body?: unknown;
}

export function registerGoogleTools(registry: RegistryLike, config: ButterclawConfig): void {
  const google = new GoogleWorkspaceTools(config);
  registry.register({
    name: "gmail_search",
    description: "Search Gmail messages and return concise metadata",
    args: { query: "Gmail search query", maxResults: "optional result limit, default 5" },
    handler: (args) => google.searchGmail(args)
  });
  registry.register({
    name: "gmail_read",
    description: "Read a Gmail message by id",
    args: { id: "Gmail message id", maxChars: "optional body character limit" },
    handler: (args) => google.readGmail(args)
  });
  registry.register({
    name: "gmail_create_draft",
    description: "Create a Gmail draft without sending it",
    args: { to: "recipient email(s)", subject: "draft subject", body: "plain text body", cc: "optional", bcc: "optional" },
    handler: (args) => google.createGmailDraft(args)
  });
  registry.register({
    name: "calendar_list_events",
    description: "List Google Calendar events",
    args: { calendarId: "optional calendar id, default config", timeMin: "optional ISO start", timeMax: "optional ISO end", maxResults: "optional limit" },
    handler: (args) => google.listCalendarEvents(args)
  });
  registry.register({
    name: "calendar_create_event",
    description: "Create a Google Calendar event",
    args: { summary: "event title", start: "ISO date or datetime", end: "ISO date or datetime", calendarId: "optional", description: "optional", attendees: "optional comma-separated emails" },
    handler: (args) => google.createCalendarEvent(args)
  });
}

class GoogleWorkspaceTools {
  constructor(private readonly config: ButterclawConfig) {}

  async searchGmail(args: Record<string, unknown>): Promise<ToolResult> {
    const query = String(args.query ?? "").trim();
    const maxResults = boundedInt(args.maxResults, 1, 10, 5);
    const list = await this.gmail("messages", {
      query: { q: query || undefined, maxResults, includeSpamTrash: Boolean(args.includeSpamTrash) || undefined }
    });
    const messages = Array.isArray(list.messages) ? list.messages.filter(isRecord) : [];
    if (!messages.length) {
      return { ok: true, output: "No Gmail messages found." };
    }
    const rows = [];
    for (const message of messages.slice(0, maxResults)) {
      const id = String(message.id ?? "");
      if (!id) continue;
      const detail = await this.gmail(`messages/${encodeURIComponent(id)}`, {
        query: { format: "metadata" },
        queryList: ["From", "To", "Subject", "Date"].map((header) => ["metadataHeaders", header])
      });
      rows.push(formatGmailSummary(detail));
    }
    return { ok: true, output: rows.join("\n") || "No Gmail messages found." };
  }

  async readGmail(args: Record<string, unknown>): Promise<ToolResult> {
    const id = String(args.id ?? "").trim();
    if (!id) {
      return { ok: false, output: "id is required" };
    }
    const maxChars = boundedInt(args.maxChars, 500, 50_000, 8_000);
    const message = await this.gmail(`messages/${encodeURIComponent(id)}`, { query: { format: "full" } });
    const headers = headersFrom(message);
    const body = truncate(extractPayloadText(message.payload).trim() || String(message.snippet ?? ""), maxChars);
    return {
      ok: true,
      output: [
        `Id: ${String(message.id ?? id)}`,
        `Thread: ${String(message.threadId ?? "")}`,
        `Date: ${headers.date ?? ""}`,
        `From: ${headers.from ?? ""}`,
        `To: ${headers.to ?? ""}`,
        `Subject: ${headers.subject ?? ""}`,
        `Snippet: ${String(message.snippet ?? "")}`,
        "",
        body || "(empty message body)"
      ].join("\n")
    };
  }

  async createGmailDraft(args: Record<string, unknown>): Promise<ToolResult> {
    const to = String(args.to ?? "").trim();
    const subject = String(args.subject ?? "").trim();
    const body = String(args.body ?? "");
    if (!to || !subject) {
      return { ok: false, output: "to and subject are required" };
    }
    const raw = encodeBase64Url(
      buildMimeMessage({
        to,
        cc: String(args.cc ?? "").trim(),
        bcc: String(args.bcc ?? "").trim(),
        subject,
        body
      })
    );
    const draft = await this.gmail("drafts", { method: "POST", body: { message: { raw } } });
    return { ok: true, output: `Created Gmail draft ${String(draft.id ?? "(unknown id)")} for ${to}: ${subject}` };
  }

  async listCalendarEvents(args: Record<string, unknown>): Promise<ToolResult> {
    const calendarId = this.calendarId(args.calendarId);
    const now = new Date().toISOString();
    const result = await this.calendar(calendarId, "events", {
      query: {
        timeMin: String(args.timeMin ?? now),
        timeMax: optionalString(args.timeMax),
        maxResults: boundedInt(args.maxResults, 1, 25, 10),
        singleEvents: true,
        orderBy: "startTime"
      }
    });
    const events = Array.isArray(result.items) ? result.items.filter(isRecord) : [];
    if (!events.length) {
      return { ok: true, output: "No calendar events found." };
    }
    return {
      ok: true,
      output: events
        .map((event) => {
          const start = eventDate(event.start);
          const end = eventDate(event.end);
          return `${start}${end ? ` - ${end}` : ""}: ${String(event.summary ?? "(untitled)")} [${String(event.id ?? "")}]`;
        })
        .join("\n")
    };
  }

  async createCalendarEvent(args: Record<string, unknown>): Promise<ToolResult> {
    const calendarId = this.calendarId(args.calendarId);
    const summary = String(args.summary ?? "").trim();
    const start = String(args.start ?? "").trim();
    const end = String(args.end ?? "").trim();
    if (!summary || !start || !end) {
      return { ok: false, output: "summary, start, and end are required" };
    }
    const timeZone = optionalString(args.timeZone);
    const event = await this.calendar(calendarId, "events", {
      method: "POST",
      query: { sendUpdates: optionalString(args.sendUpdates) },
      body: {
        summary,
        description: optionalString(args.description),
        location: optionalString(args.location),
        start: eventTime(start, timeZone),
        end: eventTime(end, timeZone),
        attendees: splitCsv(String(args.attendees ?? "")).map((email) => ({ email }))
      }
    });
    return {
      ok: true,
      output: `Created calendar event ${String(event.id ?? "(unknown id)")}: ${String(event.summary ?? summary)}${event.htmlLink ? `\n${String(event.htmlLink)}` : ""}`
    };
  }

  private async gmail(path: string, options: GoogleRequestOptions = {}): Promise<Record<string, unknown>> {
    return this.request(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, options);
  }

  private async calendar(calendarId: string, path: string, options: GoogleRequestOptions = {}): Promise<Record<string, unknown>> {
    return this.request(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/${path}`, options);
  }

  private async request(url: string, options: GoogleRequestOptions): Promise<Record<string, unknown>> {
    const response = await fetch(withQuery(url, options.query, options.queryList), {
      method: options.method ?? "GET",
      headers: {
        Authorization: `Bearer ${this.token()}`,
        Accept: "application/json",
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" })
      },
      body: options.body === undefined ? undefined : JSON.stringify(removeUndefined(options.body)),
      signal: AbortSignal.timeout(this.config.requestTimeoutSeconds * 1000)
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Google API HTTP ${response.status}: ${truncate(text, 500)}`);
    }
    if (!text.trim()) {
      return {};
    }
    try {
      const parsed = JSON.parse(text);
      return isRecord(parsed) ? parsed : {};
    } catch {
      throw new Error(`Google API returned non-JSON response: ${truncate(text, 500)}`);
    }
  }

  private token(): string {
    const token = process.env[this.config.googleTokenEnv]?.trim();
    if (!token) {
      throw new Error(`Missing Google access token. Set ${this.config.googleTokenEnv}.`);
    }
    return token;
  }

  private calendarId(value: unknown): string {
    return String(value ?? this.config.googleCalendarId ?? "primary").trim() || "primary";
  }
}

function formatGmailSummary(message: Record<string, unknown>): string {
  const headers = headersFrom(message);
  return [
    String(message.id ?? "(no id)"),
    headers.date ?? "",
    headers.from ?? "",
    headers.subject ?? "(no subject)",
    truncate(String(message.snippet ?? ""), 160)
  ]
    .filter(Boolean)
    .join(" | ");
}

function headersFrom(message: Record<string, unknown>): Record<string, string> {
  const payload = isRecord(message.payload) ? message.payload : {};
  const headers = Array.isArray(payload.headers) ? payload.headers.filter(isRecord) : [];
  const output: Record<string, string> = {};
  for (const header of headers) {
    const name = String(header.name ?? "").toLowerCase();
    if (name) output[name] = String(header.value ?? "");
  }
  return output;
}

function extractPayloadText(payload: unknown): string {
  if (!isRecord(payload)) {
    return "";
  }
  const mimeType = String(payload.mimeType ?? "");
  const body = isRecord(payload.body) && typeof payload.body.data === "string" ? decodeBase64Url(payload.body.data) : "";
  if (mimeType === "text/plain" && body) {
    return body;
  }
  const parts = Array.isArray(payload.parts) ? payload.parts : [];
  const plain = parts.map(extractPayloadText).filter(Boolean).join("\n").trim();
  if (plain) {
    return plain;
  }
  if (mimeType === "text/html" && body) {
    return body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }
  return body;
}

function buildMimeMessage(message: { to: string; cc: string; bcc: string; subject: string; body: string }): string {
  const headers = [
    ["To", message.to],
    ["Cc", message.cc],
    ["Bcc", message.bcc],
    ["Subject", encodeHeader(message.subject)],
    ["MIME-Version", "1.0"],
    ["Content-Type", 'text/plain; charset="UTF-8"']
  ]
    .filter(([, value]) => value)
    .map(([name, value]) => `${name}: ${cleanHeader(value)}`);
  return `${headers.join("\r\n")}\r\n\r\n${message.body}`;
}

function encodeHeader(value: string): string {
  return /^[\x20-\x7E]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function cleanHeader(value: string): string {
  return value.replace(/\r?\n/g, " ").trim();
}

function encodeBase64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(value: string): string {
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

function withQuery(url: string, query: GoogleRequestOptions["query"] = {}, queryList: Array<[string, string]> = []): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") {
      params.set(key, String(value));
    }
  }
  for (const [key, value] of queryList) {
    params.append(key, value);
  }
  const text = params.toString();
  return text ? `${url}?${text}` : url;
}

function eventTime(value: string, timeZone?: string): Record<string, string> {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return { date: value };
  }
  return { dateTime: value, ...(timeZone ? { timeZone } : {}) };
}

function eventDate(value: unknown): string {
  if (!isRecord(value)) {
    return "";
  }
  return String(value.dateTime ?? value.date ?? "");
}

function optionalString(value: unknown): string | undefined {
  const text = String(value ?? "").trim();
  return text || undefined;
}

function boundedInt(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function removeUndefined(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(removeUndefined);
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined).map(([key, entry]) => [key, removeUndefined(entry)]));
}
