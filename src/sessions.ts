import fs from "node:fs";
import path from "node:path";
import { Message } from "./providers.js";
import { ensureDir, slugName } from "./util.js";

export type SessionRole = Extract<Message["role"], "user" | "assistant">;

export interface SessionTurn {
  role: SessionRole;
  content: string;
  createdAt: string;
}

export interface SessionSummary {
  name: string;
  turns: number;
  updatedAt: string;
}

export class SessionStore {
  constructor(private readonly sessionsDir: string) {
    ensureDir(sessionsDir);
  }

  list(): SessionSummary[] {
    if (!fs.existsSync(this.sessionsDir)) {
      return [];
    }
    return fs
      .readdirSync(this.sessionsDir)
      .filter((name) => name.endsWith(".jsonl"))
      .map((fileName) => {
        const name = fileName.slice(0, -".jsonl".length);
        const file = path.join(this.sessionsDir, fileName);
        return {
          name,
          turns: this.read(name).length,
          updatedAt: fs.statSync(file).mtime.toISOString()
        };
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.name.localeCompare(b.name));
  }

  read(name: string): SessionTurn[] {
    const file = this.fileFor(name);
    if (!fs.existsSync(file)) {
      return [];
    }
    return fs
      .readFileSync(file, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => safeParseTurn(line))
      .filter((turn): turn is SessionTurn => turn !== null);
  }

  append(name: string, role: SessionRole, content: string): void {
    const normalized = slugName(name, "session name");
    const turn: SessionTurn = {
      role,
      content,
      createdAt: new Date().toISOString()
    };
    ensureDir(this.sessionsDir);
    fs.appendFileSync(this.fileFor(normalized), `${JSON.stringify(turn)}\n`, "utf8");
  }

  clear(name: string): boolean {
    const file = this.fileFor(name);
    if (!fs.existsSync(file)) {
      return false;
    }
    fs.unlinkSync(file);
    return true;
  }

  format(name: string, maxTurns = 50): string {
    const turns = this.read(name).slice(-maxTurns);
    if (!turns.length) {
      return `No turns in session ${slugName(name, "session name")}.`;
    }
    return turns
      .map((turn, index) => {
        const label = `${index + 1}. ${turn.role} ${turn.createdAt}`;
        return `${label}\n${turn.content}`;
      })
      .join("\n\n");
  }

  private fileFor(name: string): string {
    return path.join(this.sessionsDir, `${slugName(name, "session name")}.jsonl`);
  }
}

function safeParseTurn(line: string): SessionTurn | null {
  try {
    const raw = JSON.parse(line) as Partial<SessionTurn>;
    if ((raw.role === "user" || raw.role === "assistant") && typeof raw.content === "string") {
      return {
        role: raw.role,
        content: raw.content,
        createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date(0).toISOString()
      };
    }
  } catch {
    return null;
  }
  return null;
}
