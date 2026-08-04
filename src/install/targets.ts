import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeAtomically } from "@/support/atomic-write";
import { type UpsertOutcome, upsertJsonMcpServer } from "./json-mcp";
import type { McpServerSpec } from "./server-spec";
import {
	buildCortexTable,
	CORTEX_TABLE_HEADER,
	upsertTomlTable,
} from "./toml-mcp";

export type TargetId = "claude" | "codex" | "cursor" | "gemini";
export type InstructionFile = "CLAUDE.md" | "AGENTS.md" | "GEMINI.md";

export interface HarnessTarget {
	id: TargetId;
	displayName: string;
	instructionFile: InstructionFile;
	configPath(home: string): string;
	detectInstalled(home: string): boolean;
	register(home: string, spec: McpServerSpec): Promise<UpsertOutcome>;
}

// Detection is a best-effort existence check on the harness's user config
// dir. A false positive only pre-offers a harness the user can decline; a
// false negative only means opting in via --target.
export const ALL_TARGETS: readonly HarnessTarget[] = Object.freeze([
	jsonTarget({
		id: "claude",
		displayName: "Claude Code",
		instructionFile: "CLAUDE.md",
		configPath: (home) => join(home, ".claude.json"),
		detectInstalled: (home) =>
			existsSync(join(home, ".claude")) ||
			existsSync(join(home, ".claude.json")),
		entry: (spec) => ({
			type: "stdio",
			command: spec.command,
			args: spec.args,
		}),
	}),
	{
		id: "codex",
		displayName: "Codex CLI",
		instructionFile: "AGENTS.md",
		configPath: codexConfigPath,
		detectInstalled: (home) => existsSync(join(home, ".codex")),
		register: (home, spec) => registerToml(codexConfigPath(home), spec),
	},
	jsonTarget({
		id: "cursor",
		displayName: "Cursor",
		instructionFile: "AGENTS.md",
		configPath: (home) => join(home, ".cursor", "mcp.json"),
		detectInstalled: (home) => existsSync(join(home, ".cursor")),
		entry: (spec) => ({
			type: "stdio",
			command: spec.command,
			args: spec.args,
		}),
	}),
	jsonTarget({
		id: "gemini",
		displayName: "Gemini CLI",
		instructionFile: "GEMINI.md",
		configPath: (home) => join(home, ".gemini", "settings.json"),
		detectInstalled: (home) => existsSync(join(home, ".gemini")),
		entry: (spec) => ({ command: spec.command, args: spec.args }),
	}),
]);

export type TargetResolution = { targets: HarnessTarget[] } | { error: string };

export function resolveTargets(flag: string, home: string): TargetResolution {
	if (flag === "all") return { targets: [...ALL_TARGETS] };
	if (flag === "auto") {
		return { targets: ALL_TARGETS.filter((t) => t.detectInstalled(home)) };
	}
	return resolveIds(flag.split(","));
}

// A harness participates when its user config dir exists or a teammate
// already committed its instruction file — either way someone reads it here.
export function instructionFilesFor(
	home: string,
	root: string,
): InstructionFile[] {
	const files = ALL_TARGETS.filter(
		(t) => t.detectInstalled(home) || existsSync(join(root, t.instructionFile)),
	).map((t) => t.instructionFile);
	return [...new Set(files)];
}

function resolveIds(ids: string[]): TargetResolution {
	const targets: HarnessTarget[] = [];
	for (const id of ids.map((value) => value.trim()).filter(Boolean)) {
		const target = ALL_TARGETS.find((candidate) => candidate.id === id);
		if (!target) return { error: unknownTarget(id) };
		if (!targets.includes(target)) targets.push(target);
	}
	return { targets };
}

function unknownTarget(id: string): string {
	const known = ALL_TARGETS.map((target) => target.id).join(", ");
	return `unknown target: ${id} (known: ${known}, plus auto and all)`;
}

function codexConfigPath(home: string): string {
	return join(home, ".codex", "config.toml");
}

interface JsonTargetSpec {
	id: TargetId;
	displayName: string;
	instructionFile: InstructionFile;
	configPath(home: string): string;
	detectInstalled(home: string): boolean;
	entry(spec: McpServerSpec): Record<string, unknown>;
}

function jsonTarget(target: JsonTargetSpec): HarnessTarget {
	return {
		...target,
		register(home, spec) {
			return upsertJsonMcpServer(target.configPath(home), target.entry(spec));
		},
	};
}

async function registerToml(
	filePath: string,
	spec: McpServerSpec,
): Promise<UpsertOutcome> {
	const file = Bun.file(filePath);
	const existing = (await file.exists()) ? await file.text() : null;
	const result = upsertTomlTable(
		existing ?? "",
		CORTEX_TABLE_HEADER,
		buildCortexTable(spec),
	);
	if (result.action === "unchanged") {
		return { path: filePath, action: "unchanged" };
	}
	mkdirSync(dirname(filePath), { recursive: true });
	await writeAtomically(filePath, result.content);
	return { path: filePath, action: existing === null ? "created" : "updated" };
}
