import fs from "node:fs";
import path from "node:path";
import { ensureDir, readJsonFile, slugName, splitCsv, writeJsonFile } from "./util.js";

export interface TeamProfile {
  name: string;
  description: string;
  agents: string[];
  instructions?: string;
}

export interface TeamCreateInput {
  name: string;
  description?: string;
  agents: string[] | string;
  instructions?: string;
  overwrite?: boolean;
}

export class TeamStore {
  constructor(private readonly teamsDir: string) {
    ensureDir(teamsDir);
  }

  list(): TeamProfile[] {
    if (!fs.existsSync(this.teamsDir)) {
      return [];
    }
    return fs
      .readdirSync(this.teamsDir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => this.readFile(path.join(this.teamsDir, name)))
      .filter((team): team is TeamProfile => team !== null)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string): TeamProfile | null {
    return this.readFile(this.fileFor(name));
  }

  create(input: TeamCreateInput): TeamProfile {
    const name = slugName(input.name, "team name");
    const agents = normalizeAgents(input.agents);
    if (!agents.length) {
      throw new Error("Team must include at least one agent.");
    }
    const file = this.fileFor(name);
    if (fs.existsSync(file) && !input.overwrite) {
      throw new Error(`Team already exists: ${name}. Use --force to replace it.`);
    }
    const team: TeamProfile = {
      name,
      description: input.description?.trim() || `${name} team`,
      agents,
      ...(input.instructions?.trim() ? { instructions: input.instructions.trim() } : {})
    };
    writeJsonFile(file, team);
    return team;
  }

  private fileFor(name: string): string {
    return path.join(this.teamsDir, `${slugName(name, "team name")}.json`);
  }

  private readFile(file: string): TeamProfile | null {
    const raw = readJsonFile<Partial<TeamProfile> | null>(file, null);
    if (!raw || typeof raw.name !== "string" || !Array.isArray(raw.agents)) {
      return null;
    }
    const agents = normalizeAgents(raw.agents.map(String));
    if (!agents.length) {
      return null;
    }
    return {
      name: slugName(raw.name, "team name"),
      description: String(raw.description ?? `${raw.name} team`),
      agents,
      ...(typeof raw.instructions === "string" ? { instructions: raw.instructions } : {})
    };
  }
}

function normalizeAgents(value: string[] | string): string[] {
  const names = Array.isArray(value) ? value : splitCsv(value);
  return [...new Set(names.map((name) => slugName(name, "agent name")))];
}
